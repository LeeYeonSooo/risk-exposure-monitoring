"""Sui JSON-RPC 저수준 호출 — 객체·코인메타·동적필드 조회.

Sui 는 EVM 의 eth_call 도, Aptos 의 REST 리소스도 아니다. 모든 게 '객체(Object)'이고
JSON-RPC(suix_*, sui_*)로 객체와 그 동적필드(dynamic field)를 읽는다.
  RPC: https://fullnode.mainnet.sui.io:443
"""

import os

import requests

from ..alchemy import alchemy_url

DEFAULT_RPC = "https://fullnode.mainnet.sui.io:443"


def resolve_rpc(rpc=None):
    """RPC 결정: 인자 > SUI_RPC > Alchemy(ALCHEMY_KEY) > 공개 Fullnode."""
    return rpc or os.environ.get("SUI_RPC") or alchemy_url("sui-mainnet") or DEFAULT_RPC


def call(rpc, method, params):
    """범용 Sui JSON-RPC. 성공 시 result, 에러/실패 시 None."""
    try:
        j = requests.post(rpc, json={"jsonrpc": "2.0", "id": 1,
                                     "method": method, "params": params}, timeout=25).json()
    except Exception:
        return None
    if "error" in j:
        return None
    return j.get("result")


def get_object(rpc, object_id, content=True):
    """객체 조회 → data dict (없으면 None)."""
    res = call(rpc, "sui_getObject", [object_id, {"showContent": content, "showType": True}])
    return (res or {}).get("data")


def get_coin_metadata(rpc, coin_type):
    """코인 타입의 메타데이터(name/symbol/decimals/...). 없으면 None."""
    return call(rpc, "suix_getCoinMetadata", [coin_type])


def get_dynamic_field(rpc, parent_id, name):
    """parent 객체의 동적필드 1개 조회 → data dict (없으면 None).

    name 예: {"type": "<pkg>::token_registry::Key<CoinType>", "value": {"dummy_field": False}}
    """
    res = call(rpc, "suix_getDynamicFieldObject", [parent_id, name])
    return (res or {}).get("data")


def get_dynamic_fields(rpc, parent_id, limit=50):
    """parent 객체의 동적필드 목록(list). 실패 시 빈 리스트."""
    res = call(rpc, "suix_getDynamicFields", [parent_id, None, limit])
    return (res or {}).get("data", []) if res else []
