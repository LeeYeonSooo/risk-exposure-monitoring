"""Sui 브릿지 탐지 — 온체인 객체/레지스트리로 "확정"만 출력 (오탐 0).

Sui 메인넷에서 실측 검증한 3가지 구조적 신호:
  ① Wormhole  : 토큰브릿지 TokenRegistry 의 동적필드 <WH>::token_registry::Key<CoinType>
                → 값이 WrappedAsset<T> 면 wrapped(발행), NativeAsset<T> 면 네이티브 잠김(lock)
  ② Sui Bridge: 시스템 브릿지 객체(0x9) 의 treasury.id_token_type_map 에 등록된 코인
                (ETH·BTC·USDT·WLBTC — 네이티브 lock&mint 브릿지)
  ③ Circle CCTP: 검증된 native USDC 코인 타입 (Circle 발행, CCTP burn&mint)

전부 객체/레지스트리에 등록됐는지를 보는 구조적 증거라 라벨 의존 없이 확정한다.
표준 브릿지가 아닌 커스텀 발행은 발행사와 구분 불가하므로 출력하지 않는다(누락 > 오탐).
"""

from .rpc import get_object, get_dynamic_field, get_dynamic_fields
from .coin import normalize_type

# ── 실측 검증한 Sui 메인넷 표준 브릿지 객체/패키지 ──
WH_PKG = "0x26efee2b51c911237888e5dc6702868abca3c7ac12c53f76ef8eba0697695e3d"
WH_TOKEN_REGISTRY = "0x334881831bd89287554a6121087e498fa023ce52c037001b53a4563a00a281a5"
SUI_BRIDGE_OBJECT = "0x0000000000000000000000000000000000000000000000000000000000000009"
# 검증된 native USDC (Circle 발행) — CCTP burn&mint
NATIVE_USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"

# Wormhole 체인ID → 이름 (wrapped 의 원본 체인)
WH_CHAINS = {1: "Solana", 2: "Ethereum", 3: "Terra", 4: "BSC", 5: "Polygon", 6: "Avalanche",
             10: "Fantom", 16: "Moonbeam", 19: "Injective", 21: "Sui", 22: "Aptos",
             23: "Arbitrum", 24: "Optimism", 30: "Base"}

_BRIDGE_TOKENS = None  # Sui Bridge 등록 토큰(정규화 TypeName) 캐시


def _wormhole(rpc, coin_type):
    """Wormhole TokenRegistry 동적필드 조회 → (kind, standard, note, remotes) 또는 None."""
    name = {"type": f"{WH_PKG}::token_registry::Key<{coin_type}>",
            "value": {"dummy_field": False}}
    d = get_dynamic_field(rpc, WH_TOKEN_REGISTRY, name)
    if not d:
        return None
    t = d.get("type", "")
    if "WrappedAsset" in t:
        remotes = _wrapped_origin(d)
        return ("wrapped", "Wormhole Token Bridge (wrapped, 발행 확정)",
                "TokenRegistry 에 WrappedAsset 으로 등록 = Wormhole 이 발행한 wrapped", remotes)
    if "NativeAsset" in t:
        return ("native", "Wormhole Token Bridge (lock&mint, 잠금 확정)",
                "TokenRegistry 에 NativeAsset 으로 등록 = Wormhole 금고에 잠기는 네이티브", [])
    return None


def _wrapped_origin(field_obj):
    """WrappedAsset 객체에서 원본 체인/주소(best-effort). 못 찾으면 []."""
    try:
        info = field_obj["content"]["fields"]["value"]["fields"]["info"]["fields"]
        chain_id = int(info["token_chain"])
        # token_address: ExternalAddress → Bytes32 → data(바이트 배열) 를 hex 로
        data = info["token_address"]["fields"]["value"]["fields"]["data"]
        if isinstance(data, list):
            addr = "0x" + bytes(int(b) for b in data).hex()
        else:
            addr = str(data)
        return [{"chain": WH_CHAINS.get(chain_id, f"chain:{chain_id}"), "address": addr}]
    except Exception:
        pass
    return []


def _sui_bridge_tokens(rpc):
    """Sui 시스템 브릿지(0x9) treasury 에 등록된 코인 타입(정규화) 집합. 1회 캐시."""
    global _BRIDGE_TOKENS
    if _BRIDGE_TOKENS is not None:
        return _BRIDGE_TOKENS
    tokens = set()
    try:
        obj = get_object(rpc, SUI_BRIDGE_OBJECT)
        ver_id = obj["content"]["fields"]["inner"]["fields"]["id"]["id"]
        dfs = get_dynamic_fields(rpc, ver_id)
        if dfs:
            inner = get_object(rpc, dfs[0]["objectId"])
            contents = (inner["content"]["fields"]["value"]["fields"]
                        ["treasury"]["fields"]["id_token_type_map"]["fields"]["contents"])
            for e in contents:
                nm = e["fields"]["value"]["fields"]["name"]   # 0x 없는 64hex TypeName
                tokens.add(normalize_type(nm))
    except Exception:
        pass
    _BRIDGE_TOKENS = tokens
    return tokens


def detect_coin_bridges(rpc, coin_type):
    """Sui 코인 타입의 확정 브릿지 목록."""
    bridges = []
    norm = normalize_type(coin_type)

    # ① Wormhole (wrapped 또는 네이티브 lock)
    wh = _wormhole(rpc, coin_type)
    if wh:
        _kind, std, note, remotes = wh
        print(f"  [★ 확정] {std}" + (f" → 원본 {remotes[0]['chain']}" if remotes else ""))
        bridges.append({"standard": std, "address": WH_PKG, "remotes": remotes, "note": note})

    # ② Sui Bridge (네이티브 lock&mint: ETH·BTC·USDT·WLBTC)
    if norm in _sui_bridge_tokens(rpc):
        print("  [★ 확정] Sui Bridge (시스템 네이티브 브릿지)")
        bridges.append({
            "standard": "Sui Bridge (lock&mint, 등록 확정)",
            "address": SUI_BRIDGE_OBJECT, "remotes": [],
            "note": "Sui 시스템 브릿지 treasury 에 등록된 토큰(ETH·BTC·USDT·WLBTC)",
        })

    # ③ Circle CCTP — 검증된 native USDC 코인 타입
    if norm == normalize_type(NATIVE_USDC):
        print("  [★ 확정] Circle CCTP — native USDC")
        bridges.append({
            "standard": "Circle CCTP (native USDC, burn&mint 확정)",
            "address": NATIVE_USDC.split("::")[0], "remotes": [],
            "note": "Circle 발행 native USDC (CCTP 가 발행/소각)",
        })

    return bridges
