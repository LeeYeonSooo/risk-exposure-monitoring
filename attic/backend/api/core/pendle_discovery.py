"""
pendle_discovery.py — Pendle 의 active markets 를 공개 API 로 자동 발견.

Pendle 은 market 이 asset×expiry 단위로 동적 생성되므로 (Aave reserve 처럼 enumerate 불가),
Pendle 공개 API (api-v2.pendle.finance) 로 active market 목록을 가져와
각 market 의 SY/PT/YT/LP 노드 + underlying 연결을 자동 생성.

각 market 마다:
  - SY, PT, YT, Market(LP) 노드 (실주소)
  - underlyingAsset → SY (wraps)
  - SY → PT (principal split), SY → YT (yield split)
  - PT → Market, SY → Market (pool asset)

underlyingAsset (wstETH, weETH, sUSDe 등) 은 기존 그래프 노드와 자동 머지 → cross-protocol 허브.

출력: integration/output/discovered_pendle.json → module_loader 자동 머지.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

PENDLE_API = "https://api-v2.pendle.finance/core/v1/1/markets/active"
TOP_MARKETS = 60  # liquidity 기준 상위 N (전부 가져와도 ~76)


def _strip_chain(addr: str) -> str:
    """'1-0xabc...' → '0xabc...' (Pendle API 의 chain prefix 제거)."""
    if not addr:
        return ""
    if "-" in addr:
        addr = addr.split("-", 1)[1]
    return addr.lower()


async def discover_pendle() -> dict:
    started = time.time()
    out: dict = {"discovered_at": started, "markets": [], "error": None}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(PENDLE_API)
            r.raise_for_status()
            data = r.json()
        markets = data.get("markets", data) if isinstance(data, dict) else data
        if not isinstance(markets, list):
            out["error"] = "unexpected API shape"
            return out
        # liquidity 기준 정렬 후 상위 N
        markets = sorted(
            markets,
            key=lambda m: (m.get("details") or {}).get("liquidity", 0) or 0,
            reverse=True,
        )[:TOP_MARKETS]
        out["markets"] = markets
        out["markets_count"] = len(markets)
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        return out


def discovery_to_module_nodes(discovery: dict) -> list[dict]:
    nodes: list[dict] = []
    seen: set[str] = set()

    def add(addr: str, ntype: str, label: str, md: dict, protocol="pendle"):
        a = _strip_chain(addr)
        if not a.startswith("0x") or a in seen:
            return
        seen.add(a)
        nodes.append({
            "address": a, "chain_id": 1, "type": ntype,
            "protocol": protocol, "label": label,
            "metadata": {**md, "discovered_by": "pendle"},
        })

    for m in discovery.get("markets", []):
        name = m.get("name", "?")
        expiry = (m.get("expiry") or "")[:10]
        liq = (m.get("details") or {}).get("liquidity", 0)
        suffix = f"{name} {expiry}"
        add(m.get("sy"), "sy_token", f"SY-{name}", {"underlying": _strip_chain(m.get("underlyingAsset")), "liquidity": liq})
        add(m.get("pt"), "pt_token", f"PT-{suffix}", {"expiry": m.get("expiry"), "market": _strip_chain(m.get("address"))})
        add(m.get("yt"), "yt_token", f"YT-{suffix}", {"expiry": m.get("expiry"), "market": _strip_chain(m.get("address"))})
        add(m.get("address"), "amm_pool", f"Pendle {suffix} Market",
            {"base_assets": ["PT", "SY"], "liquidity": liq, "implied_apy": (m.get("details") or {}).get("impliedApy")})

    return nodes


def discovery_to_module_edges(discovery: dict) -> list[dict]:
    edges: list[dict] = []
    seen: set[str] = set()

    def add(eid, etype, frm, to, md):
        frm = _strip_chain(frm); to = _strip_chain(to)
        if not (frm.startswith("0x") and to.startswith("0x")) or frm == to:
            return
        if eid in seen:
            return
        seen.add(eid)
        edges.append({
            "edge_id": eid, "edge_type": etype, "from": frm, "to": to,
            "protocol": "pendle", "chain_id": 1,
            "metadata": {**md, "discovered": True},
        })

    for m in discovery.get("markets", []):
        sy = m.get("sy"); pt = m.get("pt"); yt = m.get("yt")
        mkt = m.get("address"); ul = m.get("underlyingAsset")
        sy_s = _strip_chain(sy)
        # underlying → SY (wraps) — cross-protocol 연결점
        add(f"pendle-disc:{_strip_chain(ul)[:10]}->{sy_s[:10]}:wrap", "mint_wrapper", ul, sy, {"layer": "wraps_into"})
        # SY → PT (principal split), SY → YT (yield split)
        add(f"pendle-disc:{sy_s[:10]}->{_strip_chain(pt)[:10]}:psplit", "yield_split", sy, pt, {"layer": "principal_split"})
        add(f"pendle-disc:{sy_s[:10]}->{_strip_chain(yt)[:10]}:ysplit", "yield_split", sy, yt, {"layer": "yield_split"})
        # PT → Market, SY → Market (pool asset)
        add(f"pendle-disc:{_strip_chain(pt)[:10]}->{_strip_chain(mkt)[:10]}:pool", "dex", pt, mkt, {"layer": "pool_asset"})
        add(f"pendle-disc:{sy_s[:10]}->{_strip_chain(mkt)[:10]}:pool", "dex", sy, mkt, {"layer": "pool_asset"})

    return edges
