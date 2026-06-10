"""Starknet(Cairo VM) JSON-RPC 저수준 — starknet_call·getStorageAt + selector 계산.

EVM 의 eth_call 과 달리 함수는 'selector'(이름의 starknet_keccak 해시)로 지정하고,
스토리지 변수도 selector(변수명)로 직접 읽는다(starknet_getStorageAt).
공개 RPC 가 불안정해 여러 엔드포인트를 순차 시도한다.
"""

import os

import requests
from eth_utils import keccak

# 공개 Starknet RPC (키 불필요) — 순차 폴백
DEFAULT_RPCS = [
    "https://rpc.starknet.lava.build",
    "https://api.cartridge.gg/x/starknet/mainnet",
]
_MASK_250 = (1 << 250) - 1


def selector(name):
    """starknet_keccak: keccak256(name) 의 하위 250비트 = 함수/스토리지 selector."""
    return hex(int.from_bytes(keccak(text=name), "big") & _MASK_250)


def resolve_rpcs(rpc=None):
    """조회할 RPC 목록: 인자 > STARKNET_RPC > Alchemy(ALCHEMY_KEY, 전용 경로) > 공개."""
    rpcs = []
    if rpc:
        rpcs.append(rpc)
    env = os.environ.get("STARKNET_RPC")
    if env:
        rpcs.append(env)
    key = os.environ.get("ALCHEMY_KEY")
    if key:  # Starknet 은 Alchemy 가 전용 경로(/starknet/.../rpc/vX)를 씀
        rpcs.append(f"https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_7/{key}")
    return rpcs + DEFAULT_RPCS


def _post(rpcs, method, params):
    """엔드포인트들을 순차 시도. 첫 성공 result 반환, 모두 실패 시 None."""
    for ep in rpcs:
        for _ in range(2):
            try:
                j = requests.post(ep, json={"jsonrpc": "2.0", "id": 1,
                                            "method": method, "params": params}, timeout=25).json()
            except Exception:
                continue
            if "result" in j:
                return j["result"]
            if "error" in j:
                break   # 컨트랙트/입력 에러는 다른 엔드포인트도 동일 → 다음 엔드포인트로
    return None


def call(rpcs, addr, fn, calldata=None):
    """starknet_call: addr.fn(calldata) → felt 배열(list) 또는 None."""
    return _post(rpcs, "starknet_call", [
        {"contract_address": addr, "entry_point_selector": selector(fn),
         "calldata": calldata or []}, "latest"])


def get_storage(rpcs, addr, var_name):
    """starknet_getStorageAt: addr 의 스토리지 변수 값(felt hex) 또는 None."""
    return _post(rpcs, "starknet_getStorageAt", [addr, selector(var_name), "latest"])
