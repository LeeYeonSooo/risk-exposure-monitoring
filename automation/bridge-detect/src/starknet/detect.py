"""Starknet(Cairo VM) 어댑터 — StarkGate 브릿지 탐지 (역검증으로 확정, 오탐 0).

Starknet 토큰은 브릿지를 view 로 노출하지 않는다. 대신 StarkGate 가 발행한 토큰은
스토리지 변수 `permitted_minter` 에 그 브릿지(민터) 주소를 담는다.

  ① 토큰의 `permitted_minter` 스토리지를 직접 읽어 민터(브릿지 후보) 주소 확보
  ② 그 민터에 `get_identity()` 호출 → "STARKGATE" 면 StarkGate 로 확정(자기증명)
  ③ `get_l1_token(token)` 으로 원본 L1(Ethereum) 토큰 주소까지 표면화

라벨에 의존하지 않고 브릿지 고유 함수 응답으로만 확정한다(EVM verify 와 같은 철학).
"""

from .rpc import resolve_rpcs, call, get_storage

# get_identity() 가 돌려주는 "STARKGATE" 의 felt 인코딩
STARKGATE_IDENTITY = int.from_bytes(b"STARKGATE", "big")  # 0x535441524b47415445


def _felt_str(arr):
    """felt 배열을 ASCII 짧은 문자열로 (name/symbol 디코딩)."""
    out = ""
    for h in arr or []:
        try:
            out += bytes.fromhex(h[2:].zfill(64)).lstrip(b"\x00").decode("ascii", "ignore")
        except Exception:
            pass
    return out


def _felt_eq(felt_list, value_int):
    try:
        return felt_list and int(felt_list[0], 16) == value_int
    except (ValueError, TypeError, IndexError):
        return False


def detect_starknet(token, chain="starknet", rpc=None):
    print("\n" + "=" * 60)
    print("[Starknet] Cairo VM — StarkGate 브릿지 탐지 (permitted_minter 역검증)")
    print("=" * 60)
    rpcs = resolve_rpcs(rpc)
    token = (token or "").strip()

    name = _felt_str(call(rpcs, token, "name"))
    symbol = _felt_str(call(rpcs, token, "symbol"))
    dec = call(rpcs, token, "decimals")
    decimals = int(dec[0], 16) if dec else None
    if symbol:
        print(f"[i] {symbol} ({name}) decimals={decimals}")
    else:
        print("[i] 토큰 메타데이터 없음 — 주소/체인 확인 필요 (그래도 브릿지 신호는 확인)")

    bridges = []
    minter = get_storage(rpcs, token, "permitted_minter")
    if minter and int(minter, 16) != 0:
        ident = call(rpcs, minter, "get_identity")
        if _felt_eq(ident, STARKGATE_IDENTITY):
            l1 = call(rpcs, minter, "get_l1_token", [token])
            remotes = []
            if l1 and int(l1[0], 16) != 0:
                remotes = [{"chain": "Ethereum", "address": l1[0]}]
            print(f"  [★ 확정] StarkGate — 민터 {minter}")
            bridges.append({
                "standard": "StarkGate (lock&mint, 역검증 확정)",
                "address": minter, "remotes": remotes,
                "note": "permitted_minter 의 get_identity()=STARKGATE → L1↔L2 정식 브릿지",
            })
        else:
            print(f"  [i] permitted_minter {minter} — StarkGate 미응답(발행사 추정), 제외")

    if not bridges:
        print("\n[i] 감지된 브릿지 없음 "
              "(네이티브 토큰이거나, 비StarkGate 비표준 브릿지라 온체인 확정 불가)")

    return {"family": "starknet", "token": token, "chain": "starknet",
            "bridges": bridges, "raw": {"symbol": symbol, "name": name, "decimals": decimals}}
