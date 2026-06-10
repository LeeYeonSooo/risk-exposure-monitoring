import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/health — DB 연결 + 데이터 신선도(마지막 스냅샷 시각·토큰 수).
 * 헤더의 "라이브 · N분 전" 배지가 소비 → 데이터가 stale/폴백인지 한눈에 (cron 꺼짐 감지).
 */
export const dynamic = "force-dynamic";

const DATABASE_URL = process.env.DATABASE_URL;
let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (!_pool) _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  return _pool;
}

export async function GET() {
  const p = pool();
  if (!p) return NextResponse.json({ dbConnected: false });
  try {
    const r = await p.query<{ last_run: string | null; last_sample: string | null; tokens: string }>(
      `SELECT (SELECT max(started_at) FROM snapshot_runs)      AS last_run,
              (SELECT max(snapshot_ts) FROM supply_samples)    AS last_sample,
              (SELECT count(*) FROM nodes WHERE type='Token')  AS tokens`,
    );
    const row = r.rows[0];
    return NextResponse.json({
      dbConnected: true,
      lastSnapshot: row.last_run ?? row.last_sample ?? null,
      tokenCount: Number(row.tokens ?? 0),
    });
  } catch (e) {
    return NextResponse.json({ dbConnected: true, error: (e as Error).message }, { status: 500 });
  }
}
