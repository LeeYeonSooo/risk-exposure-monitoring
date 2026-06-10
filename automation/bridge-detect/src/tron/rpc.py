"""Tron 주소 변환 + RPC.

Tron 은 TVM(EVM 호환)이라 TronGrid 의 eth_call 호환 JSON-RPC 로 컨트랙트를 조회할 수 있다.
단 주소가 base58("T...")/hex("41...") 형식이라 EVM 0x-주소로 변환해야 한다.
"""

import hashlib

from ..common import b58decode
from ..solana.pda import b58encode   # base58 인코더 재사용
from ..alchemy import alchemy_url

TRON_RPC = "https://api.trongrid.io/jsonrpc"


def resolve_rpc(rpc=None):
    """RPC 결정: 인자 > Alchemy(ALCHEMY_KEY, eth_call 호환) > TronGrid 공개."""
    return rpc or alchemy_url("tron-mainnet") or TRON_RPC


def tron_to_evm(addr):
    """Tron 주소(T-base58 또는 41-hex) → EVM 0x-주소(20바이트)."""
    a = addr.strip()
    if a.startswith("T"):
        raw = b58decode(a)          # 0x41 + 20바이트 + 4체크섬
        if not raw or len(raw) < 21:
            return None
        return "0x" + raw[1:21].hex()
    if a.startswith("41") and len(a) == 42:
        return "0x" + a[2:]
    if a.startswith("0x") and len(a) == 42:
        return a
    return None


def evm_to_tron(evm_addr):
    """EVM 0x-주소 → Tron base58check(T-주소)."""
    body = bytes.fromhex("41" + evm_addr[2:])     # 0x41 prefix
    checksum = hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    return b58encode(body + checksum)
