/**
 * Robust statistics — median / MAD / modified z-score.
 * alarm-totalsupply 의 detector/precision.py 를 충실히 포팅.
 *
 * mean+stddev 는 우리가 찾는 이상치(outlier) 자체에 끌려다님 → median+MAD 사용.
 */

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Median absolute deviation. */
export function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Modified z-score: 0.6745 * (x - median) / MAD.
 * MAD==0 (degenerate/flat baseline) 또는 baseline<2 면 0 반환 →
 * 호출부는 반드시 절대 하한(minAbsDelta)과 함께 써서 flat history 에서
 * 작은 움직임이 거대해 보이지 않게 해야 함.
 */
export function robustZ(x: number, baseline: number[]): number {
  if (baseline.length < 2) return 0;
  const m = mad(baseline);
  if (m === 0) return 0;
  return (0.6745 * (x - median(baseline))) / m;
}
