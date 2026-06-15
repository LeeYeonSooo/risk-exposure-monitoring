/**
 * 심각도 단일 출처 — 색·라벨·정렬 순위. 4개 표면(홈·AlertDock·AlertPanel·RiskHistory)이 공유해
 * info=초록vs파랑, warning 필터 의미 상이 같은 표면별 불일치를 제거한다.
 * info 는 파랑 계열로 통일(초록은 '정상' 신호로 읽혀 리스크 UI 와 의미 충돌).
 */

export type Severity = "critical" | "warning" | "info";

export const SEV_ORDER: Record<string, number> = { critical: 3, warning: 2, info: 1 };

/** 점/텍스트 강조용 색(불투명). */
export const SEV_COLOR: Record<string, string> = {
  critical: "#f87171", // red-400
  warning: "#fbbf24",  // amber-400
  info: "#60a5fa",     // blue-400 (← 초록 제거)
};

/** 행 배경(반투명). */
export const SEV_ROW_BG: Record<string, string> = {
  critical: "rgba(248,113,113,0.18)",
  warning: "rgba(251,191,36,0.18)",
  info: "rgba(96,165,250,0.16)",
};

export const SEV_LABEL: Record<string, string> = {
  critical: "위험",
  warning: "경고",
  info: "정보",
};

/** critical 먼저, 그다음 시간 내림차순으로 정렬할 때의 심각도 비교(내림차순). */
export function compareSeverityDesc(a: string, b: string): number {
  return (SEV_ORDER[b] ?? 0) - (SEV_ORDER[a] ?? 0);
}

/** 누적('이상') 필터: 선택 심각도 이상이면 통과. 'warning' 선택 시 critical 포함. */
export function severityAtLeast(sev: string, floor: string): boolean {
  return (SEV_ORDER[sev] ?? 0) >= (SEV_ORDER[floor] ?? 0);
}
