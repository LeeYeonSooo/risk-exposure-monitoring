import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/topology/[token]
 *
 * Returns the latest snapshot topology for a given token symbol (e.g. "WBTC").
 * Source: automation pipeline's Postgres DB.
 *
 * No static fallback: responds 503 if DATABASE_URL is unset, 404 if no snapshot
 * exists yet for the token. The client renders an explicit "no live data" state.
 */

const DATABASE_URL = process.env.DATABASE_URL;
let _pool: pg.Pool | null = null;

function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  return _pool;
}

interface NodeRow {
  id: string;
  type: string;
  label: string;
  address: string;
  chain: string;
  metadata: unknown;
}
interface EdgeRow {
  source: string;
  target: string;
  edge_type: string;
  weight: number;
  attrs: unknown;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  // 노드 ID 는 심볼 대소문자를 보존한다 (token:wstETH, token:cbBTC, token:sUSDe …).
  // 절대 uppercase 하지 말 것 — 과거 toUpperCase() 가 mixed-case 심볼 전부를
  // token:WSTETH 로 조회해 404 → wstETH/stETH/weETH/sUSDe 등이 그래프에서 통째로 누락됐음.
  // 입력 케이스 무관하게 대소문자 무시로 매칭하고, 실제 저장된 node_id 를 사용.
  const tokenNodeIdLc = `token:${token}`.toLowerCase();

  const p = pool();
  if (!p) {
    // No DB configured → no data (no static fallback). Client shows empty state.
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 503 },
    );
  }

  try {
    // 심볼의 모든 체인 토큰노드(token:wstETH, token:wstETH@base, …) 를 각자 최신 스냅샷으로 union
    // → 전체 그래프(/api/graph) 통째로가 아니라 이 토큰의 멀티체인 정밀 서브그래프만 온디맨드.
    const edgesR = await p.query<EdgeRow>(
      `WITH toks AS (
         SELECT token_node_id, MAX(snapshot_ts) AS ts FROM edges
         WHERE LOWER(token_node_id) = $1 OR LOWER(token_node_id) LIKE $1 || '@%'
         GROUP BY token_node_id
       )
       SELECT e.token_node_id AS source, e.protocol_node_id AS target, e.edge_type, e.weight, e.attrs
       FROM edges e JOIN toks t ON e.token_node_id = t.token_node_id AND e.snapshot_ts = t.ts`,
      [tokenNodeIdLc],
    );
    if (edgesR.rows.length === 0) {
      return NextResponse.json({ error: `No snapshots yet for ${token}` }, { status: 404 });
    }

    const involved = new Set<string>();
    edgesR.rows.forEach((e) => {
      involved.add(e.source);
      involved.add(e.target);
    });

    const nodesR = await p.query<NodeRow>(
      `SELECT node_id AS id, type, label, metadata, address, chain
       FROM nodes WHERE node_id = ANY($1::text[])`,
      [Array.from(involved)],
    );

    return NextResponse.json({
      symbol: token,
      nodes: nodesR.rows,
      edges: edgesR.rows,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
