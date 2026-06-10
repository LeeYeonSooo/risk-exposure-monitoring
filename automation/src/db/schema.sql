-- ──────────────────────────────────────────────────────────────
-- WBTC Mapping — Postgres schema
-- Idempotent: same node_id → UPSERT, edges keyed by snapshot timestamp.
-- ──────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── watchlist: which tokens we snapshot every hour ─────────────
CREATE TABLE IF NOT EXISTS watchlist (
  token_address TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason        TEXT,                              -- 'seed' / 'morpho_top10' / 'aave_top10' / 'manual'
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_snapshot_ts TIMESTAMPTZ
);

-- ── nodes: token + protocol (idempotent via node_id PK) ────────
CREATE TABLE IF NOT EXISTS nodes (
  node_id     TEXT PRIMARY KEY,                    -- "token:WBTC" or "protocol:aave_v3"
  type        TEXT NOT NULL,                       -- 'Token' | 'DefiProtocol'
  label       TEXT NOT NULL,
  address     TEXT,
  chain       TEXT NOT NULL DEFAULT 'ethereum',
  metadata    JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_address ON nodes(address);
CREATE INDEX IF NOT EXISTS idx_nodes_label_trgm ON nodes USING gin (label gin_trgm_ops);

-- ── edges: time-series (one row per snapshot per token×protocol pair) ──
-- Multi-role: a single edge row carries 1..N roles inside attrs.classification.roles[]
-- (Aave V3 WBTC = collateral + loan_asset = 1 row, 2 roles).
-- `edge_type` column holds the legacy/display primary_role for fast filtering.
CREATE TABLE IF NOT EXISTS edges (
  snapshot_ts      TIMESTAMPTZ NOT NULL,
  token_node_id    TEXT NOT NULL,
  protocol_node_id TEXT NOT NULL,
  edge_type        TEXT NOT NULL,                    -- = attrs.classification.primary_role
  weight           DOUBLE PRECISION NOT NULL,        -- = sum of all role amounts (token units)
  attrs            JSONB NOT NULL,                   -- contains classification.roles[]
  block_number     BIGINT,
  PRIMARY KEY (snapshot_ts, token_node_id, protocol_node_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_token ON edges(token_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_protocol ON edges(protocol_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_ts ON edges(snapshot_ts DESC);

-- TimescaleDB hypertable (compresses well, fast time-bucketed queries).
-- If TimescaleDB not installed, this is a noop on the catalog level.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('edges', 'snapshot_ts', if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END$$;

-- ── unknown addresses queue (Slack review pattern) ─────────────
CREATE TABLE IF NOT EXISTS unknown_addresses (
  address              TEXT PRIMARY KEY,
  discovered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_seen_token     TEXT NOT NULL,
  raw_balance          NUMERIC NOT NULL,
  heuristic_hint       TEXT,
  reviewed             BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_to_node_id  TEXT,                       -- once labeled, what node it maps to
  notes                TEXT
);

CREATE INDEX IF NOT EXISTS idx_unknown_unreviewed ON unknown_addresses(reviewed) WHERE NOT reviewed;

-- ── snapshot runs (audit log of cron executions) ───────────────
CREATE TABLE IF NOT EXISTS snapshot_runs (
  id              SERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'ok' | 'error'
  token_address   TEXT,
  block_number    BIGINT,
  edges_written   INT,
  unknowns_added  INT,
  error_message   TEXT
);
