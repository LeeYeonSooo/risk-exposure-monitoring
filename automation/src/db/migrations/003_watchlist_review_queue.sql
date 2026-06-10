-- ─────────────────────────────────────────────────────────────
-- Migration 003 — watchlist review queue
--
-- Discovery 가 찾은 새 토큰은 active=FALSE 로 "제안(proposed)" 상태로 들어감.
-- snapshot:all 은 active=TRUE 만 스냅샷하므로, 사람이 승인하기 전까지는
-- 추적되지 않음. 승인 = active 를 TRUE 로 flip.
--
-- 추가 컬럼:
--   discovery_metric_usd : 담보 순위 metric (Morpho collateralUsd / Aave aToken USD)
--   discovery_source     : 'morpho_collateral' | 'aave_reserve' | 'seed' | 'manual'
--   reviewed_at          : 사람이 검토(승인/거절)한 시각
-- ─────────────────────────────────────────────────────────────

ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS discovery_metric_usd NUMERIC;
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS discovery_source TEXT;
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- 제안 상태 토큰 빠른 조회
CREATE INDEX IF NOT EXISTS idx_watchlist_proposed ON watchlist(active) WHERE NOT active;
