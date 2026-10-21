import type { Db } from './db.ts';
import { PHASE0_TEMPLATES, upsertTemplateDefs } from './templates.ts';

export interface SelfConfig { operatorPhone?: string; phoneNumberId?: string; wabaId?: string; displayNumber?: string }

/** Turnly is business #1 in its own system (dogfood). Idempotent. */
export async function seedSelf(db: Db, cfg: SelfConfig = {
  operatorPhone: process.env.OPERATOR_ALERT_PHONE,
  phoneNumberId: process.env.PHONE_NUMBER_ID,
  wabaId: process.env.WABA_ID,
}): Promise<string> {
  const ops = cfg.operatorPhone ? [cfg.operatorPhone] : [];
  const { rows } = await db.query<{ id: string }>(
    `insert into businesses (name, type, is_self, owner_phone_e164s, plan)
     values ('Turnly', 'other', true, $1, '{"reply":true}')
     on conflict (is_self) where is_self do update set owner_phone_e164s = excluded.owner_phone_e164s
     returning id`,
    [ops],
  );
  const id = rows[0].id;
  if (cfg.phoneNumberId) {
    await db.query(
      `insert into wa_numbers (business_id, phone_number_id, waba_id, display_number)
       values ($1, $2, $3, $4)
       on conflict (phone_number_id) do update set waba_id = excluded.waba_id, status = 'active'`,
      [id, cfg.phoneNumberId, cfg.wabaId ?? '', cfg.displayNumber ?? null],
    );
    // Switching from the mock number to the real one: only the configured number may send.
    await db.query(`update wa_numbers set status = 'inactive' where business_id = $1 and phone_number_id <> $2`, [id, cfg.phoneNumberId]);
  }
  for (const op of ops) {
    // The operator opted in by configuring their own number as the alert recipient.
    await db.query(
      `insert into contacts (business_id, phone_e164, name, opt_in, opt_in_at, opt_in_source, opt_in_text, tags)
       values ($1, $2, 'Operator', true, now(), 'operator_config', 'Operator alert number set in OPERATOR_ALERT_PHONE', '{operator}')
       on conflict (business_id, phone_e164) do nothing`,
      [id, op],
    );
  }
  await upsertTemplateDefs(db, PHASE0_TEMPLATES);
  return id;
}
