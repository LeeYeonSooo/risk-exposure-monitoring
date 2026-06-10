-- ─────────────────────────────────────────────────────────────
-- Migration 004 — alerts (diff 엔진이 만든 알림을 적재, 프론트 패널에서 조회)
-- 외부 전송(Slack)은 추후. 우선 DB 적재 → /api/alerts → 패널.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alerts (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_ts   TIMESTAMPTZ,
  severity      TEXT NOT NULL,            -- 'critical' | 'warning' | 'info'
  kind          TEXT NOT NULL,            -- 'new_market' | 'oracle_changed' | ...
  token         TEXT NOT NULL,            -- 토큰 라벨 (e.g. "WBTC")
  protocol_node_id TEXT,                  -- 관련 프로토콜 (있으면)
  message       TEXT NOT NULL,
  detail        JSONB,
  acknowledged  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts(token);
