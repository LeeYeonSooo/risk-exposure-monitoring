-- 래핑본 1급화 (2026-06-13, B1)
-- bridge_authorities.note 텍스트에만 박혀 있던 래핑 변형(USDC.e 등) 주소를 정식 테이블로.
-- kind: 'bridged_wrapped'(표준 브릿지 lock&mint 래핑본) | 'ccip_remote'(CCIP 원격 토큰 — 후속 작업 사용).
-- init-db 가 매 실행 전체 재적용하므로 IF NOT EXISTS 필수.

CREATE TABLE IF NOT EXISTS token_variants (
  token        TEXT NOT NULL,                       -- 정규 토큰 심볼 (USDC 등)
  chain        TEXT NOT NULL,                       -- 변형이 존재하는 체인 (arbitrum 등)
  address      TEXT NOT NULL,                       -- 변형 컨트랙트 주소 (소문자)
  source_chain TEXT,                                -- 출발 체인 (lock&mint 의 L1 — ethereum 등)
  via          TEXT,                                -- 도출 경로 (Arbitrum Gateway 등)
  kind         TEXT NOT NULL,                       -- 'bridged_wrapped' | 'ccip_remote'
  note         TEXT,
  snapshot_ts  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token, chain, address)
);
