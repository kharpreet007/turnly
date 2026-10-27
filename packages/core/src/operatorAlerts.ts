import { sendMessage, WINDOW_MS, type SendDeps, type SendResult } from './sendMessage.ts';

/**
 * Message every owner/operator number. Plain text when they messaged us in the last 24h
 * (works before any template is approved), the approved template otherwise.
 */
export async function notifyOperators(
  deps: SendDeps, businessId: string,
  o: { dedupeBase: string; text: string; templateName: string; templateVars: string[] },
): Promise<SendResult[]> {
  const { rows: [b] } = await deps.db.query('select owner_phone_e164s from businesses where id = $1', [businessId]);
  const now = (deps.now ?? (() => new Date()))();
  const results: SendResult[] = [];
  for (const phone of (b?.owner_phone_e164s ?? []) as string[]) {
    const { rows: [c] } = await deps.db.query(
      'select id, last_inbound_at from contacts where business_id = $1 and phone_e164 = $2', [businessId, phone]);
    if (!c) continue;
    const inWindow = !!c.last_inbound_at && now.getTime() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
    results.push(await sendMessage(deps, {
      businessId, contactId: c.id, purpose: 'operator_alert', dedupeKey: `${o.dedupeBase}:${c.id}`, actor: 'operator_alert',
      payload: inWindow
        ? { kind: 'text', body: o.text }
        : { kind: 'template', name: o.templateName, language: 'en', variables: o.templateVars },
    }));
  }
  return results;
}

/** One alert per lead when its chat ends: finished, or the lead could not be understood twice. */
export async function alertFlowFinished(deps: SendDeps): Promise<number> {
  const { rows } = await deps.db.query(
    `select l.id, l.business_id, l.name, l.phone_e164, l.flow_status, l.answers
       from leads l where l.flow_status in ('done', 'needs_human') and l.flow_alerted_at is null
      order by l.created_at asc limit 20`);
  let sent = 0;
  for (const l of rows) {
    const a = (l.answers ?? {}) as Record<string, string>;
    const wants = l.flow_status === 'needs_human' ? 'needs a human (did not answer the questions)'
      : [a.interest, a.detail].filter(Boolean).join(': ') || 'not given';
    const who = `${l.name} (${l.phone_e164})`;
    const text = l.flow_status === 'needs_human'
      ? `Lead needs a human: ${who}. Please call them.`
      : `Lead finished the chat: ${who}. Wants: ${wants}. Business: ${a.business ?? 'not given'}. Best time to call: ${a.best_time ?? 'not given'}.`;
    const results = await notifyOperators(deps, l.business_id, {
      dedupeBase: `flowdone:${l.id}`, text, templateName: 'turnly_operator_lead_update',
      templateVars: [who, wants, a.business ?? 'not given', a.best_time ?? 'not given'],
    });
    // A failed send is shown on the status page; do not retry forever.
    await deps.db.query('update leads set flow_alerted_at = now() where id = $1', [l.id]);
    if (results.some((r) => r.ok)) sent++;
  }
  return sent;
}

