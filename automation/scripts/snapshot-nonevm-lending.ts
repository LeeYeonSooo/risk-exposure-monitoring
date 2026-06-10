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
import { closePool, pool } from "@/db/client";
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
  // EVM 이지만 전용 어댑터 비용 대비 lendBorrow 가 정확·저렴한 신흥 체인 (TVL 검토 2026-06-10:
  // Hyperliquid $1.4B — hyperlend·hypurrfi·felix·morpho / Plasma $0.75B — aave-v3·fluid / Katana — morpho).
  { protocol: "hyperliquid", fetch: makeDefiLlamaLendingAdapter("hyperliquid", "Hyperliquid L1") },
  { protocol: "plasma", fetch: makeDefiLlamaLendingAdapter("plasma", "Plasma") },
  { protocol: "katana", fetch: makeDefiLlamaLendingAdapter("katana", "Katana") },
];

const MIN_USD = T.utilizationLiquidity.minLiquidityUsd;

// ── 그래프 1급 시민화 — 알림과 함께 노드/엣지도 적재해 비-EVM 체인이 동심원 "정밀 레이어"로 편입.
// 노드 id 슬러그는 DeFiLlama project 와 정렬(라이브 확인: kamino-lend·save·navi-lending·scallop-lend)
// → 프론트 concentric 의 정밀-우선 dedup(canonProto)이 breadth(점선) 중복을 자동 제거.
const NODE_SLUG: Record<string, string> = { kamino: "kamino-lend", solend: "save", navi: "navi-lending", scallop: "scallop-lend" };
const PROTO_LABEL: Record<string, string> = {
  "kamino-lend": "Kamino Lend", save: "Save (Solend)", marginfi: "MarginFi", drift: "Drift",
  "navi-lending": "NAVI", "scallop-lend": "Scallop", suilend: "Suilend", vesu: "Vesu", justlend: "JustLend",
};
const CHAIN_LABEL: Record<string, string> = {
  solana: "Solana", sui: "Sui", tron: "Tron", aptos: "Aptos", starknet: "Starknet",
  hyperliquid: "Hyperliquid", plasma: "Plasma", katana: "Katana",
};

interface GraphAgg {
  chain: string; proto: string; symbol: string;
  supplyUsd: number; borrowUsd: number;
  ltvWSum: number; ltvW: number; utilWSum: number; utilW: number;
  markets: NonEvmReserve[];
}

/** sized reserve 들을 (체인,프로토콜,토큰) 으로 집계해 nodes/edges upsert (snapshot-chain 과 동일 계약). */
async function writeGraph(reserves: NonEvmReserve[], snapshotTs: string): Promise<number> {
  const agg = new Map<string, GraphAgg>();
  for (const r of reserves) {
    const proto = NODE_SLUG[r.protocol] ?? r.protocol;
    const k = `${r.chain}|${proto}|${r.symbol}`;
    let a = agg.get(k);
    if (!a) { a = { chain: r.chain, proto, symbol: r.symbol, supplyUsd: 0, borrowUsd: 0, ltvWSum: 0, ltvW: 0, utilWSum: 0, utilW: 0, markets: [] }; agg.set(k, a); }
    a.supplyUsd += r.supplyUsd; a.borrowUsd += r.borrowUsd;
    if (r.maxLtv != null) { a.ltvWSum += r.maxLtv * r.supplyUsd; a.ltvW += r.supplyUsd; }
    a.utilWSum += r.utilization * r.supplyUsd; a.utilW += r.supplyUsd;
    a.markets.push(r);
  }

  const client = await pool().connect();
  let edges = 0;
  try {
    await client.query("BEGIN");
    const protoUpserted = new Set<string>();
    for (const a of agg.values()) {
      const protoId = `protocol:${a.proto}@${a.chain}`;
      if (!protoUpserted.has(protoId)) {
        await client.query(
          `INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
           VALUES ($1,'DefiProtocol',$2,NULL,$3,$4::jsonb, now())
           ON CONFLICT (node_id) DO UPDATE SET label=EXCLUDED.label, metadata=EXCLUDED.metadata, updated_at=now()`,
          [protoId, `${PROTO_LABEL[a.proto] ?? a.proto} (${CHAIN_LABEL[a.chain] ?? a.chain})`, a.chain,
           JSON.stringify({ family: a.proto, architecture: "pooled_lending", chain: a.chain, nonEvm: true })],
        );
        protoUpserted.add(protoId);
      }
      const tokenId = `token:${a.symbol}@${a.chain}`;
      await client.query(
        `INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
         VALUES ($1,'Token',$2,NULL,$3,$4::jsonb, now())
         ON CONFLICT (node_id) DO UPDATE SET metadata=EXCLUDED.metadata, updated_at=now()`,
        [tokenId, a.symbol, a.chain, JSON.stringify({ symbol: a.symbol, chain: a.chain, sizeUsd: a.supplyUsd })],
      );

      const topMarkets = [...a.markets].sort((x, y) => y.supplyUsd - x.supplyUsd).slice(0, 12).map((m) => ({
        loanAsset: m.symbol, collateralAsset: m.symbol, marketName: m.market,
        lltv: m.maxLtv ?? 0, marketSizeUsd: m.supplyUsd, utilization: m.utilization,
        collateralUsd: null, borrowUsd: m.borrowUsd, ouroborosRisk: false,
        oracle: m.oracleName ? { type: "MARKET", provider: m.oracleName, address: null, depegSensitive: true, description: null, verified: false } : undefined,
        vaultFunded: false, fundingVaults: null, vaultFundedShareOfSupply: null,
      }));
      const headlineOracle = topMarkets.find((m) => m.oracle)?.oracle ?? null;
      const role = { edge_type: "loan_asset", amount_usd: a.supplyUsd, amount_token: null, pct_of_supply: null };
      const attrs = {
        classification: { roles: [role], primary_role: "loan_asset", venue_type: "market", protocol_class: "lending" },
        core: { amountUsd: a.supplyUsd, amountToken: null, pctOfSupply: null, pctOfProtocolTvl: null },
        edgeType: "loan_asset", venueType: "market", protocolClass: "lending",
        lendingRisk: {
          lt: a.ltvW > 0 ? a.ltvWSum / a.ltvW : null, ltv: null, liquidationBonus: null,
          supplyCap: null, borrowCap: null, reserveFactor: null,
          utilization: a.utilW > 0 ? a.utilWSum / a.utilW : null,
          liquidityUsd: Math.max(0, a.supplyUsd - a.borrowUsd), isFrozen: false, eModeCategory: null, irm: null,
        },
        oracle: headlineOracle, dex: null, wrapper: null,
        topMarkets: topMarkets.length ? topMarkets : null, topPools: null,
        meta: { confidence: "MEDIUM", dataSource: `${a.proto} API (non-EVM)`, snapshotTs, snapshotBlock: null, verifiableOnchain: false },
      };
      await client.query(
        `INSERT INTO edges (snapshot_ts, token_node_id, protocol_node_id, edge_type, weight, attrs, block_number)
         VALUES ($1,$2,$3,'loan_asset',$4,$5::jsonb,NULL)
         ON CONFLICT (snapshot_ts, token_node_id, protocol_node_id) DO UPDATE SET
           edge_type=EXCLUDED.edge_type, weight=EXCLUDED.weight, attrs=EXCLUDED.attrs`,
        [snapshotTs, tokenId, protoId, a.supplyUsd, JSON.stringify(attrs)],
      );
      edges++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return edges;
}

async function main() {
  const DRY = process.argv.includes("--dry");
  const only = process.argv.slice(2).find((s) => !s.startsWith("-"))?.toLowerCase();
  if (!DRY && !env.DATABASE_URL) { console.error("[nonevm] DATABASE_URL 필요 (또는 --dry)"); process.exit(1); }

  let totalAlerts = 0;
  const snapshotTs = new Date().toISOString();
  const allSized: NonEvmReserve[] = []; // 그래프 적재용(알림과 같은 모수)
  for (const a of ADAPTERS) {
    if (only && a.protocol !== only) continue;
    let reserves: NonEvmReserve[] = [];
    try { reserves = await a.fetch(); }
    catch (e) { console.warn(`[${a.protocol}] fetch 실패: ${(e as Error).message.slice(0, 70)}`); continue; }

    const sized = reserves.filter((r) => r.supplyUsd >= MIN_USD);
    allSized.push(...sized);
    const tvl = sized.reduce((s, r) => s + r.supplyUsd, 0);
    let alerts = 0;

    for (const r of sized) {
      const chain = r.chain;
      // 노드 id 와 동일 슬러그(NODE_SLUG) — 알림 protocol_node_id 가 그래프 노드와 1:1 매칭되게.
      const proto = `protocol:${NODE_SLUG[r.protocol] ?? r.protocol}@${chain}`;
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

  // 그래프 1급 시민화 — 노드/엣지 적재(동심원 정밀 레이어). --dry 또는 단일 프로토콜 필터 시엔 전체 모수가 아니므로 skip.
  let graphEdges = 0;
  if (!DRY && !only && allSized.length) {
    try { graphEdges = await writeGraph(allSized, snapshotTs); }
    catch (e) { console.warn(`[nonevm] 그래프 적재 실패: ${(e as Error).message.slice(0, 80)}`); }
  }
  console.log(`[nonevm-lending] ${DRY ? "(dry) " : ""}완료 — 총 ${totalAlerts}건 알림${graphEdges ? ` · 그래프 엣지 ${graphEdges}` : ""}`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
