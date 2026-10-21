import { beforeEach, describe, expect, it } from 'vitest';
import { createLead, handleAlertOperator } from '@turnly/core';
import { approveAll, db, makeHarness, OPERATOR, resetDb, validLead } from './helpers.ts';
import { leadInput } from '@turnly/core';

beforeEach(async () => { await resetDb(); await approveAll(); });

async function newLead() {
  return createLead(db, leadInput.parse(validLead()));
}

describe('operator alert', () => {
  it('sends a plain text when the operator messaged the number in the last 24h', async () => {
    const h = makeHarness();
    await db.query(`update contacts set last_inbound_at = now() where phone_e164 = $1`, [OPERATOR]);
    const lead = await newLead();
    await handleAlertOperator(h.deps, { leadId: lead.leadId });
    expect(h.wa.sent).toHaveLength(1);
    expect(h.wa.sent[0].to).toBe(OPERATOR);
    expect(h.wa.sent[0].payload).toMatchObject({ kind: 'text' });
    expect((h.wa.sent[0].payload as any).body).toContain('Asha');
  });

  it('falls back to the approved template outside the window', async () => {
    const h = makeHarness();
    const lead = await newLead();
    await handleAlertOperator(h.deps, { leadId: lead.leadId });
    expect(h.wa.sent[0].payload).toMatchObject({ kind: 'template', name: 'turnly_operator_new_lead' });
  });

  it('does not alert twice for the same lead', async () => {
    const h = makeHarness();
    const lead = await newLead();
    await handleAlertOperator(h.deps, { leadId: lead.leadId });
    await handleAlertOperator(h.deps, { leadId: lead.leadId });
    expect(h.wa.sent).toHaveLength(1);
  });
});

import { seedSelf } from '@turnly/core';
describe('switching from the mock number to the real one', () => {
  it('only the configured number stays active', async () => {
    const id = await seedSelf(db, { operatorPhone: OPERATOR, phoneNumberId: 'REAL_PNID', wabaId: 'REAL_WABA' });
    const { rows } = await db.query(`select phone_number_id, status from wa_numbers where business_id = $1 order by phone_number_id`, [id]);
    expect(rows).toEqual([{ phone_number_id: 'REAL_PNID', status: 'active' }, { phone_number_id: 'TEST_PNID', status: 'inactive' }]);
    await seedSelf(db, { operatorPhone: OPERATOR, phoneNumberId: 'TEST_PNID', wabaId: 'W' });
    const again = await db.query(`select phone_number_id, status from wa_numbers where business_id = $1 order by phone_number_id`, [id]);
    expect(again.rows).toEqual([{ phone_number_id: 'REAL_PNID', status: 'inactive' }, { phone_number_id: 'TEST_PNID', status: 'active' }]);
  });
});
