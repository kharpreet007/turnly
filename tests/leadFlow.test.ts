import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { alertFlowFinished, createLead, handleSendWelcome, leadInput, matchOption, processWebhook, renderQuestion, STEPS, syncLeadAnswersToSheet, welcomeText } from '@turnly/core';
import { approveAll, db, makeHarness, OPERATOR, PNID, resetDb, validLead } from './helpers.ts';

const LEAD = '+919876543210';
let n = 0;
const inbound = (from: string, text: string, id = `wamid.t${++n}`) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: PNID }, contacts: [{ profile: { name: 'X' }, wa_id: from.replace('+', '') }],
    messages: [{ from: from.replace('+', ''), id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
  } }] }],
});

async function startedLead() {
  const h = makeHarness();
  const lead = await createLead(db, leadInput.parse(validLead()));
  await handleSendWelcome(h.deps, { leadId: lead.leadId });
  await db.query(`update contacts set last_inbound_at = now() where phone_e164 = $1`, [OPERATOR]); // the owner messaged the number today
  h.wa.sent.length = 0;
  return { h, lead };
}
const say = (h: ReturnType<typeof makeHarness>, text: string, id?: string) => processWebhook(h.deps, inbound(LEAD, text, id));
const lastTo = (h: ReturnType<typeof makeHarness>, to: string) => [...h.wa.sent].reverse().find((s) => s.to === to)?.payload as any;

beforeEach(async () => { await resetDb(); await approveAll(); });

describe('option matching', () => {
  it('accepts numbers, words and whole sentences', () => {
    const o = STEPS.interest.options;
    expect(matchOption('1', o)?.value).toBe('packages');
    expect(matchOption(' 2. ', o)?.value).toBe('services');
    expect(matchOption('Packages', o)?.value).toBe('packages');
    expect(matchOption('services please', o)?.value).toBe('services');
    expect(matchOption('3', o)).toBeNull();
    expect(matchOption('hmm', o)).toBeNull();
    expect(matchOption('a', o)).toBeNull();
  });
  it('uses the agreed wording', () => {
    expect(welcomeText('Asha')).toBe('Hi Asha, thanks for your query. Our support team will contact you soon. In the meantime, are you looking for packages or services?\nReply 1 for Packages or 2 for Services.');
    expect(renderQuestion('package')).toBe('Which would you like?\n1. Reply\n2. Remind\n3. Return\nReply with a number.');
  });
});

describe('lead chat', () => {
  it('the welcome asks packages or services and starts the chat', async () => {
    const h = makeHarness();
    const lead = await createLead(db, leadInput.parse(validLead()));
    await handleSendWelcome(h.deps, { leadId: lead.leadId });
    expect((h.wa.sent[0].payload as any).name).toBe('turnly_demo_welcome');
    const { rows: [m] } = await db.query(`select body from messages where template_name = 'turnly_demo_welcome'`);
    expect(m.body).toContain('Hi Asha, thanks for your query');
    expect(m.body).toContain('Reply 1 for Packages or 2 for Services');
    expect((await db.query('select flow_status from leads')).rows[0].flow_status).toBe('asking');
  });

  it('walks the packages path to the close, saves the answers and alerts the owner once', async () => {
    const { h } = await startedLead();
    await say(h, '1');
    expect(lastTo(h, LEAD).body).toContain('Which would you like?');
    await say(h, '2');
    expect(lastTo(h, LEAD).body).toContain('What kind of business do you run?');
    await say(h, '1');
    expect(lastTo(h, LEAD).body).toContain('When should our team call you?');
    await say(h, 'Morning');
    expect(lastTo(h, LEAD).body).toBe('Thanks, Asha. Our team will reach you in the morning.');

    const { rows: [l] } = await db.query('select answers, flow_status, flow_alerted_at from leads');
    expect(l.answers).toEqual({ interest: 'packages', detail: 'Remind', business: 'salon', best_time: 'Morning' });
    expect(l.flow_status).toBe('done');
    expect(l.flow_alerted_at).not.toBeNull();
    const alert = lastTo(h, OPERATOR);
    expect(alert.body).toBe('Lead finished the chat: Asha (+919876543210). Wants: packages: Remind. Business: salon. Best time to call: Morning.');
    expect(await alertFlowFinished(h.deps)).toBe(0); // nothing more to send
    expect(h.wa.sent.filter((s) => s.to === OPERATOR)).toHaveLength(1);
  });

  it('walks the services path', async () => {
    const { h } = await startedLead();
    await say(h, 'services');
    expect(lastTo(h, LEAD).body).toContain('What do you need?');
    await say(h, '1'); await say(h, '5'); await say(h, '3');
    const { rows: [l] } = await db.query('select answers from leads');
    expect(l.answers).toEqual({ interest: 'services', detail: 'Set up my WhatsApp', business: 'restaurant', best_time: 'Evening' });
  });

  it('asks again once, then hands over to a person', async () => {
    const { h } = await startedLead();
    await say(h, 'what is this');
    expect(lastTo(h, LEAD).body).toContain('Sorry, I did not get that.');
    expect(lastTo(h, LEAD).body).toContain('1. Packages');
    await say(h, 'no idea');
    expect(lastTo(h, LEAD).body).toBe('No problem. Our support team will contact you soon.');
    const { rows: [l] } = await db.query('select flow_status from leads');
    expect(l.flow_status).toBe('needs_human');
    expect((await db.query('select needs_human from conversations')).rows[0].needs_human).toBe(true);
    expect(lastTo(h, OPERATOR).body).toContain('Lead needs a human');
    h.wa.sent.length = 0;
    await say(h, '1'); // the bot stays quiet after handing over
    expect(h.wa.sent).toHaveLength(0);
  });

  it('a replayed message neither answers twice nor moves the chat on twice', async () => {
    const { h } = await startedLead();
    await say(h, '1', 'wamid.same');
    await say(h, '1', 'wamid.same');
    await say(h, '1', 'wamid.same');
    expect(h.wa.sent.filter((s) => s.to === LEAD)).toHaveLength(1);
    const { rows: [c] } = await db.query('select flow_state from conversations');
    expect(c.flow_state.step).toBe('package');
  });

  it('STOP ends the chat politely and sends nothing else', async () => {
    const { h } = await startedLead();
    await say(h, 'STOP');
    const sent = h.wa.sent.filter((s) => s.to === LEAD);
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as any).body).toContain('unsubscribed');
  });

  it('ignores people who are not in a lead chat', async () => {
    const h = makeHarness();
    await processWebhook(h.deps, inbound('+919800000000', '1'));
    expect(h.wa.sent).toHaveLength(0);
  });
});

describe('chat answers in the Google Sheet', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: privateKey }), GOOGLE_SHEET_ID: 'S1', GOOGLE_SHEET_TAB: 'Leads' };

  function fakeSheet(leadId: string, rowAt = 3) {
    const calls: { url: string; method: string; body?: any }[] = [];
    const impl = (async (url: string, init: any = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined });
      const json = (o: object) => new Response(JSON.stringify(o), { status: 200 });
      if (url.startsWith('https://oauth2')) return json({ access_token: 't', expires_in: 3600 });
      if (url.includes('K%3AK')) return json({ values: [['Lead ID'], ...Array.from({ length: rowAt - 2 }, () => ['other']), [leadId]] });
      if (url.includes('N1') && method === 'GET') return json({});
      return json({});
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('writes answers to the lead row and the header once', async () => {
    const { h, lead } = await startedLead();
    for (const t of ['1', '3', '8', '2']) await say(h, t);
    await db.query('update leads set sheet_synced_at = now()');
    const g = fakeSheet(lead.leadId, 4);
    expect(await syncLeadAnswersToSheet({ db, env, fetchImpl: g.impl })).toEqual({ updated: 1 });
    const header = g.calls.find((c) => c.method === 'PUT' && c.url.includes('N1%3AS1'))!;
    expect(header.body.values[0]).toEqual(['Interest', 'Detail', 'Business (chat)', 'Best time to call', 'Call status', 'Call time (IST)']);
    const row = g.calls.find((c) => c.method === 'PUT' && c.url.includes('N4%3AS4'))!;
    expect(row.body.values[0]).toEqual(['packages', 'Return', 'other', 'Afternoon', 'Not booked', '']);
    expect((await db.query('select answers_dirty from leads')).rows[0].answers_dirty).toBe(false);
    expect(await syncLeadAnswersToSheet({ db, env, fetchImpl: g.impl })).toEqual({ updated: 0 });
  });

  it('waits when the lead row is not in the sheet yet', async () => {
    const { h } = await startedLead();
    await say(h, '1');
    await db.query('update leads set sheet_synced_at = now()');
    const g = fakeSheet('some-other-id');
    expect(await syncLeadAnswersToSheet({ db, env, fetchImpl: g.impl })).toEqual({ updated: 0 });
    expect((await db.query('select answers_dirty from leads')).rows[0].answers_dirty).toBe(true);
  });
});
