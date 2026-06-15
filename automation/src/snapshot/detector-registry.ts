/**
 * 디텍터 레지스트리 — 알림 source 의 state/event 분류 단일 출처. (2026-06 리팩터.)
 *
 * STATE 디텍터: 조건이 지속되는 동안 standing alert 를 유지하고, 조건 해소 시 resolveStaleAlerts 로 즉시 정리.
 *   (전체스캔이 매번 assert → 빠진 키 auto-resolve.)
 * EVENT 디텍터: 1회성 사건. 자체 해소 로직이 없어 조건 종료 후에도 DB 에 남는다 → resolveExpiredEvents 의
 *   severity 별 TTL 스윕으로 만료(프론트 24h fade 와 DB 상태 일치). 분류를 source 로 한다(kind 보다 안정적).
 */

/** resolveStaleAlerts 로 auto-resolve 되는 STATE 디텍터 source. 이벤트 TTL 스윕에서 제외(upsert.resolveExpiredEvents 가 SQL set-필터로 소비). */
export const STATE_SOURCES = ["currentscan-v1", "supply-conservation-v1"] as const;
