import { z } from 'zod';
import type { Db } from './db.ts';
import { normalizePhone } from './phone.ts';

export const BUSINESS_TYPES = ['salon', 'clinic', 'gym', 'coaching', 'restaurant', 'retail', 'property', 'other'] as const;

export const leadInput = z.object({
  business_type: z.enum(BUSINESS_TYPES),
  name: z.string().trim().min(1).max(120),
  country_code: z.string().regex(/^\+?\d{1,4}$/),
  phone: z.string().min(5).max(20),
  consent: z.literal(true, { error: 'Consent is required' }),
  consent_text: z.string().trim().min(10).max(1000),
  ad_source: z.string().max(60).optional(),
  wants: z.array(z.string().max(80)).max(10).optional(),
  est_monthly_loss: z.number().nonnegative().optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
  fbclid: z.string().max(300).optional(),
  referrer: z.string().max(500).optional(),
  event_id: z.string().max(100).optional(),
  website: z.string().optional(), // honeypot: real users leave it empty
});
export type LeadInput = z.infer<typeof leadInput>;

export interface LeadMeta { ip?: string; userAgent?: string; now?: Date }

export interface LeadResult { leadId: string; contactId: string; businessId: string; duplicate: boolean; phone: string }

export class LeadRateLimited extends Error {}

/** Max submissions per phone per hour before we stop recording. */
export const PER_PHONE_HOURLY = 5;

export async function createLead(db: Db, input: LeadInput, meta: LeadMeta = {}): Promise<LeadResult> {
  const phone = normalizePhone(input.country_code, input.phone); // throws PhoneError
  const now = meta.now ?? new Date();

  const { rows: [self] } = await db.query<{ id: string }>('select id from businesses where is_self');
  if (!self) throw new Error('Turnly business not seeded; run npm run migrate');

  const { rows: [{ n }] } = await db.query(
    `select coalesce(sum(submissions), 0)::int as n from leads where phone_e164 = $1 and updated_at > $2`,
    [phone, new Date(now.getTime() - 3600_000)],
  );
  if (n >= PER_PHONE_HOURLY) throw new LeadRateLimited();

  // Consent is recorded on the contact: this is what sendMessage checks before any proactive send.
  const { rows: [contact] } = await db.query<{ id: string }>(
    `insert into contacts (business_id, phone_e164, name, opt_in, opt_in_at, opt_in_source, opt_in_text)
     values ($1, $2, $3, true, $4, 'landing_form', $5)
     on conflict (business_id, phone_e164) do update
       set name = excluded.name, opt_in = true, opt_in_at = excluded.opt_in_at,
           opt_in_source = 'landing_form', opt_in_text = excluded.opt_in_text
     returning id`,
    [self.id, phone, input.name, now, input.consent_text],
  );

  const { rows: [existing] } = await db.query<{ id: string }>(
    `select id from leads where business_id = $1 and phone_e164 = $2 and created_at > $3
      order by created_at desc limit 1`,
    [self.id, phone, new Date(now.getTime() - 24 * 3600_000)],
  );

  if (existing) {
    await db.query(
      `update leads set name = $2, business_type = $3, wants = $4, est_monthly_loss = $5,
              submissions = submissions + 1, updated_at = $6 where id = $1`,
      [existing.id, input.name, input.business_type, JSON.stringify(input.wants ?? null), input.est_monthly_loss ?? null, now],
    );
    return { leadId: existing.id, contactId: contact.id, businessId: self.id, duplicate: true, phone };
  }

  const { rows: [lead] } = await db.query<{ id: string }>(
    `insert into leads (business_id, contact_id, phone_e164, name, business_type, ad_source, wants, est_monthly_loss,
                        utm, fbclid, referrer, user_agent, ip, event_id, consent_text, consent_at, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$16) returning id`,
    [self.id, contact.id, phone, input.name, input.business_type, input.ad_source ?? null,
      JSON.stringify(input.wants ?? null), input.est_monthly_loss ?? null, JSON.stringify(input.utm ?? {}),
      input.fbclid ?? null, input.referrer ?? null, meta.userAgent ?? null, meta.ip ?? null,
      input.event_id ?? null, input.consent_text, now],
  );
  await db.query(`insert into events (business_id, name, props) values ($1, 'lead_created', $2)`,
    [self.id, JSON.stringify({ leadId: lead.id, business_type: input.business_type, ad_source: input.ad_source ?? null })]);
  return { leadId: lead.id, contactId: contact.id, businessId: self.id, duplicate: false, phone };
}

export async function listLeads(db: Db, opts: { status?: string; limit?: number } = {}) {
  const { rows } = await db.query(
    `select l.id, l.name, l.phone_e164, l.business_type, l.ad_source, l.status, l.created_at, l.submissions,
            c.opt_in, c.opted_out_at, l.flow_status, l.answers,
            (select status from messages m where m.contact_id = l.contact_id and m.direction = 'out'
              order by m.created_at limit 1) as welcome_status
       from leads l join contacts c on c.id = l.contact_id
      where ($1::text is null or l.status = $1)
      order by l.created_at desc limit $2`,
    [opts.status ?? null, opts.limit ?? 100],
  );
  return rows;
}
