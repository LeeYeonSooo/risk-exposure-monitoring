"""Sui 코인 타입 식별 + 정규화 + 메타데이터.

Sui 코인은 타입태그 `<pkg>::<module>::<STRUCT>` 로 식별한다 (예 0x2::sui::SUI).
온체인 TypeName 은 주소를 0x 없이 64hex 로 zero-pad 해 저장하므로, 레지스트리 비교 전
정규화가 필요하다.
"""

import re

from .rpc import get_coin_metadata

COIN_TYPE_RE = re.compile(r"^0x[0-9a-fA-F]{1,64}::[A-Za-z0-9_]+::[A-Za-z0-9_]+")


def is_coin_type(token):
    """Sui 코인 타입태그(`0x…::mod::Struct`)인지."""
    return bool(COIN_TYPE_RE.match((token or "").strip()))


def normalize_type(coin_type):
    """Sui TypeName 정규화: 주소를 0x 없이 소문자 64hex 로 zero-pad.

    예) 0x2::sui::SUI → 0000…0002::sui::SUI  (id_token_type_map 비교용)
    """
    ct = coin_type.strip()
    addr, _, rest = ct.partition("::")
    addr = addr[2:] if addr.startswith("0x") else addr
    addr = addr.lower().rjust(64, "0")
    return f"{addr}::{rest}"


def coin_info(rpc, coin_type):
    """코인 메타데이터(name/symbol/decimals). 없으면 None."""
    m = get_coin_metadata(rpc, coin_type)
    if not m:
        return None
    return {"name": m.get("name"), "symbol": m.get("symbol"), "decimals": m.get("decimals")}
