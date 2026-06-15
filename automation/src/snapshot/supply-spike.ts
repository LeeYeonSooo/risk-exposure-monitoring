/**
 * 공급 급증(z-score) 게이트 — diff.ts checkTotalSupply 와 snapshot-chain-supply.ts 가 복붙하던
 *   "연속델타 baseline + robustZ + relDelta/minAbs/zscore 게이트"를 단일 함수로. (2026-06 리팩터.)
 *   호출자는 stats(d/z/relDelta/baseline)와 core 게이트 통과여부(fires)를 받아, 각자 추가 가드를 덧댄다
 *   (diff=designedRebase·decliningNoise, chain-supply=없음).
 */
import { robustZ } from "@/lib/stats";

export interface SupplySpikeThresholds {
  minSamples: number;
  minAbsDeltaTokens: number;
  minRelDelta: number;
  zscore: number;
}

export interface SupplySpikeStats {
  d: number;            // curr − 직전 샘플
  z: number;            // robust z-score
  relDelta: number;     // |d| / curr
  baseline: number[];   // 연속델타(오래된→최신)
  fires: boolean;       // core 게이트 통과(d>0 · |d|≥minAbs · relDelta≥minRel · |z|≥zscore)
}

/**
 * @param samplesAsc 오래된→최신 순 공급 샘플(현재값 curr 제외)
 * @param minRel     relDelta 플로어(diff=minRelDelta 0.5% · chain-supply=whitelisted?5%:2%)
 */
export function supplySpikeStats(
  samplesAsc: number[],
  curr: number,
  t: SupplySpikeThresholds,
  opts: { whitelisted: boolean; minRel: number },
): SupplySpikeStats | null {
  if (samplesAsc.length < t.minSamples) return null;
  const last = samplesAsc[samplesAsc.length - 1];
  const d = curr - last;
  const baseline: number[] = [];
  for (let i = 1; i < samplesAsc.length; i++) baseline.push(samplesAsc[i] - samplesAsc[i - 1]);
  const z = robustZ(d, baseline);
  const relDelta = curr > 0 ? Math.abs(d) / curr : 0;
  const minAbs = opts.whitelisted ? t.minAbsDeltaTokens * 100 : t.minAbsDeltaTokens;
  const fires = d > 0 && Math.abs(d) >= minAbs && relDelta >= opts.minRel && Math.abs(z) >= t.zscore;
  return { d, z, relDelta, baseline, fires };
}
