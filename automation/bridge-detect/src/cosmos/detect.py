"""Cosmos 어댑터 오케스트레이터 — IBC denom-trace 로 브릿지 추적.

Cosmos 크로스체인은 거의 전부 IBC(소스 lock → 목적지 voucher mint)라
denom-trace 가 사실상 lock&mint 메커니즘을 커버한다.
"""

from .rpc import chain_name
from .ibc import detect_ibc


def detect_cosmos(token, chain=None, rpc=None):
    print("\n" + "=" * 60)
    print("[Cosmos] IBC denom-trace — 브릿지(채널)·원본 토큰 추적")
    print("=" * 60)
    token = (token or "").strip()

    if not token.startswith("ibc/"):
        print("[i] IBC 토큰(ibc/...)이 아님 → 네이티브 토큰(브릿지 없음)으로 판단")
        return {"family": "cosmos", "token": token, "chain": chain, "bridges": [], "raw": {}}

    if not chain:
        print("[!] Cosmos 는 어느 체인에서 조회할지(chain) 가 필요합니다. 예: 'osmosis'")
        return {"family": "cosmos", "token": token, "chain": chain, "bridges": [], "raw": {}}

    print(f"[i] chain={chain_name(chain)}")
    bridges, raw = detect_ibc(token, chain, rpc)
    return {"family": "cosmos", "token": token, "chain": chain_name(chain),
            "bridges": bridges, "raw": raw}
