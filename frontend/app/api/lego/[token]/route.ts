import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/lego/[token] — 머니레고 구조 서브그래프 (snapshot-lego 가 적재한 lego_nodes/lego_edges).
 * 파생토큰(PT/YT/LP/aToken) 노드 + 구조 엣지(issues/lp_of/collateral_at/staked_in) +
 * 참조된 프로토콜 허브 노드를 돌려준다. 데이터 없으면 빈 배열 (프론트는 레이어를 안 그림).
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

export interface LegoNodeRow {
  id: string; chain: string; address: string | null; kind: string; role: string | null;
  label: string; symbol: string | null; protocol: string | null; parent_token: string | null;
  meta: Record<string, unknown>;
}
export interface LegoEdgeRow {
  src: string; dst: string; relation: string; chain: string;
  weight_usd: number | null; evidence: Record<string, unknown>;
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = pool();
  if (!p) return NextResponse.json({ nodes: [], edges: [], dbConnected: false });
  try {
    const derivR = await p.query<LegoNodeRow>(
      `SELECT id, chain, address, kind, role, label, symbol, protocol, parent_token, meta
       FROM lego_nodes
       WHERE LOWER(parent_token) = LOWER($1) OR LOWER(parent_token) LIKE LOWER($1) || '@%'`,
      [`token:${decodeURIComponent(token)}`],
    );
    const ids = derivR.rows.map((n) => n.id);
    const parents = [...new Set(derivR.rows.map((n) => n.parent_token).filter(Boolean))] as string[];
    if (!ids.length) return NextResponse.json({ nodes: [], edges: [], dbConnected: true });

    const edgesR = await p.query<LegoEdgeRow>(
      `SELECT src, dst, relation, chain, weight_usd, evidence FROM lego_edges
       WHERE src = ANY($1::text[]) OR dst = ANY($1::text[]) OR src = ANY($2::text[])`,
      [ids, parents],
    );
    // 엣지가 가리키는데 초기 쿼리(parent_token)에 안 잡힌 노드 보강(공유 프로토콜·마켓 등)
    const have = new Set(derivR.rows.map((n) => n.id));
    const refIds = new Set<string>();
    for (const e of edgesR.rows) { if (!have.has(e.src)) refIds.add(e.src); if (!have.has(e.dst)) refIds.add(e.dst); }
    const extraR = refIds.size
      ? await p.query<LegoNodeRow>(
          `SELECT id, chain, address, kind, role, label, symbol, protocol, parent_token, meta
           FROM lego_nodes WHERE id = ANY($1::text[])`,
          [[...refIds]],
        )
      : { rows: [] as LegoNodeRow[] };

    return NextResponse.json({ nodes: [...derivR.rows, ...extraR.rows], edges: edgesR.rows, dbConnected: true });
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "42P01" || /relation "lego_(nodes|edges)" does not exist/.test(err.message)) {
      return NextResponse.json({ nodes: [], edges: [], dbConnected: true, missingTables: true });
    }
    return NextResponse.json({ nodes: [], edges: [], dbConnected: true, error: err.message }, { status: 500 });
  }
}
