"""
dex_depth_live.py — LIVE DEX depth from the Uniswap v3 subgraph.

`dex_liquidity._DEX_DEPTH_USD` is a curated fallback; this module queries the real
per-token pooled liquidity (Token.totalValueLockedUSD across all Uni v3 pools) so the
fire-sale recovery uses live depth, not a constant. Built on the same The-Graph gateway
+ key as Aave/Spark (URL = gateway with the Uniswap-v3 subgraph id swapped in). Cached;
returns None on any failure so the caller falls back to the registry (always safe).
"""
from __future__ import annotations

import os
import re
import time

import httpx

try:
    from dotenv import load_dotenv; load_dotenv()
except Exception:
    pass

_AAVE_SUBGRAPH = os.getenv("AAVE_V3_SUBGRAPH_URL", "").strip()
# Uniswap v3 (Ethereum mainnet) subgraph id on The Graph's decentralized network.
_UNI_V3_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV"
UNI_SUBGRAPH = (re.sub(r"(subgraphs/id/)[^/?]+", r"\g<1>" + _UNI_V3_ID, _AAVE_SUBGRAPH)
                if _AAVE_SUBGRAPH else "")

_TTL = 600
_cache: dict[str, tuple[float, float | None]] = {}

_Q = """query($sym:String!){
  tokens(first:5, where:{symbol:$sym}, orderBy:totalValueLockedUSD, orderDirection:desc){
    symbol totalValueLockedUSD } }"""


_Q_AT = """query($sym:String!,$blk:Int!){
  tokens(first:5, where:{symbol:$sym}, orderBy:totalValueLockedUSD, orderDirection:desc,
    block:{number:$blk}){ symbol totalValueLockedUSD } }"""


def dex_depth_live(symbol: str) -> float | None:
    """Live pooled USD liquidity for `symbol` in Uniswap v3 (max-TVL token of that symbol).
    None if the subgraph is unset/unreachable → caller uses the static registry."""
    if not UNI_SUBGRAPH or not symbol:
        return None
    now = time.time()
    c = _cache.get(symbol)
    if c and now - c[0] < _TTL:
        return c[1]
    depth: float | None = None
    try:
        with httpx.Client() as client:
            r = client.post(UNI_SUBGRAPH, json={"query": _Q, "variables": {"sym": symbol}}, timeout=20)
            r.raise_for_status()
            toks = (r.json().get("data") or {}).get("tokens") or []
        best = max((float(t.get("totalValueLockedUSD") or 0) for t in toks), default=0.0)
        depth = best if best > 0 else None
    except Exception:
        depth = None
    _cache[symbol] = (now, depth)
    return depth


def dex_depth_at_block(symbol: str, block: int) -> float | None:
    """HISTORICAL pooled USD liquidity for `symbol` in Uniswap v3 at `block` (The Graph
    time-travel). Used by the backtests to feed REAL past depth (not a chosen number).
    None if unreachable / not yet indexed at that block."""
    if not UNI_SUBGRAPH or not symbol or not block:
        return None
    try:
        with httpx.Client() as client:
            r = client.post(UNI_SUBGRAPH,
                            json={"query": _Q_AT, "variables": {"sym": symbol, "blk": int(block)}},
                            timeout=25)
            r.raise_for_status()
            d = r.json()
        if "errors" in d:
            return None
        toks = (d.get("data") or {}).get("tokens") or []
        best = max((float(t.get("totalValueLockedUSD") or 0) for t in toks), default=0.0)
        return best if best > 0 else None
    except Exception:
        return None
