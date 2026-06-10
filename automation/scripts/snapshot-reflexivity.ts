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

import { env } from "@/config/chains";
import { closePool, query } from "@/db/client";
import { computeReflexivity } from "@/snapshot/reflexivity";

async function main() {
  if (!env.DATABASE_URL) { console.error("[reflexivity] DATABASE_URL 필요"); process.exit(1); }
  const only = process.argv[2]?.toUpperCase(); // 선택: 단일 심볼만(테스트)

  // active watchlist ∩ ethereum 토큰 노드(담보 introspect 는 메인넷 Morpho 기준).
  const rows = (await query<{ symbol: string; address: string }>(
    `SELECT DISTINCT w.symbol, n.address
     FROM watchlist w
     JOIN nodes n ON lower(n.address) = lower(w.token_address) AND n.type = 'Token' AND n.chain = 'ethereum'
     WHERE w.active = TRUE AND n.address IS NOT NULL
     ORDER BY w.symbol`,
  )).rows.filter((r) => !only || r.symbol.toUpperCase() === only);

  console.log(`[reflexivity] ${rows.length}개 토큰 reflexivity 계산${only ? ` (단일: ${only})` : ""}`);
  let written = 0, flagged = 0;

  for (const r of rows) {
    let f;
    try { f = await computeReflexivity(r.symbol, r.address); }
    catch (e) { console.warn(`  ${r.symbol}: 계산 실패 — ${(e as Error).message.slice(0, 60)}`); continue; }
    if (f.nMarkets === 0) continue; // Morpho 담보 마켓 없음 = 렌딩 노출 없음 → skip(loop_findings 미적재)

    // 토큰당 1행(market_key=NULL → 유니크 인덱스 coalesce(market_key,'')='' 로 단일). worst 마켓은 detail 에.
    await query(
      `INSERT INTO loop_findings
         (token, token_node_id, market_key, kind, collateral_symbol, loan_symbol, looped_usd, lltv, confidence, source, detail)
       VALUES ($1, $2, NULL, 'reflexivity', $1, $3, $4, $5, $6, 'reflexivity-v1', $7)
       ON CONFLICT (source, coalesce(token_node_id,''), coalesce(market_key,''), kind)
       DO UPDATE SET detail = EXCLUDED.detail, looped_usd = EXCLUDED.looped_usd, lltv = EXCLUDED.lltv,
                     confidence = EXCLUDED.confidence, loan_symbol = EXCLUDED.loan_symbol, detected_at = now()`,
      [
        r.symbol, `token:${r.symbol}`, f.loanSymbol, f.borrowUsd || null, f.lltv, f.grade,
        JSON.stringify({
          grade: f.grade, oracle_class: f.oracleClass, oracle_type: f.oracleType, oracle_name: f.oracleProvider,
          oracle: f.oracleAddress, worst_market: f.worstMarketKey, looping: f.looping, sole_borrower: f.soleBorrower,
          concentration: f.concentration, n_borrowers: f.nBorrowers, n_markets: f.nMarkets, borrow_usd: f.borrowUsd,
        }),
      ],
    );
    written++;
    if (f.grade !== "ok") {
      flagged++;
      console.log(`  ${f.grade.padEnd(9)} ${r.symbol.padEnd(12)} ${f.oracleClass}${f.looping ? " ·♻self-deal" : ""}${f.soleBorrower ? " ·sole" : ""} (마켓 ${f.nMarkets}, 차입자 ${f.nBorrowers})`);
    }
  }

  console.log(`[reflexivity] 완료: ${written}건 적재 (위험등급 ${flagged}건)`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
