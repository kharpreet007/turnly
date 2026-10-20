import {
  createDb, createFakeClient, handleAlertOperator, handleSendWelcome, handleWebhookJob, migrate, seedSelf,
  setTemplateStatus, type JobDeps, type Queue,
} from '@turnly/core';
import { buildApp } from '../apps/api/src/app.ts';

export const SECRET = 'test-app-secret';
export const OPERATOR = '+919000000001';
export const PNID = 'TEST_PNID';

export const db = createDb(process.env.DATABASE_URL!);

export async function resetDb() {
  await migrate(db);
  await db.query(`truncate audit_log, events, messages, leads, conversations, contacts, templates, wa_numbers, businesses restart identity cascade`);
  const businessId = await seedSelf(db, { operatorPhone: OPERATOR, phoneNumberId: PNID, wabaId: 'WABA' });
  return businessId;
}

export const approveAll = async () => {
  for (const n of ['turnly_demo_welcome', 'turnly_operator_new_lead']) await setTemplateStatus(db, n, 'approved');
};

/** Queue that runs jobs inline, like the worker would, so tests see end-to-end effects. */
export function makeHarness() {
  const wa = createFakeClient();
  const deps: JobDeps = { db, wa, env: {} };
  const jobs: { name: string; data: any }[] = [];
  const queue: Queue = {
    async send(name, data) {
      jobs.push({ name, data });
      if (name === 'send_welcome') await handleSendWelcome(deps, data as any);
      if (name === 'alert_operator') await handleAlertOperator(deps, data as any);
      if (name === 'wa_webhook') await handleWebhookJob(deps, data);
    },
  };
  const config = { databaseUrl: '', port: 0, appSecret: SECRET, verifyToken: 'verify-me', adminToken: 'admin-secret', allowedOrigins: [] };
  return { wa, deps, jobs, queue, config, build: () => buildApp({ db, queue, config }) };
}

export const validLead = (over: Record<string, unknown> = {}) => ({
  business_type: 'salon',
  name: 'Asha',
  country_code: '+91',
  phone: '98765 43210',
  consent: true,
  consent_text: 'I agree to be messaged on WhatsApp by Turnly about this demo.',
  ad_source: 'fb1',
  ...over,
});
