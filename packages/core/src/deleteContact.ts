import type { Db } from './db.ts';

export interface ContactFootprint { found: boolean; contacts: number; leads: number; messages: number; conversations: number }

/** Everything we hold for one phone number in one business (counts only). */
export async function contactFootprint(db: Db, businessId: string, phone: string): Promise<ContactFootprint> {
  const { rows: [r] } = await db.query(
    `select (select count(*)::int from contacts where business_id = $1 and phone_e164 = $2) as contacts,
            (select count(*)::int from leads where business_id = $1 and phone_e164 = $2) as leads,
            (select count(*)::int from messages m join contacts c on c.id = m.contact_id where c.business_id = $1 and c.phone_e164 = $2) as messages,
            (select count(*)::int from conversations v join contacts c on c.id = v.contact_id where c.business_id = $1 and c.phone_e164 = $2) as conversations`,
    [businessId, phone]);
  return { ...r, found: r.contacts + r.leads > 0 };
}

export class ProtectedNumberError extends Error {}

/**
 * Permanently deletes a person's data (leads, messages, conversations, contact). Used for privacy requests
 * and for clearing test data. Refuses the business's own owner/operator numbers.
 */
export async function deleteContact(db: Db, businessId: string, phone: string): Promise<ContactFootprint> {
  const { rows: [b] } = await db.query<{ owner_phone_e164s: string[] }>('select owner_phone_e164s from businesses where id = $1', [businessId]);
  if (b?.owner_phone_e164s.includes(phone)) throw new ProtectedNumberError('This is an owner/operator number, so it is protected.');
  const before = await contactFootprint(db, businessId, phone);
  const client = await db.connect();
  try {
    await client.query('begin');
    const ids = `(select id from contacts where business_id = $1 and phone_e164 = $2)`;
    await client.query(`delete from messages where contact_id in ${ids}`, [businessId, phone]);
    await client.query(`delete from conversations where contact_id in ${ids}`, [businessId, phone]);
    await client.query(`delete from leads where contact_id in ${ids}`, [businessId, phone]);
    await client.query(`delete from leads where business_id = $1 and phone_e164 = $2`, [businessId, phone]);
    await client.query(`delete from contacts where business_id = $1 and phone_e164 = $2`, [businessId, phone]);
    await client.query(
      `insert into audit_log (business_id, actor, action, detail) values ($1, 'operator', 'delete_contact', $2)`,
      [businessId, JSON.stringify({ phone_tail: phone.slice(-4), ...before })]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  return before;
}

export interface ResetResult { leads: number; contacts: number; messages: number }

/**
 * Clears all lead data for a fresh start: every lead, and every contact with their messages and conversations.
 * The owner/operator contacts stay (their opt-in and number are needed for alerts); only their leads go.
 */
export async function resetAllLeads(db: Db, businessId: string): Promise<ResetResult> {
  const { rows: [b] } = await db.query<{ owner_phone_e164s: string[] }>('select owner_phone_e164s from businesses where id = $1', [businessId]);
  const keep = b?.owner_phone_e164s ?? [];
  const client = await db.connect();
  try {
    await client.query('begin');
    const others = `(select id from contacts where business_id = $1 and not (phone_e164 = any($2::text[])))`;
    const m = await client.query(`delete from messages where contact_id in ${others}`, [businessId, keep]);
    await client.query(`delete from conversations where contact_id in ${others}`, [businessId, keep]);
    const l = await client.query(`delete from leads where business_id = $1`, [businessId]);
    const c = await client.query(`delete from contacts where business_id = $1 and not (phone_e164 = any($2::text[]))`, [businessId, keep]);
    const res = { leads: l.rowCount ?? 0, contacts: c.rowCount ?? 0, messages: m.rowCount ?? 0 };
    await client.query(`insert into audit_log (business_id, actor, action, detail) values ($1, 'operator', 'reset_leads', $2)`, [businessId, JSON.stringify(res)]);
    await client.query('commit');
    return res;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
