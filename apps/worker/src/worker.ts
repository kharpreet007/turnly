import {
  createCloudClient, createDb, waitForDb, createFakeClient, handleAlertOperator, handleCapi, handleSendWelcome,
  handleSheetLead, handleWebhookJob, migrate, seedSelf, startBoss, type JobDeps, type WhatsAppClient,
} from '@turnly/core';

const url = process.env.DATABASE_URL!;
const db = createDb(url);
await waitForDb(db);
await migrate(db);
await seedSelf(db);

// WA_MODE=mock logs instead of calling Meta (local dev without credentials).
const mock = process.env.WA_MODE === 'mock' || !process.env.META_SYSTEM_USER_TOKEN;
const wa: WhatsAppClient = mock
  ? (() => {
      const f = createFakeClient();
      return { send: async (...a: Parameters<WhatsAppClient['send']>) => { console.log('[mock wa] send', a[1], JSON.stringify(a[2])); return f.send(...a); } };
    })()
  : createCloudClient({ token: process.env.META_SYSTEM_USER_TOKEN! });
if (mock) console.warn('WhatsApp client is in MOCK mode: nothing is sent to Meta.');

const deps: JobDeps = { db, wa, trustTemplates: mock };
const { boss } = await startBoss(url, { supervise: true });

type J<T> = { id: string; data: T }[];
const each = <T>(fn: (d: T) => Promise<unknown>) => async (jobs: J<T>) => { for (const j of jobs) await fn(j.data); };

await boss.work('send_welcome', each((d: { leadId: string }) => handleSendWelcome(deps, d)));
await boss.work('alert_operator', each((d: { leadId: string }) => handleAlertOperator(deps, d)));
await boss.work('wa_webhook', each((d: unknown) => handleWebhookJob(deps, d)));
await boss.work('sheet_lead', each((d: { leadId: string }) => handleSheetLead(deps, d)));
await boss.work('capi_lead', each((d: { leadId: string }) => handleCapi(deps, d)));
console.log('worker ready');

const stop = async () => { await boss.stop(); await db.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
