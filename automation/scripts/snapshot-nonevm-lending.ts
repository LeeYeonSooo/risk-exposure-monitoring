/**
 * 비-EVM 렌딩 통합 모니터링 — Solana/Sui/Tron/Aptos/Starknet 렌딩 프로토콜 reserve 를 읽어
 * EVM 과 **동일 임계값·동일 alerts 계약**으로 알림 적재.
 * (Solana·Sui = 프로토콜 API/SDK/온체인 / Tron·Aptos·Starknet = DeFiLlama lendBorrow 표준지표)
 *   high_utilization (이용률 0.93/0.95/0.98) · high_lltv_market (maxLTV 0.90/0.945)
 * 어댑터별 source=`{protocol}-v1`, detail.chain. dedup·채널·프론트 소비 EVM 과 동일(스키마 재사용 = swap-safe).
 *
 * Usage: npm run snapshot:nonevm            (전체 적재)
 *        npm run snapshot:nonevm -- --dry   (DB 미적재, per-protocol TVL/알림 검증만)
 *        npm run snapshot:nonevm -- navi    (단일 프로토콜)
 * Env: DATABASE_URL(--dry 면 불요), ALCHEMY_API_KEY(Suilend 온체인).
 */
import process from "node:process";

import { makeDefiLlamaLendingAdapter } from "@/adapters/defillama-lending";
import * as drift from "@/adapters/drift-solana";
import * as kamino from "@/adapters/kamino-solana";
import * as marginfi from "@/adapters/marginfi-solana";
import type { NonEvmReserve } from "@/adapters/nonevm-types";
import * as navi from "@/adapters/navi-sui";
import * as scallop from "@/adapters/scallop-sui";
import * as solend from "@/adapters/solend-solana";
import * as suilend from "@/adapters/suilend-sui";
import * as vesu from "@/adapters/vesu-starknet";
import { RECOMMENDED_THRESHOLDS as T, severityForValue } from "@/config/alert-thresholds";
import { env } from "@/config/chains";
import { closePool } from "@/db/client";
import { insertAlert } from "@/db/upsert";

const ADAPTERS: { protocol: string; fetch: () => Promise<NonEvmReserve[]> }[] = [
  { protocol: "kamino", fetch: kamino.fetchReserves },
  { protocol: "solend", fetch: solend.fetchReserves },
  { protocol: "marginfi", fetch: marginfi.fetchReserves },
  { protocol: "drift", fetch: drift.fetchReserves },
  { protocol: "navi", fetch: navi.fetchReserves },
  { protocol: "scallop", fetch: scallop.fetchReserves },
  { protocol: "suilend", fetch: suilend.fetchReserves },
  { protocol: "vesu", fetch: vesu.fetchReserves }, // Starknet — 프로토콜 API 직독 (DeFiLlama lendBorrow 에 Starknet 없음)
  // DeFiLlama lendBorrow 기반 (프로토콜 SDK 불요·견고) — Tron JustLend, Aptos Echelon, Starknet Vesu 등.
  { protocol: "justlend", fetch: makeDefiLlamaLendingAdapter("tron", "Tron") },
  { protocol: "aptos", fetch: makeDefiLlamaLendingAdapter("aptos", "Aptos") },
  { protocol: "starknet", fetch: makeDefiLlamaLendingAdapter("starknet", "Starknet") },
];

const MIN_USD = T.utilizationLiquidity.minLiquidityUsd;

async function main() {
  const DRY = process.argv.includes("--dry");
  const only = process.argv.slice(2).find((s) => !s.startsWith("-"))?.toLowerCase();
  if (!DRY && !env.DATABASE_URL) { console.error("[nonevm] DATABASE_URL 필요 (또는 --dry)"); process.exit(1); }

  let totalAlerts = 0;
  for (const a of ADAPTERS) {
    if (only && a.protocol !== only) continue;
    let reserves: NonEvmReserve[] = [];
    try { reserves = await a.fetch(); }
    catch (e) { console.warn(`[${a.protocol}] fetch 실패: ${(e as Error).message.slice(0, 70)}`); continue; }

    const sized = reserves.filter((r) => r.supplyUsd >= MIN_USD);
    const tvl = sized.reduce((s, r) => s + r.supplyUsd, 0);
    let alerts = 0;

    for (const r of sized) {
      const chain = r.chain;
      const proto = `protocol:${r.protocol}@${chain}`;
      const detail = { chain, protocol: r.protocol, market: r.market, utilization: r.utilization, maxLtv: r.maxLtv, supplyUsd: r.supplyUsd, borrowUsd: r.borrowUsd };

      const uSev = severityForValue(r.utilization, T.utilizationLiquidity.utilizationAbsolute);
      if (uSev) {
        if (!DRY) await insertAlert({ severity: uSev, kind: "high_utilization", token: r.symbol, protocolNodeId: proto, source: `${r.protocol}-v1`, message: `${r.protocol} ${r.symbol} 이용률 ${(r.utilization * 100).toFixed(1)}% (${chain}) — 가용 유동성 소진(인출/청산 위험)`, detail });
        alerts++;
      }
      if (r.maxLtv != null && r.maxLtv >= T.newMarket.highLltvWarning) {
        if (!DRY) await insertAlert({ severity: r.maxLtv >= T.newMarket.highLltvCritical ? "warning" : "info", kind: "high_lltv_market", token: r.symbol, protocolNodeId: proto, source: `${r.protocol}-v1`, message: `${r.protocol} ${r.symbol} maxLTV ${(r.maxLtv * 100).toFixed(1)}% (${chain}) — 고LTV 담보(가격 급락 시 청산 여유 작음)`, detail });
        alerts++;
      }
      // 오라클 staleness(피드 멈춤=가격 동결→청산 미발화) — EVM 과 동일 stalenessFactor. (Kamino 등 신선도 제공 시)
      if (r.oracleAgeSec != null && r.oracleMaxAgeSec != null && r.oracleAgeSec > r.oracleMaxAgeSec * T.oracle.stalenessFactor) {
        if (!DRY) await insertAlert({ severity: "critical", kind: "oracle_stale", token: r.symbol, protocolNodeId: proto, source: `${r.protocol}-v1`, message: `${r.protocol} ${r.symbol} 오라클 ${r.oracleAgeSec}s 미갱신 (maxAge ${r.oracleMaxAgeSec}s×${T.oracle.stalenessFactor} 초과, ${chain}) — 가격 동결 → 청산 미발화(silent bad-debt) 위험`, detail: { ...detail, oracleAgeSec: r.oracleAgeSec, oracleMaxAgeSec: r.oracleMaxAgeSec, oracleName: r.oracleName } });
        alerts++;
      }
    }
    totalAlerts += alerts;
    console.log(`[${a.protocol.padEnd(8)}] reserve ${String(reserves.length).padStart(3)} (≥$${(MIN_USD / 1e6).toFixed(2)}M: ${String(sized.length).padStart(2)}) · TVL ~$${(tvl / 1e6).toFixed(0)}M · 알림 ${alerts}`);
  }

  console.log(`[nonevm-lending] ${DRY ? "(dry) " : ""}완료 — 총 ${totalAlerts}건 알림`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
