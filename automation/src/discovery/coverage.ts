/**
 * 누적 커버리지 선택기 — metric 큰 순으로 더해 coverageTarget 비율 도달까지 포함.
 * 절대 하한(minUsd) 미만은 먼지로 제외. topN 으로 상한.
 *
 * 예: coverage 0.95 → 담보 TVL 의 95% 를 설명하는 상위 토큰들만.
 */
export function selectByCoverage<T extends { collateralUsd: number }>(
  items: T[],
  opts: { coverageTarget: number; minUsd: number; topN: number; label?: string },
): T[] {
  const sorted = [...items].filter((x) => x.collateralUsd >= opts.minUsd).sort((a, b) => b.collateralUsd - a.collateralUsd);
  const total = sorted.reduce((s, x) => s + x.collateralUsd, 0);
  if (total <= 0) return [];

  const out: T[] = [];
  let cum = 0;
  for (const x of sorted) {
    out.push(x);
    cum += x.collateralUsd;
    if (cum >= total * opts.coverageTarget) break; // 목표 커버리지 도달 → 중단
    if (out.length >= opts.topN) break;
  }
  const cutUsd = out.length > 0 ? out[out.length - 1].collateralUsd : 0;
  if (opts.label) {
    console.log(
      `[${opts.label}] 총 $${(total / 1e9).toFixed(2)}B · 커버리지 ${(opts.coverageTarget * 100).toFixed(0)}% ` +
        `→ ${out.length}개 (컷 $${(cutUsd / 1e6).toFixed(1)}M, 하한 $${(opts.minUsd / 1e6).toFixed(1)}M)`,
    );
  }
  return out.slice(0, opts.topN);
}
