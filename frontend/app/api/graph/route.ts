import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/graph
 * 모든 체인의 "토큰별 최신 스냅샷" 노드+엣지를 한 번에 반환 (멀티체인 그래프).
 * 프론트는 node.chain 으로 체인별 "섬"으로 묶어 동심원 3개(이더/Base/Arbitrum)를 그림.
 */

const DATABASE_URL = process.env.DATABASE_URL;
let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  return _pool;
}

interface NodeRow { id: string; type: string; label: string; metadata: unknown; address: string | null; chain: string }
interface EdgeRow { source: string; target: string; edge_type: string; weight: number; attrs: unknown }

export async function GET() {
  const p = pool();
  if (!p) return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  try {
    // 토큰별 최신 스냅샷의 엣지
    const edgesR = await p.query<EdgeRow>(`
      WITH latest AS (
        SELECT token_node_id, MAX(snapshot_ts) AS ts FROM edges GROUP BY token_node_id
      )
      SELECT e.token_node_id AS source, e.protocol_node_id AS target, e.edge_type, e.weight, e.attrs
      FROM edges e JOIN latest l ON e.token_node_id = l.token_node_id AND e.snapshot_ts = l.ts
    `);

    const involved = new Set<string>();
    edgesR.rows.forEach((e) => { involved.add(e.source); involved.add(e.target); });
    if (involved.size === 0) return NextResponse.json({ nodes: [], edges: [] });

    const nodesR = await p.query<NodeRow>(
      `SELECT node_id AS id, type, label, metadata, address, chain FROM nodes WHERE node_id = ANY($1::text[])`,
      [Array.from(involved)],
    );

    return NextResponse.json({ nodes: nodesR.rows, edges: edgesR.rows });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
