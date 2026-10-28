import { beforeEach, describe, expect, it } from 'vitest';
import { createLead, leadInput, notifyBookedCalls, syncCalendlyBookings } from '@turnly/core';
import { db, resetDb, validLead } from './helpers.ts';

const env = { CALENDLY_TOKEN: 'cal_test', CALENDLY_URL: 'https://calendly.com/kharpreet007/15min', RESEND_API_KEY: 're_x', ALERT_EMAIL: 'owner@example.com' };
const EV = 'https://api.calendly.com/scheduled_events/AAA';

interface Booking { start?: string; status?: string; utm?: string; answer?: string; tz?: string; created?: string }
function fakeCalendly(b: Booking | null) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const ok = (o: object) => new Response(JSON.stringify(o), { status: 200 });
    if (url.endsWith('/users/me')) return ok({ resource: { uri: 'https://api.calendly.com/users/U1' } });
    if (url.includes('/scheduled_events/AAA/invitees')) {
      return ok({ collection: [{ name: 'Harpreet K', email: 'h@example.com', timezone: b?.tz ?? 'America/Toronto', created_at: b?.created ?? '2026-11-01T10:00:00Z',
        tracking: b?.utm ? { utm_content: b.utm, utm_source: 'turnly' } : {}, questions_and_answers: b?.answer ? [{ question: 'WhatsApp number', answer: b.answer }] : [] }] });
    }
    if (url.includes('/scheduled_events?')) {
      return ok({ collection: b ? [{ uri: EV, start_time: b.start ?? '2026-11-04T20:00:00Z', status: b.status ?? 'active' }] : [], pagination: { next_page: null } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
function fakeResend() {
  const mails: any[] = [];
  const impl = (async (_u: string, init: any) => { mails.push(JSON.parse(init.body)); return new Response('{"id":"e"}', { status: 200 }); }) as unknown as typeof fetch;
  return { impl, mails };
}
const newLead = () => createLead(db, leadInput.parse(validLead({ name: 'Harpreet K', country_code: '+1', phone: '2265069968' })));
const lead = async () => (await db.query('select call_status, call_start_at, call_tz, call_email, answers_dirty from leads')).rows[0];

beforeEach(async () => { await resetDb(); });

describe('Calendly bookings', () => {
  it('does nothing without a token', async () => {
    expect(await syncCalendlyBookings({ db, env: {} })).toEqual({ configured: false, events: 0, matched: 0 });
  });

  it('matches a booking to the lead by the id on the link', async () => {
    const l = await newLead();
    const c = fakeCalendly({ utm: l.leadId });
    expect(await syncCalendlyBookings({ db, env, fetchImpl: c.impl })).toEqual({ configured: true, events: 1, matched: 1 });
    const row = await lead();
    expect(row.call_status).toBe('booked');
    expect(new Date(row.call_start_at).toISOString()).toBe('2026-11-04T20:00:00.000Z');
    expect(row.call_tz).toBe('America/Toronto');
    expect(row.call_email).toBe('h@example.com');
    expect(row.answers_dirty).toBe(true); // so the sheet row is updated
  });

  it('falls back to the WhatsApp number typed in Calendly', async () => {
    await newLead();
    const c = fakeCalendly({ answer: '(226) 506-9968' });
    expect((await syncCalendlyBookings({ db, env, fetchImpl: c.impl })).matched).toBe(1);
    expect((await lead()).call_status).toBe('booked');
  });

  it('ignores a booking that belongs to no lead', async () => {
    await newLead();
    const c = fakeCalendly({ answer: '+44 7700 900123' });
    expect((await syncCalendlyBookings({ db, env, fetchImpl: c.impl })).matched).toBe(0);
    expect((await lead()).call_status).toBe('none');
  });

  it('does not re-read an unchanged booking', async () => {
    const l = await newLead();
    const c = fakeCalendly({ utm: l.leadId });
    await syncCalendlyBookings({ db, env, fetchImpl: c.impl });
    const before = c.calls.length;
    await syncCalendlyBookings({ db, env, fetchImpl: c.impl });
    expect(c.calls.slice(before).filter((u) => u.includes('invitees'))).toHaveLength(0);
  });

  it('follows a reschedule and a cancellation', async () => {
    const l = await newLead();
    await syncCalendlyBookings({ db, env, fetchImpl: fakeCalendly({ utm: l.leadId }).impl });
    await syncCalendlyBookings({ db, env, fetchImpl: fakeCalendly({ utm: l.leadId, start: '2026-11-05T15:00:00Z' }).impl });
    expect(new Date((await lead()).call_start_at).toISOString()).toBe('2026-11-05T15:00:00.000Z');
    await syncCalendlyBookings({ db, env, fetchImpl: fakeCalendly({ utm: l.leadId, start: '2026-11-05T15:00:00Z', status: 'canceled' }).impl });
    expect((await lead()).call_status).toBe('canceled');
  });

  it('reports a Calendly error in words', async () => {
    const bad = (async () => new Response(JSON.stringify({ title: 'Unauthenticated', message: 'The access token is invalid' }), { status: 401 })) as unknown as typeof fetch;
    const r = await syncCalendlyBookings({ db, env: { CALENDLY_TOKEN: 'other_token' }, fetchImpl: bad });
    expect(r.error).toBe('Calendly 401: The access token is invalid');
  });
});

describe('call emails', () => {
  it('emails once when booked, with the confirm message typed for WhatsApp', async () => {
    const l = await newLead();
    await syncCalendlyBookings({ db, env, fetchImpl: fakeCalendly({ utm: l.leadId }).impl });
    const r = fakeResend();
    expect(await notifyBookedCalls({ db, env, fetchImpl: r.impl })).toBe(1);
    expect(r.mails[0].subject).toMatch(/^Call booked: Harpreet K, /);
    expect(r.mails[0].text).toContain('https://wa.me/12265069968?text=');
    expect(decodeURIComponent(r.mails[0].text.match(/\?text=(\S+)/)![1])).toContain('we have got your set-up request for');
    expect(await notifyBookedCalls({ db, env, fetchImpl: r.impl })).toBe(0);
    expect(r.mails).toHaveLength(1);
  });

  it('emails again for a reschedule and for a cancellation', async () => {
    const l = await newLead();
    const r = fakeResend();
    await syncCalendlyBookings({ db, env, fetchImpl: fakeCalendly({ utm: l.leadId }).impl });
    await notifyBookedCalls({ db, env, fetchImpl: r.impl });
    await syncCalendlyBookings({ db, env, fetchImpl: fakeCalendly({ utm: l.leadId, start: '2026-11-05T15:00:00Z' }).impl });
    await notifyBookedCalls({ db, env, fetchImpl: r.impl });
    await syncCalendlyBookings({ db, env, fetchImpl: fakeCalendly({ utm: l.leadId, start: '2026-11-05T15:00:00Z', status: 'canceled' }).impl });
    await notifyBookedCalls({ db, env, fetchImpl: r.impl });
    expect(r.mails.map((m) => m.subject.split(':')[0])).toEqual(['Call booked', 'Call rescheduled', 'Call canceled']);
  });

  it('a failed email is retried, not lost', async () => {
    const l = await newLead();
    await syncCalendlyBookings({ db, env, fetchImpl: fakeCalendly({ utm: l.leadId }).impl });
    const bad = (async () => new Response('{"message":"nope"}', { status: 500 })) as unknown as typeof fetch;
    expect(await notifyBookedCalls({ db, env, fetchImpl: bad })).toBe(0);
    expect(await notifyBookedCalls({ db, env, fetchImpl: fakeResend().impl })).toBe(1);
  });
});
