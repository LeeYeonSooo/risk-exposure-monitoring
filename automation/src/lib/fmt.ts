/**
 * 금액 포맷터 — 단일 출처(의존성 없는 leaf 모듈). 어디서든 안전하게 import.
 *
 * 2026-06 통합: rules/shared.formatUsd · scanner-kit.fmtUsd/fmtToken · supply-backing.fmtAmount ·
 *   scripts 의 6개 로컬 fmtUsd 복사본이 제각기 라운딩(M/K 자릿수·sub-$1k 분기)이 달라 같은 값이 다르게
 *   렌더되던 것을 하나로. (구버전 일부는 sub-$1k 분기 누락으로 $500→"$0K" 버그.) 표준 = $1.2B/$3.4M/$56K/$12.34.
 */

/** USD compact ($1.20B / $3.40M / $56.00K / $12.34). null/NaN 은 "—". */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/** raw bigint 토큰량 → 사람단위 compact (1.20B / 3.40M / 5.6K / 12.34). */
export function fmtToken(raw: bigint, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}
