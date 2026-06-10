"""
Aave V3 on-chain auto-discovery — RPC 로 자산/aToken/debtToken 자동 발견.

graph_builder.py 가 이미 _discover_aave_reserves() 로 일부 발견 중.
이 모듈은 더 확장해서 본인 modules/aave/ 의 instances 형식으로 변환.

동작:
1. PoolAddressesProvider → Pool 주소
2. Pool.getReservesList() → 모든 reserve 자산 주소
3. 각 reserve 에 대해 Pool.getReserveData() → aToken, variableDebtToken 주소
4. AaveOracle.getSourceOfAsset() → 가격 소스 (Chainlink/CAPO)

결과는 dict 로 반환 → module_loader 가 instances.json 과 머지.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

import httpx
from Crypto.Hash import keccak

logger = logging.getLogger(__name__)

ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
ALCHEMY_RPC = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}" if ALCHEMY_KEY else ""

# Aave V3 Ethereum Main
AAVE_ADDRESSES_PROVIDER = "0x2f39d218133afab8f2b819b1066c7e434ad94e9e"
AAVE_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
AAVE_ORACLE = "0x54586be62e3c3580375ae3723c145253060ca0c2"
AAVE_MARKET_ID = "1:0x2f39d218133afab8f2b819b1066c7e434ad94e9e"

_CACHE_TTL_SECONDS = 6 * 3600  # 6시간
_discovery_cache: dict = {}


def _sel(sig: str) -> str:
    h = keccak.new(digest_bits=256)
    h.update(sig.encode())
    return "0x" + h.hexdigest()[:8]


def _addr_arg(addr: str) -> str:
    return "000000000000000000000000" + addr[2:].lower()


def _decode_address_array(hex_result: str) -> list[str]:
    if not hex_result or hex_result == "0x":
        return []
    data = hex_result[2:]
    if len(data) < 128:
        return []
    offset = int(data[0:64], 16) * 2
    length = int(data[offset:offset + 64], 16)
    addrs = []
    for i in range(length):
        start = offset + 64 + i * 64
        addr_hex = data[start + 24:start + 64]
        if len(addr_hex) == 40:
            addrs.append("0x" + addr_hex.lower())
    return addrs


def _decode_address(hex_result: str) -> Optional[str]:
    if not hex_result or len(hex_result) < 42:
        return None
    return "0x" + hex_result[-40:].lower()


async def _eth_call(client: httpx.AsyncClient, to: str, data: str) -> Optional[str]:
    try:
        resp = await client.post(ALCHEMY_RPC, json={
            "jsonrpc": "2.0", "method": "eth_call",
            "params": [{"to": to, "data": data}, "latest"],
            "id": 1,
        }, timeout=10.0)
        r = resp.json().get("result", "")
        return r if r and r != "0x" else None
    except Exception:
        return None


async def _fetch_erc20_symbols(client: httpx.AsyncClient, addresses: list[str]) -> dict[str, str]:
    """각 주소의 ERC-20 symbol() 호출 → {address_lower: symbol} 매핑 반환."""
    sel = _sel("symbol()")
    tasks = [_eth_call(client, addr, sel) for addr in addresses]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    out: dict[str, str] = {}
    for addr, raw in zip(addresses, results):
        if isinstance(raw, Exception) or not raw or raw == "0x":
            continue
        # ABI string return: offset(32) + length(32) + data
        try:
            data = raw[2:] if raw.startswith("0x") else raw
            if len(data) < 128:
                continue
            length = int(data[64:128], 16)
            if length == 0 or length > 32:
                continue
            sym_bytes = bytes.fromhex(data[128:128 + length * 2])
            sym = sym_bytes.decode("utf-8", errors="ignore").strip("\x00").strip()
            if sym:
                out[addr.lower()] = sym
        except Exception:
            pass
    return out


async def discover_aave_reserves() -> dict:
    """
    Aave V3 Main 시장의 모든 reserve 발견.

    Returns:
        {
            "discovered_at": timestamp,
            "market_id": ...,
            "reserves": [
                {
                    "underlying": "0x...",
                    "underlying_symbol": "USDC" | None,
                    "a_token": "0x...",
                    "a_token_symbol": "aEthUSDC" | None,
                    "variable_debt_token": "0x...",
                    "variable_debt_token_symbol": "variableDebtEthUSDC" | None,
                    "oracle_source": "0x..." (Chainlink feed 또는 CAPO adapter),
                },
                ...
            ]
        }

    Alchemy RPC 키 미설정 시 빈 dict 반환.
    """
    global _discovery_cache
    now = time.time()
    cached = _discovery_cache.get("data")
    if cached and (now - _discovery_cache.get("ts", 0)) < _CACHE_TTL_SECONDS:
        return cached

    if not ALCHEMY_KEY:
        empty = {"discovered_at": now, "market_id": AAVE_MARKET_ID, "reserves": [], "error": "no_alchemy_key"}
        _discovery_cache = {"data": empty, "ts": now}
        return empty

    sel_list = _sel("getReservesList()")
    sel_reserve_data = _sel("getReserveData(address)")
    sel_oracle = _sel("getSourceOfAsset(address)")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # 1. getReservesList()
            raw = await _eth_call(client, AAVE_POOL, sel_list)
            if not raw:
                raise RuntimeError("getReservesList returned empty")
            underlyings = _decode_address_array(raw)

            # 2. 각 reserve 의 getReserveData() — aToken, variableDebtToken 주소 추출
            # ReserveData 구조: configuration(32) + liquidityIndex(16) + currentLiquidityRate(16)
            #                  + variableBorrowIndex(16) + currentVariableBorrowRate(16)
            #                  + currentStableBorrowRate(16) + lastUpdateTimestamp(5+3=8)
            #                  + id(2) + aTokenAddress(20) + stableDebtTokenAddress(20)
            #                  + variableDebtTokenAddress(20) + ...
            # 각 word(32 bytes) 단위. aTokenAddress 는 word 8 (offset 8*64 hex chars).
            reserve_tasks = [
                _eth_call(client, AAVE_POOL, sel_reserve_data + _addr_arg(u))
                for u in underlyings
            ]
            oracle_tasks = [
                _eth_call(client, AAVE_ORACLE, sel_oracle + _addr_arg(u))
                for u in underlyings
            ]
            reserve_results = await asyncio.gather(*reserve_tasks, return_exceptions=True)
            oracle_results = await asyncio.gather(*oracle_tasks, return_exceptions=True)
    except Exception as e:
        logger.warning(f"aave discovery failed: {e}")
        empty = {"discovered_at": now, "market_id": AAVE_MARKET_ID, "reserves": [], "error": str(e)}
        _discovery_cache = {"data": empty, "ts": now}
        return empty

    reserves_raw = []
    for underlying, rdata, oracle_data in zip(underlyings, reserve_results, oracle_results):
        if isinstance(rdata, Exception) or not rdata:
            continue
        # ReserveData ABI return layout (각 필드가 32바이트로 정렬):
        #   word 0: configuration   word 1-7: indices/rates/timestamp/id
        #   word 8: aTokenAddress   word 9: stableDebtTokenAddress   word 10: variableDebtTokenAddress
        data_hex = rdata[2:] if rdata.startswith("0x") else rdata
        try:
            a_token = "0x" + data_hex[8 * 64 + 24:8 * 64 + 64]
            v_debt = "0x" + data_hex[10 * 64 + 24:10 * 64 + 64]
        except IndexError:
            continue

        if a_token == "0x" + "0" * 40 or v_debt == "0x" + "0" * 40:
            continue

        oracle_src = None
        if not isinstance(oracle_data, Exception) and oracle_data:
            oracle_src = _decode_address(oracle_data)

        reserves_raw.append({
            "underlying": underlying.lower(),
            "a_token": a_token.lower(),
            "variable_debt_token": v_debt.lower(),
            "oracle_source": oracle_src.lower() if oracle_src else None,
        })

    # symbol() RPC 호출 — underlying + aToken + debtToken 전체 한 번에
    try:
        all_addresses = []
        for r in reserves_raw:
            all_addresses.extend([r["underlying"], r["a_token"], r["variable_debt_token"]])
        async with httpx.AsyncClient(timeout=20.0) as client:
            symbols = await _fetch_erc20_symbols(client, all_addresses)
    except Exception as e:
        logger.warning(f"symbol() fetch failed: {e}")
        symbols = {}

    # symbol 매핑 추가
    reserves = []
    for r in reserves_raw:
        reserves.append({
            **r,
            "underlying_symbol": symbols.get(r["underlying"]),
            "a_token_symbol": symbols.get(r["a_token"]),
            "variable_debt_token_symbol": symbols.get(r["variable_debt_token"]),
        })

    result = {
        "discovered_at": now,
        "market_id": AAVE_MARKET_ID,
        "reserves": reserves,
        "count": len(reserves),
    }
    _discovery_cache = {"data": result, "ts": now}
    logger.info(f"aave discovery: {len(reserves)} reserves")
    return result


def discovery_to_module_nodes(discovery: dict) -> list[dict]:
    """
    discover_aave_reserves() 결과를 modules/aave/instances.json 의 nodes 형식으로 변환.
    symbol() RPC 결과로 라벨을 채우면 사용자가 'USDC', 'LINK' 같이 검색 가능.
    address_book 매핑이 있는 자산은 module_bridge 가 자동으로 기존 노드와 머지.
    """
    nodes: list[dict] = []
    for r in discovery.get("reserves", []):
        underlying = r["underlying"]
        a_token = r["a_token"]
        v_debt = r["variable_debt_token"]
        oracle_src = r.get("oracle_source")
        u_sym = r.get("underlying_symbol")
        a_sym = r.get("a_token_symbol")
        v_sym = r.get("variable_debt_token_symbol")

        # underlying — symbol 이 있으면 그걸 label 로 (예: "USDC"), 없으면 placeholder
        nodes.append({
            "address": underlying,
            "chain_id": 1,
            "type": "underlying_asset",
            "protocol": "external",
            "label": u_sym if u_sym else f"asset {underlying[:8]}",
            "metadata": {
                "discovered": True,
                **({"symbol": u_sym} if u_sym else {}),
            },
        })

        # aToken
        nodes.append({
            "address": a_token,
            "chain_id": 1,
            "type": "a_token",
            "protocol": "aave-v3",
            "label": a_sym if a_sym else f"aToken {a_token[:8]}",
            "market_id": AAVE_MARKET_ID,
            "metadata": {
                "underlying": underlying,
                "transferable": True,
                "discovered": True,
                **({"symbol": a_sym} if a_sym else {}),
            },
        })

        # variableDebtToken
        nodes.append({
            "address": v_debt,
            "chain_id": 1,
            "type": "variable_debt_token",
            "protocol": "aave-v3",
            "label": v_sym if v_sym else f"debt {v_debt[:8]}",
            "market_id": AAVE_MARKET_ID,
            "metadata": {
                "underlying": underlying,
                "transferable": False,
                "discovered": True,
                **({"symbol": v_sym} if v_sym else {}),
            },
        })

        # 가격 소스 노드 (Chainlink 피드 또는 CAPO Adapter)
        if oracle_src:
            # Aave V3 의 base currency 는 USD — 자산 심볼 알면 'Chainlink USDC/USD' 식으로 명명
            # 심볼 모르면 최소 'Chainlink feed (0xabcd…)' 로 표시 (그냥 주소만 보이는 것 방지)
            if u_sym:
                oracle_label = f"Chainlink {u_sym}/USD"
                feed_pair = f"{u_sym}/USD"
            else:
                oracle_label = f"Chainlink feed {oracle_src[:6]}…"
                feed_pair = None
            nodes.append({
                "address": oracle_src,
                "chain_id": 1,
                "type": "price_feed",
                "protocol": "chainlink",
                "label": oracle_label,
                "metadata": {
                    "discovered": True,
                    "base_currency": "USD",
                    **({"feed_pair": feed_pair} if feed_pair else {}),
                    **({"for_asset_symbol": u_sym} if u_sym else {}),
                    **({"for_asset": underlying} if underlying else {}),
                },
            })

    return nodes


def discovery_to_module_edges(discovery: dict) -> list[dict]:
    """
    discover_aave_reserves() 결과 → edges 자동 생성.

    각 reserve 마다 만드는 엣지:
      1) aToken            → Aave Pool   (mint_wrapper — Aave 가 발행한 receipt)
      2) variableDebtToken → Aave Pool   (mint_wrapper — Aave 가 발행한 IOU)
      3) aToken            → underlying  (mint_wrapper — 1:1 백킹)
      4) variableDebtToken → underlying  (mint_wrapper — 이 자산에 대한 부채)
      5) underlying        → oracle      (price_dependency)

    이전엔 1/2/4 가 빠져서 debt 토큰들이 그래프에서 떠다녔음.
    """
    edges: list[dict] = []
    v_debt_count = 0
    for r in discovery.get("reserves", []):
        underlying = r["underlying"]
        a_token = r["a_token"]
        v_debt = r.get("variable_debt_token")
        oracle_src = r.get("oracle_source")

        # (1) aToken → Aave Pool — Aave 가 이 receipt 토큰을 발행
        edges.append({
            "edge_id": f"aave-v3-discovered:{a_token[:10]}->aave_pool",
            "edge_type": "mint_wrapper",
            "from": a_token,
            "to": AAVE_POOL,
            "protocol": "aave-v3",
            "chain_id": 1,
            "market_id": AAVE_MARKET_ID,
            "metadata": {"discovered": True, "layer": "atoken_to_pool"},
        })

        # (3) aToken → underlying — 1:1 + 이자
        edges.append({
            "edge_id": f"aave-v3-discovered:{a_token[:10]}->{underlying[:10]}",
            "edge_type": "mint_wrapper",
            "from": a_token,
            "to": underlying,
            "protocol": "aave-v3",
            "chain_id": 1,
            "market_id": AAVE_MARKET_ID,
            "metadata": {"discovered": True, "layer": "atoken_to_underlying"},
        })

        if v_debt:
            v_debt_count += 1
            # (2) variableDebtToken → Aave Pool — Aave 가 발행한 부채 IOU
            edges.append({
                "edge_id": f"aave-v3-discovered:{v_debt[:10]}->aave_pool",
                "edge_type": "mint_wrapper",
                "from": v_debt,
                "to": AAVE_POOL,
                "protocol": "aave-v3",
                "chain_id": 1,
                "market_id": AAVE_MARKET_ID,
                "metadata": {"discovered": True, "layer": "debt_to_pool"},
            })
            # (4) variableDebtToken → underlying — 어떤 자산에 대한 부채인지
            edges.append({
                "edge_id": f"aave-v3-discovered:{v_debt[:10]}->{underlying[:10]}",
                "edge_type": "mint_wrapper",
                "from": v_debt,
                "to": underlying,
                "protocol": "aave-v3",
                "chain_id": 1,
                "market_id": AAVE_MARKET_ID,
                "metadata": {"discovered": True, "layer": "debt_to_underlying"},
            })

        # (5) underlying → oracle (price_dependency)
        if oracle_src:
            edges.append({
                "edge_id": f"aave-v3-discovered:{underlying[:10]}->{oracle_src[:10]}",
                "edge_type": "price_dependency",
                "from": underlying,
                "to": oracle_src,
                "protocol": "aave-v3",
                "chain_id": 1,
                "metadata": {"discovered": True},
            })
            # (6) oracle feed → chainlink_provider (시각 클러스터링 + provider 식별)
            # 단일 'chainlink_provider' seed 노드 (graph_data.py) 가 모든 피드의 부모.
            # d3-force 가 이 노드 주변으로 피드들을 starburst 형태로 자동 묶음.
            edges.append({
                "edge_id": f"chainlink-discovered:{oracle_src[:10]}->provider",
                "edge_type": "delegation",  # vocab: protocol family
                "from": oracle_src,
                "to": "chainlink_provider",
                "protocol": "chainlink",
                "chain_id": 1,
                "metadata": {"discovered": True, "layer": "feed_to_provider"},
            })

    return edges
