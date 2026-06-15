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

// 법정 1:1 하드페그(EXACT 매칭) — 타이트 0.5% band. yield/staked dollar 가 부분매칭으로 섞이지 않게 exact set.
//   (구버전 bare "USD" substring 이 sUSDe·savUSD·siUSD·yoUSD·frxUSD 등 yield-dollar 를 0.5% band 로 오분류해
//    가짜 depeg 를 양산하던 것을 2026-06 FN/FP 감사에서 적발 → exact-hard + soft-기본 으로 재설계.)
const _HARD_USD = new Set(["USDC", "USDT", "DAI", "PYUSD", "RLUSD", "USDS", "USDP", "TUSD", "USDE", "FDUSD", "GUSD", "AUSD", "USDTB", "USDL"]);
// 브릿지/체인 변형을 base 심볼로 정규화 후 하드페그 매칭(m.USDC·USDC.e·USDT0·USD₮0·USDbC·WXDAI·DAI.e → USDC/USDT/DAI).
//   적대검증(2026-06): exact-set 이 bridged 하드페그를 soft 로 강등 → 2~4% bridge depeg 가 info(무알림) FN. 정규화로 해소.
//   yield 래퍼(s-/sav-/yo- 접두)는 브릿지 장식이 아니라 정규화로 안 벗겨짐 → sUSDe 는 그대로 stable_soft(5%).
function normalizeBridgeStable(s: string): string {
  return s
    .replace(/₮/g, "T")        // USD₮0 → USDT0
    .replace(/^M\./, "")        // m.USDC → USDC
    .replace(/^WX/, "X")        // WXDAI → XDAI
    .replace(/^X(?=DAI$)/, "")  // XDAI → DAI
    .replace(/\.E$/, "")        // USDC.E / DAI.E → USDC / DAI
    .replace(/BC$/, "C")        // USDbC → USDC
    .replace(/0$/, "");         // USDT0 → USDT
}
// 비-하드 달러(yield/staked/synth/CDP/algo wrapper)의 substring 루트 — 전부 stable_soft(5% band, 정상 프리미엄/할인).
//   USD-명 외 달러(sDAI·GHO·DOLA·MIM·LUSD·MAI·BOLD·crvUSD)도 포함해 모든 달러가 어떤 stable 클래스로는 잡히게(커버리지 보존).
const _DOLLAR_ROOTS = ["USD", "DAI", "GHO", "FRAX", "DOLA", "MIM", "LUSD", "MAI", "BOLD", "CRVUSD", "USR"];
const _LST = ["STETH", "WSTETH", "RETH", "WEETH", "RSETH", "EZETH", "CBETH", "OSETH", "SFRXETH", "ETHX"];
const _BTC = ["BTC", "WBTC", "CBBTC", "TBTC", "PAXG", "XAU"];
const _RWA = ["MF1", "MF-ONE", "MFONE", "RWA", "TBILL", "USTB", "BUIDL", "OUSG", "USYC", "USYE", "USCC", "JTRSY", "USDY"];

export function classifyAsset(symbol: string | null | undefined): AssetClass {
  const s = (symbol ?? "").toUpperCase();
  if (s === "ETH" || s === "WETH") return "major"; // 모호한 bare 티커 먼저 — major(LST 아님)
  if (s.startsWith("PT-") || s.startsWith("PT ") || s.includes("-PT-")) return "pendle_pt"; // Pendle PT (만기 전 할인 정상)
  if (_HARD_USD.has(s) || _HARD_USD.has(normalizeBridgeStable(s))) return "stable"; // 하드페그(브릿지 변형 정규화 포함) — RLUSD 버그·yield-dollar 오분류 차단
  if (_RWA.some((t) => s.includes(t))) return "rwa"; // RWA 먼저 — USDY 가 달러로 안 빠지게
  if (_LST.some((t) => s.includes(t)) || s.endsWith("ETH")) return "lst"; // *ETH 접미 LST (WETH/ETH 는 위에서 단락)
  if (_BTC.some((t) => s.includes(t))) return "major";
  if (_DOLLAR_ROOTS.some((t) => s.includes(t))) return "stable_soft"; // 그 외 모든 달러 = 소프트(yield/synth 정상 프리미엄/할인)
  return "altcoin";
}

/** 담보가 LST/LRT(rsETH·weETH·*ETH)면 오라클은 교환비(EXCHANGE_RATE) 기반(Aave CAPO 등) — 2차 시장가 아님. */
export function oracleTypeForCollateral(symbol: string | null | undefined): "MARKET" | "EXCHANGE_RATE" {
  return classifyAsset(symbol) === "lst" ? "EXCHANGE_RATE" : "MARKET";
}

/**
 * NAV/교환비 오라클로 평가되는 "수익형 루프" 마켓인가 — 청산오라클이 시장가가 아니라 NAV/교환비(4626
 *   convertToAssets·savings rate·CAPO)라 "시장가 −X% 하락 → 청산"·"고-util=위험" 채널이 약하다(CLAUDE.md 규칙1).
 *   near_liquidation 면제 + high_utilization 강등 공용. 루프 패턴:
 *     · LST 담보(rsETH·weETH·*ETH)           — CAPO/교환비
 *     · 달러↔달러(stable·stable_soft 양쪽)    — sUSDS·USDe·sUSDe·siUSD 등 수익/CDP 달러 담보의 캐리 루프.
 *       ⚠️ hard `stable` 만 보면 sUSDS/USDT0(sUSDS=stable_soft) 같은 정상 루프를 청산임박 오판(2026-06 라이브 FP).
 *     · PT 담보 + 달러 차입                    — linear-discount 오라클(만기 par 수렴)
 *   ⚠️ 심볼 분류 근사 — 엣지에 per-market 오라클 타입을 실어 실검증하는 게 근본해법(후속). 비-달러 알트는 분류상
 *      stable_soft 가 안 되므로(달러 루트 substring 필요) 과면제 위험 낮음. 실현 deficit 은 bad_debt_threshold 가 백업.
 */
export function isNavPricedLoop(collSymbol: string | null | undefined, loanSymbol: string | null | undefined): boolean {
  const c = classifyAsset(collSymbol);
  const l = classifyAsset(loanSymbol);
  const isDollar = (x: AssetClass) => x === "stable" || x === "stable_soft";
  return c === "lst" || (isDollar(c) && isDollar(l)) || (c === "pendle_pt" && isDollar(l));
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
    /** liquidity_drop_dex 읽기 아티팩트 컷 — 한 틱 드롭이 이 분수 이상이면 빈/실패 read 로 보고 억제 (메이저 풀 →$0 FP) */
    dexArtifactDropPct: number;
    /** ...단, 잔여 유동성이 이 USD 이상이면 아티팩트가 아니라 진짜 near-total 드레인(rug)으로 보고 발화.
     *  (구버전은 dropPct≥95% 면 무조건 아티팩트 억제 → 97% 실드레인을 잔여 비-zero 라도 묵살하던 FN.) */
    dexArtifactResidualUsd: number;
    /** liquidity_drop_dex V3 진동 컷 — currLiq 가 최근 윈도 최저점보다 이 분수만큼 더 아래로 떨어질 때만 발화(진동 범위 이탈=진짜 드롭). robustZ 대비 점진드레인·flat-read 견고 */
    dexFloorMargin: number;
    minLiquidityUsd: number;
    /** util 속도 catch-all: 1스냅샷 이 jump 이상 + 이 level 이상에 안착 → run (risk_rules util_jump) */
    jumpActionable: number;
    jumpMinLevel: number;
    /** high_utilization 마켓규모 하한(USD) — dust 마켓(GHO $80·osETH $22)의 util=100% 차단 (2026-06 감사 R4) */
    minMarketSupplyUsd: number;
    /** high_utilization critical(page) 하한(USD) — 이 미만 마켓의 봉쇄(≥99.5% util)는 warning 으로 강등.
     *  100% util 격리마켓이라도 차입규모가 작으면 전염 위험 미미(공급자 인출지연일 뿐) → page 부적정 (2026-06 검증). */
    critMinSizeUsd: number;
    /** liquidity_drop 절대 드롭 USD 하한 — %만으로 발화하던 얇은 마켓 노이즈 차단 (R1) */
    minLiquidityDropUsd: number;
    /** velocity 룰(jump/liquidity_drop) prev↔curr 경과 상한(분) — 초과 시 커버리지갭으로 보고 억제 (R3, H3) */
    maxStalenessMin: number;
  };

  // ── 8. 디페깅 ──
  depeg: {
    /** 자산클래스별 정상-노이즈 band (분수). 넘으면 디페그. (risk_rules depeg_band_by_class) */
    bandByClass: Record<AssetClass, number>;
    /** 이 이상 깊은 디페그는 LT 거리 무관 catastrophic = critical (risk_rules 0.085, USD0++ 보정) */
    catastrophicMagnitude: number;
    /** 비-USD(LST/BTC래퍼) skew 허용 floor — 스냅샷 시장가↔라이브 Chainlink/NAV 피드 시점 불일치(피드 lag·stale 시세)가
     *  만드는 phantom 디페그를 흡수. 이 미만은 발화 안 함(시장가-vs-온체인 비교는 이 이하 신뢰불가). USD 페그엔 미적용. */
    nonUsdSkewFloor: number;
    /** 오라클-인지 위험 증폭 — 디페그 토큰을 담보로 쓰는 프로토콜의 자가보고/하드코딩 오라클 노출($) 임계.
     *  이 이상이면 디페그가 청산 미발화로 조용히 쌓이는 silent bad debt 로 보고 severity escalate. */
    oracleRisk: { warnUsd: number; critUsd: number };
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

  // ── 9b. 크로스체인 공급 보존 (supply_conservation, Kelp 무담보 OFT mint) ──
  supplyConservation: {
    warnPctBps: number;  // escrow 대비 초과 bps ≥ 이 값 = warning (mint 메커니즘)
    critPctBps: number;  // ... = critical (NAV-anchored 는 % 단독 critical 가능)
    warnUsd: number;     // 초과 USD ≥ 이 값 = warning
    critUsd: number;     // ... = critical
    releaseDropPct: number; // escrow 가 원격공급 하락 동반 없이 이 비율 이상 급락 = 무단 release 의심(Kelp b 메커니즘)
    releaseDropUsd: number; // 그 미설명 급락의 USD 하한(dust 컷)
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
    minChainCoverageRatio: number; // latest 체인수 ≥ 윈도최대×이 비율 일 때만 비교(부분-스냅샷 결손 FP 차단)
    /** 가치낙폭 중 **공급(units) 감소**가 설명해야 하는 최소 비율 — value=supply×price 라 가격만 폭락해도
     *  Σsupply_usd 가 무너진다. 진짜 유출(redeem/bridge-out)은 units 가 빠지지만 가격 폭락(illiquid·stale 보정)은
     *  units 유지. supplyDropPct < dropPct×이 값 이면 "가격 마크다운"으로 보고 발화 안 함(유출 오판 FP 차단). */
    minSupplyShareOfDrop: number;
  };

  // ── 데이터 품질 가드 (열화/결손 스냅샷 임계) ──
  // 부분-스냅샷 가드는 사이트마다 신호·억제대상이 달라 한 함수로 통일하지 않는다(data-quality.ts 참조).
  // 여기엔 종전 하드코딩돼 흩어져 있던 매직넘버만 모은다. staleGap(utilizationLiquidity.maxStalenessMin)·
  // chainCoverage(valueDrift.minChainCoverageRatio)는 각 도메인 블록에 이미 있어 중복 보관하지 않는다.
  dataQuality: {
    scanMinRows: number;          // scan: 이보다 적은 row = 결손 스캔 의심 → auto-resolve 보류
    scanMinActiveForRatio: number; // scan: active 알림 ≥ 이 수일 때만 asserted 비율 게이트 적용
    scanAssertedRatio: number;     // scan: asserted < active×이 비율 = 결손 의심
    supplyQuarantineDevPct: number; // chain-supply: median 대비 이 분수 초과 상향 read = baseline 적재 보류(무결성)
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
    // IRM 컨트랙트 주소 swap = UNCERTAIN(거버넌스 정상 업데이트일 수도, 악성 교체일 수도) → 정보 등급(2026-06).
    //   baseRate 점프(irm_base_rate_jump)는 별개 — 실제 금리 변화량이라 티어 유지.
    addressChange: "info",
    baseRateDelta: { info: 0.01, warning: 0.03, critical: 0.08 },
  },

  oracle: {
    // 오라클 주소 swap = UNCERTAIN(거버넌스 정상 업그레이드 vs 악성 교체) → critical→warning 강등(2026-06 라벨 리뷰).
    //   진짜 위험 전환(MARKET→NONE=oracle_paused_suspect, live→hardcoded=oracle_hardcoded_switch)은 특수화가 critical로
    //   별도 담당. IRM addressChange(info)와도 정합(둘 다 "거버넌스 정상 가능"). 순수 주소교체만 #risk-warning.
    addressChange: "warning",
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
    // util_jump info 0.05→0.12 상향 — 5pp 점프까지 발화하던 노이즈 컷(레퍼런스 single-floor 12pp 의도와 정렬).
    utilizationJumpPct: { info: 0.12, warning: 0.15, critical: 0.30 },
    // 유동성 봉쇄(high_utilization, scan 단독, dust 게이트 $1M) — 임계 상향 2026-06: 정상 kink(80~95%)는 위험이
    //   아니므로 ≥98%(공급자 사실상 인출 불가)만. 온셋(급증)은 utilization_jump 가 별도. info=얇은버퍼·warning=인출난·critical=봉쇄.
    utilizationAbsolute: { info: 0.98, warning: 0.99, critical: 0.995 },
    // liquidity_drop info 0.10→0.25 — 고util 마켓 가용유동성은 얇은 잔차라 %변화가 불안정(레퍼런스가 안 쓰는 지표).
    liquidityDropPct: { info: 0.25, warning: 0.40, critical: 0.60 },
    dexLiquidityDropPct: { info: 0.25, warning: 0.40, critical: 0.60 },
    dexArtifactDropPct: 0.95,       // ≥95% 한틱 드롭 = read 아티팩트(메이저 풀 →$0). 실측 정상 최대 ~82% 와 분리.
    dexArtifactResidualUsd: 1_000,  // ...잔여 ≥$1k 면 아티팩트 아님 → 진짜 near-total 드레인으로 발화(잔여 ~$0 만 아티팩트).
    dexFloorMargin: 0.10,           // currLiq < 최근윈도 최저점×(1−0.10) 일 때만 발화. 진동 하단 복귀는 최저 근처라 억제, 점진드레인=매틱 새최저·flat-read drop=평탄값 아래라 발화(robustZ MAD 인플레/MAD==0 FN 면역).
    minLiquidityUsd: 250_000,
    jumpActionable: 0.12,   // ≥12pp util 점프 (apxUSD run 을 LEVEL 게이트가 놓친 것을 잡음)
    jumpMinLevel: 0.70,     // ...≥70% 에 안착할 때만(idle 노이즈 차단)
    minMarketSupplyUsd: 1_000_000,  // R4: dust 마켓 컷(GHO $80·osETH $22 → 0건, TP $11M~$1.26B 전부 보존)
    critMinSizeUsd: 25_000_000,     // 봉쇄 critical(page)은 차입규모 ≥$25M 마켓만 — 소형 격리마켓 100% util 은 warning (2026-06)
    minLiquidityDropUsd: 1_000_000, // R1: %드롭이 커도 절대 $1M 미만 유동성 변화는 노이즈
    maxStalenessMin: 360,           // R3: prev↔curr 6h 초과면 커버리지갭(velocity 룰 억제). 정상 주기(코어 1h·비코어 ~4.7h)는 통과, 73h/48h/12.6h outage 만 컷
  },

  depeg: {
    // 자산클래스별 band(분수) — 정상 트레이딩 노이즈 vs 디페그 분리. risk_rules depeg_band_by_class + 라벨 백테스트.
    // stable(하드페그) 타이트 0.5% / stable_soft·altcoin 넓은 5%(GHO·mkUSD 소프트 할인 정상) / pendle_pt 8%(만기 할인) / lst·rwa 2%.
    bandByClass: { major: 0.0075, stable: 0.005, stable_soft: 0.05, pendle_pt: 0.08, lst: 0.02, rwa: 0.02, altcoin: 0.05 },
    catastrophicMagnitude: 0.085, // ≥8.5% 디페그 = critical (USD0++ 실측 9.02% 보정)
    nonUsdSkewFloor: 0.025,       // 비-USD: 2.5% 미만은 피드 lag·stale 시세 skew(실측 BTC래퍼 ~1.5%·osETH 1.5%)로 흡수. 진짜 LST/BTC 디페그(>2.5%)만.
    oracleRisk: { warnUsd: 1_000_000, critUsd: 10_000_000 }, // 자가보고/하드코딩 오라클 노출 ≥$1M warning·≥$10M critical(silent bad debt)
  },

  unbacked: { toleranceBps: 50, criticalBps: 100, settlementSeconds: 1800, persistencePolls: 2 },
  supplyConservation: { warnPctBps: 100, critPctBps: 200, warnUsd: 1_000_000, critUsd: 10_000_000, releaseDropPct: 0.05, releaseDropUsd: 1_000_000 },

  mintBurn: { matchWindowSeconds: 1800 },

  badDebt: { actionableUsd: 1_000_000, highUsd: 50_000_000 },

  // 가치-드리프트: 24h 내 총가치(price×supply) peak 대비 25% 빠지면 warning · 40% critical.
  //   minAbsUsd $10M 게이트로 소형 토큰 노이즈 차단(deUSD redemption-run·뱅크런·대량 유출 포착).
  valueDrift: { dropPct: { info: 0.10, warning: 0.25, critical: 0.40 }, minAbsUsd: 10_000_000, windowHours: 24, minSamples: 3, minChainCoverageRatio: 0.8, minSupplyShareOfDrop: 0.5 },

  // 부분-스냅샷/결손 가드 매직넘버 — 종전 scan-current-risks(20/5/0.5)·snapshot-chain-supply(0.35) 인라인 리터럴을 이관(값 동일).
  dataQuality: { scanMinRows: 20, scanMinActiveForRatio: 5, scanAssertedRatio: 0.5, supplyQuarantineDevPct: 0.35 },

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
