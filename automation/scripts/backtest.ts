/**
 * 백테스트 하니스 (설계 §7.3) — `backtest/events/` 의 라벨된 사건을 **production 알림 로직**에 replay 해
 * precision/recall 을 측정한다. 결정론적(LLM 아님). 임계값을 바꾸면 여기서 회귀가 잡힌다.
 *
 * label.json = detector-agnostic 계약. case 마다 should_fire[] / must_not_fire[] (각 {signal_type,
 *   min_severity, node_id|edge_id}). 가격은 case.peg_probes 또는 case.polls[].peg_probes (멀티폴 dedup 테스트).
 *
 * 본 하니스가 **구동하는 신호**(스냅샷 metadata + peg_probes 로 충분한 것):
 *   DEPEG               — peg_probes 가격 → depegSeverity(부호 인식: 아래=catastrophic 가능, 위=WARN 상한)
 *   LARGE_SINGLE_MINT   — 비-home·**무권한** 수신자 단일 mint 의 %of-supply (provenance 우선 → 5%+ = HIGH+)
 *   TOTAL_SUPPLY_SPIKE  — curr vs prev %Δ. **리베이스 억제**(|Δ|≤rebaseSaneMax ∧ 이산 mint 0 → 설계 리베이스)
 *   UNMATCHED_MINT      — Detector B reconcile(금액+시간창 매칭 안 되는 mint)
 *   UNBACKED_SUPPLY     — Detector A evaluateBacking(Σremote_supply > backing+slack 멀티체인 불변식)
 * dedup: polls[] 케이스는 severity별 쿨다운(cooldownBySeverity)으로 재생 후 **마지막 폴**의 emit 을 채점.
 * 미구동 신호(ORACLE/UTIL/WHALE/BAD_DEBT/UNBACKED/SUPPLY_DELTA_ANOMALY 등)는 입력이 스냅샷에 없어
 *   coverage 에서 제외(부분 커버리지). should_fire 중 구동 신호만 채점 — 정직하게 보고.
 *
 * Usage: npm run backtest  [-- --verbose]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { cooldownSecondsFor, depegSeverity, RECOMMENDED_THRESHOLDS as T, severityForValue, type Severity } from "@/config/alert-thresholds";
import { reconcile, type LedgerRow } from "@/snapshot/mint-burn-recon";
import { evaluateBacking } from "@/snapshot/supply-backing";

// import.meta.dirname 은 Node 20.11+ 전용 — Node 18 에선 undefined 라 "." (cwd) 폴백 시 경로가 한 단계 어긋난다.
//   fileURLToPath(import.meta.url) 로 스크립트 위치를 robust 하게 해석(표준 ESM __dirname 패턴).
const _here = dirname(fileURLToPath(import.meta.url));
const EVENTS_DIR = resolve(_here, "..", "backtest", "events");
const VERBOSE = process.argv.includes("--verbose");

// 라벨 severity 스케일(INFO<WARN<HIGH<CRITICAL) ↔ 우리 3-tier(info<warning<critical). HIGH 는 critical 이 충족.
const RANK: Record<string, number> = { INFO: 0, WARN: 1, HIGH: 2, CRITICAL: 3, info: 0, warning: 1, critical: 3 };
const sevRank = (s: Severity): number => RANK[s] ?? 0;
const sevOfRank = (r: number): Severity => (r >= 3 ? "critical" : r >= 1 ? "warning" : "info");
const DRIVEN = new Set(["DEPEG", "LARGE_SINGLE_MINT", "TOTAL_SUPPLY_SPIKE", "UNMATCHED_MINT", "UNBACKED_SUPPLY"]);
const secOf = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

interface SnapMeta {
  symbol: string; decimals: number; total_supply: number;
  supply_samples?: number[];
  mint_events?: { amount: number; to: string; home?: boolean; ts: number; tx_hash?: string }[];
  burn_events?: { amount: number; from: string; ts: number; tx_hash?: string }[];
  authorized_minters?: string[];
  backing?: number;                          // Detector A 입력: 홈 lockbox/escrow 백킹(raw)
  remote_supply?: Record<string, number>;    // 체인별 원격 공급(raw) — Σ vs backing
  circulating?: string;
}
function loadSnap(eventDir: string, rel: string | undefined): SnapMeta | null {
  if (!rel) return null;
  try {
    const j = JSON.parse(readFileSync(resolve(eventDir, rel), "utf8")) as { nodes?: { type: string; metadata: SnapMeta }[] };
    const tok = (j.nodes ?? []).find((n) => n.type === "Token");
    return tok ? tok.metadata : null;
  } catch { return null; }
}

interface Emit { type: string; edge: string; rank: number }
type PegProbes = Record<string, { price: number; peg: number }>;

/** DEPEG — 한 폴의 peg_probes → emit 집합 (edge = probe key). 부호: (peg-price)/peg, 양수=아래. */
function depegEmits(probes: PegProbes | undefined, symbol: string): Emit[] {
  const out: Emit[] = [];
  for (const [edge, p] of Object.entries(probes ?? {})) {
    if (!p || !(p.peg > 0)) continue;
    const belowFrac = (p.peg - p.price) / p.peg;
    const sev = depegSeverity(symbol, belowFrac);
    if (sev) out.push({ type: "DEPEG", edge, rank: sevRank(sev) });
  }
  return out;
}

/** 공급/민트 신호 — 스냅샷 metadata 기반(폴 무관 상수). edge = "*"(노드 레벨). */
function supplyEmits(snap: SnapMeta, prev: SnapMeta | null, nowSec: number): Emit[] {
  const out: Emit[] = [];
  const auth = new Set((snap.authorized_minters ?? []).map((a) => a.toLowerCase()));

  // LARGE_SINGLE_MINT — provenance 우선: 비-home·무권한 수신자 단일 mint 가 supply 의 5%+ → HIGH+(critical).
  // (정상 발행자/브릿지(authorized) mint 는 크기 무관 무시 — 라벨이 benign 처리.)
  for (const m of snap.mint_events ?? []) {
    if (m.home) continue;
    if (auth.has((m.to ?? "").toLowerCase())) continue;
    const bps = snap.total_supply > 0 ? (m.amount / snap.total_supply) * 10_000 : 0;
    if (bps >= T.totalSupply.singleTxPctBps) out.push({ type: "LARGE_SINGLE_MINT", edge: "*", rank: RANK.CRITICAL });
  }

  // TOTAL_SUPPLY_SPIKE — curr vs prev %Δ. 설계된 리베이스(|Δ|≤rebaseSaneMax ∧ 이산 mint 0)는 억제.
  if (prev && prev.total_supply > 0) {
    const pct = (snap.total_supply - prev.total_supply) / prev.total_supply;
    const mints = (snap.mint_events ?? []).length;
    const isRebase = Math.abs(pct) <= T.totalSupply.rebaseSaneMax && mints === 0;
    if (!isRebase) {
      const sev = severityForValue(pct, T.totalSupply.perSnapshotPct);
      if (sev) out.push({ type: "TOTAL_SUPPLY_SPIKE", edge: "*", rank: sevRank(sev) });
    }
  }

  // UNMATCHED_MINT — Detector B reconcile (무권한 mint vs burn 금액+시간창 매칭).
  const rows: LedgerRow[] = [
    ...(snap.burn_events ?? []).map((b) => ({ chain: "ethereum", txHash: b.tx_hash ?? `b${b.ts}`, logIndex: 0, kind: "burn" as const, amount: String(b.amount), eventTsSec: b.ts, firstSeenSec: b.ts })),
    ...(snap.mint_events ?? []).filter((m) => !m.home && !auth.has((m.to ?? "").toLowerCase()))
      .map((m) => ({ chain: "ethereum", txHash: m.tx_hash ?? `m${m.ts}`, logIndex: 0, kind: "mint" as const, amount: String(m.amount), eventTsSec: m.ts, firstSeenSec: m.ts })),
  ];
  const { flagged } = reconcile(rows, T.mintBurn.matchWindowSeconds, nowSec);
  if (flagged.length) out.push({ type: "UNMATCHED_MINT", edge: "*", rank: RANK.WARN });

  // UNBACKED_SUPPLY — Detector A: Σremote_supply > backing(+slack) (멀티체인 backing 불변식).
  // (backing/remote 는 raw 정수. 큰 수는 Number 정밀 손실이 있으나 deficit 방향/배수는 명확 — 경계 케이스는 안전범위.)
  if (snap.backing != null && snap.remote_supply) {
    const remoteSum = Object.values(snap.remote_supply).reduce((a, b) => a + (b || 0), 0);
    const finding = evaluateBacking({
      symbol: snap.symbol ?? "", homeChain: "ethereum", decimals: snap.decimals ?? 18,
      circulating: "remotes", tolBps: T.unbacked.toleranceBps,
      backing: BigInt(Math.trunc(snap.backing)), remoteSum: BigInt(Math.trunc(remoteSum)),
      staleHome: false, breakdown: {},
    });
    if (finding) out.push({ type: "UNBACKED_SUPPLY", edge: "*", rank: finding.overageBps >= T.unbacked.criticalBps ? RANK.CRITICAL : RANK.WARN });
  }

  return out;
}

interface Poll { probes: PegProbes | undefined; now: string }
interface CaseResult { event: string; id: string; status: "PASS" | "MISS" | "FORBIDDEN" | "UNCOVERED"; partial: boolean; detail: string }

function runCase(eventName: string, eventDir: string, c: Record<string, unknown>): CaseResult {
  const id = String(c.id);
  const snap = loadSnap(eventDir, c.snapshot as string | undefined);
  if (!snap) return { event: eventName, id, status: "UNCOVERED", partial: false, detail: "snapshot 로드 실패" };
  const prev = loadSnap(eventDir, c.prev as string | undefined);

  // 폴 시퀀스 — polls[] 있으면 시간순, 없으면 단일 폴.
  const rawPolls = (c.polls as { peg_probes?: PegProbes; now: string }[] | undefined);
  const polls: Poll[] = (rawPolls?.length ? rawPolls.map((p) => ({ probes: p.peg_probes, now: p.now }))
    : [{ probes: c.peg_probes as PegProbes | undefined, now: String(c.now) }])
    .sort((a, b) => secOf(a.now) - secOf(b.now));

  const supplyConst = supplyEmits(snap, prev, secOf(polls[polls.length - 1].now));

  // DEPEG dedup 재생 — severity별 쿨다운(cooldownBySeverity). 같은 edge 가 더 높거나 같은 severity 로
  // 쿨다운 내 재발화하면 억제(USDC SVB steady=억제 vs worsens=재페이지). 공급/backing 신호는 point-in-time
  // (persistence 확정 자체가 신호 — xUSD persist)라 dedup 미적용, 마지막 폴에 항상 포함.
  const state = new Map<string, { rank: number; ts: number }>();
  let lastDepeg: Emit[] = [];
  for (const poll of polls) {
    const ts = secOf(poll.now);
    const emitted: Emit[] = [];
    for (const e of depegEmits(poll.probes, snap.symbol)) {
      const key = `${e.type}|${e.edge}`;
      const prior = state.get(key);
      const cd = cooldownSecondsFor(sevOfRank(e.rank));
      if (prior && prior.rank >= e.rank && ts - prior.ts < cd) continue; // 동일/하위 severity 쿨다운 내 → dedup
      state.set(key, { rank: e.rank, ts });
      emitted.push(e);
    }
    lastDepeg = emitted;
  }
  const lastEmitted: Emit[] = [...lastDepeg, ...supplyConst];

  const should = (c.should_fire ?? []) as { signal_type: string; min_severity?: string }[];
  const mustNot = (c.must_not_fire ?? []) as { signal_type: string }[];
  const drivenShould = should.filter((s) => DRIVEN.has(s.signal_type));
  const partial = should.length > 0 && drivenShould.length < should.length;

  // 양성(should_fire)을 하나도 검증 못 하면 UNCOVERED.
  if (should.length > 0 && drivenShould.length === 0) {
    return { event: eventName, id, status: "UNCOVERED", partial: false, detail: `미구동 신호만 기대: ${should.map((s) => s.signal_type).join(",")}` };
  }
  const maxRankOf = (type: string) => lastEmitted.filter((e) => e.type === type).reduce((mx, e) => Math.max(mx, e.rank), -1);

  // FN — 구동 should_fire 가 안 떴거나 severity 부족.
  for (const s of drivenShould) {
    const need = RANK[s.min_severity ?? "INFO"] ?? 0;
    const got = maxRankOf(s.signal_type);
    if (got < need) return { event: eventName, id, status: "MISS", partial, detail: `${s.signal_type} 기대 ≥${s.min_severity ?? "INFO"}, 실제 ${got < 0 ? "없음" : sevOfRank(got)}` };
  }
  // FP — 구동 must_not_fire 가 WARN+ 로 떴으면 실패.
  for (const m of mustNot) {
    if (!DRIVEN.has(m.signal_type)) continue;
    const got = maxRankOf(m.signal_type);
    if (got >= RANK.WARN) return { event: eventName, id, status: "FORBIDDEN", partial, detail: `${m.signal_type} 침묵해야 하나 ${sevOfRank(got)} 로 발화` };
  }
  return { event: eventName, id, status: "PASS", partial, detail: (drivenShould.map((s) => s.signal_type).join(",") || "controls") };
}

function main() {
  const events = readdirSync(EVENTS_DIR).filter((d) => { try { return statSync(resolve(EVENTS_DIR, d)).isDirectory() && !d.startsWith("_"); } catch { return false; } }).sort();
  const results: CaseResult[] = [];
  for (const ev of events) {
    const dir = resolve(EVENTS_DIR, ev);
    let label: { cases?: Record<string, unknown>[] };
    try { label = JSON.parse(readFileSync(resolve(dir, "label.json"), "utf8")); } catch { continue; }
    for (const c of label.cases ?? []) results.push(runCase(ev, dir, c));
  }

  const scored = results.filter((r) => r.status !== "UNCOVERED");
  const pass = scored.filter((r) => r.status === "PASS").length;
  const miss = scored.filter((r) => r.status === "MISS");
  const forbidden = scored.filter((r) => r.status === "FORBIDDEN");
  const uncovered = results.filter((r) => r.status === "UNCOVERED").length;
  const partialN = scored.filter((r) => r.partial).length;

  console.log(`\n═══ 백테스트 스코어보드 (DEPEG·LARGE_SINGLE_MINT·TOTAL_SUPPLY_SPIKE·UNMATCHED_MINT·UNBACKED_SUPPLY) ═══`);
  console.log(`사건 ${events.length}개 · case ${results.length}개 (구동채점 ${scored.length} / 미구동 ${uncovered} · 부분커버 ${partialN})`);
  console.log(`  ✓ PASS ${pass}  ·  ✗ MISS(FN) ${miss.length}  ·  ✗ FORBIDDEN(FP) ${forbidden.length}`);
  const recall = pass + miss.length ? pass / (pass + miss.length) : 1;
  const fpRate = scored.length ? forbidden.length / scored.length : 0;
  console.log(`  recall ${(recall * 100).toFixed(1)}%  ·  FP rate ${(fpRate * 100).toFixed(1)}%  ·  결과: ${miss.length === 0 && forbidden.length === 0 ? "🟢 GREEN" : "🔴 RED"}`);
  if (miss.length || forbidden.length) {
    console.log("\n실패 case:");
    for (const r of [...miss, ...forbidden]) console.log(`  [${r.status}] ${r.event}/${r.id} — ${r.detail}`);
  }
  if (VERBOSE) {
    console.log("\n전체 case:");
    for (const r of results) console.log(`  ${r.status === "PASS" ? "✓" : r.status === "UNCOVERED" ? "·" : "✗"} [${r.status}${r.partial ? "/부분" : ""}] ${r.event}/${r.id} — ${r.detail}`);
  }
  process.exit(miss.length === 0 && forbidden.length === 0 ? 0 : 1);
}

main();
