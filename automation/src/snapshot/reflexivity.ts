/**
 * Reflexivity(사기 루핑) 라이브 계산 — kuromi reflexivity_scan 포팅 (정적 JSON 수동복사 대체).
 *
 * 토큰이 담보로 쓰이는 **Morpho 마켓들의 오라클을 온체인 introspect** 해 가장 reflexive(자기참조)한
 * 오라클을 고르고, 그 마켓의 차입자 집중도/self-deal 을 더해 grade 를 매긴다.
 *   - bespoke/NAV (fundamental/naked/hardcoded) = 자기참조 → 시장 디페그가 가격에 안 잡혀 청산 미발동 → HIGH+
 *   - self-NAV (vault convertToAssets) = MED · market-feed/anchored = ok
 *   - sole_borrower(집중도>90% ∧ 차입≥$1M) ∧ reflexive → CRITICAL (private market 사기 패턴)
 *
 * 오라클 분류는 `oracle/introspect.ts`(이미 kuromi 포팅) 재사용. 포지션은 morpho-api(옵션 — 실패해도
 * 오라클 기준 grade). 결과는 loop_findings(source=reflexivity-v1) 로 적재 → dossier.loops 가 서빙 → 프론트.
 */

import { fetchMarketPositions, fetchMarketsByCollateral, type MorphoMarket } from "@/lib/morpho-api";
import { introspectOracle, type OracleIntrospection } from "@/oracle/introspect";
import type { OracleType } from "@/types/edge-schema";

export type Grade = "CRITICAL" | "DISTRESSED" | "HIGH" | "MED" | "CHECK" | "ok";

export interface ReflexivityFinding {
  symbol: string;
  grade: Grade;
  oracleClass: string;        // bespoke/NAV · self-NAV · market-feed · anchored · none
  oracleType: OracleType;
  oracleProvider: string | null;
  oracleAddress: string | null;
  worstMarketKey: string | null;
  nMarkets: number;
  looping: boolean;           // 같은 주소가 빌리고+공급 = self-deal
  soleBorrower: boolean;      // 집중도>90% ∧ 차입≥$1M
  concentration: number | null;
  nBorrowers: number;
  borrowUsd: number;
  loanSymbol: string | null;
  lltv: number | null;
}

/** introspect type → kuromi oracle_class + reflexive/self-NAV 플래그. */
function classOf(type: OracleType, provider: string | null): { oracleClass: string; reflexive: boolean; selfNav: boolean } {
  const prov = (provider ?? "").toLowerCase();
  if (type === "NAV") {
    if (prov.includes("self")) return { oracleClass: "self-NAV", reflexive: false, selfNav: true };
    return { oracleClass: "bespoke/NAV", reflexive: true, selfNav: false };
  }
  if (type === "ORACLE_FREE") return { oracleClass: "bespoke/NAV", reflexive: true, selfNav: false };
  if (type === "EXCHANGE_RATE") return { oracleClass: "anchored", reflexive: false, selfNav: false };
  return { oracleClass: "market-feed", reflexive: false, selfNav: false };
}

/** worst(가장 reflexive) 오라클 선택용 순위: bespoke/NAV(3) > self-NAV(2) > anchored/market(0). */
function sev(type: OracleType, provider: string | null): number {
  const c = classOf(type, provider);
  return c.reflexive ? 3 : c.selfNav ? 2 : 0;
}

const MAX_MARKETS_INTROSPECT = 8;

/** chainId — Morpho 가 있는 체인이면 어디든(기본 메인넷). introspect/Etherscan V2 도 chainId 라우팅. */
export async function computeReflexivity(symbol: string, tokenAddr: string, chainId = 1): Promise<ReflexivityFinding> {
  const base: ReflexivityFinding = {
    symbol, grade: "ok", oracleClass: "none", oracleType: "NONE", oracleProvider: null, oracleAddress: null,
    worstMarketKey: null, nMarkets: 0, looping: false, soleBorrower: false, concentration: null, nBorrowers: 0,
    borrowUsd: 0, loanSymbol: null, lltv: null,
  };

  let markets: MorphoMarket[] = [];
  try { markets = await fetchMarketsByCollateral(tokenAddr, chainId); } catch { return base; }
  markets = markets.filter((m) => m.oracleAddress && (m.state.supplyAssetsUsd ?? 0) > 0);
  if (!markets.length) return base;
  base.nMarkets = markets.length;

  // 상위 마켓의 오라클 introspect → 가장 reflexive 한 것을 worst 로.
  const top = [...markets].sort((a, b) => (b.state.supplyAssetsUsd ?? 0) - (a.state.supplyAssetsUsd ?? 0)).slice(0, MAX_MARKETS_INTROSPECT);
  let worst: { market: MorphoMarket; oracle: OracleIntrospection; s: number } | null = null;
  for (const m of top) {
    if (!m.oracleAddress) continue;
    const o = await introspectOracle(m.oracleAddress as `0x${string}`, chainId, symbol, tokenAddr).catch(() => null);
    if (!o) continue;
    const s = sev(o.type, o.provider);
    if (!worst || s > worst.s) worst = { market: m, oracle: o, s };
    if (s >= 3) break; // 이미 최악(reflexive) — 더 볼 필요 없음
  }
  if (!worst) return base;

  const { oracleClass, reflexive, selfNav } = classOf(worst.oracle.type, worst.oracle.provider);
  base.oracleClass = oracleClass;
  base.oracleType = worst.oracle.type;
  base.oracleProvider = worst.oracle.provider;
  base.oracleAddress = worst.market.oracleAddress;
  base.worstMarketKey = worst.market.uniqueKey;
  base.loanSymbol = worst.market.loanAsset.symbol;
  base.lltv = Number(worst.market.lltv) / 1e18;

  // 차입자 집중도/self-deal — 옵션(실패해도 grade 는 오라클 기준).
  try {
    const pos = await fetchMarketPositions(worst.market.uniqueKey, chainId);
    const borrowers = pos
      .map((p) => ({ addr: p.user.address.toLowerCase(), b: p.state.borrowAssetsUsd ?? 0, s: p.state.supplyAssetsUsd ?? 0 }))
      .filter((x) => x.b > 0);
    const tot = borrowers.reduce((a, x) => a + x.b, 0);
    base.nBorrowers = borrowers.length;
    base.borrowUsd = tot;
    base.concentration = tot > 0 ? Math.max(...borrowers.map((x) => x.b)) / tot : null;
    base.looping = borrowers.some((x) => x.s > 0);          // 같은 주소가 빌리고+공급 = self-deal
    base.soleBorrower = (base.concentration ?? 0) > 0.90 && tot >= 1_000_000;
  } catch { /* positions 미조회 → looping/concentration null, grade 는 오라클 기준 */ }

  // grade ladder (kuromi 포팅 — distressed/cycle 은 라이브 미산출이라 생략).
  base.grade = reflexive
    ? (base.soleBorrower ? "CRITICAL" : "HIGH")
    : selfNav ? "MED" : "ok";

  return base;
}
