/**
 * Rule 5 / 6: totalSupply 급변(supply_single_mint·supply_spike) + 고래 unwind(whale_unwind). (diff.ts 에서 분리.)
 */
import { severityForValue, type AlertThresholds, type Severity } from "@/config/alert-thresholds";
import { type DiffAlert, formatUsd } from "@/snapshot/rules/shared";
import { supplySpikeStats } from "@/snapshot/supply-spike";
import type { TokenSnapshotResult } from "@/types/edge-schema";

// 탄력 공급(리베이스) 토큰 — 1스냅샷 0.5~50% 공급변화가 '설계된 리베이스'일 수 있는 토큰만 designedRebase 억제.
//   그 외 토큰의 0.5~50% 점프(z≥6)는 진짜 mint/burn 이므로 통계 스파이크로 발화해야 함.
//   stETH/OETH/superOETHb = 실제 리베이싱(yield 분배), AMPL = 대표 elastic-supply(안전망).
const REBASE_TOKENS = new Set(["STETH", "OETH", "SUPEROETHB", "AMPL"]);
function isRebaseToken(sym: string): boolean { return REBASE_TOKENS.has((sym ?? "").toUpperCase()); }

export function checkTotalSupply(
  current: TokenSnapshotResult,
  prevBlock: number | null,
  recentSamples: number[], // 과거 totalSupply (현재 ts 미만), 최신순
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  const symbol = current.token.label;
  const curr = current.token.metadata.totalSupply;
  const whitelisted = t.totalSupply.autoMintWhitelist.includes(symbol);
  const ts = t.totalSupply;

  // ── 단일 블록 %of-supply (single-tx large mint) ──
  if (prevBlock != null && prevBlock > 0 && curr > prevBlock) {
    const pct = (curr - prevBlock) / prevBlock;
    const bps = pct * 10_000;
    const thrBps = whitelisted ? ts.singleTxPctBps * 2 : ts.singleTxPctBps;
    const critBps = whitelisted ? ts.largeSingleMintBps * 2 : ts.largeSingleMintBps;
    if (bps >= thrBps) {
      // ≥largeSingleMintBps(10%) 단일-블록 mint = 크기 무관 critical (provenance 우선, risk_rules large_single_mint_high).
      const sev: Severity = bps >= critBps ? "critical" : "warning";
      out.push({
        severity: sev,
        kind: "supply_single_mint",
        token: symbol,
        message: `totalSupply +${(pct * 100).toFixed(2)}% · 단일 블록`,
        detail: { prevBlock, curr, deltaPct: pct, bps: Math.round(bps), block: current.blockNumber },
      });
    }
  }

  // ── robust z-score 스파이크 — chain-supply 와 공용 게이트(supplySpikeStats) ──
  if (recentSamples.length >= ts.minSamples) {
    const asc = [...recentSamples].reverse(); // 오래된→최신
    const st = supplySpikeStats(asc, curr, ts, { whitelisted, minRel: ts.minRelDelta });
    // 설계된 리베이스 억제(rebaseSaneMax): 1스냅샷 |Δ| 가 rebaseSaneMax(50%) 안이고 단일-블록 이산 mint 가 없으면
    //   탄력 공급(AMPL 등)으로 보고 통계 스파이크 억제(진짜 무한민팅·provenance 경로는 영향 없음).
    const last = asc[asc.length - 1];
    const snapPct = st && last > 0 ? Math.abs(st.d) / last : 0;
    const discreteMint = out.some((a) => a.kind === "supply_single_mint");
    const designedRebase = isRebaseToken(symbol) && snapPct <= ts.rebaseSaneMax && !discreteMint;
    // MAD-붕괴 z폭발 가드(FP 감사 2026-06, wsrUSD): 윈도가 평탄/하락(순변화≤0 또는 양의델타비율<20%)인데
    //   delta 가 이산-mint(5%) 미만이면 하락추세의 단일 반등(MAD≈0 z폭발)이지 무한민팅 아님. 진짜 대량mint(≥5%)는 통과.
    const windowNet = curr - asc[0];
    const posShare = st && st.baseline.length ? st.baseline.filter((x) => x > 0).length / st.baseline.length : 1;
    const decliningNoise = !!st && (windowNet <= 0 || posShare < 0.2) && st.relDelta < 0.05;
    if (st && st.fires && !designedRebase && !decliningNoise) {
      out.push({
        severity: "info", // 통계-only → 페이지 X (alarm WATCH 등급)
        kind: "supply_spike",
        token: symbol,
        message: `totalSupply 급증 +${st.d.toFixed(2)} · z ${st.z.toFixed(1)}`,
        detail: { curr, delta: st.d, z: Number(st.z.toFixed(2)), samples: recentSamples.length },
      });
    }
  }

  // ── corroboration: 단일-tx mint + 통계 스파이크 동시 → critical 승격 ──
  const single = out.find((a) => a.kind === "supply_single_mint");
  if (single && out.some((a) => a.kind === "supply_spike")) {
    single.severity = "critical";
    single.message = `${single.message} · 통계 동반 확증`;
  }

  return out;
}

function mergeSeverity(a: Severity | null, b: Severity | null): Severity | null {
  if (!a && !b) return null;
  const rank = { info: 1, warning: 2, critical: 3 } as const;
  const ar = a ? rank[a] : 0;
  const br = b ? rank[b] : 0;
  const max = Math.max(ar, br);
  if (max === 3) return "critical";
  if (max === 2) return "warning";
  return "info";
}

export function checkWhaleUnwind(
  current: TokenSnapshotResult,
  prevTopHolders: Array<{ address: string; amount: number }> | null,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  const currTop = current.token.metadata.topHolders ?? [];
  if (!prevTopHolders || prevTopHolders.length === 0 || currTop.length === 0) return out;

  // Token price 추정 — marketCapUsd / totalSupply
  const meta = current.token.metadata;
  const priceUsd = meta.totalSupply > 0 && meta.marketCapUsd
    ? meta.marketCapUsd / meta.totalSupply
    : 1;

  const prevByAddr = new Map(prevTopHolders.map((h) => [h.address.toLowerCase(), h.amount]));

  for (const c of currTop.slice(0, t.whaleUnwind.trackTopN)) {
    const prevAmt = prevByAddr.get(c.address.toLowerCase());
    if (prevAmt == null || prevAmt <= 0) continue;
    if (c.amount >= prevAmt) continue;  // 증가 또는 동일 → 무시

    const dropAbsToken = prevAmt - c.amount;
    const dropPct = dropAbsToken / prevAmt;
    const dropUsd = dropAbsToken * priceUsd;

    // dust 플로어: $1M(absDropUsd.info) 미만 인출은 % 가 커도 무시 — $100k 짜리 50% 인출이 critical 페이지 되던 것 차단
    // (risk_rules whale_dust_usd: mergeSeverity(max) 가 % 만으로 승격하던 우회를 절대 USD 게이트로 막음).
    if (dropUsd < t.whaleUnwind.absDropUsd.info) continue;
    const pctSev = severityForValue(dropPct, t.whaleUnwind.perSnapshotDropPct);
    const usdSev = severityForValue(dropUsd, t.whaleUnwind.absDropUsd);
    const severity = mergeSeverity(pctSev, usdSev);
    if (!severity) continue;

    out.push({
      severity,
      kind: "whale_unwind",
      token: current.token.label,
      message: `${c.address.slice(0, 6)}…${c.address.slice(-4)} — −${(dropPct * 100).toFixed(1)}% · ${formatUsd(dropUsd)}`,
      detail: { address: c.address, prevAmount: prevAmt, currAmount: c.amount, dropPct, dropUsd },
    });
  }
  return out;
}
