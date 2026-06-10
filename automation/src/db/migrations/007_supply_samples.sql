-- ─────────────────────────────────────────────────────────────
-- Migration 007 — totalSupply 시계열(supply_samples)
--
-- 왜: 기존엔 nodes.metadata.totalSupply(현재값 1개)만 보존 → 견고한 z-score
--   (alarm-totalsupply Detector C: median/MAD modified z) 에 필요한 "윈도(과거 N개
--   샘플)"가 없었음. 토큰별 totalSupply 를 스냅샷마다 append 해 시계열로 쌓는다.
--   diff 의 z-score 는 current 미만 ts 의 최근 N개로 baseline 을 만든다.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supply_samples (
  snapshot_ts   timestamptz      NOT NULL,
  token_node_id text             NOT NULL,
  block_number  bigint,
  total_supply  double precision NOT NULL,
  PRIMARY KEY (token_node_id, snapshot_ts)
);

CREATE INDEX IF NOT EXISTS idx_supply_samples_token_ts
  ON supply_samples (token_node_id, snapshot_ts DESC);

-- TimescaleDB 있으면 hypertable + 보존 정책(180일이면 윈도 N=50 충분).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    BEGIN
      PERFORM create_hypertable('supply_samples', 'snapshot_ts', if_not_exists => TRUE, migrate_data => TRUE);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'supply_samples hypertable skip: %', SQLERRM;
    END;
    BEGIN
      PERFORM add_retention_policy('supply_samples', INTERVAL '180 days', if_not_exists => TRUE);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'supply_samples retention skip: %', SQLERRM;
    END;
  END IF;
END $$;
