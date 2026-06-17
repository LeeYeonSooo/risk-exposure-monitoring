-- 021: alerts.resolution_reason — 알림 해소/처리 사유 태그.
-- 왜: resolved_at 만으론 "왜 해소됐는지"를 구분 못 해 정밀 삭제/감사가 불가했다(2026-06: FP 일괄삭제 시 같은 kind 의
--   과거 resolved 까지 휩쓸림). reason 으로 FP/stale/auto 를 구분해 정밀 타깃.
-- 값 컨벤션: 'auto:condition_cleared'(scan auto-resolve) · 'auto:event_ttl'(이벤트 TTL 만료) · 'fp:*'·'stale:*'(수동 처리).
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution_reason text;
CREATE INDEX IF NOT EXISTS idx_alerts_resolution_reason ON alerts (resolution_reason) WHERE resolution_reason IS NOT NULL;
