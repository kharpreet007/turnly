import dns from 'node:dns';
import net from 'node:net';
import pg from 'pg';

// Hosted Postgres (Neon) can be asleep for a few seconds. Prefer IPv4 and give each address time to answer.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false); // Railway has no IPv6 route: use the first (IPv4) address only
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

export type Db = pg.Pool;

// Keep timestamptz/numeric parsing predictable.
pg.types.setTypeParser(1700, (v) => Number(v));

export function createDb(connectionString: string): Db {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 20_000 });
}

/** Wait for the database to accept connections (it may be waking up). Throws after about a minute. */
export async function waitForDb(db: Db, attempts = 12, delayMs = 5000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.query('select 1');
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      console.warn(`database not ready (attempt ${i}/${attempts}): ${describeError(e)}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** AggregateError (several failed addresses) has an empty message, so list each cause. */
export function describeError(e: unknown): string {
  const errs = (e as { errors?: unknown[] }).errors;
  const one = (x: unknown) => { const y = x as { code?: string; message?: string; address?: string }; return [y.code, y.address, y.message].filter(Boolean).join(' '); };
  return errs?.length ? errs.map(one).join(' | ') : one(e) || String(e);
}
