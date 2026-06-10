-- 010: 자금추적/루핑 계약 — loop_findings.
-- 외부 팀의 자금추적·셀프루핑 탐지 알고리즘이 swap 될 슬롯.
-- 현 구조적 ouroboros 휴리스틱(morpho-blue.ts) = source 'structural-v1' 로 기록.
-- 외부 flow-tracker 는 같은 스키마에 'flowtracker-vX' 로 풍부한 row(participants·실 looped$) 기록.
-- UI(그래프 빨강 루프, Tier3 패널)는 이 테이블만 읽음 → provider 교체 시 무변경.
CREATE TABLE IF NOT EXISTS loop_findings (
  id                BIGSERIAL PRIMARY KEY,
  snapshot_ts       TIMESTAMPTZ,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  token             TEXT NOT NULL,
  token_node_id     TEXT,
  protocol_node_id  TEXT,
  market_key        TEXT,
  kind              TEXT NOT NULL,            -- 'ouroboros' | 'self_loop' | 'cross_protocol'
  collateral_symbol TEXT,
  loan_symbol       TEXT,
  looped_usd        NUMERIC,
  lltv              NUMERIC,
  participants      JSONB,                    -- 외부 flow-tracker 가 채울 차입자/지갑
  confidence        TEXT,                     -- 'low' | 'medium' | 'high'
  source            TEXT NOT NULL DEFAULT 'structural-v1',
  detail            JSONB
);

-- 같은 provider 의 같은 (토큰,마켓,kind) 은 최신값으로 upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_findings
  ON loop_findings (source, coalesce(token_node_id,''), coalesce(market_key,''), kind);

CREATE INDEX IF NOT EXISTS idx_loop_findings_token ON loop_findings (token_node_id, detected_at DESC);
