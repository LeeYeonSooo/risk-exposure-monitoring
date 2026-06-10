"""Sui(Move VM) 어댑터 오케스트레이터.

Sui 토큰은 코인 타입태그(`<pkg>::<module>::<STRUCT>`)로 식별한다. 해당 타입이 표준
브릿지의 레지스트리/시스템 객체에 등록됐는지 온체인으로 확인해 확정한다.

Aptos 와 같은 Move 언어지만 런타임/RPC/저장모델이 달라(별도 어댑터): Aptos=REST 리소스,
Sui=JSON-RPC 객체/동적필드.
"""

from .rpc import resolve_rpc
from .coin import is_coin_type, coin_info
from .bridges import detect_coin_bridges


def detect_sui(token, chain="sui", rpc=None):
    print("\n" + "=" * 60)
    print("[Sui] Move VM — 코인 타입의 표준 브릿지 등록 여부로 확정")
    print("=" * 60)
    rpc = resolve_rpc(rpc)
    token = (token or "").strip()
    print(f"[i] RPC={rpc}")

    meta = None
    bridges = []
    if is_coin_type(token):
        meta = coin_info(rpc, token)
        if meta:
            print(f"[i] Coin: {meta.get('symbol')} ({meta.get('name')}) decimals={meta.get('decimals')}")
        else:
            print("[i] 코인 메타데이터 없음 — 미배포/오타 가능 (그래도 브릿지 신호는 확인)")
        bridges = detect_coin_bridges(rpc, token)
    else:
        print("[!] Sui 는 코인 타입태그(`0x…::module::Struct`) 형식이 필요합니다. 예: 0x2::sui::SUI")

    if not bridges:
        print("\n[i] 감지된 브릿지 없음 "
              "(네이티브 단일체인 토큰이거나, 비표준 브릿지라 온체인 확정 불가)")

    return {"family": "sui", "token": token, "chain": "sui",
            "bridges": bridges, "raw": {"meta": meta}}
