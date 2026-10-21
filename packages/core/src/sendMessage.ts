import type { Db } from './db.ts';
import { WaSendError, type OutboundPayload, type WhatsAppClient } from './whatsapp.ts';

/**
 * The only place a WhatsApp message leaves the system. All rules live here:
 * consent, STOP, 24-hour window, template approval, dedupe, throttling, audit.
 *
 * purpose:
 *  - reply:               answer to something the contact sent (window rules apply)
 *  - proactive:           business-initiated; needs opt_in = true
 *  - operator_alert:      alert to an allow-listed owner/operator contact; needs opt_in = true
 *  - optout_confirmation: the single confirmation after STOP; the only send allowed to an opted-out contact
 */
export type Purpose = 'reply' | 'proactive' | 'operator_alert' | 'optout_confirmation';

export interface SendRequest {
  businessId: string;
  contactId: string;
  purpose: Purpose;
  payload: OutboundPayload;
  /** One key per logical send. A second call with the same key never sends twice. */
  dedupeKey: string;
  actor?: string;
}

export type RefusalReason =
  | 'blocked' | 'opted_out' | 'no_consent' | 'outside_window' | 'template_unknown'
  | 'template_not_approved' | 'no_number' | 'throttled' | 'contact_not_found' | 'send_failed';

export type SendResult =
  | { ok: true; messageId: string; waMessageId: string }
  | { ok: false; reason: RefusalReason | 'duplicate'; error?: string };

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 3;

/** trustTemplates: mock mode only. Treats every template as approved without touching the database. */
export interface SendDeps { db: Db; wa: WhatsAppClient; now?: () => Date; trustTemplates?: boolean }

export function renderTemplate(body: string, vars: readonly string[]): string {
  return body.replace(/{{(\d+)}}/g, (_, i) => vars[Number(i) - 1] ?? '');
}

export async function sendMessage(deps: SendDeps, req: SendRequest): Promise<SendResult> {
  const { db, wa } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const actor = req.actor ?? 'system';

  const refuse = async (reason: RefusalReason, detail: object = {}): Promise<SendResult> => {
    await db.query(
      `insert into audit_log (business_id, actor, action, detail) values ($1, $2, 'send_refused', $3)`,
      [req.businessId, actor, JSON.stringify({ reason, contactId: req.contactId, purpose: req.purpose, dedupeKey: req.dedupeKey, ...detail })],
    );
    return { ok: false, reason };
  };

  const { rows: [c] } = await db.query(
    `select id, phone_e164, opt_in, opted_out_at, blocked, last_inbound_at
       from contacts where id = $1 and business_id = $2`,
    [req.contactId, req.businessId],
  );
  if (!c) return refuse('contact_not_found');

  if (c.blocked) return refuse('blocked');
  if (c.opted_out_at && !c.opt_in && req.purpose !== 'optout_confirmation') return refuse('opted_out');

  const inWindow = !!c.last_inbound_at && now.getTime() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
  const isTemplate = req.payload.kind === 'template';
  const businessInitiated = req.purpose === 'proactive' || req.purpose === 'operator_alert' || (isTemplate && !inWindow);

  if (businessInitiated && !c.opt_in) return refuse('no_consent');
  if (!isTemplate && !inWindow) return refuse('outside_window');

  let renderedBody: string | null = null;
  let templateName: string | null = null;
  if (req.payload.kind === 'template') {
    templateName = req.payload.name;
    const { rows: [t] } = await db.query(
      `select body, status from templates
        where name = $1 and language = $2 and (business_id = $3 or business_id is null)
        order by business_id nulls last limit 1`,
      [req.payload.name, req.payload.language, req.businessId],
    );
    if (!t) return refuse('template_unknown', { template: req.payload.name });
    if (t.status !== 'approved' && !deps.trustTemplates) return refuse('template_not_approved', { template: req.payload.name, status: t.status });
    renderedBody = renderTemplate(t.body, req.payload.variables);
  } else {
    renderedBody = req.payload.body;
  }

  const { rows: [num] } = await db.query(
    `select phone_number_id from wa_numbers where business_id = $1 and status = 'active' order by id limit 1`,
    [req.businessId],
  );
  if (!num) return refuse('no_number');

  const { rows: [biz] } = await db.query('select send_per_minute from businesses where id = $1', [req.businessId]);
  const { rows: [{ n }] } = await db.query(
    `select count(*)::int as n from messages
      where business_id = $1 and direction = 'out' and created_at > $2`,
    [req.businessId, new Date(now.getTime() - 60_000)],
  );
  if (n >= biz.send_per_minute) return refuse('throttled');

  // Claim the dedupe key. An existing row still queued/retrying is a retry of the same send.
  let messageId: string;
  let attempts = 0;
  const ins = await db.query(
    `insert into messages (business_id, contact_id, direction, type, body, template_name, status, dedupe_key)
     values ($1, $2, 'out', $3, $4, $5, 'queued', $6)
     on conflict (business_id, dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [req.businessId, req.contactId, req.payload.kind, renderedBody, templateName, req.dedupeKey],
  );
  if (ins.rows[0]) {
    messageId = ins.rows[0].id;
  } else {
    const { rows: [m] } = await db.query(
      `select id, status, attempts from messages where business_id = $1 and dedupe_key = $2`,
      [req.businessId, req.dedupeKey],
    );
    if (!m || !['queued', 'retrying'].includes(m.status)) return { ok: false, reason: 'duplicate' };
    messageId = m.id;
    attempts = m.attempts;
  }

  try {
    const { waMessageId } = await wa.send(num.phone_number_id, c.phone_e164, req.payload);
    await db.query(`update messages set status = 'sent', wa_message_id = $2, attempts = $3, error = null where id = $1`, [messageId, waMessageId, attempts + 1]);
    await db.query(
      `insert into audit_log (business_id, actor, action, detail) values ($1, $2, 'send', $3)`,
      [req.businessId, actor, JSON.stringify({ messageId, waMessageId, purpose: req.purpose, kind: req.payload.kind, template: templateName })],
    );
    return { ok: true, messageId, waMessageId };
  } catch (e) {
    const err = e instanceof WaSendError ? e : new WaSendError((e as Error).message, false);
    const next = attempts + 1;
    if (err.transient && next < MAX_ATTEMPTS) {
      await db.query(`update messages set status = 'retrying', attempts = $2, error = $3 where id = $1`, [messageId, next, err.message]);
      throw err; // queue retries with backoff
    }
    await db.query(`update messages set status = 'failed', attempts = $2, error = $3 where id = $1`, [messageId, next, err.message]);
    await db.query(
      `insert into audit_log (business_id, actor, action, detail) values ($1, $2, 'send_failed', $3)`,
      [req.businessId, actor, JSON.stringify({ messageId, error: err.message, code: err.code })],
    );
    return { ok: false, reason: 'send_failed', error: err.message };
  }
}
