"""Aptos 토큰 식별 — Coin 타입태그 파싱 + 메타데이터 조회.

Aptos 토큰은 두 형식이 공존한다:
  ① Coin(레거시):    <발행주소>::<모듈>::<구조체>   예) 0x1::aptos_coin::AptosCoin
  ② Fungible Asset:  0x + 객체주소(최대 64hex)        예) 0xbae2…(native USDC)

Coin 은 "발행 주소(<addr>)"가 곧 그 코인을 publish 한 계정이라, 그 주소가 알려진
브릿지면 브릿지 발행 토큰으로 확정할 수 있다(EVM 의 minter 추적과 같은 목적).
"""

import re

from .rpc import get_resource, view

# Coin 타입태그:  0x<hex>::module::Struct (제네릭 인자<…> 가 붙을 수도)
COIN_TYPE_RE = re.compile(r"^0x[0-9a-fA-F]{1,64}::[A-Za-z0-9_]+::[A-Za-z0-9_]+")


def is_coin_type(token):
    """'::' 구조의 Coin 타입태그인지."""
    return bool(COIN_TYPE_RE.match((token or "").strip()))


def coin_publisher(coin_type):
    """Coin 타입태그에서 발행 주소(<addr>) 추출."""
    return coin_type.strip().split("::")[0]


def coin_info(rest, coin_type):
    """0x1::coin::CoinInfo<CoinType> 에서 name/symbol/decimals. 없으면 None."""
    pub = coin_publisher(coin_type)
    data = get_resource(rest, pub, f"0x1::coin::CoinInfo<{coin_type}>")
    if not data:
        return None
    return {"name": data.get("name"), "symbol": data.get("symbol"),
            "decimals": data.get("decimals")}


def fa_info(rest, fa_address):
    """Fungible Asset 객체의 name/symbol/decimals (view). 없으면 None."""
    name = view(rest, "0x1::fungible_asset::name", ["0x1::object::ObjectCore"], [fa_address])
    if not name:
        return None
    sym = view(rest, "0x1::fungible_asset::symbol", ["0x1::object::ObjectCore"], [fa_address])
    dec = view(rest, "0x1::fungible_asset::decimals", ["0x1::object::ObjectCore"], [fa_address])
    return {"name": name[0] if name else None,
            "symbol": sym[0] if sym else None,
            "decimals": dec[0] if dec else None}
