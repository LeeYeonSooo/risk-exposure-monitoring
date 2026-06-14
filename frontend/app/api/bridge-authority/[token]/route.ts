import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/bridge-authority/[token]
 * 토큰 컨트랙트에서 온체인으로 읽은 검증된 브릿지 mint 권한(xERC20 한도/MINTER_ROLE/OFT peer/CCIP pool).
 * automation 의 snapshot-bridge-authority 가 적재. 체인별로 그룹.
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

interface Row { token: string; chain: string; bridge_addr: string; auth_type: string; mint_limit: number | null; current_limit_raw: string | null; note: string | null }

// 2026-06-12 스코프 축소: 이더리움·베이스·아비트럼만 서빙 (DB 의 과거 다른 체인 행은 보존하되 숨김).
const ALLOWED_CHAINS = new Set(["ethereum", "base", "arbitrum"]);

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = pool();
  if (!p) return NextResponse.json({ byChain: {}, dbConnected: false });
  try {
    const r = await p.query<Row>(
      `SELECT token, chain, bridge_addr, auth_type, mint_limit, current_limit_raw, note
       FROM bridge_authorities WHERE lower(token) = lower($1) ORDER BY chain, auth_type`,
      [token],
    );
    const byChain: Record<string, { bridgeAddr: string; authType: string; mintLimit: number | null; note: string | null; standard?: string }[]> = {};
    for (const x of r.rows) {
      if (!ALLOWED_CHAINS.has(x.chain)) continue;
      (byChain[x.chain] ??= []).push({ bridgeAddr: x.bridge_addr, authType: x.auth_type, mintLimit: x.mint_limit, note: x.note });
    }
    // (2026-06-12) 비-EVM bridge_detections 병합 제거 — EVM 3체인 스코프. EVM 민트권한(bridge_authorities)만 반환.
    return NextResponse.json({ token, byChain, dbConnected: true });
  } catch (e) {
    return NextResponse.json({ byChain: {}, dbConnected: true, error: (e as Error).message }, { status: 500 });
  }
}
