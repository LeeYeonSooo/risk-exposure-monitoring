-- ─────────────────────────────────────────────────────────────
-- Migration 012 — 지갑 추적(DeBank) : tracked_wallets + wallet_snapshots
--
-- 왜: 전문가 인터뷰 권장 — 큐레이터/고래 지갑의 포지션을 추적해 "매핑 지갑 밸류 급감"
--   (자금 이탈 = 디리스킹/런 조기경보)을 잡는다. DeBank 우회 스크레이프로 프로토콜별
--   포지션 + 총가치(USD)를 받아 시계열로 쌓고, 직전 스냅샷 대비 급감 시 wallet_value_drop 알림.
--
-- tracked_wallets : 감시할 지갑 화이트리스트(큐레이터·고래·수동). active 만 스냅샷.
-- wallet_snapshots: (wallet, ts) 시계열 — total_usd + 프로토콜/토큰 포지션(jsonb).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tracked_wallets (
  wallet       text PRIMARY KEY,           -- 0x… (소문자)
  label        text,                       -- 사람이 읽는 이름(큐레이터/펀드명 등)
  kind         text,                       -- 'curator' | 'whale' | 'fund' | 'manual'
  source_token text,                       -- 어느 토큰 추적 중 발견됐는지(옵션)
  active       boolean NOT NULL DEFAULT true,
  added_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_snapshots (
  snapshot_ts    timestamptz      NOT NULL,
  wallet         text             NOT NULL,
  total_usd      double precision NOT NULL,
  protocol_count integer,
  protocols      jsonb,            -- [{protocolName, chain, netUsdValue}]
  wallet_tokens  jsonb,            -- [{symbol, usdValue, chain}] (상위 일부)
  source         text,             -- 'debank' | 'alchemy' | 'debank+alchemy'
  PRIMARY KEY (wallet, snapshot_ts)
);

CREATE INDEX IF NOT EXISTS idx_wallet_snapshots_wallet_ts
  ON wallet_snapshots (wallet, snapshot_ts DESC);

-- TimescaleDB 있으면 hypertable + 보존 정책(180일).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    BEGIN
      PERFORM create_hypertable('wallet_snapshots', 'snapshot_ts', if_not_exists => TRUE, migrate_data => TRUE);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'wallet_snapshots hypertable skip: %', SQLERRM;
    END;
    BEGIN
      PERFORM add_retention_policy('wallet_snapshots', INTERVAL '180 days', if_not_exists => TRUE);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'wallet_snapshots retention skip: %', SQLERRM;
    END;
  END IF;
END $$;
