/**
 * FP 억제 필터 + decision 층 — risk_rules_test_agent `risk_rules/filters/` + `decision.py` 의 TS 포팅.
 *
 * main 은 디텍터(diff.ts·scan-current-risks.ts·snapshot-*.ts)는 있으나 레퍼런스의 **filter 층**(탐지 후
 * 양성패턴을 인식해 억제)과 **decision 층**(지속+증거 escalation)을 누락 → 이게 FP 폭증의 구조적 원인이었다.
 * 이 모듈이 그 두 층을 main 의 알림 경로(insertAlert) 앞에 추가한다.
 *
 * 설계 원칙(레퍼런스 그대로):
 *   • context 데이터(labels/bridge/rebase 등)가 없으면 필터는 **graceful no-op** — 안전 기본값.
 *   • **안전캡**: CRITICAL 은 절대 억제 안 함. near-LT/depeg-sensitive 도 마스킹 금지.
 *   • coverage-gap(MEDIUM/LOW·non-verifiable 엣지): 억제 **비활성** — PASS/ANNOTATE 만(절대 learned-away 금지).
 *   • 규칙은 fail-CLOSED(만료/미해결이면 적용 안 함).
 */

import { isIntentionalDiscountOracle } from "@/config/alert-thresholds";

export type Verdict = "PASS" | "SUPPRESSED" | "ANNOTATED";
type Sev = "info" | "warning" | "critical";
const SEV_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

/** main kind → 레퍼런스 signal family (필터 디스패치용). */
export function signalFamily(kind: string): string {
  if (kind === "depeg") return "DEPEG";
  if (kind === "whale_unwind") return "WHALE_UNWIND";
  if (kind === "wallet_value_drop" || kind === "value_drift") return "VALUE_OUTFLOW";
  if (kind === "curator_derisk") return "DERISK_OUTFLOW";
  if (kind.startsWith("liquidity_drop") || kind === "high_utilization" || kind === "utilization_jump") return "UTIL_LIQUIDITY_DROP";
  if (kind === "oracle_changed") return "ORACLE_CHANGE";
  if (kind === "irm_changed" || kind === "irm_base_rate_jump") return "IRM_CHANGE";
  if (kind === "new_market" || kind === "market_fast_growth") return "NEW_MARKET";
  if (kind === "collateral_adoption") return "COLLATERAL_ADOPTION";
  return kind.toUpperCase();
}

export interface FilterAlert {
  severity: Sev;
  kind: string;
  token: string;
  protocolNodeId?: string;
  detail?: Record<string, unknown>;
}

export interface AddrLabel {
  kind: "cex" | "custodian" | "otc" | "bridge" | "optimistic_bridge" | "contract";
  name?: string;
}
export interface RebaseInfo {
  dailyRate: number; // 기대 일일 공급/잔액 증가율 (예 stETH ~0.0001)
}

/** main 이 채울 수 있는 context — 비면 graceful no-op. */
export interface FpContext {
  nowUnix: number;
  labels: Map<string, AddrLabel>; // addr(lower) → 라벨
  rebaseTokens: Map<string, RebaseInfo>; // token(upper) → 리베이스 정보
  rwaDiscountTokens: Set<string>; // token(upper) — NAV 대비 의도적 디스카운트 거래 RWA
}

interface Hit {
  name: string;
  note: string;
  action: "suppress" | "annotate";
}

const BENIGN = new Set(["cex", "custodian", "otc", "bridge", "optimistic_bridge", "contract"]);

// ─────────────────────────────────────────────────────────────
// 구조적 필터 (structural.py 포팅) — 각 함수는 양성패턴이면 Hit, 아니면 null.
// ─────────────────────────────────────────────────────────────

/** by_design_discount: RWA 의도적 디스카운트(LT 위) = 보호적 설계. DEPEG 만, near-LT/HIGH 제외. */
function byDesignDiscount(a: FilterAlert, ctx: FpContext): Hit | null {
  if (signalFamily(a.kind) !== "DEPEG") return null;
  if (a.severity === "critical" || a.detail?.nearLt === true) return null;
  const oracleType = String(a.detail?.oracleType ?? "");
  const isRwaDiscount =
    ctx.rwaDiscountTokens.has(a.token.toUpperCase()) ||
    (oracleType ? isIntentionalDiscountOracle(a.token, oracleType) : false);
  return isRwaDiscount ? { name: "byDesignDiscount", note: "RWA by-design discount above LT", action: "suppress" } : null;
}

/** optimistic_bridge_window: optimistic-rollup 7일 인출창 = 자금 '사라진' 듯하나 정상. */
function optimisticBridgeWindow(a: FilterAlert): Hit | null {
  const fam = signalFamily(a.kind);
  if (fam !== "WHALE_UNWIND" && fam !== "VALUE_OUTFLOW" && fam !== "UTIL_LIQUIDITY_DROP") return null;
  // main snapshot-wallets.ts 가 이미 bridgeInFlight 를 계산(ad-hoc) → 필터로 중앙화.
  if (a.detail?.bridgeInFlight === true) {
    const chain = a.detail?.bridgeChain ? ` (${a.detail.bridgeChain})` : "";
    // wallet_value_drop 은 러너가 이미 severity→info 로 다운그레이드함 → annotate(기록 보존). 완전 suppress 하면
    //   bridge-inflight 감사 레코드가 사라진다(2026-06 검증 DATA_BUG). 그 외(value_drift 등)는 FP 가드로 suppress.
    const action = a.kind === "wallet_value_drop" ? "annotate" : "suppress";
    return { name: "optimisticBridge", note: `funds in bridge in-flight window${chain}`, action };
  }
  return null;
}

/** labeled_transfer: 모든 수신처(또는 보유자)가 CEX/브릿지/컨트랙트 라벨이면 이동이지 이탈 아님. */
function labeledTransfer(a: FilterAlert, ctx: FpContext): Hit | null {
  const fam = signalFamily(a.kind);
  if (fam !== "WHALE_UNWIND" && fam !== "VALUE_OUTFLOW") return null;
  // 수신처/관여 주소 수집: whale_unwind=보유자(detail.address), wallet_value_drop=bridgeTo, 둘 다 가능.
  const addrs: string[] = [];
  for (const k of ["address", "bridgeTo", "destination", "to"]) {
    const v = a.detail?.[k];
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) addrs.push(v.toLowerCase());
  }
  if (!addrs.length) return null; // 주소 없음 → 판단 불가, no-op
  const names: string[] = [];
  for (const d of addrs) {
    const lab = ctx.labels.get(d);
    if (!lab || !BENIGN.has(lab.kind)) return null; // 하나라도 미라벨/비양성 → 억제 안 함(#4 split-outflow 보호)
    names.push(lab.name ?? `${d.slice(0, 8)}…`);
  }
  return { name: "labeledTransfer", note: `all addresses labeled benign: ${names.join(", ")}`, action: "suppress" };
}

/** rebase_accrual: 리베이스/이자 누적 밴드 내 = 실제 흐름 아님(증가 방향만, COLLATERAL_ADOPTION). */
function rebaseAccrual(a: FilterAlert, ctx: FpContext): Hit | null {
  if (signalFamily(a.kind) !== "COLLATERAL_ADOPTION" || a.severity === "critical") return null;
  const info = ctx.rebaseTokens.get(a.token.toUpperCase());
  if (!info) return null;
  const v = Number(a.detail?.fracDelta ?? a.detail?.value ?? NaN);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v <= Math.min(info.dailyRate * 1.5, 0.05)
    ? { name: "rebaseAccrual", note: `within expected rebase ~${(info.dailyRate * 100).toFixed(3)}%/day`, action: "suppress" }
    : null;
}

const STRUCTURAL: Array<(a: FilterAlert, ctx: FpContext) => Hit | null> = [
  byDesignDiscount,
  (a) => optimisticBridgeWindow(a),
  labeledTransfer,
  rebaseAccrual,
];

/** coverage-gap: 미검증/저신뢰 엣지면 억제 비활성(safety veto) — learned-away 금지, annotate 만. */
function coverageGapVeto(a: FilterAlert): boolean {
  return a.detail?.verifiableOnchain === false || a.detail?.confidence === "LOW" || a.detail?.confidence === "MEDIUM";
}

// ─────────────────────────────────────────────────────────────
// apply (chain.py 포팅)
// ─────────────────────────────────────────────────────────────

export function applyFpFilters(a: FilterAlert, ctx: FpContext): { verdict: Verdict; applied: string[]; notes: string } {
  // 안전캡 #1: CRITICAL 은 어떤 규칙도 억제하지 않음(오라클 freeze·LT 이하 디페그 등은 항상 사람에게).
  if (a.severity === "critical") return { verdict: "PASS", applied: [], notes: "critical — never suppressed" };

  const suppressionDisabled = coverageGapVeto(a);
  const applied: string[] = [];
  const notes: string[] = [];
  if (suppressionDisabled) {
    applied.push("coverageGap");
    notes.push("coverage MEDIUM/LOW or not on-chain-verifiable → suppression disabled (mapping gap, not benign)");
  }

  const hits: Hit[] = [];
  for (const f of STRUCTURAL) {
    const h = f(a, ctx);
    if (h && !hits.some((x) => x.name === h.name)) hits.push(h);
  }
  // (learned suppression rules 매처는 여기 — registerExceptionRule 훅과 연결. 현재 규칙 없음.)

  let suppressed = false;
  let annotated = false;
  for (const h of hits) {
    applied.push(h.name);
    if (h.action === "annotate" || suppressionDisabled) {
      annotated = true;
      notes.push(`${h.name}: ${h.note} (annotate)`);
    } else {
      suppressed = true;
      notes.push(`${h.name}: ${h.note}`);
    }
  }
  const verdict: Verdict = suppressed ? "SUPPRESSED" : annotated ? "ANNOTATED" : "PASS";
  return { verdict, applied, notes: notes.join("; ") };
}

// ─────────────────────────────────────────────────────────────
// 시드 context — main 이 가진/공개적으로 아는 최소 데이터. (후속: 라벨 DB·브릿지 상태 서비스로 확장)
// ─────────────────────────────────────────────────────────────

const SEED_LABELS: Array<[string, AddrLabel]> = [
  // 잘 알려진 CEX hot wallets (공개)
  ["0x28c6c06298d514db089934071355e5743bf21d60", { kind: "cex", name: "Binance 14" }],
  ["0x21a31ee1afc51d94c2efccaa2092ad1028285549", { kind: "cex", name: "Binance 15" }],
  ["0xdfd5293d8e347dfe59e90efd55b2956a1343963d", { kind: "cex", name: "Binance 16" }],
  ["0x71660c4005ba85c37ccec55d0c4493e66fe775d3", { kind: "cex", name: "Coinbase 1" }],
  ["0x503828976d22510aad0201ac7ec88293211d23da", { kind: "cex", name: "Coinbase 2" }],
  ["0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43", { kind: "cex", name: "Coinbase 10" }],
  ["0x46340b20830761efd32832a74d7169b29feb9758", { kind: "cex", name: "Crypto.com" }],
  // 잘 알려진 브릿지/lockbox (공개)
  ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", { kind: "contract", name: "USDC token" }],
];

const SEED_REBASE: Array<[string, RebaseInfo]> = [
  ["STETH", { dailyRate: 0.0001 }],
  ["RETH", { dailyRate: 0.00009 }],
  ["SUSDE", { dailyRate: 0.0003 }],
];

const SEED_RWA_DISCOUNT = new Set(["MF1", "MFONE", "USTB", "BUIDL", "OUSG", "USYC", "JTRSY", "USDY"]);

let _ctx: FpContext | null = null;
/** 기본 시드 context (프로세스당 1회 구성). */
export function defaultFpContext(): FpContext {
  if (_ctx) {
    _ctx.nowUnix = Math.floor(Date.now() / 1000);
    return _ctx;
  }
  _ctx = {
    nowUnix: Math.floor(Date.now() / 1000),
    labels: new Map(SEED_LABELS),
    rebaseTokens: new Map(SEED_REBASE),
    rwaDiscountTokens: SEED_RWA_DISCOUNT,
  };
  return _ctx;
}
