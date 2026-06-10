-- ─────────────────────────────────────────────────────────────
-- Migration 011 — 체인별 totalSupply 시계열(chain_supply_samples)
--
-- 왜: 기존 supply_samples 는 토큰당 totalSupply 1개(사실상 이더리움)만 추적 →
--   "어느 체인에서든 비정상 민팅"(전문가 #1 시그널, 무한민팅)을 체인 단위로 못 잡음.
--   L2/사이드체인에 브릿지로 들어온 양이 갑자기 튀는 것도 위험 신호다.
--   체인별 onchain totalSupply(eth_call) 를 스냅샷마다 append → (token, chain) 별 시계열.
--   diff/감시 스크립트가 (token,chain) 별 robust z-score 로 chain_supply_spike 알림 생성.
--
-- supply_usd 도 같이 보존(시세 변동 분리 분석용). token_node_id 는 체인 무관 심볼 키
-- (예: token:wstETH) + chain 컬럼 → 한 토큰의 전 체인 공급을 한 테이블에서 비교.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chain_supply_samples (
  snapshot_ts   timestamptz      NOT NULL,
  token_node_id text             NOT NULL,
  chain         text             NOT NULL,
  block_number  bigint,
  total_supply  double precision NOT NULL,
  supply_usd    double precision,
  PRIMARY KEY (token_node_id, chain, snapshot_ts)
);

CREATE INDEX IF NOT EXISTS idx_chain_supply_samples_key
  ON chain_supply_samples (token_node_id, chain, snapshot_ts DESC);

-- TimescaleDB 있으면 hypertable + 보존 정책(180일).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    BEGIN
      PERFORM create_hypertable('chain_supply_samples', 'snapshot_ts', if_not_exists => TRUE, migrate_data => TRUE);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'chain_supply_samples hypertable skip: %', SQLERRM;
    END;
    BEGIN
      PERFORM add_retention_policy('chain_supply_samples', INTERVAL '180 days', if_not_exists => TRUE);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'chain_supply_samples retention skip: %', SQLERRM;
    END;
  END IF;
END $$;
