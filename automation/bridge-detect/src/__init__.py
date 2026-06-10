"""get_token_bridge_address — 토큰 주소로 브릿지를 자동 탐지 (EVM·Solana·Cosmos).

  from src import detect
  detect("0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7", 1)
"""

# 다른 모듈보다 먼저 .env 를 환경변수로 로드 (SOLANA_RPC 등)
from .config import load_env
load_env()

from .router import detect

__all__ = ["detect"]
