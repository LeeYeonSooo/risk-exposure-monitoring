import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/wallets
 * 추적 지갑(tracked_wallets) + 각 지갑의 최신 스냅샷(총가치) + 직전 대비 변화율.
 * DeBank 스크레이프(가능시) / 온체인-매핑(폴백) 가치. automation 의 snapshot-wallets 가 적재.
 */
export const dynamic = "force-dynamic";

const DATABASE_URL = process.env.DATABASE_URL;
let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  return _pool;
}

interface Row {
  wallet: string; label: string | null; kind: string | null; active: boolean;
  total_usd: string | null; protocol_count: number | null; source: string | null;
  snapshot_ts: string | null; prev_usd: string | null;
}

export async function GET() {
  const p = pool();
  if (!p) return NextResponse.json({ wallets: [], dbConnected: false });
  try {
    // 각 지갑의 최신 스냅샷 + 직전 스냅샷(변화율 계산용)
    const r = await p.query<Row>(`
      WITH ranked AS (
        SELECT wallet, total_usd, protocol_count, source, snapshot_ts,
               row_number() OVER (PARTITION BY wallet ORDER BY snapshot_ts DESC) AS rn
        FROM wallet_snapshots
      )
      SELECT tw.wallet, tw.label, tw.kind, tw.active,
             cur.total_usd, cur.protocol_count, cur.source, cur.snapshot_ts,
             prev.total_usd AS prev_usd
      FROM tracked_wallets tw
      LEFT JOIN ranked cur  ON cur.wallet = tw.wallet AND cur.rn = 1
      LEFT JOIN ranked prev ON prev.wallet = tw.wallet AND prev.rn = 2
      WHERE tw.active = true
      ORDER BY cur.total_usd DESC NULLS LAST, tw.added_at
    `);
    const wallets = r.rows.map((x) => {
      const total = x.total_usd != null ? Number(x.total_usd) : null;
      const prev = x.prev_usd != null ? Number(x.prev_usd) : null;
      const dropPct = total != null && prev != null && prev > 0 ? (prev - total) / prev : null;
      return {
        wallet: x.wallet, label: x.label, kind: x.kind, active: x.active,
        totalUsd: total, protocolCount: x.protocol_count, source: x.source,
        snapshotTs: x.snapshot_ts, prevUsd: prev, dropPct,
      };
    });
    return NextResponse.json({ wallets, dbConnected: true });
  } catch (e) {
    return NextResponse.json({ wallets: [], dbConnected: true, error: (e as Error).message }, { status: 500 });
  }
}
