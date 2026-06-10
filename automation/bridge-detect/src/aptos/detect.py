"""Aptos(Move VM) 어댑터 오케스트레이터.

토큰 형식(Coin 타입태그 / Fungible Asset 객체주소)에 따라 알맞은 탐지 경로로 분기하고,
라우터 공통 포맷(bridges 리스트)으로 정규화해 반환한다.

  Coin(레거시):  <addr>::<mod>::<struct> → detect_coin_bridges (Wormhole wrapped/lock · LayerZero)
  Fungible Asset: 0x+객체주소            → detect_fa_bridges   (Circle CCTP · Wormhole lock)
"""

from .rpc import resolve_rest
from .coin import is_coin_type, coin_info, fa_info
from .bridges import detect_coin_bridges, detect_fa_bridges


def detect_aptos(token, chain="aptos", rpc=None):
    print("\n" + "=" * 60)
    print("[Aptos] Move VM — Coin/FA 발행·잠금 구조로 표준 브릿지 확정")
    print("=" * 60)
    rest = resolve_rest(rpc)
    token = (token or "").strip()
    print(f"[i] REST={rest}")

    bridges = []
    meta = None

    if is_coin_type(token):
        meta = coin_info(rest, token)
        if meta:
            print(f"[i] Coin: {meta.get('symbol')} ({meta.get('name')}) decimals={meta.get('decimals')}")
        else:
            print("[i] Coin 메타데이터 없음 — 미배포/오타 가능 (그래도 브릿지 신호는 확인)")
        bridges = detect_coin_bridges(rest, token)
    else:
        # Fungible Asset 객체 주소로 간주
        meta = fa_info(rest, token)
        if meta:
            print(f"[i] FA: {meta.get('symbol')} ({meta.get('name')}) decimals={meta.get('decimals')}")
        else:
            print("[i] FA 메타데이터 없음 — 객체주소가 아닐 수 있음 (그래도 브릿지 신호는 확인)")
        bridges = detect_fa_bridges(rest, token)

    if not bridges:
        print("\n[i] 감지된 브릿지 없음 "
              "(네이티브 단일체인 토큰이거나, 비표준 브릿지라 온체인 확정 불가)")

    return {"family": "aptos", "token": token, "chain": "aptos",
            "bridges": bridges, "raw": {"meta": meta}}
