"""Solana(SVM) 어댑터 오케스트레이터 — 발행권한(authority) + 보유자(holders)를 합쳐 탐지.

  발행형(burn&mint, lock&mint 목적지) → authority.detect_authority
  잠김/풀형(lock&mint 원본, 유동성 풀)  → holders.detect_holders
"""

from .rpc import resolve_rpc
from .authority import detect_authority
from .holders import detect_holders
from .known_bridges import detect_known_locks


def detect_solana(token, chain="solana", rpc=None):
    print("\n" + "=" * 60)
    print("[Solana] 발행 권한자 + 보유자(금고/풀) + 알려진 lock 금고 — 세 유형 탐지")
    print("=" * 60)
    rpc = resolve_rpc(rpc)
    token = (token or "").strip()

    bridges = []
    bridges += detect_authority(rpc, token)      # ①② 발행형 (mintAuthority/CCTP)
    bridges += detect_known_locks(rpc, token)    # ② lock 금고 (Wormhole custody PDA, 금액 무관)
    bridges += detect_holders(rpc, token)        # ②원본/③풀 (대량 보유자)

    if not bridges:
        print("\n[i] 감지된 브릿지 없음")
    return {"family": "solana", "token": token, "chain": "solana", "bridges": bridges, "raw": {}}
