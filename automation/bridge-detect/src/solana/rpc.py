"""Solana 저수준 RPC 호출 계층."""

import os
import time
import requests

from ..alchemy import alchemy_url


def resolve_rpc(rpc=None):
    """RPC 결정: 인자 > SOLANA_RPC > Alchemy(ALCHEMY_KEY) > 공개 RPC 폴백."""
    return (rpc or os.environ.get("SOLANA_RPC") or alchemy_url("solana-mainnet")
            or "https://api.mainnet-beta.solana.com")


def rpc_call(rpc, method, params, retries=3):
    """429 재시도 포함 Solana JSON-RPC. 성공 시 result, 실패 시 None."""
    for i in range(retries):
        try:
            j = requests.post(rpc, json={"jsonrpc": "2.0", "id": 1,
                                         "method": method, "params": params}, timeout=25).json()
        except Exception:
            return None
        if "error" in j:
            if j["error"].get("code") == 429:
                time.sleep(1.5 * (i + 1)); continue
            return None
        return j.get("result")
    return None


def account_owner(rpc, address):
    """계정의 소유 프로그램(.owner) 반환 — PDA 면 그 PDA 를 만든 프로그램."""
    res = rpc_call(rpc, "getAccountInfo", [address, {"encoding": "jsonParsed"}])
    val = (res or {}).get("value")
    return val.get("owner") if val else None
