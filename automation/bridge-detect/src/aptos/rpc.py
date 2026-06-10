"""Aptos(Move VM) REST API 저수준 호출 — Move 리소스 조회 + view 함수.

Aptos 는 EVM 의 eth_call 이 없다. 대신 Fullnode REST 로 계정의 Move 리소스를 읽거나
view 함수를 호출해 상태를 조회한다.
  REST: https://fullnode.mainnet.aptoslabs.com/v1
"""

import os
import urllib.parse

import requests

from ..alchemy import alchemy_url

DEFAULT_REST = "https://fullnode.mainnet.aptoslabs.com/v1"


def resolve_rest(rpc=None):
    """REST 결정: 인자 > APTOS_REST > Alchemy(ALCHEMY_KEY, /v1) > 공개 Fullnode."""
    return (rpc or os.environ.get("APTOS_REST") or alchemy_url("aptos-mainnet", "/v1")
            or DEFAULT_REST)


def get_resource(rest, address, resource_type):
    """특정 Move 리소스 조회 → data dict (없으면 None).

    resource_type 예: "0x1::coin::CoinInfo<0x1::aptos_coin::AptosCoin>"
    """
    rt = urllib.parse.quote(resource_type, safe="")
    try:
        r = requests.get(f"{rest}/accounts/{address}/resource/{rt}", timeout=25)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json().get("data")
    except Exception:
        return None


def get_resources(rest, address, limit=300):
    """계정의 모든 리소스 목록(list of {type, data}). 실패 시 빈 리스트."""
    try:
        r = requests.get(f"{rest}/accounts/{address}/resources?limit={limit}", timeout=25)
        if r.status_code != 200:
            return []
        j = r.json()
        return j if isinstance(j, list) else []
    except Exception:
        return []


def has_modules(rest, address, *names):
    """계정에 주어진 모듈이 모두 있으면 True — 브릿지 지문 재검증용(신뢰X, 증명O)."""
    try:
        r = requests.get(f"{rest}/accounts/{address}/modules?limit=100", timeout=25)
        if r.status_code != 200:
            return False
        mods = {m.get("abi", {}).get("name") for m in r.json()}
        return all(n in mods for n in names)
    except Exception:
        return False


def view(rest, function, type_args, args):
    """view 함수 호출 → 결과 리스트(없으면 None).

    function 예: "0x1::coin::balance", type_args=[CoinType], args=[owner]
    """
    try:
        r = requests.post(f"{rest}/view",
                          json={"function": function, "type_arguments": type_args, "arguments": args},
                          timeout=25)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        j = r.json()
        return j if isinstance(j, list) else None
    except Exception:
        return None


def coin_balance(rest, coin_type, owner):
    """owner 가 보유한 coin_type 잔고(정수). 실패/없음이면 0."""
    res = view(rest, "0x1::coin::balance", [coin_type], [owner])
    if res:
        try:
            return int(res[0])
        except (ValueError, TypeError, IndexError):
            return 0
    return 0
