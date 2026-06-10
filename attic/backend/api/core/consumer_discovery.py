"""
consumer_discovery.py — Generic token-consumer 의존성 자동 발견.

설계 의도 (사용자 비전 충실):
    "subgraph + events 로 자동화. 새 프로토콜 추가 시 코드 수정 없음."

본 모듈은 *임의의 token × 임의의 consumer protocol* 조합에 대해
RPC balanceOf 호출로 보유 관계를 자동 발견.

작동 방식:
    1) shared/address_book.json 의 tokens 목록을 읽음
    2) shared/consumer_registry.json 의 consumers 목록을 읽음
    3) 각 (consumer, token) 쌍에 대해 RPC balanceOf 호출
    4) balance > threshold 인 쌍만 edge 생성

자동화 정도:
    - 새 LST 토큰 등장 → address_book.json 에 한 줄 → 모든 consumer 와 자동 체크 ✓
    - 새 consumer 등장 → consumer_registry.json 에 한 줄 → 모든 토큰과 자동 체크 ✓
    - 코드 수정: 0

본 모듈은 Lido / EigenLayer / Curve / Balancer 등을 "수동 instances.json 없이"
그래프에 연결하는 게 핵심 목적.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

ROOT = Path(__file__).parent.parent.parent.parent  # backend/api/core → new-simulator (repo root)
ADDRESS_BOOK = ROOT / "shared" / "address_book.json"
CONSUMER_REGISTRY = ROOT / "shared" / "consumer_registry.json"

ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
ETH_RPC = (
    f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
    if ALCHEMY_KEY
    else "https://eth.llamarpc.com"  # fallback
)

# balanceOf(address) selector
SEL_BALANCE_OF = "0x70a08231"
# decimals() selector
SEL_DECIMALS = "0x313ce567"

# threshold — 너무 작은 보유는 dust 로 간주 (default $1M USD 등가)
# 단위는 토큰 raw amount. 18 decimals 기준 1e21 = ~1000 토큰.
# 실제로는 보수적으로 1e18 (1 token) 부터 인정.
MIN_BALANCE_RAW = 10 ** 18  # 1 token equivalent


# ─────────────────────────────────────────────────────────────────
# RPC helpers
# ─────────────────────────────────────────────────────────────────

def _addr_arg(addr: str) -> str:
    """address → 32-byte padded hex (selector 뒤에 붙임)"""
    return "000000000000000000000000" + addr.lower().replace("0x", "")


async def _eth_call(client: httpx.AsyncClient, to: str, data: str) -> Optional[str]:
    try:
        r = await client.post(
            ETH_RPC,
            json={
                "jsonrpc": "2.0",
                "method": "eth_call",
                "params": [{"to": to, "data": data}, "latest"],
                "id": 1,
            },
        )
        r.raise_for_status()
        d = r.json()
        return d.get("result")
    except Exception as e:
        logger.debug(f"eth_call fail {to[:10]}: {e}")
        return None


async def _balance_of(client: httpx.AsyncClient, token_addr: str, holder: str) -> Optional[int]:
    """RPC balanceOf 결과 → int. 실패/0 이면 None."""
    data = SEL_BALANCE_OF + _addr_arg(holder)
    hex_result = await _eth_call(client, token_addr, data)
    if not hex_result or hex_result == "0x":
        return None
    try:
        val = int(hex_result, 16)
        return val if val > 0 else None
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────
# Discovery
# ─────────────────────────────────────────────────────────────────

def _load_tokens() -> dict[str, str]:
    """address_book 에서 token address → canonical id 매핑 로드."""
    if not ADDRESS_BOOK.exists():
        return {}
    data = json.loads(ADDRESS_BOOK.read_text(encoding="utf-8"))
    return {
        addr.lower(): name
        for addr, name in data.get("ethereum", {}).get("tokens", {}).items()
        if addr.startswith("0x")
    }


def _load_consumers() -> dict[str, dict]:
    """consumer_registry 에서 (skip 안 된) consumer 들 로드."""
    if not CONSUMER_REGISTRY.exists():
        return {}
    data = json.loads(CONSUMER_REGISTRY.read_text(encoding="utf-8"))
    return {
        addr.lower(): meta
        for addr, meta in data.get("consumers", {}).items()
        if addr.startswith("0x") and not meta.get("_skip")
    }


async def discover_consumers() -> dict:
    """
    address_book × consumer_registry 모든 쌍에 RPC balanceOf 호출.

    Returns:
        {
          "discovered_at": float,
          "pairs_checked": int,
          "holdings": [{"consumer": "0x...", "token": "0x...", "balance_raw": int}],
          "error": str | None,
        }
    """
    started = time.time()
    tokens = _load_tokens()      # token_addr → canonical_id
    consumers = _load_consumers()  # consumer_addr → meta

    out: dict = {
        "discovered_at": started,
        "tokens_count": len(tokens),
        "consumers_count": len(consumers),
        "pairs_checked": 0,
        "holdings": [],
        "error": None,
    }

    if not tokens or not consumers:
        out["error"] = "tokens 또는 consumers 비어있음 (address_book / consumer_registry 확인)"
        return out

    if not ALCHEMY_KEY:
        logger.warning("ALCHEMY_API_KEY 미설정 — public RPC fallback 사용 (느림)")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # 모든 (consumer, token) 쌍 병렬 호출
            tasks = []
            pair_keys = []
            for c_addr in consumers:
                for t_addr in tokens:
                    tasks.append(_balance_of(client, t_addr, c_addr))
                    pair_keys.append((c_addr, t_addr))

            out["pairs_checked"] = len(tasks)
            results = await asyncio.gather(*tasks, return_exceptions=True)

        # 결과 정리
        for (c_addr, t_addr), bal in zip(pair_keys, results):
            if isinstance(bal, Exception) or bal is None:
                continue
            if bal < MIN_BALANCE_RAW:
                continue
            out["holdings"].append({
                "consumer": c_addr,
                "token": t_addr,
                "balance_raw": bal,
            })

        out["holdings_count"] = len(out["holdings"])
        return out

    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        return out


# ─────────────────────────────────────────────────────────────────
# discovery → graph 변환
# ─────────────────────────────────────────────────────────────────

def discovery_to_module_nodes(discovery: dict) -> list[dict]:
    """
    consumer 마다 1개 노드 생성 (label/protocol 은 registry 에서).

    토큰 노드는 별도로 안 만듦 — address_book 으로 이미 다른 모듈/discovery 에서 등장.
    """
    nodes: list[dict] = []
    seen: set[str] = set()
    consumers = _load_consumers()

    # holdings 에 등장한 consumer 만 노드로 (실제 보유가 있어야 의미)
    active_consumers = {h["consumer"] for h in discovery.get("holdings", [])}

    for addr, meta in consumers.items():
        if addr in seen or addr not in active_consumers:
            continue
        seen.add(addr)

        category = meta.get("category", "external")
        # 카테고리별 simulator vocab 매핑 — vocab_mapper 휴리스틱이 잘 잡음
        vocab_type = {
            "dex_pool": "vault",  # DEX pool 은 vault 형태로
            "lending": "protocol_pool",
            "restaking_strategy": "vault",
        }.get(category, "vault")

        nodes.append({
            "address": addr,
            "chain_id": 1,
            "type": vocab_type,
            "protocol": meta.get("protocol", "external"),
            "label": meta.get("label") or f"consumer {addr[:8]}",
            "metadata": {
                "category": category,
                "kind": meta.get("kind"),
                "discovered_by": "consumer_discovery",
                "expected_tokens": meta.get("expected_tokens", []),
            },
        })

    return nodes


def discovery_to_module_edges(discovery: dict) -> list[dict]:
    """
    holdings → edges: consumer → token (collateral 의미. mint_wrapper 로 매핑)
    """
    edges: list[dict] = []
    for h in discovery.get("holdings", []):
        c = h["consumer"]
        t = h["token"]
        bal = h["balance_raw"]
        edges.append({
            "edge_id": f"consumer-discovered:{c[:10]}->{t[:10]}",
            "edge_type": "mint_wrapper",  # consumer 가 token 청구권 보유
            "from": c,
            "to": t,
            "protocol": "external",
            "chain_id": 1,
            "metadata": {
                "discovered": True,
                "layer": "consumer_holds_token",
                "balance_raw": str(bal),  # JSON int 한계 회피
            },
        })
    return edges
