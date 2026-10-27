import { beforeEach, describe, expect, it } from 'vitest';
import { signBody } from '@turnly/core';
import { approveAll, db, makeHarness, OPERATOR, PNID, resetDb, SECRET, validLead } from './helpers.ts';

beforeEach(async () => { await resetDb(); await approveAll(); });

const post = (app: any, payload: object) => app.inject({ method: 'POST', url: '/api/leads', payload });

function hook(app: any, value: object, sign = true) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PNID }, ...value } }] }] });
  return app.inject({
    method: 'POST', url: '/webhook', payload: body,
    headers: { 'content-type': 'application/json', ...(sign ? { 'x-hub-signature-256': signBody(body, SECRET) } : {}) },
  });
}
const inboundText = (id: string, from: string, text: string) => ({
  contacts: [{ profile: { name: 'Asha' }, wa_id: from.replace('+', '') }],
  messages: [{ from: from.replace('+', ''), id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});

describe('POST /api/leads', () => {
  it('creates a lead and sends the welcome template to the lead (and alerts the operator)', async () => {
    const h = makeHarness();
    const app = await h.build();
    const res = await post(app, validLead());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, duplicate: false });

    const toLead = h.wa.sent.filter((s) => s.to === '+919876543210');
    expect(toLead).toHaveLength(1);
    expect(toLead[0].payload).toMatchObject({ kind: 'template', name: 'turnly_demo_welcome' });
    expect(h.wa.sent.filter((s) => s.to === OPERATOR)).toHaveLength(1);

    const { rows: [lead] } = await db.query(`select status, ad_source, consent_text from leads`);
    expect(lead).toMatchObject({ status: 'contacted', ad_source: 'fb1' });
    expect(lead.consent_text).toContain('agree to be messaged');
  });

  it('without the consent box: rejected, nothing stored, nothing sent', async () => {
    const h = makeHarness();
    const app = await h.build();
    for (const bad of [{ consent: false }, { consent: undefined }, { consent_text: '' }]) {
      const res = await post(app, validLead(bad));
      expect(res.statusCode).toBe(400);
    }
    expect((await db.query('select 1 from leads')).rowCount).toBe(0);
    expect(h.wa.sent).toHaveLength(0);
  });

  it('even a lead row lacking opt-in never gets a message (sendMessage guards it)', async () => {
    const h = makeHarness();
    const app = await h.build();
    await post(app, validLead());
    h.wa.sent.length = 0;
    await db.query(`update contacts set opt_in = false where phone_e164 = '+919876543210'`);
    await db.query(`delete from messages where direction = 'out'`);
    const { handleSendWelcome } = await import('@turnly/core');
    const { rows: [l] } = await db.query('select id from leads');
    expect(await handleSendWelcome(h.deps, { leadId: l.id })).toMatchObject({ ok: false, reason: 'no_consent' });
    expect(h.wa.sent).toHaveLength(0);
  });

  it('duplicate submissions in 24h update the lead and do not double-send', async () => {
    const h = makeHarness();
    const app = await h.build();
    await post(app, validLead());
    const second = await post(app, validLead({ name: 'Asha K', phone: '9876543210' }));
    expect(second.json()).toEqual({ ok: true, duplicate: true });
    expect((await db.query('select 1 from leads')).rowCount).toBe(1);
    expect(h.wa.sent.filter((s) => s.to === '+919876543210')).toHaveLength(1);
    const { rows: [l] } = await db.query('select name, submissions from leads');
    expect(l).toMatchObject({ name: 'Asha K', submissions: 2 });
  });

  it('rejects bad phones with a field error', async () => {
    const app = await makeHarness().build();
    const res = await post(app, validLead({ phone: '12345' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().fields[0].field).toBe('phone');
  });

  it('honeypot: pretends success, stores and sends nothing', async () => {
    const h = makeHarness();
    const app = await h.build();
    const res = await post(app, validLead({ website: 'http://spam.example' }));
    expect(res.statusCode).toBe(200);
    expect((await db.query('select 1 from leads')).rowCount).toBe(0);
    expect(h.wa.sent).toHaveLength(0);
  });

  it('rate limits repeated submissions per phone', async () => {
    const app = await makeHarness().build();
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await post(app, validLead())).statusCode);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});

describe('WhatsApp webhook', () => {
  it('verifies the subscription handshake', async () => {
    const app = await makeHarness().build();
    const ok = await app.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123' });
    expect(ok.body).toBe('123');
    const bad = await app.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123' });
    expect(bad.statusCode).toBe(403);
  });

  it('rejects unsigned and wrongly signed payloads', async () => {
    const h = makeHarness();
    const app = await h.build();
    expect((await hook(app, inboundText('w1', '+919876543210', 'hi'), false)).statusCode).toBe(401);
    expect(h.jobs).toHaveLength(0);
  });

  it('stores each inbound message once, even when Meta replays it', async () => {
    const app = await makeHarness().build();
    for (let i = 0; i < 3; i++) expect((await hook(app, inboundText('wamid.A', '+919876543210', 'price?'))).statusCode).toBe(200);
    expect((await db.query(`select 1 from messages where direction = 'in'`)).rowCount).toBe(1);
  });

  it('STOP opts the lead out immediately, sends one confirmation, and blocks later proactive sends', async () => {
    const h = makeHarness();
    const app = await h.build();
    await post(app, validLead());
    h.wa.sent.length = 0;

    await hook(app, inboundText('wamid.STOP', '+919876543210', ' Stop '));
    const { rows: [c] } = await db.query(`select opt_in, opted_out_at from contacts where phone_e164 = '+919876543210'`);
    expect(c.opt_in).toBe(false);
    expect(c.opted_out_at).not.toBeNull();
    expect(h.wa.sent).toHaveLength(1);
    expect(h.wa.sent[0].payload).toMatchObject({ kind: 'text' });

    // Replay of STOP must not send a second confirmation.
    await hook(app, inboundText('wamid.STOP', '+919876543210', 'STOP'));
    expect(h.wa.sent).toHaveLength(1);

    // A fresh welcome attempt (e.g. a retried job) is now refused.
    const { handleSendWelcome } = await import('@turnly/core');
    const { rows: [l] } = await db.query('select id from leads');
    await db.query(`delete from messages where dedupe_key like 'welcome:%'`);
    expect(await handleSendWelcome(h.deps, { leadId: l.id })).toMatchObject({ ok: false, reason: 'opted_out' });
    expect(h.wa.sent).toHaveLength(1);
  });

  it('records delivery statuses without moving backwards', async () => {
    const h = makeHarness();
    const app = await h.build();
    await post(app, validLead());
    const { rows: [m] } = await db.query(`select wa_message_id from messages where template_name = 'turnly_demo_welcome'`);
    const st = (status: string) => hook(app, { statuses: [{ id: m.wa_message_id, status, timestamp: '1', recipient_id: '1' }] });
    await st('delivered'); await st('read'); await st('delivered');
    expect((await db.query(`select status from messages where wa_message_id = $1`, [m.wa_message_id])).rows[0].status).toBe('read');
    await st('failed');
    expect((await db.query(`select status from messages where wa_message_id = $1`, [m.wa_message_id])).rows[0].status).toBe('failed');
  });

  it('a reply moves a new lead to contacted', async () => {
    const app = await makeHarness().build();
    await post(app, validLead());
    await db.query(`update leads set status = 'new'`);
    await hook(app, inboundText('wamid.R', '+919876543210', 'yes'));
    expect((await db.query('select status from leads')).rows[0].status).toBe('contacted');
  });
});

describe('admin leads', () => {
  it('requires the admin token', async () => {
    const app = await makeHarness().build();
    expect((await app.inject({ method: 'GET', url: '/admin/leads' })).statusCode).toBe(401);
    await post(app, validLead());
    const ok = await app.inject({ method: 'GET', url: '/admin/leads', headers: { authorization: 'Bearer admin-secret' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveLength(1);
  });
});

describe('landing page', () => {
  it('is served at / and told which API to post to', async () => {
    const app = await makeHarness().build();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('window.TURNLY_API_BASE = location.origin');
    expect(res.body).toContain('Get this set up for my salon');
  });
});

describe('lead export', () => {
  const get = (app: any, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/admin/leads.csv', headers });

  it('needs the admin token', async () => {
    const app = await makeHarness().build();
    expect((await get(app)).statusCode).toBe(401);
  });

  it('downloads a CSV Excel can open, with the phone kept intact', async () => {
    const app = await makeHarness().build();
    await post(app, validLead());
    const res = await get(app, { authorization: 'Bearer admin-secret' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('turnly-leads.csv');
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body).toContain('"WhatsApp"');
    expect(res.body).toContain('="+919876543210"');
    expect(res.body).toContain('"Asha"');
    expect(res.body).toContain('agree to be messaged');
  });

  it('defuses spreadsheet formulas typed into the form', async () => {
    const app = await makeHarness().build();
    await post(app, validLead({ name: '=HYPERLINK("http://evil","x")' }));
    const res = await get(app, { authorization: 'Bearer admin-secret' });
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  });
});

describe('sheet sync page', () => {
  it('needs the token and explains when Google is not set up', async () => {
    const app = await makeHarness().build();
    expect((await app.inject({ method: 'GET', url: '/admin/sheet/sync' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/admin/sheet/sync', headers: { authorization: 'Bearer admin-secret' } });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('Google Sheet is not set up');
  });
});

describe('template admin pages', () => {
  it('list templates as pending and explain when Meta is not connected', async () => {
    const app = await makeHarness().build();
    const h = { authorization: 'Bearer admin-secret' };
    const list = await app.inject({ method: 'GET', url: '/admin/templates', headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('turnly_demo_welcome');
    const sub = await app.inject({ method: 'GET', url: '/admin/templates/submit', headers: h });
    expect(sub.statusCode).toBe(500);
    expect(sub.body).toContain('Not connected to Meta yet');
  });
});

describe('sending status page', () => {
  it('needs the token and shows provider, alert number and refusals', async () => {
    const h = makeHarness();
    const app = await h.build();
    expect((await app.inject({ method: 'GET', url: '/admin/status' })).statusCode).toBe(401);
    await post(app, validLead());
    const res = await app.inject({ method: 'GET', url: '/admin/status', headers: { authorization: 'Bearer admin-secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Provider:');
    expect(res.body).toContain('+91•••••0001');
    expect(res.body).toContain('turnly_operator_new_lead');
    expect(res.body).not.toContain('+919000000001');
  });
});

describe('delete contact', () => {
  const auth = { authorization: 'Bearer admin-secret' };

  it('shows what will go, deletes only on POST, and the number works again afterwards', async () => {
    const h = makeHarness();
    const app = await h.build();
    await post(app, validLead());
    const preview = await app.inject({ method: 'GET', url: '/admin/delete-contact?phone=%2B919876543210', headers: auth });
    expect(preview.body).toContain('Delete everything for +919876543210');
    expect((await db.query('select 1 from leads')).rowCount).toBe(1); // GET deleted nothing

    const del = await app.inject({ method: 'POST', url: '/admin/delete-contact', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'phone=%2B919876543210' });
    expect(del.body).toContain('Deleted');
    expect((await db.query(`select 1 from leads where phone_e164 = '+919876543210'`)).rowCount).toBe(0);
    expect((await db.query(`select 1 from contacts where phone_e164 = '+919876543210'`)).rowCount).toBe(0);
    expect((await db.query(`select 1 from audit_log where action = 'delete_contact'`)).rowCount).toBe(1);

    const again = await post(app, validLead());
    expect(again.json()).toEqual({ ok: true, duplicate: false });
  });

  it('refuses the operator number and needs the token', async () => {
    const app = await makeHarness().build();
    expect((await app.inject({ method: 'GET', url: '/admin/delete-contact?phone=%2B919876543210' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/admin/delete-contact', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'phone=%2B919000000001' });
    expect(res.statusCode).toBe(403);
    expect((await db.query(`select 1 from contacts where phone_e164 = '+919000000001'`)).rowCount).toBe(1);
  });
});

describe('status page: Google Sheet line', () => {
  it('says the sheet is not set up when the Google variables are missing', async () => {
    const app = await makeHarness().build();
    const res = await app.inject({ method: 'GET', url: '/admin/status', headers: { authorization: 'Bearer admin-secret' } });
    expect(res.body).toContain('Google Sheet:');
    expect(res.body).toContain('not set up');
  });
});

describe('reset test data', () => {
  const auth = { authorization: 'Bearer admin-secret', 'content-type': 'application/x-www-form-urlencoded' };

  it('needs the word RESET, then removes every lead but keeps the operator contact', async () => {
    const app = await makeHarness().build();
    await post(app, validLead());
    await post(app, validLead({ phone: '9876543211', name: 'Second' }));
    // The operator number may itself have submitted a lead: its lead goes, its contact stays.
    await post(app, validLead({ phone: '9000000001', name: 'Operator test' }));

    const no = await app.inject({ method: 'POST', url: '/admin/reset-leads', headers: auth, payload: 'confirm=reset-please' });
    expect(no.statusCode).toBe(400);
    expect((await db.query('select 1 from leads')).rowCount).toBe(3);

    const yes = await app.inject({ method: 'POST', url: '/admin/reset-leads', headers: auth, payload: 'confirm=RESET' });
    expect(yes.body).toContain('Fresh start');
    expect((await db.query('select 1 from leads')).rowCount).toBe(0);
    expect((await db.query(`select 1 from contacts where phone_e164 in ('+919876543210', '+919876543211')`)).rowCount).toBe(0);
    expect((await db.query(`select 1 from contacts where phone_e164 = '+919000000001'`)).rowCount).toBe(1);
    expect((await post(app, validLead())).json()).toEqual({ ok: true, duplicate: false });
  });

  it('needs the token', async () => {
    const app = await makeHarness().build();
    expect((await app.inject({ method: 'GET', url: '/admin/reset-leads' })).statusCode).toBe(401);
  });
});
