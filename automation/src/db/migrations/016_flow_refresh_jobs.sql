-- 016: 트랜잭션 플로우 온디맨드 갱신 큐
-- API 는 캐시를 즉시 반환하고, 누락/오래된 토큰만 백그라운드 갱신으로 넘긴다.

CREATE TABLE IF NOT EXISTS flow_refresh_jobs (
  id            BIGSERIAL PRIMARY KEY,
  token_symbol  TEXT NOT NULL,
  chain         TEXT NOT NULL DEFAULT 'ethereum',
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | failed
  source        TEXT NOT NULL DEFAULT 'auto',   -- auto | dune | rpc
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT,
  pid           INT
);

CREATE INDEX IF NOT EXISTS idx_flow_refresh_jobs_token
  ON flow_refresh_jobs (token_symbol, chain, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_flow_refresh_jobs_active
  ON flow_refresh_jobs (token_symbol, chain, status, requested_at DESC);
