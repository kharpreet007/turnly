import { PgBoss } from 'pg-boss';
import { JOB_NAMES, type Queue } from './queue.ts';

/** Postgres-backed queue (pg-boss). Retries: 3 with exponential backoff. */
export async function startBoss(connectionString: string, opts: { supervise?: boolean } = {}) {
  const boss = new PgBoss({ connectionString, supervise: opts.supervise ?? false });
  boss.on('error', (e) => console.error('[pg-boss]', e));
  await boss.start();
  for (const name of JOB_NAMES) {
    await boss.createQueue(name, { retryLimit: 3, retryDelay: 2, retryBackoff: true });
  }
  const queue: Queue = {
    async send(name, data, o) {
      await boss.send(name, data, o?.singletonKey ? { singletonKey: o.singletonKey } : {});
    },
  };
  return { boss, queue };
}
