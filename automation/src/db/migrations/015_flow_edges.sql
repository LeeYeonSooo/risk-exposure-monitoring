-- 015: 트랜잭션 플로우 그래프 (kuromi flow_trace 포팅, Dune erc20 Transfer 기반)
-- 토큰별 "코어 행위자 + 행위자간 멀티자산 방향 흐름" — 상세그래프 탭 전용(관계맵 비노출).
-- 토큰당 최신 런 1개만 유지(REPLACE 시맨틱: 런너가 DELETE 후 INSERT). 이력은 flow_runs 가 보존.

CREATE TABLE IF NOT EXISTS flow_runs (
  id            BIGSERIAL PRIMARY KEY,
  token_symbol  TEXT NOT NULL,
  chain         TEXT NOT NULL DEFAULT 'ethereum',
  snapshot_ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_days   INT NOT NULL,
  max_actors    INT NOT NULL,
  dune_query_id BIGINT,
  dune_execution_id TEXT,
  stats         JSONB           -- {actors, edges, cycleNodes, cycleEdges, lenders…}
);
CREATE INDEX IF NOT EXISTS idx_flow_runs_token ON flow_runs (token_symbol, chain, snapshot_ts DESC);

CREATE TABLE IF NOT EXISTS flow_nodes (
  token_symbol  TEXT NOT NULL,
  chain         TEXT NOT NULL DEFAULT 'ethereum',
  addr          TEXT NOT NULL,           -- lower-hex 주소
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL,           -- mint_burn | EOA | token | protocol | contract
  protocol_family TEXT,                  -- 레지스트리 매칭 시 family (morpho_blue 등)
  degree        INT,                     -- 대상 토큰 transfer 활동량 (시드 랭킹)
  is_seed       BOOLEAN NOT NULL DEFAULT false,
  in_cycle      BOOLEAN NOT NULL DEFAULT false,
  snapshot_ts   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (token_symbol, chain, addr)
);

CREATE TABLE IF NOT EXISTS flow_edges (
  token_symbol  TEXT NOT NULL,
  chain         TEXT NOT NULL DEFAULT 'ethereum',
  src           TEXT NOT NULL,
  dst           TEXT NOT NULL,
  asset_addr    TEXT NOT NULL,
  asset_symbol  TEXT,
  suspicious    BOOLEAN NOT NULL DEFAULT false,  -- 심볼 스푸핑 의심(비ASCII 정제/메이저 사칭)
  amount        NUMERIC,                 -- 토큰 단위 합 (decimals 반영)
  amount_usd    NUMERIC,                 -- 가격 알 때만 (llama)
  transfer_count INT NOT NULL DEFAULT 1,
  role          TEXT,                    -- 공급/담보 · 차입/인출 (렌더에 그대로)
  in_cycle      BOOLEAN NOT NULL DEFAULT false,  -- 병적 자기조달 고리 위의 엣지
  is_mint_burn  BOOLEAN NOT NULL DEFAULT false,
  min_block     BIGINT, max_block BIGINT,
  sample_tx     TEXT,
  snapshot_ts   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (token_symbol, chain, src, dst, asset_addr)
);
CREATE INDEX IF NOT EXISTS idx_flow_edges_token ON flow_edges (token_symbol, chain);
