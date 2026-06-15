/**
 * Rule 8: 디페깅 — 토큰 가격이 peg(USD $1 · LST=ETH×NAV · BTC래퍼=BTC/USD) 아래로 이탈. (diff.ts 에서 분리.)
 */
import { type AssetClass, classifyAsset, depegSeverity, type AlertThresholds, type Severity } from "@/config/alert-thresholds";
import { rpc } from "@/lib/rpc";
import { isBtcWrapper, resolvePegRefUsd } from "@/snapshot/peg-reference";
import { type DiffAlert, formatUsd } from "@/snapshot/rules/shared";
import type { EdgeSnapshot, OracleInfo, TokenSnapshotResult } from "@/types/edge-schema";

// USD-페그로 볼 토큰. PT(만기 할인 거래)·LP 등은 $1 페그가 아니라 제외.
const KNOWN_USD_STABLES = new Set([
  "DAI", "sDAI", "GHO", "FRAX", "frxUSD", "USDS", "sUSDS", "USD0", "USD0++",
  "BUIDL", "USDM", "USDA", "AUSD", "deUSD", "sdeUSD",
]);
function isUsdPegged(symbol: string): boolean {
  const s = symbol.trim();
  if (!s) return false;
  // PT-/YT-/LP- 류 파생은 $1 페그 아님
  if (/^(pt|yt|lp)[-_]/i.test(s)) return false;
  if (KNOWN_USD_STABLES.has(s)) return true; // BUIDL 등 RWA-분류 $1 토큰 명시 override
  // classifyAsset 과 단일화(적대검증 2026-06): /usd/ 정규식이 GHO·DOLA·MAI·m.DAI·USR 등 비-"usd"명 달러를 놓쳐
  //   depeg 미검사하던 갭을 해소. classifyAsset 이 dollar(하드/소프트, 브릿지변형·DAI·GHO·MAI·USR 포함)로 판정하면 대상.
  const cls = classifyAsset(s);
  return cls === "stable" || cls === "stable_soft";
}

// ── 오라클-인지 위험 분류 (2026-06) ─────────────────────────────────────────
// 디페그의 실제 위험은 토큰 1개의 시장가가 아니라, 그 토큰을 담보로 쓰는 **각 프로토콜의 오라클**이 결정한다.
// "그 오라클이 시장 디페그를 보는가?" 로 분류(reflexivity.ts classOf 와 동형):
export type DepegOracleRisk = "cascade" | "insulated" | "silent_bad_debt" | "unknown";
const COLLATERAL_ROLES = new Set(["collateral", "collateral_isolated", "cdp_collateral"]);

/**
 *   · cascade        : MARKET 시장추종 → 디페그→청산 발화(가시적, 프로토콜이 처리). 스테이블의 Chainlink 시장피드 등.
 *   · insulated      : EXCHANGE_RATE/CAPO(온체인 교환비) → 2차시장 디페그 안 봄·내재가치 무결(LST 표준, CLAUDE.md 규칙1).
 *   · silent_bad_debt: NAV(자가보고)/ORACLE_FREE(하드코딩) → 디페그 은폐 → 청산 미발화로 부실 누적(가장 위험·은밀).
 *   · unknown        : NONE/미introspect(dl:* 프로토콜) → 분류 불가(커버리지 갭).
 */
export function oracleDepegRisk(oracle: OracleInfo | undefined, tokenClass: AssetClass): DepegOracleRisk {
  if (!oracle || oracle.type === "NONE") return "unknown";
  if (oracle.type === "ORACLE_FREE") return "silent_bad_debt"; // 하드코딩/고정 — 디페그 은폐
  if (oracle.type === "NAV") return "silent_bad_debt";          // 자가보고/operator NAV(reflexive — Kelp 류)
  if (oracle.type === "EXCHANGE_RATE") return "insulated";       // 온체인 교환비(anchored)
  // CAPO/exchange/correlated 가 type=MARKET 으로 오라벨된 케이스(Aave WstETHPriceCap·Spark Exch·Compound Corr) → anchored.
  //   ⚠️ 단독 \brate\b 제거(2026-06): "rate" 는 피드 설명에 흔해(예: market-following 스테이블 오라클) 진짜 cascade
  //   오라클을 insulated 로 오분류→디페그 info 강등하던 FP. anchored 특정어(capo/pricecap/exchange/correlat/redemption)만.
  const pd = `${oracle.provider ?? ""} ${oracle.description ?? ""}`.toLowerCase();
  if (/capo|pricecap|exch|correlat|redemption/.test(pd)) return "insulated";
  // LST 는 표준 청산오라클이 CAPO/exchange-rate (CLAUDE.md 규칙1) → MARKET 라벨도 anchored 로 lean.
  if (tokenClass === "lst") return "insulated";
  return "cascade"; // 그 외 MARKET — 시장추종(스테이블 등)
}

export interface DepegOracleExposure {
  cascadeUsd: number; insulatedUsd: number; silentBadDebtUsd: number; unknownUsd: number;
  silentMarkets: Array<{ protocol: string; usd: number; oracle: string }>;
}

/** 토큰의 담보 엣지를 순회해 오라클 위험 클래스별 노출($) 집계. per-market 오라클(Morpho) 우선, 없으면 헤드라인. */
export function assessCollateralOracleRisk(edges: EdgeSnapshot[], tokenClass: AssetClass): DepegOracleExposure {
  const out: DepegOracleExposure = { cascadeUsd: 0, insulatedUsd: 0, silentBadDebtUsd: 0, unknownUsd: 0, silentMarkets: [] };
  const add = (risk: DepegOracleRisk, usd: number, proto: string, oracle?: OracleInfo) => {
    if (!(usd > 0)) return;
    if (risk === "cascade") out.cascadeUsd += usd;
    else if (risk === "insulated") out.insulatedUsd += usd;
    else if (risk === "silent_bad_debt") {
      out.silentBadDebtUsd += usd;
      out.silentMarkets.push({ protocol: proto, usd, oracle: `${oracle?.type ?? "?"}${oracle?.provider ? "/" + oracle.provider : ""}` });
    } else out.unknownUsd += usd;
  };
  for (const edge of edges ?? []) {
    const roles = edge.attrs?.classification?.roles ?? [];
    if (!roles.some((r) => COLLATERAL_ROLES.has(r.edge_type))) continue;
    const pc = edge.attrs?.classification?.protocol_class;
    if (pc !== "lending" && pc !== "cdp") continue;
    // per-market 담보 USD 가 신뢰성 있게 있으면 마켓별, 아니면 헤드라인 오라클 + 엣지 총노출(이중계상 방지).
    const markets = (edge.attrs?.topMarkets ?? []).filter((m) => m.oracle && (m.collateralUsd ?? 0) > 0);
    if (markets.length > 0) {
      for (const m of markets) add(oracleDepegRisk(m.oracle, tokenClass), m.collateralUsd ?? 0, edge.target, m.oracle);
    } else {
      add(oracleDepegRisk(edge.attrs?.oracle, tokenClass), edge.attrs?.core?.amountUsd ?? 0, edge.target, edge.attrs?.oracle);
    }
  }
  return out;
}

const SEV_RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 };
function maxSev(a: Severity, b: Severity): Severity { return SEV_RANK[a] >= SEV_RANK[b] ? a : b; }

export async function checkDepeg(current: TokenSnapshotResult, t: AlertThresholds, priceBaseline: number | null): Promise<DiffAlert[]> {
  const meta = current.token.metadata;
  const sym = meta.symbol;
  // 가격 = marketCapUsd / totalSupply (coins.llama 시세 기반, snapshot 에서 세팅). USD·LST·BTC 공통.
  const price = meta.totalSupply > 0 && meta.marketCapUsd ? meta.marketCapUsd / meta.totalSupply : null;
  if (price == null || !(price > 0)) return [];

  let pegRef: number;
  let refKind: "usd" | "eth_nav" | "btc";
  let refLabel: string;
  let extra: Record<string, unknown> = {};
  let cmpPrice = price; // 디페그 판정 비교가 — 비-USD 는 baseline 평활로 override(시점 불일치 skew/글리치 흡수)

  if (isUsdPegged(sym)) {
    // ── USD 페그(스테이블) ── 기준선(pegRef) = 하드 $1 아니라 최근 종합가격 median(지속 수준).
    //   · baseline 이 명확히 sub-$1(<0.99) 지속이면 그 baseline 기준 + 그 아래로 추가 하락(≥3%)일 때만 발화.
    //   · baseline ~$1 또는 이력부족이면 $1 기준(초기 break 포착). median 이 내려가면 발화 멈춤(지속=baseline 침묵).
    const sustainedBelowPeg = priceBaseline != null && priceBaseline >= 0.5 && priceBaseline < 0.99;
    pegRef = sustainedBelowPeg ? priceBaseline : 1.0;
    refKind = "usd";
    refLabel = sustainedBelowPeg ? `기준선 $${pegRef.toFixed(4)}` : "$1";
    if (price >= pegRef) return []; // 기준선 이상 = 디페그 아님(상향=수익률, 유지=baseline)
    if (sustainedBelowPeg && (pegRef - price) / pegRef < 0.03) return []; // baseline 밴드 내 진동 = 지속 수준
  } else {
    // ── 비-USD: LST(ETH×NAV) · BTC 1:1 래퍼(BTC/USD). major(ETH/WETH)·altcoin·pendle·rwa 는 peg 없음 → skip. ──
    const cls = classifyAsset(sym);
    const btc = isBtcWrapper(sym);
    if (cls !== "lst" && !btc) return [];
    const ref = await resolvePegRefUsd(sym, btc ? "btc_wrapper" : "lst", rpc());
    if (!ref) return []; // NAV getter/피드 해석 불가(미등록 LST 등) → skip(FN)
    pegRef = ref.pegRefUsd;
    refKind = ref.refKind;
    refLabel = ref.refKind === "btc"
      ? `BTC $${pegRef.toFixed(0)}`
      : `NAV $${pegRef.toFixed(2)} · ETH $${ref.refUsd?.toFixed(0)}×${ref.navRate?.toFixed(4)}`;
    extra = { refKind: ref.refKind, navRate: ref.navRate ?? null, refUsd: ref.refUsd ?? null };
    // 단일 스냅샷 글리치/stale 시세 평활(2026-06 검증: OETH $1630 글리치·osETH 130분 stale 시세) — current 와
    //   baseline(최근 median) 중 **높은 쪽**으로 비교해 "지속" 디페그만 통과. 한쪽이 peg면 글리치/skew 로 보고 흡수.
    cmpPrice = priceBaseline != null && priceBaseline > 0 ? Math.max(price, priceBaseline) : price;
    if (cmpPrice >= pegRef) return []; // NAV/BTC 이상(프리미엄)은 디페그 아님 — 하향(할인)만
  }

  const dropFromRef = (pegRef - cmpPrice) / pegRef;
  const devBps = dropFromRef * 10_000;
  // 자산클래스별 band + catastrophic(8.5%) — risk_rules 보정. lst=2% · major(BTC래퍼)=0.75% · stable=0.5%.
  let sev = depegSeverity(sym ?? current.token.label, dropFromRef, t);
  if (!sev) return [];
  // 비-USD skew floor(2026-06 검증): 시장가↔온체인피드 시점 불일치(스냅샷 시장가 ↔ 라이브 Chainlink/NAV 피드)가
  //   ETH/BTC 변동 중 phantom 디페그를 만든다 — BTC래퍼 3종 동시 -1.2~1.5%(피드 lag) FP 실측. nonUsdSkewFloor(2.5%)
  //   미만 비-USD 는 발화 안 함(시장가-vs-온체인 비교는 이 이하 신뢰불가). 진짜 LST/BTC 디페그(>2.5%, stETH류)만 통과.
  if (refKind !== "usd" && dropFromRef < t.depeg.nonUsdSkewFloor) return [];
  // USD 단일-프린트 글리치 가드(2026-06): USD 경로는 skew floor·baseline 평활이 없어 thin/illiquid 스테이블의
  //   stale 시세 1프린트(≥8.5%)가 곧장 catastrophic critical 페이지가 된다. 진짜 catastrophic 은 baseline(최근
  //   median)도 함께 내려앉지만 글리치는 1프린트만 튄다 → critical 은 baseline 도 catastrophic 수준일 때만 허용,
  //   아니면 warning 강등(초기 break 의 warning 민감도는 보존, 지속되면 다음 스냅샷에 baseline 동반 → critical).
  if (refKind === "usd" && sev === "critical" && priceBaseline != null && priceBaseline > 0) {
    const cmpCat = Math.max(price, priceBaseline);
    if ((pegRef - cmpCat) / pegRef < t.depeg.catastrophicMagnitude) sev = "warning";
  }

  // ── 오라클-인지 위험 증폭 ──────────────────────────────────────────────
  // 디페그의 실제 위험은 담보 프로토콜의 오라클이 결정한다(CLAUDE.md 규칙1). 토큰 시장가 디페그를
  //   각 (프로토콜, 마켓) 오라클로 cross-reference 해 cascade/insulated/silent_bad_debt 로 분류 →
  //   가장 위험한 silent bad debt(디페그가 청산 미발화 → 조용히 누적)면 escalate, 전부 insulated(NAV/CAPO)면 info 강등.
  const exposure = assessCollateralOracleRisk(current.edges, classifyAsset(sym));
  const orc = t.depeg.oracleRisk;
  let finalSev = sev;
  let note: string;
  // 노트 = 미니멀 태그(severity 구동 시그널만). 서술은 라벨/툴팁이 담당.
  if (exposure.silentBadDebtUsd >= orc.critUsd) {
    finalSev = "critical";
    note = ` · 부실누적 ${formatUsd(exposure.silentBadDebtUsd)}`;
  } else if (exposure.silentBadDebtUsd >= orc.warnUsd) {
    finalSev = maxSev(sev, "warning");
    note = ` · 부실누적 ${formatUsd(exposure.silentBadDebtUsd)}`;
  } else if (exposure.cascadeUsd >= orc.warnUsd) {
    note = "";
  } else if (exposure.cascadeUsd + exposure.silentBadDebtUsd === 0 && exposure.insulatedUsd > 0) {
    if (sev !== "critical") finalSev = "info"; // 전부 NAV/CAPO — 디페그 안 봄·청산위험 낮음(catastrophic 은 유지)
    note = " · NAV절연";
  } else {
    note = "";
  }
  if (exposure.unknownUsd >= orc.warnUsd) note += ` · 미분류 ${formatUsd(exposure.unknownUsd)}`;

  return [
    {
      severity: finalSev,
      kind: "depeg",
      token: current.token.label, // 토큰 레벨 알림 — 특정 프로토콜이 아님
      message: `${sym} −${(dropFromRef * 100).toFixed(1)}% · $${price.toFixed(4)}${note}`,
      detail: {
        priceUsd: price, deviationBps: devBps, pegTarget: pegRef, baseline: priceBaseline, direction: "down", refKind,
        oracleExposure: exposure, ...extra,
      },
    },
  ];
}
