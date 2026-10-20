import { createDb } from './db.ts';
import { migrate } from './migrate.ts';
import { seedSelf } from './seed.ts';

const db = createDb(process.env.DATABASE_URL!);
console.log('applied:', await migrate(db));
await seedSelf(db);
await db.end();
