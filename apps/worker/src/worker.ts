import {
  createCloudClient, createDb, createTwilioClient, twilioConfig, waitForDb, createFakeClient, handleAlertOperator, handleCapi, handleSendWelcome,
  handleSheetLead, handleWebhookJob, emailNewLeads, syncPendingLeadsToSheet, syncLeadAnswersToSheet, alertFlowFinished, migrate, seedSelf, startBoss, type JobDeps, type WhatsAppClient,
} from '@turnly/core';

const url = process.env.DATABASE_URL!;
const db = createDb(url);
await waitForDb(db);
await migrate(db);
await seedSelf(db);

// Provider: Twilio when its settings exist, Meta when a Meta token exists, otherwise mock (logs only).
const twilio = twilioConfig(process.env);
const mock = process.env.WA_MODE === 'mock' || (!twilio && !process.env.META_SYSTEM_USER_TOKEN);
let wa: WhatsAppClient;
if (mock) {
  const f = createFakeClient();
  wa = { send: async (...a: Parameters<WhatsAppClient['send']>) => { console.log('[mock wa] send', a[1], JSON.stringify(a[2])); return f.send(a[0], a[1], a[2]); } };
  console.warn('WhatsApp client is in MOCK mode: nothing is sent to anyone.');
} else if (twilio) {
  wa = createTwilioClient(twilio);
  console.log('WhatsApp provider: Twilio');
} else {
  wa = createCloudClient({ token: process.env.META_SYSTEM_USER_TOKEN! });
  console.log('WhatsApp provider: Meta Cloud API');
}
// TRUST_TEMPLATES=1: skip our approval check. For the Twilio sandbox / testing only.
const trustTemplates = mock || process.env.TRUST_TEMPLATES === '1';

const deps: JobDeps = { db, wa, trustTemplates };
const { boss } = await startBoss(url, { supervise: true });

type J<T> = { id: string; data: T }[];
const each = <T>(fn: (d: T) => Promise<unknown>) => async (jobs: J<T>) => { for (const j of jobs) await fn(j.data); };

await boss.work('send_welcome', each((d: { leadId: string }) => handleSendWelcome(deps, d)));
await boss.work('alert_operator', each((d: { leadId: string }) => handleAlertOperator(deps, d)));
await boss.work('wa_webhook', each((d: unknown) => handleWebhookJob(deps, d)));
await boss.work('sheet_lead', each((d: { leadId: string }) => handleSheetLead(deps, d)));
await boss.work('email_lead', each(() => emailNewLeads({ db, env: process.env }).then((r) => { if (r.error) throw new Error(r.error); })));
await boss.work('capi_lead', each((d: { leadId: string }) => handleCapi(deps, d)));
// Safety net for the Google Sheet: every minute, add any lead that is still missing. Errors are kept for the status page.
const sheetTick = async () => {
  try {
    const r = await syncPendingLeadsToSheet({ db, env: process.env });
    if (r.error) {
      console.warn('[sheet] sync failed:', r.error);
      await db.query(
        `insert into events (name, props) select 'sheet_sync_error', $1::jsonb
          where not exists (select 1 from events where name = 'sheet_sync_error' and created_at > now() - interval '10 minutes' and props->>'message' = $2)`,
        [JSON.stringify({ message: r.error }), r.error]);
    } else if (r.synced > 0) {
      console.log(`[sheet] added ${r.synced} lead(s)`);
      await db.query(`insert into events (name, props) values ('sheet_sync_ok', $1)`, [JSON.stringify({ added: r.synced })]);
    }
    const em = await emailNewLeads({ db, env: process.env });
    if (em.error) console.warn('[email] failed:', em.error);
    const a = await syncLeadAnswersToSheet({ db, env: process.env });
    if (a.error) console.warn('[sheet] answers sync failed:', a.error);
    else if (a.updated > 0) console.log(`[sheet] updated chat answers for ${a.updated} lead(s)`);
  } catch (e) {
    console.warn('[sheet] sync crashed:', (e as Error).message);
  }
};
// Safety net for lead chats: alert you about any finished chat whose alert did not go out the first time.
setInterval(() => { alertFlowFinished(deps).catch((e) => console.warn('[flow] alert failed:', (e as Error).message)); }, 30_000);
setInterval(sheetTick, 60_000);
setTimeout(sheetTick, 10_000);
console.log('worker ready');

const stop = async () => { await boss.stop(); await db.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
