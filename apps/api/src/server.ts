import { createDb, migrate, seedSelf, startBoss, waitForDb } from '@turnly/core';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const db = createDb(config.databaseUrl);
await waitForDb(db);
await migrate(db);
await seedSelf(db);
const { queue, boss } = await startBoss(config.databaseUrl);
const app = await buildApp({ db, queue, config });

const stop = async () => { await app.close(); await boss.stop(); await db.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await app.listen({ port: config.port, host: '0.0.0.0' });

// One-service deploys: RUN_WORKER=1 runs the queue worker inside this process.
if (process.env.RUN_WORKER === '1') await import('../../worker/src/worker.ts');
