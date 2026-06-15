-- ─────────────────────────────────────────────────────────────
-- Migration 017 — 상태형 알림 auto-resolve (resolved_at)
-- 조건이 해소된 상태형 알림(reserve_frozen·high_utilization·high_lltv·near_liquidation 등)을
-- 전체스캔 디텍터가 resolved 로 내려 피드에서 자동 제거. acknowledged(수동 처리)와 의미 분리.
-- 활성 = acknowledged IS NOT TRUE AND resolved_at IS NULL.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- 활성 알림 조회·dedup 가속 (kind+token 으로 active 만)
CREATE INDEX IF NOT EXISTS idx_alerts_active
  ON alerts(kind, token)
  WHERE acknowledged IS NOT TRUE AND resolved_at IS NULL;
