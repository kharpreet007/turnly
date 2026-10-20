// npm run templates -- submit | sync | status <name> <approved|pending|rejected>
import { createDb, PHASE0_TEMPLATES, setTemplateStatus, submitTemplate, syncTemplateStatuses, upsertTemplateDefs } from '@turnly/core';

const [cmd, name, status] = process.argv.slice(2);
const db = createDb(process.env.DATABASE_URL!);
const waba = process.env.WABA_ID!;
const token = process.env.META_SYSTEM_USER_TOKEN!;

if (cmd === 'submit') {
  await upsertTemplateDefs(db, PHASE0_TEMPLATES);
  for (const t of PHASE0_TEMPLATES) {
    const r = await submitTemplate(waba, token, t);
    await setTemplateStatus(db, t.name, 'pending', r.id);
    console.log('submitted', t.name, r.status);
  }
} else if (cmd === 'sync') {
  await syncTemplateStatuses(db, waba, token);
  console.log('synced');
} else if (cmd === 'status') {
  // Manual override, for the Meta test number where sample templates are pre-approved.
  await setTemplateStatus(db, name, status as any);
  console.log(name, '->', status);
} else {
  console.error('usage: templates submit | sync | status <name> <approved|pending|rejected>');
}
await db.end();
