-- 프로토콜 활동(거래 수·거래 규모) — 토큰별·프로토콜별. 노드 크기 3요소(TVL + 트랜잭션 수 + 거래 규모)의
-- 트랜잭션/규모 축. 데이터 = Dune spell lending.supply/borrow(+후속 dex.trades) 집계, 무료 엔진(0.03크레딧/실행).
-- 주기 갱신 = scripts/snapshot-protocol-activity.ts (Dune REST). 토큰별 페이지에서 프로토콜 노드 크기에 반영.
CREATE TABLE IF NOT EXISTS protocol_activity (
  token_symbol text NOT NULL,
  chain        text NOT NULL DEFAULT 'ethereum',
  project      text NOT NULL,              -- Dune project 슬러그 (spark·aave·compound·morpho·aave_horizon …)
  tx_count     bigint NOT NULL DEFAULT 0,  -- 거래 수 (distinct tx_hash, supply+borrow)
  volume_usd   double precision NOT NULL DEFAULT 0, -- 거래 규모 (sum amount_usd)
  window_days  int NOT NULL DEFAULT 60,    -- 집계 윈도우(일)
  snapshot_ts  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_symbol, chain, project)
);
CREATE INDEX IF NOT EXISTS idx_protocol_activity_token ON protocol_activity (token_symbol, chain);
