-- Migration 014 — Detector B: mint/burn 정합 ledger (alarm-totalsupply mint_burn_recon 포팅)
-- 크로스체인 mint↔burn 을 금액+시간창으로 매칭. 창 지나도 미정합 mint = 무담보민팅 의심(Kelp 시그니처).

CREATE TABLE IF NOT EXISTS mint_burn_ledger (
  token         text          NOT NULL,           -- 심볼(논리 토큰)
  chain         text          NOT NULL,
  tx_hash       text          NOT NULL,
  log_index     int           NOT NULL,
  kind          text          NOT NULL,           -- 'mint' | 'burn'
  amount        numeric(78,0) NOT NULL,           -- raw uint256 (정확 정수 매칭)
  event_ts      timestamptz   NOT NULL,           -- 이벤트 블록 시각(근사)
  first_seen_ts timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_mbl_token_amt  ON mint_burn_ledger (token, amount);
CREATE INDEX IF NOT EXISTS idx_mbl_token_kind ON mint_burn_ledger (token, kind);

-- 체인×토큰 증분 스캔 커서
CREATE TABLE IF NOT EXISTS mint_burn_cursor (
  token      text   NOT NULL,
  chain      text   NOT NULL,
  last_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token, chain)
);
