/**
 * Reflexivity(사기 루핑) 러너 — kuromi reflexivity_scan 라이브화 (정적 JSON 수동복사 대체).
 *
 * active watchlist 토큰별로 Morpho 담보 마켓 오라클을 introspect → grade/oracle_class/looping/concentration
 * 산출 → loop_findings(source=reflexivity-v1, kind=reflexivity, 토큰당 1행) 적재.
 * dossier.loops 가 이 행을 서빙 → 프론트 Tier0 판결 + 상세그래프가 라이브로 소비.
 *
 * Usage: npm run snapshot:reflexivity
 * Env: DATABASE_URL(필수), ALCHEMY_API_KEY·ETHERSCAN_API_KEY(권장 — 오라클 introspect 정확도).
 */
import process from "node:process";

import { chainIdOf, env } from "@/config/chains";
import { closePool, query } from "@/db/client";
import { computeReflexivity } from "@/snapshot/reflexivity";

// 비-메인넷 Morpho 체인 — snapshot-chain 이 만든 체인 스코프 토큰 노드(token:SYM@base …)를 대상으로.
// 비용가드: 체인당 상위 MAX_PER_CHAIN(규모순) ∧ ≥MIN_SIZE_USD 만 introspect (시간당 RPC 보호).
const EXTRA_MORPHO_CHAINS = ["base", "arbitrum", "optimism", "polygon", "unichain", "worldchain"];
const MAX_PER_CHAIN = 25;
const MIN_SIZE_USD = 5_000_000;

async function main() {
  if (!env.DATABASE_URL) { console.error("[reflexivity] DATABASE_URL 필요"); process.exit(1); }
  const only = process.argv[2]?.toUpperCase(); // 선택: 단일 심볼만(테스트)

  // ① 메인넷: active watchlist ∩ ethereum 토큰 노드.
  const eth = (await query<{ symbol: string; address: string }>(
    `SELECT DISTINCT w.symbol, n.address
     FROM watchlist w
     JOIN nodes n ON lower(n.address) = lower(w.token_address) AND n.type = 'Token' AND n.chain = 'ethereum'
     WHERE w.active = TRUE AND n.address IS NOT NULL
     ORDER BY w.symbol`,
  )).rows.map((r) => ({ ...r, chain: "ethereum", nodeId: `token:${r.symbol}` }));

  // ② 비-메인넷 Morpho 체인: 체인 스코프 토큰 노드(규모순 상위, 하한 컷).
  const extra = (await query<{ symbol: string; address: string; chain: string; node_id: string }>(
    `SELECT symbol, address, chain, node_id FROM (
       SELECT n.label AS symbol, n.address, n.chain, n.node_id,
              COALESCE((n.metadata->>'sizeUsd')::numeric, 0) AS size_usd,
              row_number() OVER (PARTITION BY n.chain ORDER BY COALESCE((n.metadata->>'sizeUsd')::numeric, 0) DESC) AS rn
       FROM nodes n
       WHERE n.type = 'Token' AND n.address IS NOT NULL AND n.chain = ANY($1)
     ) t WHERE rn <= $2 AND size_usd >= $3
     ORDER BY chain, symbol`,
    [EXTRA_MORPHO_CHAINS, MAX_PER_CHAIN, MIN_SIZE_USD],
  )).rows.map((r) => ({ symbol: r.symbol, address: r.address, chain: r.chain, nodeId: r.node_id }));

  const rows = [...eth, ...extra].filter((r) => !only || r.symbol.toUpperCase() === only);
  console.log(`[reflexivity] ${rows.length}개 토큰 (메인넷 ${eth.length} + 체인스코프 ${extra.length})${only ? ` (단일: ${only})` : ""}`);
  let written = 0, flagged = 0;

  for (const r of rows) {
    const chainId = chainIdOf(r.chain) ?? 1;
    let f;
    try { f = await computeReflexivity(r.symbol, r.address, chainId); }
    catch (e) { console.warn(`  ${r.symbol}@${r.chain}: 계산 실패 — ${(e as Error).message.slice(0, 60)}`); continue; }
    if (f.nMarkets === 0) continue; // Morpho 담보 마켓 없음 = 렌딩 노출 없음 → skip(loop_findings 미적재)

    // (토큰,체인)당 1행 — token_node_id 가 체인 스코프(token:SYM@base)라 체인별 행이 분리됨.
    await query(
      `INSERT INTO loop_findings
         (token, token_node_id, market_key, kind, collateral_symbol, loan_symbol, looped_usd, lltv, confidence, source, detail)
       VALUES ($1, $2, NULL, 'reflexivity', $1, $3, $4, $5, $6, 'reflexivity-v1', $7)
       ON CONFLICT (source, coalesce(token_node_id,''), coalesce(market_key,''), kind)
       DO UPDATE SET detail = EXCLUDED.detail, looped_usd = EXCLUDED.looped_usd, lltv = EXCLUDED.lltv,
                     confidence = EXCLUDED.confidence, loan_symbol = EXCLUDED.loan_symbol, detected_at = now()`,
      [
        r.symbol, r.nodeId, f.loanSymbol, f.borrowUsd || null, f.lltv, f.grade,
        JSON.stringify({
          grade: f.grade, oracle_class: f.oracleClass, oracle_type: f.oracleType, oracle_name: f.oracleProvider,
          oracle: f.oracleAddress, worst_market: f.worstMarketKey, looping: f.looping, sole_borrower: f.soleBorrower,
          concentration: f.concentration, n_borrowers: f.nBorrowers, n_markets: f.nMarkets, borrow_usd: f.borrowUsd,
          chain: r.chain,
        }),
      ],
    );
    written++;
    if (f.grade !== "ok") {
      flagged++;
      console.log(`  ${f.grade.padEnd(9)} ${r.symbol.padEnd(12)}@${r.chain.padEnd(10)} ${f.oracleClass}${f.looping ? " ·♻self-deal" : ""}${f.soleBorrower ? " ·sole" : ""} (마켓 ${f.nMarkets}, 차입자 ${f.nBorrowers})`);
    }
  }

  console.log(`[reflexivity] 완료: ${written}건 적재 (위험등급 ${flagged}건)`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
