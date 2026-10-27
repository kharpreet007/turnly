import { beforeEach, describe, expect, it } from 'vitest';
import { createTwilioClient, sendMessage, twilioConfig, twilioSignature, WaSendError } from '@turnly/core';
import { approveAll, db, makeHarness, OPERATOR, resetDb } from './helpers.ts';

const cfg = { accountSid: 'ACxxx', authToken: 'tok', from: 'whatsapp:+14155238886', contentSids: {} as Record<string, string>, statusCallback: 'https://x.test/twilio/status', fallbackVariableNames: ['1', '2'] };

function fakeTwilio(status = 201, json: object = { sid: 'SM123' }) {
  const calls: { url: string; init: any }[] = [];
  const impl = (async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify(json), { status }); }) as unknown as typeof fetch;
  return { impl, calls, form: () => Object.fromEntries(calls[0].init.body as URLSearchParams) };
}

describe('Twilio client', () => {
  it('sends text as a WhatsApp message with basic auth and a status callback', async () => {
    const t = fakeTwilio();
    const r = await createTwilioClient(cfg, t.impl).send('n', '+919876543210', { kind: 'text', body: 'hello' });
    expect(r.waMessageId).toBe('SM123');
    expect(t.calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json');
    expect(t.calls[0].init.headers.authorization).toBe('Basic ' + Buffer.from('ACxxx:tok').toString('base64'));
    expect(t.form()).toMatchObject({ To: 'whatsapp:+919876543210', From: 'whatsapp:+14155238886', Body: 'hello', StatusCallback: 'https://x.test/twilio/status' });
  });

  it('sends a template as its filled-in text unless a Content template is configured', async () => {
    const plain = fakeTwilio();
    const tpl = { kind: 'template', name: 'turnly_demo_welcome', language: 'en', variables: ['Asha', 'salon'] } as const;
    await createTwilioClient(cfg, plain.impl).send('n', '+919876543210', tpl, { renderedBody: 'Hi Asha' });
    expect(plain.form().Body).toBe('Hi Asha');
    const rich = fakeTwilio();
    await createTwilioClient({ ...cfg, contentSids: { turnly_demo_welcome: 'HX1' } }, rich.impl).send('n', '+919876543210', tpl, { renderedBody: 'Hi Asha' });
    expect(rich.form()).toMatchObject({ ContentSid: 'HX1', ContentVariables: '{"1":"Asha","2":"salon"}' });
    expect(rich.form().Body).toBeUndefined();
  });

  it('classifies errors: rate limits retry, the rest are permanent', async () => {
    const send = (status: number, code: number) => createTwilioClient(cfg, fakeTwilio(status, { code, message: 'nope' }).impl).send('n', '+919876543210', { kind: 'text', body: 'x' });
    await expect(send(429, 20429)).rejects.toMatchObject({ transient: true });
    await expect(send(400, 63016)).rejects.toMatchObject({ transient: false, code: 63016 });
    await expect(send(400, 63016)).rejects.toBeInstanceOf(WaSendError);
  });

  it('reads settings from env', () => {
    expect(twilioConfig({})).toBeNull();
    const c = twilioConfig({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+14155238886', PUBLIC_BASE_URL: 'https://a.test/' });
    expect(c?.from).toBe('whatsapp:+14155238886');
    expect(c?.statusCallback).toBe('https://a.test/twilio/status');
  });

  it('matches the signature example in Twilio docs format (url + sorted params, HMAC-SHA1)', () => {
    const sig = twilioSignature('tok', 'https://x.test/twilio/webhook', { To: 'b', From: 'a' });
    expect(sig).toBe(twilioSignature('tok', 'https://x.test/twilio/webhook', { From: 'a', To: 'b' }));
    expect(sig).not.toBe(twilioSignature('tok2', 'https://x.test/twilio/webhook', { From: 'a', To: 'b' }));
  });
});

beforeEach(async () => { await resetDb(); await approveAll(); });

describe('sendMessage passes the filled-in template text to the provider', () => {
  it('as renderedBody', async () => {
    const h = makeHarness();
    const seen: any[] = [];
    const wa = { send: async (_n: string, _t: string, _p: any, ctx: any) => { seen.push(ctx); return { waMessageId: 'x' }; } };
    const { rows: [c] } = await db.query(`select b.id as bid, c.id as cid from businesses b join contacts c on c.business_id = b.id where c.phone_e164 = $1`, [OPERATOR]);
    await sendMessage({ ...h.deps, wa }, { businessId: c.bid, contactId: c.cid, purpose: 'operator_alert', dedupeKey: 'r1',
      payload: { kind: 'template', name: 'turnly_operator_new_lead', language: 'en', variables: ['Asha', 'salon', '+91', 'fb1'] } });
    expect(seen[0].renderedBody).toBe('New Turnly lead: Asha (salon), +91. Source: fb1.');
  });
});

describe('Twilio webhooks', () => {
  const twilioCfg = { twilio: { authToken: 'tok', numberId: 'TEST_PNID' }, publicBaseUrl: 'https://x.test' };
  const post = (app: any, path: string, params: Record<string, string>, sign = true) => app.inject({
    method: 'POST', url: path, payload: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sign ? { 'x-twilio-signature': twilioSignature('tok', 'https://x.test' + path, params) } : {}) },
  });

  it('rejects unsigned requests', async () => {
    const h = makeHarness(twilioCfg);
    const app = await h.build();
    expect((await post(app, '/twilio/webhook', { From: 'whatsapp:+919876543210', Body: 'hi', MessageSid: 'SM1' }, false)).statusCode).toBe(403);
    expect(h.jobs).toHaveLength(0);
  });

  it('stores an incoming message once, opening the 24h window', async () => {
    const h = makeHarness(twilioCfg);
    const app = await h.build();
    const p = { From: 'whatsapp:+919000000001', Body: 'join happy-tiger', MessageSid: 'SM1', ProfileName: 'Operator' };
    expect((await post(app, '/twilio/webhook', p)).statusCode).toBe(200);
    await post(app, '/twilio/webhook', p);
    expect((await db.query(`select 1 from messages where direction = 'in'`)).rowCount).toBe(1);
    const { rows: [c] } = await db.query(`select last_inbound_at from contacts where phone_e164 = $1`, [OPERATOR]);
    expect(c.last_inbound_at).not.toBeNull();
  });

  it('STOP over Twilio opts the contact out and confirms once', async () => {
    const h = makeHarness(twilioCfg);
    const app = await h.build();
    await post(app, '/twilio/webhook', { From: 'whatsapp:+919811111111', Body: 'STOP', MessageSid: 'SM9' });
    const { rows: [c] } = await db.query(`select opt_in, opted_out_at from contacts where phone_e164 = '+919811111111'`);
    expect(c.opt_in).toBe(false);
    expect(c.opted_out_at).not.toBeNull();
    expect(h.wa.sent).toHaveLength(1);
  });

  it('records delivery status callbacks', async () => {
    const h = makeHarness(twilioCfg);
    const app = await h.build();
    const { rows: [b] } = await db.query(`select id from businesses limit 1`);
    const { rows: [c] } = await db.query(`select id from contacts where phone_e164 = $1`, [OPERATOR]);
    await db.query(`insert into messages (business_id, contact_id, direction, type, status, wa_message_id) values ($1, $2, 'out', 'text', 'sent', 'SM55')`, [b.id, c.id]);
    expect((await post(app, '/twilio/status', { MessageSid: 'SM55', MessageStatus: 'delivered', To: 'whatsapp:+919000000001' })).statusCode).toBe(204);
    expect((await db.query(`select status from messages where wa_message_id = 'SM55'`)).rows[0].status).toBe('delivered');
    await post(app, '/twilio/status', { MessageSid: 'SM55', MessageStatus: 'undelivered', To: 'whatsapp:+919000000001', ErrorCode: '63016' });
    expect((await db.query(`select status, error from messages where wa_message_id = 'SM55'`)).rows[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('63016') });
  });
});

describe('Twilio fallback template', () => {
  it('retries once through the fallback template when Twilio says ContentSid is required', async () => {
    const calls: any[] = [];
    const impl = (async (_u: string, init: any) => {
      calls.push(Object.fromEntries(init.body as URLSearchParams));
      return calls.length === 1
        ? new Response(JSON.stringify({ code: 21654, message: 'ContentSid Required' }), { status: 400 })
        : new Response(JSON.stringify({ sid: 'SM9' }), { status: 201 });
    }) as unknown as typeof fetch;
    const client = createTwilioClient({ ...cfg, fallbackContentSid: 'HXfallback' }, impl);
    const r = await client.send('n', '+919053151756', { kind: 'template', name: 'turnly_operator_new_lead', language: 'en', variables: [] }, { renderedBody: 'New Turnly lead: Asha (salon), +91. Source: fb1.' });
    expect(r.waMessageId).toBe('SM9');
    expect(calls).toHaveLength(2);
    expect(calls[0].Body).toContain('New Turnly lead');
    expect(calls[1].ContentSid).toBe('HXfallback');
    expect(calls[1].Body).toBeUndefined();
    expect(JSON.parse(calls[1].ContentVariables)).toEqual({ '1': 'New Turnly lead: Asha (salon), +91. Source: fb1.', '2': 'Turnly' });
  });

  it('does not retry without a fallback template, and does not loop', async () => {
    let n = 0;
    const impl = (async () => { n++; return new Response(JSON.stringify({ code: 21654, message: 'ContentSid Required' }), { status: 400 }); }) as unknown as typeof fetch;
    await expect(createTwilioClient(cfg, impl).send('n', '+91', { kind: 'text', body: 'x' })).rejects.toMatchObject({ code: 21654 });
    expect(n).toBe(1);
    n = 0;
    await expect(createTwilioClient({ ...cfg, fallbackContentSid: 'HXf' }, impl).send('n', '+91', { kind: 'text', body: 'x' })).rejects.toMatchObject({ code: 21654 });
    expect(n).toBe(2);
  });

  it('reads the fallback from env', () => {
    const c = twilioConfig({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+1415', TWILIO_FALLBACK_CONTENT_SID: ' HXabc ' });
    expect(c?.fallbackContentSid).toBe('HXabc');
  });
});

describe('Twilio fallback variable names', () => {
  it('uses the names from settings: text in the first, "Turnly" in the rest', async () => {
    const calls: any[] = [];
    const impl = (async (_u: string, init: any) => {
      calls.push(Object.fromEntries(init.body as URLSearchParams));
      return calls.length === 1 ? new Response(JSON.stringify({ code: 21654 }), { status: 400 }) : new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 });
    }) as unknown as typeof fetch;
    const c = twilioConfig({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+1415', TWILIO_FALLBACK_CONTENT_SID: 'HXf', TWILIO_FALLBACK_VARIABLES: 'date, time' })!;
    expect(c.fallbackVariableNames).toEqual(['date', 'time']);
    await createTwilioClient(c, impl).send('n', '+91', { kind: 'text', body: 'New lead' });
    expect(JSON.parse(calls[1].ContentVariables)).toEqual({ date: 'New lead', time: 'Turnly' });
  });
  it('defaults to 1 and 2', () => {
    expect(twilioConfig({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+1415' })?.fallbackVariableNames).toEqual(['1', '2']);
  });
});
