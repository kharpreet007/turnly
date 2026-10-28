import type { Db } from './db.ts';
import { emailConfig, sendEmail } from './email.ts';
import { formatWhen, whatsAppLink } from './links.ts';
import { ist } from './export.ts';

type Env = Record<string, string | undefined>;
export interface CalendlyDeps { db: Db; env?: Env; fetchImpl?: typeof fetch; now?: () => Date }
export interface CalendlySyncResult { configured: boolean; events: number; matched: number; error?: string }

const BASE = 'https://api.calendly.com';
let userCache: { token: string; uri: string } | null = null;

async function get(token: string, f: typeof fetch, pathOrUrl: string): Promise<any> {
  const res = await f(pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Calendly ${res.status}: ${json.message ?? json.title ?? 'request failed'}`);
  return json;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lead behind a booking: by the id our link carried, else by the WhatsApp number they typed in Calendly. */
async function findLead(db: Db, invitee: any): Promise<string | null> {
  const utm = invitee.tracking?.utm_content;
  if (typeof utm === 'string' && UUID.test(utm)) {
    const { rows: [l] } = await db.query('select id from leads where id = $1', [utm]);
    if (l) return l.id;
  }
  const digits = ((invitee.questions_and_answers ?? []) as any[]).map((q) => String(q.answer ?? '').replace(/\D/g, '')).find((d) => d.length >= 8);
  if (digits) {
    const { rows: [l] } = await db.query(
      `select id from leads where regexp_replace(phone_e164, '\\D', '', 'g') like '%' || $1 order by created_at desc limit 1`, [digits]);
    if (l) return l.id;
  }
  return null;
}

/** Make the lead's call fields match its best booking. Returns true when something changed. */
async function refreshLeadCall(db: Db, leadId: string): Promise<boolean> {
  const { rows: [b] } = await db.query(
    `select event_status, start_time, invitee_tz, invitee_email from calendly_bookings where lead_id = $1
      order by (event_status = 'active') desc, invitee_created_at desc nulls last, start_time desc limit 1`, [leadId]);
  if (!b) return false;
  const status = b.event_status === 'active' ? 'booked' : 'canceled';
  const r = await db.query(
    `update leads set call_status = $2, call_start_at = $3, call_tz = $4, call_email = $5, answers_dirty = true
      where id = $1 and (call_status <> $2 or call_start_at is distinct from $3 or call_tz is distinct from $4)`,
    [leadId, status, b.start_time, b.invitee_tz, b.invitee_email]);
  return (r.rowCount ?? 0) > 0;
}

/** Read recent Calendly bookings and attach them to leads. Cheap when nothing changed (one list call). */
export async function syncCalendlyBookings(deps: CalendlyDeps): Promise<CalendlySyncResult> {
  const env = deps.env ?? process.env;
  const token = env.CALENDLY_TOKEN?.trim();
  if (!token) return { configured: false, events: 0, matched: 0 };
  const f = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? (() => new Date()))();
  try {
    if (!userCache || userCache.token !== token) userCache = { token, uri: (await get(token, f, '/users/me')).resource.uri };
    const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    let url: string = `/scheduled_events?user=${encodeURIComponent(userCache.uri)}&min_start_time=${encodeURIComponent(since)}&count=100&sort=start_time:asc`;
    const events: any[] = [];
    for (let i = 0; i < 5 && url; i++) {
      const page = await get(token, f, url);
      events.push(...(page.collection ?? []));
      url = page.pagination?.next_page ?? '';
    }
    let matched = 0;
    for (const ev of events) {
      const { rows: [seen] } = await deps.db.query('select event_status, start_time from calendly_bookings where event_uri = $1', [ev.uri]);
      if (seen && seen.event_status === ev.status && new Date(seen.start_time).getTime() === new Date(ev.start_time).getTime()) continue;
      const uuid = String(ev.uri).split('/').pop();
      const inv = await get(token, f, `/scheduled_events/${uuid}/invitees?count=100`);
      const invitees: any[] = inv.collection ?? [];
      let leadId: string | null = null;
      let chosen = invitees[0];
      for (const i of invitees) { leadId = await findLead(deps.db, i); if (leadId) { chosen = i; break; } }
      await deps.db.query(
        `insert into calendly_bookings (event_uri, lead_id, start_time, event_status, invitee_name, invitee_email, invitee_tz, invitee_created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (event_uri) do update set lead_id = excluded.lead_id, start_time = excluded.start_time, event_status = excluded.event_status,
           invitee_name = excluded.invitee_name, invitee_email = excluded.invitee_email, invitee_tz = excluded.invitee_tz, updated_at = now()`,
        [ev.uri, leadId, ev.start_time, ev.status, chosen?.name ?? null, chosen?.email ?? null, chosen?.timezone ?? null, chosen?.created_at ?? null]);
      if (leadId) { matched++; await refreshLeadCall(deps.db, leadId); }
    }
    return { configured: true, events: events.length, matched };
  } catch (e) {
    return { configured: true, events: 0, matched: 0, error: (e as Error).message };
  }
}

/** One email per change: call booked, rescheduled or canceled, with the WhatsApp message ready to send. */
export async function notifyBookedCalls(deps: { db: Db; env?: Env; fetchImpl?: typeof fetch }): Promise<number> {
  const env = deps.env ?? process.env;
  const mail = emailConfig(env);
  const { rows } = await deps.db.query(
    `select id, name, phone_e164, call_status, call_start_at, call_tz, call_email, call_notified_key from leads
      where call_status in ('booked', 'canceled') order by created_at asc limit 20`);
  let sent = 0;
  for (const l of rows) {
    const key = `${l.call_status}:${new Date(l.call_start_at).toISOString()}`;
    if (l.call_notified_key === key) continue;
    if (mail) {
      const booked = l.call_status === 'booked';
      const again = !!l.call_notified_key && l.call_notified_key.startsWith('booked');
      const link = whatsAppLink({ id: l.id, name: l.name, phone: l.phone_e164, callStatus: l.call_status, callStart: l.call_start_at, callTz: l.call_tz }, env);
      try {
        await sendEmail(mail, {
          subject: booked ? `${again ? 'Call rescheduled' : 'Call booked'}: ${l.name}, ${formatWhen(l.call_start_at, 'Asia/Kolkata')}` : `Call canceled: ${l.name}`,
          text: [
            booked ? `${l.name} ${again ? 'moved their set-up call to' : 'booked a set-up call for'} ${formatWhen(l.call_start_at, 'Asia/Kolkata')} (your time).` : `${l.name} canceled their set-up call (${formatWhen(l.call_start_at, 'Asia/Kolkata')}).`,
            booked ? `In their time zone: ${formatWhen(l.call_start_at, l.call_tz)}` : '',
            `WhatsApp: ${l.phone_e164}`, l.call_email ? `Email: ${l.call_email}` : '', '',
            booked ? 'Tap to confirm on WhatsApp (message is typed for you, just press Send):' : 'Tap to message them on WhatsApp:', link,
          ].filter((x, i, a) => x !== '' || (a[i - 1] !== '' && i > 0)).join('\n'),
        }, deps.fetchImpl ?? fetch);
      } catch (e) { console.warn('[calendly] email failed:', (e as Error).message); continue; }
    }
    await deps.db.query('update leads set call_notified_key = $2 where id = $1', [l.id, key]);
    sent++;
  }
  return sent;
}

export const callLabel = (l: { call_status: string; call_start_at: Date | string | null }) =>
  l.call_status === 'booked' && l.call_start_at ? `Booked ${ist(new Date(l.call_start_at))} IST`
    : l.call_status === 'canceled' ? 'Canceled' : 'Not booked';
