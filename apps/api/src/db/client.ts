import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';

export type Db = NodePgDatabase<Record<string, never>>;
export type Tx = PgTransaction<NodePgQueryResultHKT, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, max = 10): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  // timestamptz -> Date is the default; keep bigints as strings (default) and numeric as strings.
  const db = drizzle(pool);
  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}
