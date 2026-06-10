import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/tokens
 * 스냅샷이 존재하는 토큰 심볼 목록 (그래프에 그릴 대상).
 * 프론트가 이걸 먼저 받아서 토큰별 /api/topology 를 호출 → 하드코딩 제거.
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

export async function GET() {
  const p = pool();
  if (!p) return NextResponse.json({ tokens: [], dbConnected: false });
  try {
    // active 워치리스트(임계 통과) ∩ 스냅샷 존재 토큰만.
    // 임계 미달로 해제된 토큰은 옛 엣지가 남아도 그래프에서 제외됨.
    const r = await p.query<{ symbol: string }>(
      `SELECT DISTINCT replace(n.node_id, 'token:', '') AS symbol
       FROM watchlist w
       JOIN nodes n ON lower(n.address) = lower(w.token_address) AND n.type = 'Token'
       JOIN edges e ON e.token_node_id = n.node_id
       WHERE w.active = TRUE
       ORDER BY symbol`,
    );
    return NextResponse.json({ tokens: r.rows.map((x) => x.symbol), dbConnected: true });
  } catch (e) {
    return NextResponse.json(
      { tokens: [], dbConnected: true, error: (e as Error).message },
      { status: 500 },
    );
  }
}
