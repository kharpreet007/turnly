import { beforeEach, describe, expect, it } from 'vitest';
import { sendMessage, WaSendError } from '@turnly/core';
import { approveAll, db, makeHarness, resetDb } from './helpers.ts';

let businessId: string;
beforeEach(async () => { businessId = await resetDb(); await approveAll(); });

async function contact(over: Partial<{ opt_in: boolean; opted_out_at: Date | null; last_inbound_at: Date | null; blocked: boolean }> = {}) {
  const o = { opt_in: false, opted_out_at: null, last_inbound_at: null, blocked: false, ...over };
  const { rows: [c] } = await db.query(
    `insert into contacts (business_id, phone_e164, opt_in, opted_out_at, last_inbound_at, blocked)
     values ($1, '+919811111111', $2, $3, $4, $5) returning id`,
    [businessId, o.opt_in, o.opted_out_at, o.last_inbound_at, o.blocked]);
  return c.id as string;
}
const welcome = { kind: 'template', name: 'turnly_demo_welcome', language: 'en', variables: ['Asha', 'salon'] } as const;

describe('sendMessage rules', () => {
  it('refuses a proactive template without opt-in', async () => {
    const h = makeHarness();
    const r = await sendMessage(h.deps, { businessId, contactId: await contact(), purpose: 'proactive', payload: welcome, dedupeKey: 'a' });
    expect(r).toMatchObject({ ok: false, reason: 'no_consent' });
    expect(h.wa.sent).toHaveLength(0);
  });

  it('sends an approved template to an opted-in contact and renders the body', async () => {
    const h = makeHarness();
    const r = await sendMessage(h.deps, { businessId, contactId: await contact({ opt_in: true }), purpose: 'proactive', payload: welcome, dedupeKey: 'a' });
    expect(r.ok).toBe(true);
    const { rows: [m] } = await db.query(`select body, status from messages`);
    expect(m.status).toBe('sent');
    expect(m.body).toContain('Hi Asha');
  });

  it('blocks unapproved templates', async () => {
    await db.query(`update templates set status = 'pending'`);
    const h = makeHarness();
    const r = await sendMessage(h.deps, { businessId, contactId: await contact({ opt_in: true }), purpose: 'proactive', payload: welcome, dedupeKey: 'a' });
    expect(r).toMatchObject({ ok: false, reason: 'template_not_approved' });
  });

  it('allows free-form only inside the 24h window', async () => {
    const h = makeHarness();
    const text = { kind: 'text', body: 'hello' } as const;
    const stale = await contact({ opt_in: true, last_inbound_at: new Date(Date.now() - 25 * 3600_000) });
    expect(await sendMessage(h.deps, { businessId, contactId: stale, purpose: 'reply', payload: text, dedupeKey: 'x' }))
      .toMatchObject({ ok: false, reason: 'outside_window' });
    await db.query(`update contacts set last_inbound_at = now() where id = $1`, [stale]);
    expect((await sendMessage(h.deps, { businessId, contactId: stale, purpose: 'reply', payload: text, dedupeKey: 'y' })).ok).toBe(true);
  });

  it('never sends proactive messages to an opted-out contact, but allows the one confirmation', async () => {
    const h = makeHarness();
    const c = await contact({ opt_in: false, opted_out_at: new Date(), last_inbound_at: new Date() });
    expect(await sendMessage(h.deps, { businessId, contactId: c, purpose: 'proactive', payload: welcome, dedupeKey: 'a' }))
      .toMatchObject({ ok: false, reason: 'opted_out' });
    expect(await sendMessage(h.deps, { businessId, contactId: c, purpose: 'reply', payload: { kind: 'text', body: 'hi' }, dedupeKey: 'b' }))
      .toMatchObject({ ok: false, reason: 'opted_out' });
    expect((await sendMessage(h.deps, { businessId, contactId: c, purpose: 'optout_confirmation', payload: { kind: 'text', body: 'bye' }, dedupeKey: 'c' })).ok).toBe(true);
  });

  it('refuses blocked contacts', async () => {
    const h = makeHarness();
    const c = await contact({ opt_in: true, blocked: true });
    expect(await sendMessage(h.deps, { businessId, contactId: c, purpose: 'proactive', payload: welcome, dedupeKey: 'a' }))
      .toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('dedupes on the logical send key', async () => {
    const h = makeHarness();
    const c = await contact({ opt_in: true });
    const req = { businessId, contactId: c, purpose: 'proactive', payload: welcome, dedupeKey: 'same' } as const;
    expect((await sendMessage(h.deps, req)).ok).toBe(true);
    expect(await sendMessage(h.deps, req)).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(h.wa.sent).toHaveLength(1);
  });

  it('retries transient failures up to 3 attempts, then records a permanent failure', async () => {
    const h = makeHarness();
    const c = await contact({ opt_in: true });
    const req = { businessId, contactId: c, purpose: 'proactive', payload: welcome, dedupeKey: 'r' } as const;
    h.wa.failNextWith(new WaSendError('boom', true));
    await expect(sendMessage(h.deps, req)).rejects.toThrow('boom');
    h.wa.failNextWith(new WaSendError('boom', true));
    await expect(sendMessage(h.deps, req)).rejects.toThrow('boom');
    h.wa.failNextWith(new WaSendError('boom', true));
    expect(await sendMessage(h.deps, req)).toMatchObject({ ok: false, reason: 'send_failed' });
    const { rows: [m] } = await db.query(`select status, error, attempts from messages`);
    expect(m).toMatchObject({ status: 'failed', error: 'boom', attempts: 3 });
  });

  it('a retry after a transient failure sends once', async () => {
    const h = makeHarness();
    const c = await contact({ opt_in: true });
    const req = { businessId, contactId: c, purpose: 'proactive', payload: welcome, dedupeKey: 'r2' } as const;
    h.wa.failNextWith(new WaSendError('flaky', true));
    await expect(sendMessage(h.deps, req)).rejects.toThrow();
    expect((await sendMessage(h.deps, req)).ok).toBe(true);
    expect(h.wa.sent).toHaveLength(1);
  });

  it('throttles per business', async () => {
    const h = makeHarness();
    await db.query(`update businesses set send_per_minute = 1 where id = $1`, [businessId]);
    const c = await contact({ opt_in: true });
    expect((await sendMessage(h.deps, { businessId, contactId: c, purpose: 'proactive', payload: welcome, dedupeKey: '1' })).ok).toBe(true);
    expect(await sendMessage(h.deps, { businessId, contactId: c, purpose: 'proactive', payload: welcome, dedupeKey: '2' }))
      .toMatchObject({ ok: false, reason: 'throttled' });
  });

  it('does not touch another business\'s contacts', async () => {
    const h = makeHarness();
    const c = await contact({ opt_in: true });
    const { rows: [other] } = await db.query(`insert into businesses (name) values ('Other') returning id`);
    expect(await sendMessage(h.deps, { businessId: other.id, contactId: c, purpose: 'proactive', payload: welcome, dedupeKey: 'z' }))
      .toMatchObject({ ok: false, reason: 'contact_not_found' });
  });
});
