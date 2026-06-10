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
      (byChain[x.chain] ??= []).push({ bridgeAddr: x.bridge_addr, authType: x.auth_type, mintLimit: x.mint_limit, note: x.note });
    }
    // 비-EVM 표준 브릿지(bridge_detections, 파이썬 8계열 탐지기) 병합 — 표준명 → authType 슬러그
    try {
      const d = await p.query<{ chain: string; standard: string; bridge_address: string; note: string | null }>(
        `SELECT chain, standard, bridge_address, note FROM bridge_detections WHERE lower(token) = lower($1) ORDER BY chain, standard`,
        [token],
      );
      const slugOf = (s: string) =>
        /cctp/i.test(s) ? "cctp" : /wormhole/i.test(s) ? "wormhole" : /ibc/i.test(s) ? "ibc"
        : /starkgate/i.test(s) ? "starkgate" : /sui bridge/i.test(s) ? "sui_bridge"
        : /layerzero|oft/i.test(s) ? "layerzero" : s.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
      for (const x of d.rows) {
        (byChain[x.chain] ??= []).push({ bridgeAddr: x.bridge_address, authType: slugOf(x.standard), mintLimit: null, note: x.note, standard: x.standard });
      }
    } catch { /* 테이블 미생성 시 EVM 권한만 반환 */ }
    return NextResponse.json({ token, byChain, dbConnected: true });
  } catch (e) {
    return NextResponse.json({ byChain: {}, dbConnected: true, error: (e as Error).message }, { status: 500 });
  }
}
