-- 머니레고 구조 그래프 (2026-06-12, 멘토 피드백 §6·§8·§9)
-- 파생토큰(PT/YT/LP/aToken)을 1급 노드로, "자금흐름 없이도 구조로 잇는" 관계 엣지를 저장.
-- 시계열이 아니라 "현재 구조" 스냅샷 — 토큰 단위 replace 갱신 (만기 PT 등 소멸 반영).

CREATE TABLE IF NOT EXISTS lego_nodes (
  id           TEXT PRIMARY KEY,            -- deriv:0xaddr@chain | protocol:slug[@chain]
  chain        TEXT NOT NULL,
  address      TEXT,                        -- 컨트랙트 주소 (protocol 허브 노드는 NULL 가능)
  kind         TEXT NOT NULL,               -- 'derivative' | 'protocol'
  role         TEXT,                        -- pt|yt|lp|receipt|wrapper (derivative 만)
  label        TEXT NOT NULL,               -- 사람이 읽는 라벨 (PT-sUSDE-13AUG2026 등)
  symbol       TEXT,
  protocol     TEXT,                        -- 발행/호스팅 프로토콜 슬러그 (pendle|curve|aave_v3|convex|morpho_blue)
  parent_token TEXT,                        -- 기초 토큰 노드 id (token:sUSDe / token:sUSDe@base) — protocol 노드는 NULL
  meta         JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lego_nodes_parent ON lego_nodes(parent_token);
CREATE INDEX IF NOT EXISTS idx_lego_nodes_addr ON lego_nodes(address);

CREATE TABLE IF NOT EXISTS lego_edges (
  src         TEXT NOT NULL,                -- 노드 id (token:* | deriv:* | protocol:*)
  dst         TEXT NOT NULL,
  relation    TEXT NOT NULL,                -- issues | lp_of | collateral_at | staked_in
  chain       TEXT NOT NULL,
  weight_usd  DOUBLE PRECISION,             -- 알려진 규모 (Morpho 마켓 공급 등; 구조만 알면 NULL)
  evidence    JSONB NOT NULL DEFAULT '{}',  -- 어떻게 알았나 (api/온체인 메서드 + 원자료 요지)
  snapshot_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (src, dst, relation)
);
CREATE INDEX IF NOT EXISTS idx_lego_edges_src ON lego_edges(src);
CREATE INDEX IF NOT EXISTS idx_lego_edges_dst ON lego_edges(dst);
