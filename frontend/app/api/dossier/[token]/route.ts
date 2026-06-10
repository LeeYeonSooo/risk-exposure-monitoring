import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/dossier/[token]  — 토큰 실사 도시에(dossier)의 DB-히스토리 부분.
 * [token] = 노드 심볼(예: "weETH", "WBTC"). 엣지-파생 지표(집중도·역할·오라클·LTV·부실채권)는
 * 클라이언트가 topology 엣지에서 계산하고, 이 라우트는 DB 누적 데이터만 반환:
 *   - alerts(토큰 위험 히스토리 + 심각도 카운트)   [Tier1 B4]
 *   - supplyHistory(24h 변화율·스파크라인)         [Tier1 B1]
 *   - loops(loop_findings = 루핑/ouroboros 계약)    [Tier3 D4 슬롯]
 *   - curators(이 토큰 담보를 다루는 볼트/큐레이터)  [Tier3 D5]
 */
export const dynamic = "force-dynamic";

const DATABASE_URL = process.env.DATABASE_URL;
let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (!_pool) _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  return _pool;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: raw } = await params;
  const sym = decodeURIComponent(raw);
  const nodeId = `token:${sym}`;

  const p = pool();
  if (!p) return NextResponse.json({ dbConnected: false });

  try {
    const [alertsR, countsR, supplyR, loopsR, curatorsR] = await Promise.all([
      p.query(
        `SELECT created_at, severity, kind, protocol_node_id, message, source
         FROM alerts WHERE upper(token)=upper($1) ORDER BY created_at DESC LIMIT 60`,
        [sym],
      ),
      p.query<{ severity: string; n: string }>(
        `SELECT severity, count(*) n FROM alerts WHERE upper(token)=upper($1) GROUP BY severity`,
        [sym],
      ),
      p.query<{ snapshot_ts: string; total_supply: string }>(
        `SELECT snapshot_ts, total_supply FROM supply_samples
         WHERE token_node_id=$1 ORDER BY snapshot_ts DESC LIMIT 48`,
        [nodeId],
      ),
      p.query(
        // 체인 스코프 행(token:SYM@base …) 포함 — reflexivity 가 비-메인넷 Morpho 체인도 적재함.
        `SELECT kind, collateral_symbol, loan_symbol, looped_usd, lltv, confidence, source, protocol_node_id, detail, token_node_id
         FROM loop_findings
         WHERE token_node_id = $1 OR token_node_id LIKE $1 || '@%'
         ORDER BY looped_usd DESC NULLS LAST`,
        [nodeId],
      ),
      p.query(
        `SELECT curator, vault_name, chain, sum(supply_usd) supply_usd,
                bool_or(in_withdraw_queue) in_withdraw_queue, avg(utilization) utilization
         FROM vault_allocations WHERE upper(collateral)=upper($1)
         GROUP BY curator, vault_name, chain
         ORDER BY supply_usd DESC NULLS LAST LIMIT 20`,
        [sym],
      ),
    ]);

    const counts: Record<string, number> = {};
    for (const r of countsR.rows) counts[r.severity] = Number(r.n);

    // 24h 변화율 — 최신 vs ~24h 전 샘플
    const samples = supplyR.rows
      .map((r) => ({ ts: r.snapshot_ts, supply: Number(r.total_supply) }))
      .filter((s) => s.supply > 0);
    let supply24hChangePct: number | null = null;
    if (samples.length >= 2) {
      const latest = samples[0];
      const cutoff = new Date(latest.ts).getTime() - 24 * 3600 * 1000;
      const old =
        samples.find((s) => new Date(s.ts).getTime() <= cutoff) ?? samples[samples.length - 1];
      if (old.supply > 0) supply24hChangePct = (latest.supply - old.supply) / old.supply;
    }

    return NextResponse.json({
      dbConnected: true,
      symbol: sym,
      alerts: alertsR.rows,
      alertCounts: counts,
      totalSupply: samples[0]?.supply ?? null,
      supply24hChangePct,
      supplyHistory: samples.slice(0, 24).reverse(), // 오래된→최신 (스파크라인)
      loops: loopsR.rows,
      curators: curatorsR.rows,
    });
  } catch (e) {
    return NextResponse.json(
      { dbConnected: true, error: (e as Error).message },
      { status: 500 },
    );
  }
}
