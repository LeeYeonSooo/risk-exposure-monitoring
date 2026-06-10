/**
 * Alert thresholds — 동적 리스크 팩터.
 *
 * 값은 **백테스트로 보정**됨 (risk_rules_test_agent QA 에이전트가 라벨된 과거 사건 —
 * AMPL rebase · PAID 무한민팅 · Wormhole 무담보 · USD0++ 디페그 · cbBTC 등 — 으로 GREEN 까지 튜닝).
 * 자산클래스별(major/stable/lst/rwa/altcoin) band + 무한민팅/무담보/디페그 catastrophic 보정.
 *   대표 보정: depeg catastrophic 0.085 — USD0++ 실측 on-chain trough 9.02%(deepest 9.07%)에 맞춰 0.10→0.085
 *             (자산-asserted 0.10 이 실제 사건 위에 앉아 못 잡던 것을 measured-data 로 재보정, full backtest GREEN).
 *
 * 임계 미달 → 알림 X (DB 만 갱신). 임계 도달 → severity 별 알림. 매 알림은 `exceptions` hook 통과.
 * 본 파일은 룰베이스의 **1차 필터** — 컨텍스트 예외는 추후 에이전트가 register.
 */

export type Severity = "info" | "warning" | "critical";

export interface ThresholdTriplet {
  /** info: log + DB only */
  info: number;
  /** warning: Discord #risk-warning */
  warning: number;
  /** critical: Discord #risk-critical (page-er) */
  critical: number;
}

// ─────────────────────────────────────────────────────────────
// 자산 클래스 분류 (risk_rules classify_asset 포팅) — detector 가 토큰 심볼이 아니라
// 클래스로 분기하게 해 per-class band 적용. ETH/WETH 는 major(LST 아님)로 먼저 단락.
// ─────────────────────────────────────────────────────────────
// stable = 법정화폐 1:1 하드페그(USDC/USDT — 타이트 band). stable_soft = 설계상 할인 거래되는
// 소프트/CDP/본드 스테이블(GHO/mkUSD/USD0++ — 넓은 band). pendle_pt = 만기 전 할인 거래되는 PT.
export type AssetClass = "major" | "stable" | "stable_soft" | "pendle_pt" | "lst" | "rwa" | "altcoin";

const _STABLE = ["USDC", "USDT", "DAI", "PYUSD", "RLUSD", "FRAX", "USDS", "USDP", "TUSD", "USDE", "USD"]; // bare "USD" 마지막
const _SOFT_STABLE = ["GHO", "CRVUSD", "MKUSD", "USD0", "USDN", "LUSD", "DOLA", "MIM", "USDD"]; // 설계상 소프트/CDP — 할인 정상
const _LST = ["STETH", "WSTETH", "RETH", "WEETH", "RSETH", "EZETH", "CBETH", "OSETH", "SFRXETH", "ETHX"];
const _BTC = ["BTC", "WBTC", "CBBTC", "TBTC", "PAXG", "XAU"];
const _RWA = ["MF1", "MF-ONE", "MFONE", "RWA", "TBILL", "USTB", "BUIDL", "OUSG", "USYC", "USYE", "USCC", "JTRSY", "USDY", "USYC"];

export function classifyAsset(symbol: string | null | undefined): AssetClass {
  const s = (symbol ?? "").toUpperCase();
  if (s === "ETH" || s === "WETH") return "major"; // 모호한 bare 티커 먼저 — major(LST 아님)
  if (s.startsWith("PT-") || s.startsWith("PT ") || s.includes("-PT-")) return "pendle_pt"; // Pendle PT (만기 전 할인 정상)
  if (_RWA.some((t) => s.includes(t))) return "rwa"; // RWA 먼저 — USYC 가 stable "USD" 에 안 걸리게
  if (_SOFT_STABLE.some((t) => s.includes(t))) return "stable_soft"; // soft 먼저 — USD0/mkUSD 가 _STABLE "USD" 에 안 걸리게
  if (_STABLE.some((t) => s.includes(t))) return "stable";
  if (_LST.some((t) => s.includes(t)) || s.endsWith("ETH")) return "lst"; // *ETH 접미 LST (WETH/ETH 는 위에서 단락)
  if (_BTC.some((t) => s.includes(t))) return "major";
  return "altcoin";
}

/** 담보가 LST/LRT(rsETH·weETH·*ETH)면 오라클은 교환비(EXCHANGE_RATE) 기반(Aave CAPO 등) — 2차 시장가 아님. */
export function oracleTypeForCollateral(symbol: string | null | undefined): "MARKET" | "EXCHANGE_RATE" {
  return classifyAsset(symbol) === "lst" ? "EXCHANGE_RATE" : "MARKET";
}

/**
 * RWA 의도적 디스카운트 오라클 판별 (BACKLOG P2-8, mF-ONE 류).
 * RWA(국채/펀드형)는 NAV 대비 보수적으로 **일부러 낮춰 고정/평가**(예: NAV 1.1 인데 오라클 0.98 — 청산 방지)
 * 하는 게 정상 설계. 이 경우의 NAV/fixed/ORACLE_FREE 오라클은 "위험 하드코딩"이 아니라 **의도된 설계**.
 * (비-RWA 의 고정 오라클은 여전히 위험: 가격 동결 → 청산 미발화 → bad debt.)
 */
export function isIntentionalDiscountOracle(symbol: string | null | undefined, oracleType: string | null | undefined): boolean {
  if (classifyAsset(symbol) !== "rwa") return false;
  const t = (oracleType ?? "").toUpperCase();
  return t === "NAV" || t === "ORACLE_FREE" || t.includes("FIXED") || t.includes("HARD");
}

export interface AlertThresholds {
  // ── 1. 새 마켓 생성 ──
  newMarket: {
    minMarketSizeUsd: number;
    highLltvWarning: number;
    highLltvCritical: number;
    /** 신생 마켓이 이 USD 이상으로 빠르게 성장 → novelty 신호 (risk_rules new_market_fast_growth) */
    fastGrowthUsd: number;
  };

  // ── 2. 담보 채택 ──
  collateralAdoption: {
    majorProtocols: string[];
    minorLendingFlag: boolean;
    /** 신규 마켓/큐레이터(이력 없음)는 절대 materiality floor 로 (risk_rules adoption_material_usd) */
    materialUsd: number;
    /** 먼지 포지션 노이즈 게이트 */
    dustUsd: number;
  };

  // ── 3. IRM ──
  irmChange: {
    addressChange: Severity;
    baseRateDelta: ThresholdTriplet;
  };

  // ── 4. 오라클 ──
  oracle: {
    addressChange: Severity;
    depegFlagFlip: Severity;
    /** 자산클래스별 heartbeat(초) — staleness × stalenessFactor 기준 (risk_rules) */
    heartbeatByClass: Record<AssetClass, number>;
    /** staleness = heartbeat × 이 배수 초과면 stale (risk_rules 1.75) */
    stalenessFactor: number;
  };

  // ── 5. totalSupply (무한민팅) ──
  totalSupply: {
    perSnapshotPct: ThresholdTriplet;
    autoMintWhitelist: string[];
    zscore: number;
    windowN: number;
    minSamples: number;
    minAbsDeltaTokens: number;
    singleTxPctBps: number;
    /** 단일 unauthorized mint >= 이 bps(=10%) → critical (risk_rules large_single_mint_high_bps) */
    largeSingleMintBps: number;
    /** decimals-agnostic floor: delta 가 supply 의 이 비율 이상이어야 z 신뢰 (risk_rules supply_z_min_rel) */
    minRelDelta: number;
    /** 리베이스 토큰: |Δsupply| 이 band 안이면 설계된 리베이스로 보고 억제 (risk_rules rebase_sane_max) */
    rebaseSaneMax: number;
  };

  // ── 6. 고래 unwind ──
  whaleUnwind: {
    perSnapshotDropPct: ThresholdTriplet;
    absDropUsd: ThresholdTriplet;
    trackTopN: number;
  };

  // ── 7. 가동률 / 유동성 ──
  utilizationLiquidity: {
    utilizationJumpPct: ThresholdTriplet;
    utilizationAbsolute: ThresholdTriplet;
    liquidityDropPct: ThresholdTriplet;
    dexLiquidityDropPct: ThresholdTriplet;
    minLiquidityUsd: number;
    /** util 속도 catch-all: 1스냅샷 이 jump 이상 + 이 level 이상에 안착 → run (risk_rules util_jump) */
    jumpActionable: number;
    jumpMinLevel: number;
  };

  // ── 8. 디페깅 ──
  depeg: {
    /** 자산클래스별 정상-노이즈 band (분수). 넘으면 디페그. (risk_rules depeg_band_by_class) */
    bandByClass: Record<AssetClass, number>;
    /** 이 이상 깊은 디페그는 LT 거리 무관 catastrophic = critical (risk_rules 0.085, USD0++ 보정) */
    catastrophicMagnitude: number;
  };

  // ── 9. 무담보 공급 (Detector A, risk_rules D09) ──
  unbacked: {
    toleranceBps: number;       // 이 안의 breach 무시(반올림/finality skew)
    criticalBps: number;        // backing 대비 이 bps 초과 = critical
    settlementSeconds: number;  // breach 가 이만큼 지속해야 "persisted"(skew 아님)
    persistencePolls: number;   // ...연속 폴 수
  };

  // ── 10. mint/burn 정합 (Detector B, risk_rules D11) ──
  mintBurn: {
    matchWindowSeconds: number; // mint 가 이 창 안에 매칭 burn 없으면 flag
  };

  // ── 11. bad debt (risk_rules D12) ──
  badDebt: {
    actionableUsd: number; // 마켓 deficit 이 이 USD 이상 = HIGH
    highUsd: number;       // ...이 이상 = CRITICAL
  };

  // ── 12. NAV×supply 가치-드리프트 (자금 유출, BACKLOG P2-6) ──
  // 총가치 = price(NAV) × supply. 윈도우 내 peak 대비 급락 = 밸류 유출("Binance 갔네").
  valueDrift: {
    dropPct: ThresholdTriplet; // 윈도우 내 총가치 낙폭(분수)
    minAbsUsd: number;         // 이 USD 이상 빠져야 알림(소형 토큰 노이즈 컷)
    windowHours: number;       // 최근 N시간 내 peak 대비
    minSamples: number;        // 최소 시계열 포인트
  };

  // ── dedup 쿨다운 (severity 별, 초) ──
  cooldownBySeverity: Record<Severity, number>;
}

// ─────────────────────────────────────────────────────────────
// 백테스트 보정 default (risk_rules_test_agent thresholds.py)
// ─────────────────────────────────────────────────────────────

export const RECOMMENDED_THRESHOLDS: AlertThresholds = {
  newMarket: {
    minMarketSizeUsd: 100_000,
    highLltvWarning: 0.90,
    highLltvCritical: 0.945,
    fastGrowthUsd: 5_000_000,
  },

  collateralAdoption: {
    majorProtocols: [
      "protocol:aave_v3", "protocol:compound_v3", "protocol:spark",
      "protocol:maker", "protocol:morpho_blue", "protocol:fluid",
    ],
    minorLendingFlag: true,
    materialUsd: 10_000_000,
    dustUsd: 1_000_000,
  },

  irmChange: {
    addressChange: "critical",
    baseRateDelta: { info: 0.01, warning: 0.03, critical: 0.08 },
  },

  oracle: {
    addressChange: "critical",
    depegFlagFlip: "warning",
    // D04b 보정(라이브 측정): 실제 Chainlink USD 피드 heartbeat 기준 — USDC 평시 age 3.3h(24h heartbeat) 측정 →
    //   구 stable 1h 는 오탐 폭주였음. stalenessFactor 1.75 적용 시 stable 등 ~42h, major(ETH/BTC) ~3.5h 초과만 "frozen".
    heartbeatByClass: { major: 7200, stable: 86400, stable_soft: 86400, pendle_pt: 86400, lst: 86400, rwa: 86400, altcoin: 86400 },
    stalenessFactor: 1.75,
  },

  totalSupply: {
    perSnapshotPct: { info: 0.01, warning: 0.03, critical: 0.10 },
    // 자연스럽게 대량 mint/burn 하는 토큰 → 임계 ×2 (USDC 시간당 페이지 방지). risk_rules supply_elastic_whitelist.
    autoMintWhitelist: ["USDC", "USDT", "DAI", "USDS", "PYUSD", "USDE", "RLUSD", "FRAX", "GHO", "USDP", "TUSD"],
    zscore: 6.0,
    windowN: 50,
    minSamples: 5,
    minAbsDeltaTokens: 1,
    singleTxPctBps: 500,        // 5% of supply in 1 block → flag
    largeSingleMintBps: 1000,   // 10% → critical
    minRelDelta: 0.005,         // delta 가 supply 의 0.5% 이상이어야 z 신뢰 (flat-MAD z-폭발 차단)
    rebaseSaneMax: 0.5,         // |Δsupply| 50% 안이면 설계된 리베이스로 억제
  },

  whaleUnwind: {
    perSnapshotDropPct: { info: 0.10, warning: 0.30, critical: 0.50 },
    absDropUsd: { info: 1_000_000, warning: 10_000_000, critical: 50_000_000 },
    trackTopN: 20,
  },

  utilizationLiquidity: {
    utilizationJumpPct: { info: 0.05, warning: 0.15, critical: 0.30 },
    utilizationAbsolute: { info: 0.93, warning: 0.95, critical: 0.98 },
    liquidityDropPct: { info: 0.10, warning: 0.30, critical: 0.50 },
    dexLiquidityDropPct: { info: 0.10, warning: 0.30, critical: 0.50 },
    minLiquidityUsd: 250_000,
    jumpActionable: 0.12,   // ≥12pp util 점프 (apxUSD run 을 LEVEL 게이트가 놓친 것을 잡음)
    jumpMinLevel: 0.70,     // ...≥70% 에 안착할 때만(idle 노이즈 차단)
  },

  depeg: {
    // 자산클래스별 band(분수) — 정상 트레이딩 노이즈 vs 디페그 분리. risk_rules depeg_band_by_class + 라벨 백테스트.
    // stable(하드페그) 타이트 0.5% / stable_soft·altcoin 넓은 5%(GHO·mkUSD 소프트 할인 정상) / pendle_pt 8%(만기 할인) / lst·rwa 2%.
    bandByClass: { major: 0.0075, stable: 0.005, stable_soft: 0.05, pendle_pt: 0.08, lst: 0.02, rwa: 0.02, altcoin: 0.05 },
    catastrophicMagnitude: 0.085, // ≥8.5% 디페그 = critical (USD0++ 실측 9.02% 보정)
  },

  unbacked: { toleranceBps: 50, criticalBps: 100, settlementSeconds: 1800, persistencePolls: 2 },

  mintBurn: { matchWindowSeconds: 1800 },

  badDebt: { actionableUsd: 1_000_000, highUsd: 50_000_000 },

  // 가치-드리프트: 24h 내 총가치(price×supply) peak 대비 25% 빠지면 warning · 40% critical.
  //   minAbsUsd $10M 게이트로 소형 토큰 노이즈 차단(deUSD redemption-run·뱅크런·대량 유출 포착).
  valueDrift: { dropPct: { info: 0.10, warning: 0.25, critical: 0.40 }, minAbsUsd: 10_000_000, windowHours: 24, minSamples: 3 },

  // risk_rules cooldown_seconds (CRITICAL 1h / HIGH 4h / WARN 12h / INFO 24h) → TS 3-tier 매핑.
  cooldownBySeverity: { critical: 3600, warning: 43200, info: 86400 },
};

// ─────────────────────────────────────────────────────────────
// 임계 결정 함수
// ─────────────────────────────────────────────────────────────

/** 양의 임계값(클수록 위험) → severity. */
export function severityForValue(value: number, t: ThresholdTriplet): Severity | null {
  if (value >= t.critical) return "critical";
  if (value >= t.warning) return "warning";
  if (value >= t.info) return "info";
  return null;
}

/** Auto-mint whitelist 적용 — 임계 ×factor 완화. */
export function relaxThreshold(t: ThresholdTriplet, factor = 2): ThresholdTriplet {
  return { info: t.info * factor, warning: t.warning * factor, critical: t.critical * factor };
}

/**
 * 디페그 severity — 자산클래스 band + catastrophic (risk_rules D08 포팅, 부호 인식).
 * @param belowPegFraction (peg-price)/peg = **양수면 peg 아래**(디페그 다운, catastrophic 가능),
 *        **음수면 peg 위**(수익누적/프리미엄 — review-nudge 라 WARN 상한, critical 아님).
 *        diff.ts 는 `(1 - price)` 를 넘긴다(아래=양수). info=band/2, warning=band, critical=catastrophic(아래만).
 */
export function depegSeverity(symbol: string, belowPegFraction: number, t: AlertThresholds = RECOMMENDED_THRESHOLDS): Severity | null {
  const band = t.depeg.bandByClass[classifyAsset(symbol)];
  const mag = Math.abs(belowPegFraction);
  if (mag < band * 0.5) return null;
  const belowPeg = belowPegFraction > 0;
  if (belowPeg && mag >= t.depeg.catastrophicMagnitude) return "critical"; // 깊은 디페그 다운만 catastrophic
  if (mag >= band) return "warning"; // above-peg 는 여기서 상한(critical 로 안 올라감)
  return "info";
}

/** severity 별 dedup 쿨다운(초). */
export function cooldownSecondsFor(severity: Severity, t: AlertThresholds = RECOMMENDED_THRESHOLDS): number {
  return t.cooldownBySeverity[severity] ?? 26 * 3600;
}

// ─────────────────────────────────────────────────────────────
// 예외 hook — 추후 LLM 에이전트가 register 하는 자리
// ─────────────────────────────────────────────────────────────

export interface AlertContext {
  token: string;
  protocolNodeId?: string;
  kind: string;
  severity: Severity;
  detail?: Record<string, unknown>;
}

export type ExceptionRule = (ctx: AlertContext) => boolean; // true = suppress

const _exceptionRules: ExceptionRule[] = [];

export function registerExceptionRule(rule: ExceptionRule): void {
  _exceptionRules.push(rule);
}

export function shouldSuppress(ctx: AlertContext): boolean {
  return _exceptionRules.some((r) => {
    try {
      return r(ctx);
    } catch {
      return false;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Pre-baked example exceptions (commented — register to enable)
// ─────────────────────────────────────────────────────────────
/*
registerExceptionRule((ctx) => {
  if (ctx.kind !== "whale_unwind") return false;
  const proto = ctx.protocolNodeId ?? "";
  return proto === "bridge:optimism" || proto === "bridge:arbitrum_classic";
});
*/
