import { beforeEach, describe, expect, it } from 'vitest';
import { createLead, emailConfig, emailNewLeads, leadInput, maskEmail, sendEmail } from '@turnly/core';
import { db, resetDb, validLead } from './helpers.ts';

const env = { RESEND_API_KEY: 're_test', ALERT_EMAIL: 'owner@example.com, second@example.com' };

function fakeResend(status = 200) {
  const calls: { url: string; init: any; body: any }[] = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(status === 200 ? { id: 'e1' } : { message: 'API key is invalid' }), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(async () => { await resetDb(); });

describe('email alerts', () => {
  it('reads settings, with a default sender', () => {
    expect(emailConfig({})).toBeNull();
    expect(emailConfig({ RESEND_API_KEY: 'k' })).toBeNull();
    const c = emailConfig(env)!;
    expect(c.to).toEqual(['owner@example.com', 'second@example.com']);
    expect(c.from).toBe('Turnly <onboarding@resend.dev>');
    expect(maskEmail('owner@example.com')).toBe('o•••@example.com');
  });

  it('posts to Resend with the key', async () => {
    const r = fakeResend();
    await sendEmail(emailConfig(env)!, { subject: 'S', text: 'T' }, r.impl);
    expect(r.calls[0].url).toBe('https://api.resend.com/emails');
    expect(r.calls[0].init.headers.authorization).toBe('Bearer re_test');
    expect(r.calls[0].body).toMatchObject({ to: ['owner@example.com', 'second@example.com'], subject: 'S', text: 'T' });
  });

  it('emails each new lead once, with a link to message them', async () => {
    await createLead(db, leadInput.parse(validLead({ wants: ['Reply ₹3,999'] })));
    const r = fakeResend();
    expect(await emailNewLeads({ db, env, fetchImpl: r.impl })).toEqual({ sent: 1 });
    expect(r.calls[0].body.subject).toBe('New Turnly lead: Asha (salon)');
    expect(r.calls[0].body.text).toContain('WhatsApp: +919876543210');
    expect(r.calls[0].body.text).toContain('https://wa.me/919876543210?text=');
    expect(r.calls[0].body.text).toContain('Plans: Reply ₹3,999');
    expect(await emailNewLeads({ db, env, fetchImpl: r.impl })).toEqual({ sent: 0 });
    expect(r.calls).toHaveLength(1);
  });

  it('does nothing without settings, and keeps the lead for a retry when Resend refuses', async () => {
    await createLead(db, leadInput.parse(validLead()));
    expect(await emailNewLeads({ db, env: {} })).toEqual({ sent: 0 });
    const bad = await emailNewLeads({ db, env, fetchImpl: fakeResend(403).impl });
    expect(bad.sent).toBe(0);
    expect(bad.error).toContain('API key is invalid');
    expect((await db.query('select email_sent_at from leads')).rows[0].email_sent_at).toBeNull();
    expect(await emailNewLeads({ db, env, fetchImpl: fakeResend().impl })).toEqual({ sent: 1 });
  });
});
