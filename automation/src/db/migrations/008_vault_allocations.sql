-- P2: 큐레이터 볼트 마켓 할당 시계열 — 디리스킹 신호(withdraw queue 제거/적극 인출) 탐지용.
CREATE TABLE IF NOT EXISTS vault_allocations (
  snapshot_ts        TIMESTAMPTZ NOT NULL,
  chain              TEXT NOT NULL,
  vault_address      TEXT NOT NULL,
  vault_name         TEXT,
  curator            TEXT,
  market_key         TEXT NOT NULL,        -- collateral|loan|lltv 로 마켓 식별
  collateral         TEXT,
  supply_usd         DOUBLE PRECISION,
  in_withdraw_queue  BOOLEAN,
  utilization        DOUBLE PRECISION,
  PRIMARY KEY (snapshot_ts, vault_address, market_key)
);
CREATE INDEX IF NOT EXISTS idx_vault_alloc_lookup
  ON vault_allocations (vault_address, market_key, snapshot_ts DESC);
