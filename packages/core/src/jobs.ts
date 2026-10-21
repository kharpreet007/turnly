import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { sendMessage, WINDOW_MS, type SendDeps } from './sendMessage.ts';
import { processWebhook } from './webhook.ts';
import { ist } from './export.ts';
import { appendSheetRow, sheetConfig } from './sheets.ts';

export interface JobDeps extends SendDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** Welcome template to a lead who ticked the consent box. sendMessage enforces consent itself. */
export async function handleSendWelcome(deps: JobDeps, data: { leadId: string }) {
  const { rows: [l] } = await deps.db.query(
    `select business_id, contact_id, name, business_type from leads where id = $1`, [data.leadId]);
  if (!l) return { ok: false, reason: 'lead_not_found' };
  const res = await sendMessage(deps, {
    businessId: l.business_id, contactId: l.contact_id, purpose: 'proactive',
    payload: { kind: 'template', name: 'turnly_demo_welcome', language: 'en', variables: [l.name, l.business_type] },
    dedupeKey: `welcome:${data.leadId}`, actor: 'lead_welcome',
  });
  if (res.ok) {
    await deps.db.query(`update leads set status = 'contacted', updated_at = now() where id = $1 and status = 'new'`, [data.leadId]);
  }
  return res;
}

/**
 * Tell every allow-listed operator number about a new lead. Inside the 24h window (the operator
 * messaged the number recently) this is a plain text, so it works before any template is approved.
 * Outside the window it falls back to the approved template.
 */
export async function handleAlertOperator(deps: JobDeps, data: { leadId: string }) {
  const { rows: [l] } = await deps.db.query(
    `select l.business_id, l.name, l.business_type, l.phone_e164, coalesce(l.ad_source, 'direct') as src, b.owner_phone_e164s
       from leads l join businesses b on b.id = l.business_id where l.id = $1`, [data.leadId]);
  if (!l) return [];
  const now = (deps.now ?? (() => new Date()))();
  const results = [];
  for (const phone of l.owner_phone_e164s as string[]) {
    const { rows: [c] } = await deps.db.query(
      'select id, last_inbound_at from contacts where business_id = $1 and phone_e164 = $2', [l.business_id, phone]);
    if (!c) continue;
    const inWindow = !!c.last_inbound_at && now.getTime() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
    const payload = inWindow
      ? { kind: 'text' as const, body: `New Turnly demo request: ${l.name} (${l.business_type}), ${l.phone_e164}. Source: ${l.src}.` }
      : { kind: 'template' as const, name: 'turnly_operator_new_lead', language: 'en', variables: [l.name, l.business_type, l.phone_e164, l.src] };
    results.push(await sendMessage(deps, {
      businessId: l.business_id, contactId: c.id, purpose: 'operator_alert', payload,
      dedupeKey: `alert:${data.leadId}:${c.id}`, actor: 'operator_alert',
    }));
  }
  return results;
}

export async function handleWebhookJob(deps: JobDeps, payload: unknown) {
  return processWebhook(deps, payload);
}

/** Server-side Meta Conversions API Lead event. event_id matches the browser Pixel event for dedupe. */
export async function handleCapi(deps: JobDeps, data: { leadId: string }) {
  const env = deps.env ?? process.env;
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return { skipped: true };
  const { rows: [l] } = await deps.db.query(
    `select id, phone_e164, event_id, fbclid, user_agent, ip, extract(epoch from created_at)::bigint as ts from leads where id = $1`, [data.leadId]);
  if (!l) return { skipped: true };
  const sha = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');
  const body = {
    data: [{
      event_name: 'Lead',
      event_time: Number(l.ts),
      event_id: l.event_id ?? `lead:${l.id}`,
      action_source: 'website',
      event_source_url: env.PUBLIC_BASE_URL,
      user_data: {
        ph: [sha(l.phone_e164.replace(/\D/g, ''))],
        client_user_agent: l.user_agent ?? undefined,
        client_ip_address: l.ip ?? undefined,
        fbc: l.fbclid ? `fb.1.${Number(l.ts) * 1000}.${l.fbclid}` : undefined,
      },
    }],
  };
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`https://graph.facebook.com/v21.0/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CAPI ${res.status}`);
  return { skipped: false };
}

/** Appends a new lead to the Google Sheet, once. Does nothing when the Google settings are not set. */
export type SheetDeps = Pick<JobDeps, 'db' | 'env' | 'fetchImpl'>;

export async function handleSheetLead(deps: SheetDeps, data: { leadId: string }) {
  const cfg = sheetConfig(deps.env ?? process.env);
  if (!cfg) return { skipped: true, reason: 'not_configured' };
  const { rows: [l] } = await deps.db.query(
    `select l.id, l.created_at, l.name, l.phone_e164, l.business_type, l.ad_source, l.wants, l.est_monthly_loss,
            l.utm, l.consent_text, l.sheet_synced_at, c.opt_in
       from leads l join contacts c on c.id = l.contact_id where l.id = $1`, [data.leadId]);
  if (!l || l.sheet_synced_at) return { skipped: true, reason: 'already_synced' };
  const utm = Object.entries((l.utm ?? {}) as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('; ');
  await appendSheetRow(cfg, [
    ist(l.created_at), l.name, l.phone_e164, l.business_type, l.ad_source ?? '',
    Array.isArray(l.wants) ? l.wants.join('; ') : '', String(l.est_monthly_loss ?? ''),
    l.opt_in ? 'yes' : 'no', l.consent_text, utm, l.id, 'new', '',
  ], deps.fetchImpl ?? fetch);
  await deps.db.query('update leads set sheet_synced_at = now() where id = $1', [l.id]);
  return { skipped: false };
}

export interface SheetSyncResult { configured: boolean; total: number; synced: number; error?: string }

/** Adds every lead not yet in the sheet, oldest first. Stops at the first error and reports it. */
export async function syncPendingLeadsToSheet(deps: SheetDeps): Promise<SheetSyncResult> {
  try {
    if (!sheetConfig(deps.env ?? process.env)) return { configured: false, total: 0, synced: 0 };
  } catch (e) {
    return { configured: true, total: 0, synced: 0, error: (e as Error).message };
  }
  const { rows } = await deps.db.query<{ id: string }>('select id from leads where sheet_synced_at is null order by created_at asc');
  let synced = 0;
  for (const r of rows) {
    try {
      await handleSheetLead(deps, { leadId: r.id });
      synced++;
    } catch (e) {
      return { configured: true, total: rows.length, synced, error: (e as Error).message };
    }
  }
  return { configured: true, total: rows.length, synced };
}
