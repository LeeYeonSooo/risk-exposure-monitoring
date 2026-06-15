/**
 * 디텍터 골든 테스트 — diff.ts 분해(2026-06)의 동작 보존 자동검증.
 *
 * 분해 후 11개 디텍터는 전부 순수 함수(입력 스냅샷 → DiffAlert[]). 여기서 각 디텍터의
 *   ① 대표 발화 경로 + ② 2026-06 FP 감사로 넣은 핵심 억제 가드를 합성 픽스처로 못박는다.
 *   "verbatim 이동" 주장을 사람 눈이 아니라 테스트가 보증 → 앞으로의 리팩터/FP 수정 회귀를 자동 적발.
 *
 * 실행: npm test  (tsx --test, 의존성 0 · node:test 내장)
 * 주의: depeg LST/BTC 경로는 RPC(NAV getter)를 타므로 제외 — USD-페그 경로만(RPC 비의존) 검증.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyAsset, isNavPricedLoop, RECOMMENDED_THRESHOLDS as T } from "@/config/alert-thresholds";
import { assessCollateralOracleRisk, checkDepeg, oracleDepegRisk } from "@/snapshot/rules/depeg";
import {
  checkBadDebt, checkCollateralAdoption, checkNewMarkets, checkReserveFreeze,
} from "@/snapshot/rules/market";
import { checkOracleChange, checkOracleStaleness } from "@/snapshot/rules/oracle";
import { checkIrmChange, checkUtilizationLiquidity } from "@/snapshot/rules/rates";
import { checkTotalSupply, checkWhaleUnwind } from "@/snapshot/rules/supply";
import { baseProtoId, maxSeverity } from "@/snapshot/rules/shared";
import { computeValueDrift, type ValuePoint } from "@/snapshot/value-drift";
import { type LedgerRow, reconcile } from "@/snapshot/mint-burn-recon";
import { pickRiskiestPosition } from "@/adapters/morpho-blue";
import type { MarketPosition } from "@/lib/morpho-api";
import type {
  Classification, DexMetrics, EdgeAttrs, EdgeRole, EdgeSnapshot, EdgeTypeName,
  LendingRisk, MarketEntry, OracleInfo, OracleType, ProtocolClass, TokenSnapshotResult,
} from "@/types/edge-schema";

// ─────────────────────────────────────────────────────────────
// 픽스처 팩토리 — 필수 필드를 sane 기본값으로 채우고 over 로 덮는다.
// ─────────────────────────────────────────────────────────────
function role(edge_type: EdgeTypeName): EdgeRole {
  return { edge_type, amount_token: 0, amount_usd: 0 };
}
function cls(protocol_class: ProtocolClass, roles: EdgeRole[] = []): Classification {
  return { roles, primary_role: roles[0]?.edge_type ?? "collateral", venue_type: "market", protocol_class };
}
function orc(type: OracleType, address: string | null): OracleInfo {
  return { type, provider: null, address, depegSensitive: false };
}
function lr(over: Partial<LendingRisk> = {}): LendingRisk {
  return {
    ltv: null, lt: null, liquidationBonus: null, supplyCap: null, borrowCap: null,
    reserveFactor: null, utilization: null, liquidityUsd: null, isFrozen: null,
    eModeCategory: null, irm: null, ...over,
  };
}
function dx(liquidityUsd: number): DexMetrics {
  return { poolCount: 1, liquidityUsd, depthAt1pctUsd: null, depthAt5pctUsd: null, topPairs: null };
}
function mkt(over: Partial<MarketEntry>): MarketEntry {
  return { lltv: 0.8, marketSizeUsd: 1_000_000, vaultFunded: false, fundingVaults: null, vaultFundedShareOfSupply: null, ...over };
}
function attrs(over: Partial<EdgeAttrs> = {}): EdgeAttrs {
  return {
    classification: cls("lending"),
    edgeType: "collateral", venueType: "market", protocolClass: "lending",
    core: { amountToken: 0, amountUsd: 0, pctOfSupply: null, pctOfProtocolTvl: null },
    oracle: orc("MARKET", "0xAAA"),
    lendingRisk: null, dex: null, wrapper: null, topMarkets: null, topPools: null,
    meta: { snapshotBlock: 1, snapshotTs: "2026-06-14T00:00:00Z", verifiableOnchain: true, confidence: "HIGH", dataSource: "test" },
    ...over,
  };
}
function edge(target: string, over: Partial<EdgeAttrs> = {}): EdgeSnapshot {
  return { edgeId: "e", source: "token:X", target, type: "collateral", weight: 0, attrs: attrs(over) };
}
function makeToken(
  label: string,
  meta: Partial<TokenSnapshotResult["token"]["metadata"]> = {},
  blockNumber: number | null = 100,
): TokenSnapshotResult {
  return {
    token: {
      nodeId: `token:${label}`, type: "Token", label, address: "0x0",
      metadata: { symbol: label, decimals: 18, totalSupply: 0, holders: null, marketCapUsd: null, paused: false, bridges: {}, ...meta },
    },
    protocols: [], edges: [], unknownAddresses: [], snapshotTs: "2026-06-14T00:00:00Z", blockNumber,
  };
}
const kinds = (a: { kind: string }[]) => a.map((x) => x.kind).sort();

// ─────────────────────────────────────────────────────────────
// market.ts
// ─────────────────────────────────────────────────────────────
describe("checkNewMarkets", () => {
  const prev = edge("protocol:morpho_blue", {
    topMarkets: [mkt({ loanAsset: "USDC", collateralAsset: "WETH", lltv: 0.80, marketSizeUsd: 5_000_000 })],
  });
  test("신규 고-LLTV 마켓 → critical", () => {
    const curr = edge("protocol:morpho_blue", {
      topMarkets: [
        mkt({ loanAsset: "USDC", collateralAsset: "WETH", lltv: 0.80, marketSizeUsd: 5_000_000 }),
        mkt({ loanAsset: "USDC", collateralAsset: "rsETH", lltv: 0.95, marketSizeUsd: 200_000 }),
      ],
    });
    const out = checkNewMarkets("rsETH", curr, prev, T);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "new_market");
    assert.equal(out[0].severity, "critical");
  });
  test("부분폴 가드: prev 마켓 0개면 발화 안 함", () => {
    const prevEmpty = edge("protocol:morpho_blue", { topMarkets: [] });
    const curr = edge("protocol:morpho_blue", {
      topMarkets: [mkt({ loanAsset: "USDC", collateralAsset: "rsETH", lltv: 0.95, marketSizeUsd: 200_000 })],
    });
    assert.deepEqual(checkNewMarkets("rsETH", curr, prevEmpty, T), []);
  });
  // 담보 품질 인지(2026-06): 검증 코어 담보(WETH)의 고-LLTV 신규 마켓은 info(블루칩 스팸 컷), 미검증은 escalate.
  test("검증 코어 담보(WETH) 고-LLTV 신규 마켓 → info", () => {
    const curr = edge("protocol:morpho_blue", {
      topMarkets: [
        mkt({ loanAsset: "USDC", collateralAsset: "WETH", lltv: 0.80, marketSizeUsd: 5_000_000 }),
        mkt({ loanAsset: "USDC", collateralAsset: "WETH", lltv: 0.945, marketSizeUsd: 3_000_000 }),
      ],
    });
    const out = checkNewMarkets("WETH", curr, prev, T);
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, "info");
  });
});

describe("checkBadDebt", () => {
  test("borrow > collateral deficit ≥ highUsd → critical", () => {
    const curr = edge("protocol:aave_v3", {
      topMarkets: [mkt({ loanAsset: "USDC", lltv: 0.86, marketSizeUsd: 100_000_000, collateralUsd: 5_000_000, borrowUsd: 60_000_000 })],
    });
    const out = checkBadDebt("rsETH", curr, T);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "bad_debt_threshold");
    assert.equal(out[0].severity, "critical");
  });
  test("collateral > borrow → 발화 안 함", () => {
    const curr = edge("protocol:aave_v3", {
      topMarkets: [mkt({ loanAsset: "USDC", collateralUsd: 100_000_000, borrowUsd: 50_000_000 })],
    });
    assert.deepEqual(checkBadDebt("rsETH", curr, T), []);
  });
});

describe("checkCollateralAdoption", () => {
  const adopt = (token: string, amountUsd: number) =>
    edge("protocol:aave_v3", {
      classification: cls("lending", [role("collateral")]),
      core: { amountToken: 0, amountUsd, pctOfSupply: null, pctOfProtocolTvl: null },
    });
  test("MAJOR 렌딩 + 미검증 담보(material) → critical", () => {
    const out = checkCollateralAdoption("rsETH", adopt("rsETH", 20_000_000), T);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "collateral_adoption");
    assert.equal(out[0].severity, "critical");
  });
  test("MAJOR 렌딩 + 검증된 코어 담보(WETH) → info", () => {
    const out = checkCollateralAdoption("WETH", adopt("WETH", 20_000_000), T);
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, "info");
  });
  test("dust(<$1M) → 발화 안 함", () => {
    assert.deepEqual(checkCollateralAdoption("rsETH", adopt("rsETH", 500_000), T), []);
  });
  // ★ 체인 스코프 id 회귀(2026-06 버그수정): 런타임 proto 는 `protocol:aave_v3@ethereum`. 구버전은
  //   majorProtocols(비-스코프)와 includes 불일치로 isMajor 영구 false → 아래가 minor 분기로 새던 것 고정.
  const scopedAdopt = (amountUsd: number) =>
    edge("protocol:aave_v3@ethereum", {
      classification: cls("lending", [role("collateral")]),
      core: { amountToken: 0, amountUsd, pctOfSupply: null, pctOfProtocolTvl: null },
    });
  test("스코프 MAJOR id + 미검증 담보(material) → critical (isMajor 복구)", () => {
    const out = checkCollateralAdoption("rsETH", scopedAdopt(20_000_000), T);
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, "critical");
    assert.equal(out[0].detail?.isMajor, true);
  });
  test("스코프 MAJOR id + 검증 코어 담보(WETH) → info (블루칩 스팸 컷)", () => {
    const out = checkCollateralAdoption("WETH", scopedAdopt(20_000_000), T);
    assert.equal(out[0].severity, "info");
  });
});

describe("computeValueDrift (유출 vs 가격 마크다운 분해)", () => {
  const vp = (ts: number, valueUsd: number, supplyUnits: number | null): ValuePoint =>
    ({ ts, valueUsd, nChains: 3, supplyUnits });
  test("가치낙폭 + 공급 동반감소(units↓) → 실유출 발화", () => {
    const series = [vp(1000, 100e6, 100e6), vp(4600, 85e6, 85e6), vp(8200, 70e6, 70e6)];
    const f = computeValueDrift("deUSD", series, T);
    assert.ok(f, "fire expected");
    assert.equal(f!.severity, "warning");
    assert.ok(f!.supplyDropPct! > 0.25);
  });
  test("가치낙폭인데 공급 유지(가격 마크다운) → 발화 안 함", () => {
    const series = [vp(1000, 100e6, 100e6), vp(4600, 85e6, 100e6), vp(8200, 70e6, 100e6)];
    assert.equal(computeValueDrift("XYZ", series, T), null);
  });
  test("공급 데이터 결손 → 미분해, 보수적 발화", () => {
    const series = [vp(1000, 100e6, null), vp(4600, 85e6, null), vp(8200, 70e6, null)];
    const f = computeValueDrift("XYZ", series, T);
    assert.ok(f, "fire expected (undecomposed)");
    assert.equal(f!.supplyDropPct, null);
  });
});

describe("reconcile (mint↔burn 크로스체인 매칭)", () => {
  const lr2 = (chain: string, kind: "mint" | "burn", amount: string, ts: number): LedgerRow =>
    ({ chain, txHash: `0x${chain}${kind}`, logIndex: 0, kind, amount, eventTsSec: ts, firstSeenSec: ts });
  test("크로스체인 동일금액 mint+burn(창내) → 매칭", () => {
    const r = reconcile([lr2("base", "mint", "1000", 1000), lr2("ethereum", "burn", "1000", 1100)], 1800, 5000);
    assert.equal(r.matchedPks.length, 2);
    assert.equal(r.flagged.length, 0);
  });
  // ★ 같은 체인 burn-remint 도 매칭(2026-06 백테스트 회귀수정): PAID 무한민팅의 같은-체인 burn↔remint(순공급 flat,
  //   단일체인 토큰)을 미정합으로 오발하던 크로스체인 제약을 되돌림. 은폐 이론엣지는 Detector A(supply_conservation)가 백스톱.
  test("같은 체인 동일금액 burn-remint → 매칭(미정합 아님)", () => {
    const r = reconcile([lr2("base", "mint", "1000", 1000), lr2("base", "burn", "1000", 1100)], 1800, 5000);
    assert.equal(r.matchedPks.length, 2);
    assert.equal(r.flagged.length, 0);
  });
});

describe("pickRiskiestPosition (near_liquidation 포지션 단위)", () => {
  const pos = (borrowUsd: number | null, collateralUsd: number | null, hf: number | null, user = "0xabc"): MarketPosition =>
    ({ user: { address: user }, healthFactor: hf, priceVariationToLiquidationPrice: null, state: { borrowAssetsUsd: borrowUsd, supplyAssetsUsd: null, collateralUsd } });

  test("큰 포지션들 중 청산임계 최근접(HF 최소)을 고른다", () => {
    const r = pickRiskiestPosition([pos(5_000_000, 6_000_000, 1.30, "0xsafe"), pos(3_000_000, 3_100_000, 1.02, "0xrisk")], 1_000_000);
    assert.equal(r?.user, "0xrisk");
    // dropToLiquidation = 1 − 1/HF = 1 − 1/1.02 ≈ 0.0196
    assert.ok(Math.abs(r!.dropToLiquidation - (1 - 1 / 1.02)) < 1e-9);
  });

  // ★ FN 케이스(사용자 지적): 큰 안전 고래가 집계 LTV 를 희석해 옆의 청산임박 포지션을 가리던 것 — 포지션 단위는 안 가림.
  test("큰 안전 고래가 있어도 위험 포지션을 가리지 않는다", () => {
    const r = pickRiskiestPosition([pos(50_000_000, 200_000_000, 4.0, "0xwhale"), pos(2_000_000, 2_050_000, 1.01, "0xrisk")], 1_000_000);
    assert.equal(r?.user, "0xrisk");
  });

  test("규모 미달(차입 < $1M) 포지션은 무시 — 청산임박이어도", () => {
    assert.equal(pickRiskiestPosition([pos(200_000, 205_000, 1.001)], 1_000_000), null);
  });

  // ★ 이국적/무가격 담보(BONDUSD 류: collateralUsd null + HF 비현실값)는 제외 — 실측 API 아티팩트.
  test("collateralUsd 없거나 HF 무효면 제외", () => {
    assert.equal(pickRiskiestPosition([pos(3_000_000, null, 0.05)], 1_000_000), null);
    assert.equal(pickRiskiestPosition([pos(3_000_000, 3_000_000, null)], 1_000_000), null);
  });

  test("위험 포지션 없으면(전부 HF 높음) null 아님 — 가장 위험한 것 반환(scan 게이트가 3% 컷)", () => {
    const r = pickRiskiestPosition([pos(2_000_000, 4_000_000, 1.8)], 1_000_000);
    assert.equal(r?.healthFactor, 1.8); // 데이터 존재(healthy)와 데이터 결손(null)을 scan 이 구분하게
  });
});

describe("isNavPricedLoop (near_liq/high_util NAV-루프 면제)", () => {
  test("LST 담보 → true", () => {
    assert.equal(isNavPricedLoop("weETH", "WETH"), true);
    assert.equal(isNavPricedLoop("rsETH", "USDC"), true);
  });
  // ★ stable_soft 수익달러 담보 루프(2026-06 라이브 FP 수정): sUSDS=stable_soft 라 구버전(stable만)에선 누락→FP.
  test("수익달러(stable_soft) 담보 ↔ 달러 차입 → true", () => {
    assert.equal(isNavPricedLoop("sUSDS", "USDT0"), true);  // Sky savings (실측 오라클 'sUSDS/USDS Exchange Rate')
    assert.equal(isNavPricedLoop("USDe", "USDC"), true);
    assert.equal(isNavPricedLoop("sUSDe", "USDT"), true);
    assert.equal(isNavPricedLoop("siUSD", "msUSD"), true);
  });
  test("하드 스테이블 루프 → true", () => assert.equal(isNavPricedLoop("USDC", "USDT"), true));
  test("PT 담보 + 달러 차입 → true", () => assert.equal(isNavPricedLoop("PT-USDai-2026", "USDC"), true));
  test("비-NAV(시장가 담보) 루프 → false", () => {
    assert.equal(isNavPricedLoop("WBTC", "EURC"), false); // major 담보, EUR 스테이블(altcoin) 차입 — 봉쇄 실위험
    assert.equal(isNavPricedLoop("ARB", "USDC"), false);  // 변동성 알트 담보
    assert.equal(isNavPricedLoop("WETH", "USDC"), false); // ETH 담보는 시장가 청산 채널 존재(LST 아님)
  });
});

describe("shared helpers", () => {
  test("baseProtoId 는 @chain 접미를 벗긴다", () => {
    assert.equal(baseProtoId("protocol:aave_v3@ethereum"), "protocol:aave_v3");
    assert.equal(baseProtoId("protocol:morpho_blue@base"), "protocol:morpho_blue");
    assert.equal(baseProtoId("protocol:dl:silo@arbitrum"), "protocol:dl:silo");
    assert.equal(baseProtoId("protocol:aave_v3"), "protocol:aave_v3"); // 이미 비-스코프
    assert.equal(baseProtoId(null), "");
  });
  test("maxSeverity 는 더 높은 등급", () => {
    assert.equal(maxSeverity("info", "warning"), "warning");
    assert.equal(maxSeverity("critical", "warning"), "critical");
    assert.equal(maxSeverity("info", "info"), "info");
  });
});

describe("checkReserveFreeze", () => {
  test("false → true 전이 + 대형 노출 → critical", () => {
    const prev = edge("protocol:aave_v3", { lendingRisk: lr({ isFrozen: false }) });
    const curr = edge("protocol:aave_v3", {
      lendingRisk: lr({ isFrozen: true }),
      core: { amountToken: 0, amountUsd: 60_000_000, pctOfSupply: null, pctOfProtocolTvl: null },
    });
    const out = checkReserveFreeze("rsETH", curr, prev);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "reserve_frozen");
    assert.equal(out[0].severity, "critical");
  });
  test("standing 동결(true → true)은 전이 아님 → 발화 안 함", () => {
    const prev = edge("protocol:aave_v3", { lendingRisk: lr({ isFrozen: true }) });
    const curr = edge("protocol:aave_v3", { lendingRisk: lr({ isFrozen: true }) });
    assert.deepEqual(checkReserveFreeze("rsETH", curr, prev), []);
  });
});

// ─────────────────────────────────────────────────────────────
// oracle.ts
// ─────────────────────────────────────────────────────────────
describe("checkOracleChange", () => {
  // 순수 주소 swap = UNCERTAIN(거버넌스 vs 악성) → warning(2026-06 라벨 리뷰: critical 과대, IRM과 정합).
  //   진짜 위험 전환(MARKET→NONE, live→hardcoded)은 특수화가 critical로 별도 담당(아래 테스트).
  test("주소 swap → oracle_changed warning", () => {
    const prev = edge("protocol:aave_v3", { oracle: orc("MARKET", "0xAAA") });
    const curr = edge("protocol:aave_v3", { oracle: orc("MARKET", "0xBBB") });
    const out = checkOracleChange("rsETH", curr, prev, T);
    assert.equal(kinds(out).join(","), "oracle_changed");
    assert.equal(out[0].severity, "warning");
  });
  test("MARKET → NONE + 주소변경 → oracle_paused_suspect critical", () => {
    const prev = edge("protocol:aave_v3", { oracle: orc("MARKET", "0xAAA") });
    const curr = edge("protocol:aave_v3", { oracle: orc("NONE", "0xBBB") });
    const out = checkOracleChange("rsETH", curr, prev, T);
    assert.equal(kinds(out).join(","), "oracle_paused_suspect");
    assert.equal(out[0].severity, "critical");
  });
  test("immutable 프로토콜(morpho) 헤드라인 swap → 발화 안 함", () => {
    const prev = edge("protocol:morpho_blue", { oracle: orc("MARKET", "0xAAA") });
    const curr = edge("protocol:morpho_blue", { oracle: orc("MARKET", "0xBBB") });
    assert.deepEqual(checkOracleChange("rsETH", curr, prev, T), []);
  });
  test("introspection flap 가드: 같은 주소 type만 뒤집힘 → 발화 안 함", () => {
    const prev = edge("protocol:aave_v3", { oracle: orc("MARKET", "0xAAA") });
    const curr = edge("protocol:aave_v3", { oracle: orc("ORACLE_FREE", "0xAAA") });
    assert.deepEqual(checkOracleChange("rsETH", curr, prev, T), []);
  });
});

describe("checkOracleStaleness", () => {
  const NOW = 1_750_000_000;
  test("answer ≤ 0 → critical", () => {
    const cur = makeToken("USDC", { oracleFeed: { updatedAt: NOW - 100, answer: -1, roundStale: false } });
    const out = checkOracleStaleness(cur, NOW, T);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "oracle_stale");
    assert.equal(out[0].severity, "critical");
  });
  test("stale round → critical", () => {
    const cur = makeToken("USDC", { oracleFeed: { updatedAt: NOW - 100, answer: 1, roundStale: true } });
    assert.equal(checkOracleStaleness(cur, NOW, T)[0].kind, "oracle_stale");
  });
  test("신선한 피드 → 발화 안 함", () => {
    const cur = makeToken("USDC", { oracleFeed: { updatedAt: NOW - 100, answer: 1, roundStale: false } });
    assert.deepEqual(checkOracleStaleness(cur, NOW, T), []);
  });
});

// ─────────────────────────────────────────────────────────────
// rates.ts
// ─────────────────────────────────────────────────────────────
describe("checkIrmChange", () => {
  test("baseRate 점프 ≥ critical band → irm_base_rate_jump critical", () => {
    const prev = edge("protocol:aave_v3", { lendingRisk: lr({ irm: { address: "0xI1", family: "linear", baseRate: 0.02, kink: null } }) });
    const curr = edge("protocol:aave_v3", { lendingRisk: lr({ irm: { address: "0xI1", family: "linear", baseRate: 0.12, kink: null } }) });
    const out = checkIrmChange("rsETH", curr, prev, T);
    assert.equal(kinds(out).join(","), "irm_base_rate_jump");
    assert.equal(out[0].severity, "critical");
  });
  test("mono-pool IRM 주소 swap → irm_changed info", () => {
    const prev = edge("protocol:aave_v3", { lendingRisk: lr({ irm: { address: "0xI1", family: "linear", baseRate: 0.02, kink: null } }) });
    const curr = edge("protocol:aave_v3", { lendingRisk: lr({ irm: { address: "0xI2", family: "linear", baseRate: 0.02, kink: null } }) });
    const out = checkIrmChange("rsETH", curr, prev, T);
    assert.equal(kinds(out).join(","), "irm_changed");
    assert.equal(out[0].severity, "info");
  });
  test("immutable 프로토콜(morpho) IRM 주소 swap → 발화 안 함", () => {
    const prev = edge("protocol:morpho_blue", { lendingRisk: lr({ irm: { address: "0xI1", family: "linear", baseRate: 0.02, kink: null } }) });
    const curr = edge("protocol:morpho_blue", { lendingRisk: lr({ irm: { address: "0xI2", family: "linear", baseRate: 0.02, kink: null } }) });
    assert.deepEqual(checkIrmChange("rsETH", curr, prev, T), []);
  });
});

describe("checkUtilizationLiquidity", () => {
  test("util median 대비 점프 + landed ≥ 70% → utilization_jump warning", () => {
    const prev = edge("protocol:aave_v3", { classification: cls("lending"), lendingRisk: lr({ utilization: 0.5 }) });
    const curr = edge("protocol:aave_v3", { classification: cls("lending"), lendingRisk: lr({ utilization: 0.85 }) });
    const out = checkUtilizationLiquidity("rsETH", curr, prev, T, { lend: [], dex: [], util: [0.5, 0.5, 0.5] });
    assert.equal(kinds(out).join(","), "utilization_jump");
    assert.equal(out[0].severity, "warning");
  });
  test("멀티마켓(Morpho topMarkets) per-market util 점프 → 마켓별 발화", () => {
    const prev = edge("protocol:morpho_blue", { classification: cls("lending"), topMarkets: [mkt({ loanAsset: "USDC", lltv: 0.86, marketSizeUsd: 50e6, utilization: 0.60 }), mkt({ loanAsset: "WETH", lltv: 0.86, marketSizeUsd: 30e6, utilization: 0.80 })] });
    const curr = edge("protocol:morpho_blue", { classification: cls("lending"), topMarkets: [mkt({ loanAsset: "USDC", lltv: 0.86, marketSizeUsd: 50e6, utilization: 0.92 }), mkt({ loanAsset: "WETH", lltv: 0.86, marketSizeUsd: 30e6, utilization: 0.80 })] }); // USDC 60→92(+32pp), WETH 무변화
    const out = checkUtilizationLiquidity("wstETH", curr, prev, T, { lend: [], dex: [], util: [] });
    assert.equal(kinds(out).join(","), "utilization_jump");
    assert.equal(out[0].detail?.perMarket, true);
    assert.equal(out[0].detail?.market, "wstETH/USDC");
  });
  test("멀티마켓: dust 마켓(<$1M) 점프는 제외", () => {
    const prev = edge("protocol:morpho_blue", { classification: cls("lending"), topMarkets: [mkt({ loanAsset: "X", lltv: 0.86, marketSizeUsd: 500e3, utilization: 0.60 })] });
    const curr = edge("protocol:morpho_blue", { classification: cls("lending"), topMarkets: [mkt({ loanAsset: "X", lltv: 0.86, marketSizeUsd: 500e3, utilization: 0.95 })] });
    assert.deepEqual(checkUtilizationLiquidity("wstETH", curr, prev, T, { lend: [], dex: [], util: [] }), []);
  });
  test("커버리지갭(staleGap > 360min) → velocity 룰 억제", () => {
    const prev = edge("protocol:aave_v3", {
      classification: cls("lending"), lendingRisk: lr({ utilization: 0.5 }),
      meta: { snapshotBlock: 1, snapshotTs: "2026-06-13T00:00:00Z", verifiableOnchain: true, confidence: "HIGH", dataSource: "test" },
    });
    const curr = edge("protocol:aave_v3", {
      classification: cls("lending"), lendingRisk: lr({ utilization: 0.85 }),
      meta: { snapshotBlock: 2, snapshotTs: "2026-06-14T00:00:00Z", verifiableOnchain: true, confidence: "HIGH", dataSource: "test" },
    });
    assert.deepEqual(checkUtilizationLiquidity("rsETH", curr, prev, T, { lend: [], dex: [], util: [0.5, 0.5, 0.5] }), []);
  });
  test("DEX 유동성 드롭 → liquidity_drop_dex warning", () => {
    const prev = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(10_000_000) });
    const curr = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(5_000_000) });
    const out = checkUtilizationLiquidity("rsETH", curr, prev, T, { lend: [], dex: [10_000_000, 10_000_000, 10_000_000], util: [] });
    assert.equal(kinds(out).join(","), "liquidity_drop_dex");
    assert.equal(out[0].severity, "warning");
  });
  test("near-total 드롭(메이저 풀 →$0) = read 아티팩트 → 억제", () => {
    // $10M 풀이 한 틱에 $0.001 = 빈/실패 read (dropPct 0.9999 ≥ dexArtifactDropPct 0.95, 잔여 ~$0)
    const prev = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(10_000_000) });
    const curr = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(0.001) });
    assert.deepEqual(checkUtilizationLiquidity("USDT", curr, prev, T, { lend: [], dex: [10_000_000, 10_000_000, 10_000_000], util: [] }), []);
  });
  // ★ FN 수정(2026-06): 97% 드레인이지만 잔여가 비-zero($1.8M)면 진짜 rug → 발화(구버전은 ≥95% 면 무조건 아티팩트 억제).
  test("near-total 드레인 but 잔여 비-zero($1.8M) → liquidity_drop_dex 발화", () => {
    const prev = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(60_000_000) });
    const curr = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(1_800_000) }); // 97% 드롭, 잔여 $1.8M
    const out = checkUtilizationLiquidity("USDC", curr, prev, T, { lend: [], dex: [60_000_000, 60_000_000, 60_000_000], util: [] });
    assert.equal(kinds(out).join(","), "liquidity_drop_dex");
  });
  test("미해석 토큰(UNKNOWN) → util/liq 둘 다 억제", () => {
    const prev = edge("protocol:aave_v3", { classification: cls("lending"), lendingRisk: lr({ utilization: 0.5 }) });
    const curr = edge("protocol:aave_v3", { classification: cls("lending"), lendingRisk: lr({ utilization: 0.95 }) });
    assert.deepEqual(checkUtilizationLiquidity("UNKNOWN", curr, prev, T, { lend: [], dex: [], util: [0.5, 0.5, 0.5] }), []);
  });
  test("V3 집중유동성 진동 하향 swing → 억제 (robust z 가드, USDe 실측)", () => {
    const osc = [1.70e6, 1.42e6, 0.73e6, 1.24e6, 1.39e6, 2.00e6, 2.09e6, 1.62e6, 1.71e6, 1.85e6]; // USDe $0.73~2.09M 진동
    const prev = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(1.57e6) });
    const curr = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(0.73e6) }); // 진동 하단(z≈-2.6 > -3.5)
    assert.deepEqual(checkUtilizationLiquidity("USDe", curr, prev, T, { lend: [], dex: osc, util: [] }), []);
  });
  test("안정풀 실제 드롭(최저점 아래) → liquidity_drop_dex warning", () => {
    const stable = [8.2e6, 8.3e6, 8.1e6, 8.2e6, 8.2e6, 8.3e6, 8.2e6, 8.1e6, 8.3e6, 8.2e6];
    const prev = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(8.2e6) });
    const curr = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(4.5e6) }); // 45% 드롭, 최저 8.1M×0.9 아래
    const out = checkUtilizationLiquidity("USDS", curr, prev, T, { lend: [], dex: stable, util: [] });
    assert.equal(kinds(out).join(","), "liquidity_drop_dex");
  });
  test("점진 드레인(매 틱 새 최저) → 발화 (robustZ MAD-인플레 FN 회귀 방지)", () => {
    const drain = [5e6, 4e6, 3.2e6, 2.56e6, 2.05e6, 1.64e6]; // 단조 감소
    const prev = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(1.64e6) });
    const curr = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(0.2e6) }); // 윈도 최저 1.64M 아래로 붕괴
    const out = checkUtilizationLiquidity("XYZ", curr, prev, T, { lend: [], dex: drain, util: [] });
    assert.equal(kinds(out).join(","), "liquidity_drop_dex");
  });
  test("flat-read 풀 드롭(MAD==0) → 발화 (robustZ z=0 FN 회귀 방지)", () => {
    const flat = [2e6, 2e6, 2e6, 2e6, 2e6]; // 동일값(MAD=0)
    const prev = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(2e6) });
    const curr = edge("protocol:uniswap_v3", { classification: cls("dex"), dex: dx(0.5e6) }); // 75% 드롭, 평탄값 아래
    const out = checkUtilizationLiquidity("XYZ", curr, prev, T, { lend: [], dex: flat, util: [] });
    assert.equal(kinds(out).join(","), "liquidity_drop_dex");
  });
});

// ─────────────────────────────────────────────────────────────
// supply.ts
// ─────────────────────────────────────────────────────────────
describe("checkTotalSupply", () => {
  test("단일 블록 ≥ 10% mint → supply_single_mint critical", () => {
    const cur = makeToken("rsETH", { totalSupply: 1200 });
    const out = checkTotalSupply(cur, 1000, [], T);
    assert.equal(kinds(out).join(","), "supply_single_mint");
    assert.equal(out[0].severity, "critical");
  });
  test("샘플 부족 + 단일블록 변화 없음 → 발화 안 함", () => {
    const cur = makeToken("rsETH", { totalSupply: 100 });
    assert.deepEqual(checkTotalSupply(cur, null, [100, 100, 100], T), []);
  });
});

describe("checkWhaleUnwind", () => {
  test("top holder 대량 인출(≥$1M, ≥50%) → whale_unwind critical", () => {
    const cur = makeToken("rsETH", {
      totalSupply: 100_000_000, marketCapUsd: 100_000_000,
      topHolders: [{ address: "0xWhale", rawBalance: "40000000", amount: 40_000_000 }],
    });
    const out = checkWhaleUnwind(cur, [{ address: "0xWhale", amount: 100_000_000 }], T);
    assert.equal(kinds(out).join(","), "whale_unwind");
    assert.equal(out[0].severity, "critical");
  });
  test("dust 인출(<$1M) → 발화 안 함", () => {
    const cur = makeToken("rsETH", {
      totalSupply: 1_000_000, marketCapUsd: 1_000_000,
      topHolders: [{ address: "0xWhale", rawBalance: "400000", amount: 400_000 }],
    });
    assert.deepEqual(checkWhaleUnwind(cur, [{ address: "0xWhale", amount: 1_000_000 }], T), []);
  });
});

// ─────────────────────────────────────────────────────────────
// depeg.ts  (USD-페그 경로만 — LST/BTC 는 RPC 의존이라 제외)
// ─────────────────────────────────────────────────────────────
describe("checkDepeg (USD)", () => {
  test("USD 스테이블 $1 아래 이탈 → depeg warning", async () => {
    const cur = makeToken("USDC", { totalSupply: 1000, marketCapUsd: 970 }); // price $0.97
    const out = await checkDepeg(cur, T, null);
    assert.equal(kinds(out).join(","), "depeg");
    assert.equal(out[0].severity, "warning");
  });
  test("페그 유지(≥$1) → 발화 안 함", async () => {
    const cur = makeToken("USDC", { totalSupply: 1000, marketCapUsd: 1000 }); // price $1.00
    assert.deepEqual(await checkDepeg(cur, T, null), []);
  });
  // USD 단일-프린트 글리치 가드(2026-06): baseline 이 peg 면 1프린트 catastrophic 은 warning 으로 강등(false critical 컷).
  test("catastrophic(−10%) 인데 baseline 이 peg($1) → warning 강등(글리치)", async () => {
    const cur = makeToken("USDC", { totalSupply: 1000, marketCapUsd: 900 }); // price $0.90 (−10%)
    const out = await checkDepeg(cur, T, 1.0); // baseline peg 유지
    assert.equal(out[0].kind, "depeg");
    assert.equal(out[0].severity, "warning"); // critical 아님 — 글리치 의심
  });
  test("catastrophic(−10%) + baseline 없음 → critical 보존(코로보 불가, 보수적)", async () => {
    const cur = makeToken("USDC", { totalSupply: 1000, marketCapUsd: 900 });
    const out = await checkDepeg(cur, T, null);
    assert.equal(out[0].severity, "critical");
  });
});

// ─────────────────────────────────────────────────────────────
// classifyAsset (2026-06 FN/FP 감사 재설계 — exact 하드페그 + yield-dollar 소프트)
// ─────────────────────────────────────────────────────────────
describe("classifyAsset", () => {
  test("하드페그(법정 1:1) → stable (타이트 0.5% band)", () => {
    for (const s of ["USDC", "USDT", "DAI", "PYUSD", "USDS", "TUSD", "USDe"]) {
      assert.equal(classifyAsset(s), "stable", `${s} should be stable`);
    }
  });
  test("RLUSD → stable (LUSD soft-매칭 버그 수정 — 하드페그)", () => {
    assert.equal(classifyAsset("RLUSD"), "stable");
  });
  test("yield/staked/synth 달러 → stable_soft (5% band, 정상 프리미엄/할인)", () => {
    for (const s of ["sUSDe", "sUSDS", "sDAI", "savUSD", "siUSD", "yoUSD", "frxUSD", "stcUSD", "wsrUSD", "apxUSD"]) {
      assert.equal(classifyAsset(s), "stable_soft", `${s} should be stable_soft`);
    }
  });
  test("MAI(QiDao CDP) → stable_soft (구버전 altcoin 누락 FN 수정)", () => {
    assert.equal(classifyAsset("MAI"), "stable_soft");
  });
  test("소프트/CDP 스테이블 → stable_soft", () => {
    for (const s of ["GHO", "crvUSD", "USD0", "DOLA", "LUSD"]) {
      assert.equal(classifyAsset(s), "stable_soft", `${s} should be stable_soft`);
    }
  });
  test("LST(NAV 등록 전종) → lst", () => {
    for (const s of ["wstETH", "rETH", "cbETH", "rsETH", "weETH", "ezETH", "osETH", "ETHx", "wrsETH", "OETH"]) {
      assert.equal(classifyAsset(s), "lst", `${s} should be lst`);
    }
  });
  test("ETH/WETH → major (LST 아님), BTC 래퍼 → major", () => {
    assert.equal(classifyAsset("ETH"), "major");
    assert.equal(classifyAsset("WETH"), "major");
    for (const s of ["WBTC", "tBTC", "cbBTC"]) assert.equal(classifyAsset(s), "major", `${s}`);
  });
  test("Pendle PT → pendle_pt", () => {
    assert.equal(classifyAsset("PT-USDai-18JUN2026"), "pendle_pt");
  });
  test("브릿지/체인 변형 하드페그 → stable (normalizeBridgeStable, bridge-depeg FN 수정)", () => {
    for (const s of ["USDC.e", "USDbC", "USDT0", "m.USDC", "DAI.e", "AUSD", "USDtb"]) {
      assert.equal(classifyAsset(s), "stable", `${s} should normalize to hard stable`);
    }
  });
  test("달러/ETH/BTC 루트 없는 토큰 → altcoin", () => {
    for (const s of ["PENDLE", "AAVE", "LINK", "ENA", "MKR"]) {
      assert.equal(classifyAsset(s), "altcoin", `${s} should be altcoin`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 오라클-인지 depeg 위험 (2026-06 — 프로토콜별 오라클로 cascade/insulated/silent_bad_debt 분류)
// ─────────────────────────────────────────────────────────────
const oi = (type: OracleType, provider: string | null = null): OracleInfo => ({ type, provider, address: null, depegSensitive: false });

describe("oracleDepegRisk", () => {
  test("MARKET(스테이블) → cascade (디페그→청산 발화)", () => assert.equal(oracleDepegRisk(oi("MARKET", "Chainlink"), "stable"), "cascade"));
  test("EXCHANGE_RATE → insulated (온체인 교환비)", () => assert.equal(oracleDepegRisk(oi("EXCHANGE_RATE"), "stable"), "insulated"));
  test("NAV(자가보고) → silent_bad_debt", () => assert.equal(oracleDepegRisk(oi("NAV", "self"), "lst"), "silent_bad_debt"));
  test("ORACLE_FREE(하드코딩) → silent_bad_debt", () => assert.equal(oracleDepegRisk(oi("ORACLE_FREE"), "stable"), "silent_bad_debt"));
  test("MARKET+CAPO provider → insulated (오라벨 보정)", () => assert.equal(oracleDepegRisk(oi("MARKET", "WstETHPriceCap"), "stable"), "insulated"));
  test("MARKET + LST 토큰 → insulated (CLAUDE.md 규칙1)", () => assert.equal(oracleDepegRisk(oi("MARKET", "Chainlink"), "lst"), "insulated"));
  // ★ \brate\b 과대매칭 제거(2026-06): "rate" 가 든 market-following 스테이블 오라클이 insulated 로 오분류되던 FP.
  test("MARKET + 'rate' 든 시장피드(스테이블) → cascade (insulated 오분류 아님)", () =>
    assert.equal(oracleDepegRisk(oi("MARKET", "USD Interest Rate Feed"), "stable"), "cascade"));
  test("NONE → unknown (커버리지 갭)", () => assert.equal(oracleDepegRisk(oi("NONE"), "stable"), "unknown"));
});

describe("assessCollateralOracleRisk", () => {
  const collEdge = (target: string, oracle: ReturnType<typeof oi>, usd: number) =>
    edge(target, { classification: cls("lending", [role("collateral")]), oracle, core: { amountToken: 0, amountUsd: usd, pctOfSupply: null, pctOfProtocolTvl: null } });
  test("스테이블: market $100M(cascade) + 하드코딩 $20M(silent bad debt) 분리", () => {
    const r = assessCollateralOracleRisk([
      collEdge("protocol:aave_v3", oi("MARKET", "Chainlink"), 100e6),
      collEdge("protocol:morpho_blue", oi("ORACLE_FREE"), 20e6),
    ], "stable");
    assert.equal(r.cascadeUsd, 100e6);
    assert.equal(r.silentBadDebtUsd, 20e6);
    assert.equal(r.silentMarkets.length, 1);
  });
  test("LST: CAPO(type=MARKET 오라벨) 전부 insulated", () => {
    const r = assessCollateralOracleRisk([collEdge("protocol:aave_v3", oi("MARKET", "WstETHPriceCap"), 500e6)], "lst");
    assert.equal(r.insulatedUsd, 500e6);
    assert.equal(r.cascadeUsd + r.silentBadDebtUsd, 0);
  });
  test("비-담보/비-렌딩 엣지(LP)는 집계 제외", () => {
    const lp = edge("protocol:uniswap_v3", { classification: cls("dex", [role("lp_pair")]), oracle: oi("NONE"), core: { amountToken: 0, amountUsd: 50e6, pctOfSupply: null, pctOfProtocolTvl: null } });
    const r = assessCollateralOracleRisk([lp], "stable");
    assert.equal(r.cascadeUsd + r.insulatedUsd + r.silentBadDebtUsd + r.unknownUsd, 0);
  });
});
