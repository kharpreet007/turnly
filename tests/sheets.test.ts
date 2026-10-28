import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLead, handleSheetLead, leadInput, sheetConfig } from '@turnly/core';
import { db, makeHarness, resetDb, validLead } from './helpers.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const sa = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey });
const env = { GOOGLE_SERVICE_ACCOUNT_JSON: sa, GOOGLE_SHEET_ID: 'SHEET123', GOOGLE_SHEET_TAB: 'Leads' };

/** Fake Google: records calls; the sheet is "empty" until the header is written. */
function fakeGoogle(opts: { headerExists?: boolean; appendStatus?: number } = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  let hasHeader = opts.headerExists ?? false;
  const impl = (async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url, method, body });
    const json = (o: object, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'tok', expires_in: 3600 });
    if (method === 'GET') return json(hasHeader ? { values: [['When (IST)']] } : {});
    if (method === 'PUT') { hasHeader = true; return json({}); }
    return json(opts.appendStatus && opts.appendStatus !== 200 ? { error: { message: 'denied' } } : {}, opts.appendStatus ?? 200);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(async () => { await resetDb(); });
const newLead = () => createLead(db, leadInput.parse(validLead({ wants: ['Reply ₹3,999'], est_monthly_loss: 30960 })));

describe('Google Sheet sync', () => {
  it('does nothing when Google is not configured', async () => {
    const h = makeHarness();
    const lead = await newLead();
    expect(await handleSheetLead({ ...h.deps, env: {} }, { leadId: lead.leadId })).toMatchObject({ skipped: true, reason: 'not_configured' });
  });

  it('writes the header then appends one row, as plain text', async () => {
    const h = makeHarness();
    const g = fakeGoogle();
    const lead = await newLead();
    expect(await handleSheetLead({ ...h.deps, env, fetchImpl: g.impl }, { leadId: lead.leadId })).toMatchObject({ skipped: false });

    const put = g.calls.find((c) => c.method === 'PUT')!;
    expect(put.body.values[0][0]).toBe('When (IST)');
    expect(put.url).toContain('valueInputOption=RAW');

    const append = g.calls.find((c) => c.url.includes(':append'))!;
    expect(append.url).toContain('SHEET123');
    expect(append.url).toContain('valueInputOption=RAW');
    const row = append.body.values[0];
    expect(row).toContain('Asha');
    expect(row).toContain('+919876543210');
    expect(row).toContain('Reply ₹3,999');
    expect(row).toContain(lead.leadId);
    const auth = g.calls.find((c) => c.url.startsWith('https://oauth2'))!;
    expect(String(auth.body)).toContain('urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');

    const { rows: [l] } = await db.query('select sheet_synced_at from leads');
    expect(l.sheet_synced_at).not.toBeNull();
  });

  it('keeps an existing header and never appends the same lead twice', async () => {
    const h = makeHarness();
    const g = fakeGoogle({ headerExists: true });
    const lead = await newLead();
    const deps = { ...h.deps, env, fetchImpl: g.impl };
    await handleSheetLead(deps, { leadId: lead.leadId });
    expect(await handleSheetLead(deps, { leadId: lead.leadId })).toMatchObject({ skipped: true, reason: 'already_synced' });
    expect(g.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(g.calls.filter((c) => c.url.includes(':append'))).toHaveLength(1);
  });

  it('throws on a Google error so the queue retries, and does not mark the lead synced', async () => {
    const h = makeHarness();
    const g = fakeGoogle({ headerExists: true, appendStatus: 403 });
    const lead = await newLead();
    await expect(handleSheetLead({ ...h.deps, env, fetchImpl: g.impl }, { leadId: lead.leadId })).rejects.toThrow(/403/);
    const { rows: [l] } = await db.query('select sheet_synced_at from leads');
    expect(l.sheet_synced_at).toBeNull();
  });

  it('accepts the service account as base64', () => {
    const cfg = sheetConfig({ ...env, GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(sa).toString('base64') });
    expect(cfg?.clientEmail).toBe('bot@proj.iam.gserviceaccount.com');
    expect(cfg?.tab).toBe('Leads');
  });
});

import { syncPendingLeadsToSheet } from '@turnly/core';

describe('sync pending leads', () => {
  const mk = (phone: string, name: string) => createLead(db, leadInput.parse(validLead({ phone, name })));

  it('adds every unsynced lead oldest first, then has nothing left to do', async () => {
    const h = makeHarness();
    const g = fakeGoogle({ headerExists: true });
    await mk('9876543210', 'First');
    await mk('9876543211', 'Second');
    const deps = { db: h.deps.db, env, fetchImpl: g.impl };
    expect(await syncPendingLeadsToSheet(deps)).toEqual({ configured: true, total: 2, synced: 2 });
    const rows = g.calls.filter((c) => c.url.includes(':append')).map((c) => c.body.values[0][1]);
    expect(rows).toEqual(['First', 'Second']);
    expect(await syncPendingLeadsToSheet(deps)).toEqual({ configured: true, total: 0, synced: 0 });
  });

  it('reports not configured, a bad key and Google errors in words', async () => {
    const h = makeHarness();
    await mk('9876543210', 'First');
    expect(await syncPendingLeadsToSheet({ db: h.deps.db, env: {} })).toMatchObject({ configured: false });
    const bad = await syncPendingLeadsToSheet({ db: h.deps.db, env: { ...env, GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email": "a", "private_key": ' } });
    expect(bad.error).toMatch(/not valid JSON/);
    const g = fakeGoogle({ headerExists: true, appendStatus: 403 });
    const denied = await syncPendingLeadsToSheet({ db: h.deps.db, env, fetchImpl: g.impl });
    expect(denied).toMatchObject({ configured: true, total: 1, synced: 0 });
    expect(denied.error).toMatch(/403/);
  });
});

describe('sync page: send everything again', () => {
  it('?all=1 clears the sent marks so every lead is written again', async () => {
    const { buildApp } = await import('../apps/api/src/app.ts');
    const h = makeHarness();
    await createLead(db, leadInput.parse(validLead()));
    await db.query('update leads set sheet_synced_at = now()');
    const app = await buildApp({ db, queue: h.queue, config: h.config });
    const auth = { authorization: 'Bearer admin-secret' };
    // Without ?all=1 nothing is pending, so the (unconfigured) page just reports setup state; the marks stay.
    await app.inject({ method: 'GET', url: '/admin/sheet/sync', headers: auth });
    expect((await db.query('select sheet_synced_at from leads')).rows[0].sheet_synced_at).not.toBeNull();
    await app.inject({ method: 'GET', url: '/admin/sheet/sync?all=1', headers: auth });
    expect((await db.query('select sheet_synced_at from leads')).rows[0].sheet_synced_at).toBeNull();
  });
});

import { clearSheetRows, sheetConfig } from '@turnly/core';
describe('clearing the sheet', () => {
  it('empties row 2 down across all columns, not only the first thirteen', async () => {
    const calls: { url: string; method: string }[] = [];
    const impl = (async (url: string, init: any = {}) => {
      calls.push({ url, method: init.method ?? 'GET' });
      return url.startsWith('https://oauth2') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }) : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await clearSheetRows(sheetConfig(env)!, impl);
    const clear = calls.find((c) => c.url.includes(':clear'))!;
    expect(clear.method).toBe('POST');
    expect(decodeURIComponent(clear.url)).toContain("'Leads'!A2:Z:clear");
  });
});
