import pg from "pg";

import { env } from "@/config/chains";

let _pool: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (_pool) return _pool;
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set");
  }
  _pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool().query<T>(sql, params);
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
