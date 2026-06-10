"""Stellar Horizon REST 저수준 — 계정/자산 조회.

Stellar classic 자산은 컨트랙트가 아니라 '발행자 계정'이 발행한다. Horizon REST 로
계정(home_domain·flags)과 자산을 조회한다. (Soroban 컨트랙트는 별도 RPC)
"""

import os

import requests

DEFAULT_HORIZON = "https://horizon.stellar.org"


def resolve_horizon(rpc=None):
    """Horizon 결정: 인자 > STELLAR_HORIZON > 공개 Horizon."""
    return rpc or os.environ.get("STELLAR_HORIZON") or DEFAULT_HORIZON


def get(horizon, path):
    """Horizon GET → JSON dict (실패 시 None)."""
    try:
        r = requests.get(horizon + path, timeout=20)
        return r.json() if r.status_code == 200 else None
    except Exception:
        return None


def account(horizon, address):
    """발행자 계정 정보(home_domain·flags 등). 없으면 None."""
    return get(horizon, f"/accounts/{address}")
