/**
 * 데이터 정확도 대조 — 우리 정밀(precise) tier 값 vs DeFiLlama TVL.
 * (전문가 1순위: "데이터 정확성이 제일 중요")
 *
 * 우리 amountUsd(온체인 Multicall3 + DeFiLlama 가격) 를 DeFiLlama 풀 TVL 과 비교해
 * 토큰×프로토콜별 괴리율을 표로. breadth(defillama 출처)는 자기 자신 비교라 제외.
 *
 * Usage: npm run validate
 */
import { closePool, query } from "@/db/client";
import { fetchLlamaPools, poolContainsToken } from "@/lib/defillama";

// 우리 canonical node_id → DeFiLlama project slug (정밀 tier 만)
const CANONICAL_TO_SLUG: Record<string, string[]> = {
  "protocol:aave_v3": ["aave-v3"],
  "protocol:aave_v2": ["aave-v2"],
  "protocol:morpho_blue": ["morpho-blue"],
  "protocol:compound_v3": ["compound-v3"],
  "protocol:spark": ["sparklend"],
  "protocol:fluid": ["fluid-lending", "fluid-dex"],
  "protocol:uniswap_v3": ["uniswap-v3"],
  "protocol:uniswap_v2": ["uniswap-v2"],
  "protocol:curve": ["curve-dex"],
};

interface Row {
  token: string;
  protocol: string;
  our_usd: number;
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  const pools = await fetchLlamaPools();

  // 최신 스냅샷의 정밀 tier 엣지.
  // DeFiLlama yields tvlUsd = "가용 유동성(supply−borrow)" 이므로 like-for-like 비교를 위해
  // lending 은 우리 liquidityUsd(가용)와, 그게 없으면(DEX/wrapper) amountUsd(총)와 비교.
  const r = await query<{ token: string; protocol: string; total_usd: number; liq_usd: number | null }>(`
    WITH latest AS (SELECT token_node_id, MAX(snapshot_ts) ts FROM edges GROUP BY token_node_id)
    SELECT replace(e.token_node_id,'token:','') AS token,
           e.protocol_node_id AS protocol,
           (e.attrs->'core'->>'amountUsd')::float8 AS total_usd,
           (e.attrs->'lendingRisk'->>'liquidityUsd')::float8 AS liq_usd
    FROM edges e JOIN latest l ON e.token_node_id=l.token_node_id AND e.snapshot_ts=l.ts
    WHERE (e.attrs->'meta'->>'dataSource') NOT LIKE 'defillama%'
  `);

  const rows: Row[] = r.rows
    .filter((x) => x.protocol in CANONICAL_TO_SLUG)
    .map((x) => ({
      token: x.token,
      protocol: x.protocol,
      // 가용유동성이 있으면(lending) 그걸로 DeFiLlama 와 동일 지표 비교
      our_usd: x.liq_usd != null && x.liq_usd > 0 ? x.liq_usd : x.total_usd,
    }))
    .filter((x) => x.our_usd > 0);

  console.log(`\n정확도 대조 (우리 정밀 tier vs DeFiLlama) — ${rows.length}개 (token,protocol) 쌍\n`);
  console.log("token        protocol           our_usd      dl_usd      괴리율");
  console.log("─".repeat(72));

  const results: Array<{ token: string; protocol: string; our: number; dl: number; diff: number }> = [];
  for (const row of rows) {
    const slugs = CANONICAL_TO_SLUG[row.protocol];
    const dlUsd = pools
      .filter((p) => slugs.includes(p.project) && poolContainsToken(p.symbol, row.token))
      .reduce((s, p) => s + (p.tvlUsd ?? 0), 0);
    if (dlUsd <= 0) continue; // DeFiLlama 에 매칭 풀 없음 → 비교 불가
    const diff = (row.our_usd - dlUsd) / dlUsd;
    results.push({ token: row.token, protocol: row.protocol, our: row.our_usd, dl: dlUsd, diff });
  }

  results.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  for (const x of results) {
    const flag = Math.abs(x.diff) > 0.5 ? " ⚠️" : Math.abs(x.diff) > 0.25 ? " ⚡" : " ✓";
    console.log(
      `${x.token.padEnd(12)} ${x.protocol.replace("protocol:", "").padEnd(16)} ` +
        `${fmtUsd(x.our).padStart(10)} ${fmtUsd(x.dl).padStart(11)}  ${(x.diff * 100 >= 0 ? "+" : "") + (x.diff * 100).toFixed(1)}%${flag}`,
    );
  }

  const within25 = results.filter((x) => Math.abs(x.diff) <= 0.25).length;
  console.log("─".repeat(72));
  console.log(`✓ ±25% 이내: ${within25}/${results.length} (${results.length ? Math.round((within25 / results.length) * 100) : 0}%)`);
  console.log(`(주의: 멀티자산 풀·LP·서로 다른 측정정의 때문에 일부 괴리는 정상. lending 단일자산이 가장 정확.)`);

  await closePool().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
