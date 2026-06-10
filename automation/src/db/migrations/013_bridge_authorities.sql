-- ─────────────────────────────────────────────────────────────
-- Migration 013 — 검증된 브릿지 mint 권한 (bridge_authorities)
--
-- 왜: 브릿지 허브가 metadata.bridges(레지스트리) + canonical "추정" 에 의존했음.
--   토큰 컨트랙트에서 직접 읽은 xERC20 한도 / MINTER_ROLE / OFT peers / CCIP pool 을 저장 →
--   "이 담보가 어떤 브릿지에 mint 권한을 줬고 한도가 얼마"를 추정이 아니라 온체인 확정으로 표시.
--   = 큐레이터가 제일 보고 싶어할 "이 담보의 크로스체인 약점" 그 자체.
--
-- auth_type: xerc20(한도 확정) | minter_role(주소·보통 무제한) | oft_peer(LZ 신뢰경로) | ccip_pool.
-- mint_limit: 토큰 단위(없으면 null=무제한/미상). 최신 스냅샷 upsert.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bridge_authorities (
  token            text             NOT NULL,   -- 심볼
  chain            text             NOT NULL,
  bridge_addr      text             NOT NULL,
  auth_type        text             NOT NULL,    -- xerc20 | minter_role | oft_peer | ccip_pool
  mint_limit       double precision,             -- 토큰 단위(없으면 null)
  mint_limit_raw   text,
  current_limit_raw text,
  note             text,
  snapshot_ts      timestamptz      NOT NULL,
  PRIMARY KEY (token, chain, bridge_addr, auth_type)
);

CREATE INDEX IF NOT EXISTS idx_bridge_auth_token ON bridge_authorities (token, chain);
