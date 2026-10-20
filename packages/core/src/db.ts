import pg from 'pg';

export type Db = pg.Pool;

// Keep timestamptz/numeric parsing predictable.
pg.types.setTypeParser(1700, (v) => Number(v));

export function createDb(connectionString: string): Db {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new pg.Pool({ connectionString, max: 10 });
}
