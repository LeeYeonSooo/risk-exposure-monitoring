"""Alchemy RPC URL 헬퍼 — `.env` 의 ALCHEMY_KEY 가 있으면 Alchemy 엔드포인트 URL 을 조립.

키가 없으면 None 을 돌려주고, 각 어댑터는 기존 공개 RPC 로 폴백한다.
키는 코드/깃에 박지 않고 `.env` 의 ALCHEMY_KEY 로만 받는다.

  EVM:    alchemy_url("eth-mainnet")        → https://eth-mainnet.g.alchemy.com/v2/<key>
  Solana: alchemy_url("solana-mainnet")     → 표준 Solana JSON-RPC
  Sui:    alchemy_url("sui-mainnet")        → 표준 Sui JSON-RPC
  Tron:   alchemy_url("tron-mainnet")       → eth_call 호환 JSON-RPC
  Aptos:  alchemy_url("aptos-mainnet","/v1")→ REST (경로 접두사 /v1 필요)
"""

import os


def alchemy_key():
    """`.env`(또는 셸)의 ALCHEMY_KEY. 없으면 None."""
    return os.environ.get("ALCHEMY_KEY")


def alchemy_url(subdomain, suffix=""):
    """ALCHEMY_KEY 가 있으면 Alchemy URL, 없거나 subdomain 이 없으면 None.

    suffix: 일부 계열의 경로 접두사(예: Aptos REST 는 '/v1').
    """
    key = alchemy_key()
    if not key or not subdomain:
        return None
    return f"https://{subdomain}.g.alchemy.com/v2/{key}{suffix}"
