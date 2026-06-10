-- ─────────────────────────────────────────────────────────────
-- Migration 006 — 관리자 수동 의도 (pin / exclude)
--
-- 자동 임계 발굴 위에 관리자 오버라이드:
--   - pin:     reason='manual', active=TRUE → 임계 미달이어도 항상 추적,
--              discover 의 deactivateDiscoveredExcept 가 건드리지 않음(reason<>'manual')
--   - exclude: excluded=TRUE → 임계 통과해도 discover 가 재활성화하지 않음
-- ─────────────────────────────────────────────────────────────

ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_watchlist_excluded ON watchlist(excluded) WHERE excluded;
