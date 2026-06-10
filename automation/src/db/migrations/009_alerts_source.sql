-- 009: 알림 계약 — source/algo_version 컬럼.
-- 외부 위험-알림 알고리즘이 swap 될 때 어느 알고리즘이 낸 알림인지 추적·A/B.
-- 현 builtin detector(diff.ts + scan-current-risks.ts) = 'builtin-v1'.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'builtin-v1';

-- 토큰별 알림 히스토리(Tier1) 조회용 인덱스.
CREATE INDEX IF NOT EXISTS idx_alerts_token_created ON alerts (token, created_at DESC);
