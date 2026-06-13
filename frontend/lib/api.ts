/**
 * 흐름맵 공용 포매터. (배포 준비성 정리 2026-06-13: 흐름맵만 남기며 이 파일은 흐름맵이 실제로
 * 쓰는 formatUsd 만 남기고 트림됨 — 구 그래프/토폴로지 타입과 edge-schema 의존은 제거.)
 */
export function formatUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}
