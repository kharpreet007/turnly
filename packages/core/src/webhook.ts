import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { fromWaId } from './phone.ts';
import { isOptOut, OPTOUT_CONFIRMATION } from './optout.ts';
import { sendMessage, type SendDeps } from './sendMessage.ts';
import { advanceLeadFlow } from './leadFlow.ts';
import { alertFlowFinished } from './operatorAlerts.ts';

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

const STATUS_RANK: Record<string, number> = { queued: 0, retrying: 0, sent: 1, delivered: 2, read: 3 };

interface InboundMessage {
  from: string; id: string; timestamp: string; type: string;
  text?: { body: string };
  interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  image?: { id: string };
  location?: { latitude: number; longitude: number };
}

function describe(m: InboundMessage): string {
  switch (m.type) {
    case 'text': return m.text?.body ?? '';
    case 'interactive': return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
    case 'image': return `[image:${m.image?.id}]`; // media id only, never the bytes
    case 'location': return `[location:${m.location?.latitude},${m.location?.longitude}]`;
    default: return `[${m.type}]`;
  }
}

export interface WebhookSummary { inbound: number; duplicates: number; statuses: number; optOuts: number; unknownNumber: number }

/** Process one Meta webhook payload. Safe to replay: every write is idempotent. */
export async function processWebhook(deps: SendDeps, payload: any): Promise<WebhookSummary> {
  const { db } = deps;
  const out: WebhookSummary = { inbound: 0, duplicates: 0, statuses: 0, optOuts: 0, unknownNumber: 0 };

  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.metadata?.phone_number_id) continue;
      const { rows: [num] } = await db.query<{ business_id: string }>(
        'select business_id from wa_numbers where phone_number_id = $1', [value.metadata.phone_number_id]);
      if (!num) { out.unknownNumber++; continue; }
      const businessId = num.business_id;

      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of (value.messages ?? []) as InboundMessage[]) {
        const r = await handleInbound(deps, businessId, m, names.get(m.from));
        if (r === 'duplicate') out.duplicates++; else out.inbound++;
        if (r === 'optout') out.optOuts++;
      }
      for (const s of value.statuses ?? []) {
        await applyStatus(db, businessId, s);
        out.statuses++;
      }
    }
  }
  return out;
}

async function handleInbound(deps: SendDeps, businessId: string, m: InboundMessage, profileName?: string): Promise<'ok' | 'duplicate' | 'optout'> {
  const { db } = deps;
  const phone = fromWaId(m.from);
  const at = new Date(Number(m.timestamp) * 1000);

  const { rows: [contact] } = await db.query<{ id: string }>(
    `insert into contacts (business_id, phone_e164, name, last_inbound_at)
     values ($1, $2, $3, $4)
     on conflict (business_id, phone_e164) do update
       set last_inbound_at = greatest(contacts.last_inbound_at, excluded.last_inbound_at),
           name = coalesce(contacts.name, excluded.name)
     returning id`,
    [businessId, phone, profileName ?? null, at],
  );

  const body = describe(m);
  const ins = await db.query(
    `insert into messages (business_id, contact_id, direction, wa_message_id, type, body, status, created_at)
     values ($1, $2, 'in', $3, $4, $5, 'received', $6)
     on conflict (business_id, wa_message_id) where wa_message_id is not null do nothing
     returning id`,
    [businessId, contact.id, m.id, m.type, body, at],
  );
  if (!ins.rows[0]) {
    // A replay: the flow remembers message ids, so this only completes work an earlier attempt left unfinished.
    await runFlow(deps, businessId, contact.id, m, body);
    return 'duplicate';
  }

  await db.query(
    `insert into conversations (business_id, contact_id, window_expires_at)
     values ($1, $2, $3)
     on conflict (business_id, contact_id) do update set window_expires_at = excluded.window_expires_at`,
    [businessId, contact.id, new Date(at.getTime() + 24 * 3600_000)],
  );

  if (m.type === 'text' && isOptOut(body)) {
    // Immediate, before anything else can send to this contact.
    await db.query(
      `update contacts set opt_in = false, opted_out_at = now() where id = $1`, [contact.id]);
    await db.query(`insert into audit_log (business_id, actor, action, detail) values ($1, 'contact', 'opt_out', $2)`,
      [businessId, JSON.stringify({ contactId: contact.id })]);
    await sendMessage(deps, {
      businessId, contactId: contact.id, purpose: 'optout_confirmation',
      payload: { kind: 'text', body: OPTOUT_CONFIRMATION }, dedupeKey: `optout:${m.id}`,
    });
    return 'optout';
  }

  await runFlow(deps, businessId, contact.id, m, body);

  // Funnel: a reply to our welcome moves a new lead to "contacted".
  await db.query(
    `update leads set status = 'contacted', updated_at = now() where contact_id = $1 and status = 'new'`, [contact.id]);
  await db.query(`insert into events (business_id, name, props) values ($1, 'inbound_message', $2)`,
    [businessId, JSON.stringify({ contactId: contact.id, type: m.type })]);
  return 'ok';
}

async function applyStatus(db: Db, businessId: string, s: any) {
  const status = s.status as string;
  if (status === 'failed') {
    const err = s.errors?.[0];
    await db.query(
      `update messages set status = 'failed', error = $3 where business_id = $1 and wa_message_id = $2`,
      [businessId, s.id, err ? `${err.code}: ${err.title ?? err.message ?? ''}` : 'failed']);
    return;
  }
  const rank = STATUS_RANK[status];
  if (rank === undefined) return;
  // Never move backwards (webhooks can arrive out of order).
  await db.query(
    `update messages set status = $3
      where business_id = $1 and wa_message_id = $2
        and coalesce(case status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end, 0) < $4`,
    [businessId, s.id, status, rank]);
}

async function runFlow(deps: SendDeps, businessId: string, contactId: string, m: InboundMessage, body: string) {
  if (m.type !== 'text' && m.type !== 'interactive') return;
  const outcome = await advanceLeadFlow(deps, { businessId, contactId, waMessageId: m.id, text: body });
  if (outcome === 'done' || outcome === 'handoff') {
    try { await alertFlowFinished(deps); } catch (e) { console.warn('[flow] operator alert failed:', (e as Error).message); }
  }
}
