"""
pendle_amm.py — Pendle market structure + AMM liquidity (the venue PT actually trades in).

PT (principal token) is NOT redeemed on Uniswap — it is bought/sold in its OWN Pendle AMM
pool (PT ⇄ SY). So a PT collateral liquidation hits the PENDLE pool's liquidity, and a run
on a Pendle pool drains THAT book. This module gives, per Pendle market:
  underlying  — what the SY wraps (e.g. wstETH)
  pt/yt/sy    — token addresses
  liquidity   — the AMM pool USD liquidity (the real fire-sale depth for PT)
  expiry      — maturity (PT → underlying at expiry; pre-expiry it trades at a discount)

Relationships modeled: underlying → SY (wrapper) → { PT (principal), YT (yield) }.
A depeg of the underlying flows to SY and into PT (principal claim); the PENDLE pool
liquidity (not Uniswap) sets PT's fire-sale recovery and its liquidity-run fragility.

Source: Pendle public API (markets/active). Cached; safe-empty on failure.
"""
from __future__ import annotations

import time
import httpx

_API = "https://api-v2.pendle.finance/core/v1/1/markets/active"
_TTL = 600
_cache: dict = {"ts": 0.0, "markets": None}


def _addr(x: str | None) -> str:
    """'1-0xabc...' -> '0xabc...' (strip chain prefix), lowercased."""
    if not x:
        return ""
    return x.split("-")[-1].lower()


def _load() -> list[dict]:
    now = time.time()
    if _cache["markets"] is not None and (now - _cache["ts"]) < _TTL:
        return _cache["markets"]
    out: list[dict] = []
    try:
        r = httpx.get(_API, timeout=25)
        r.raise_for_status()
        for m in r.json().get("markets", []):
            det = m.get("details") or {}
            out.append({
                "underlying": (m.get("name") or "").strip(),
                "market": _addr(m.get("address")),
                "pt": _addr(m.get("pt")),
                "yt": _addr(m.get("yt")),
                "sy": _addr(m.get("sy")),
                "expiry": m.get("expiry"),
                "liquidity_usd": float(det.get("liquidity") or 0.0),
                "implied_apy": float(det.get("impliedApy") or 0.0),
            })
    except Exception:
        out = []
    _cache.update(ts=now, markets=out)
    return out


def pt_market_by_addr(pt_addr: str) -> dict | None:
    """Pendle market info for a PT token address (the PT's own AMM pool)."""
    a = (pt_addr or "").lower()
    if not a:
        return None
    for m in _load():
        if m["pt"] == a:
            return m
    return None


def markets_for_underlying(underlying_symbol: str) -> list[dict]:
    """All Pendle markets whose SY wraps `underlying_symbol` (case-insensitive)."""
    u = (underlying_symbol or "").lower()
    return [m for m in _load() if m["underlying"].lower() == u]


def pt_amm_depth_by_addr(pt_addr: str) -> float | None:
    """Pendle AMM pool liquidity (USD) for a PT — the real fire-sale depth for PT collateral.
    None if the PT isn't in the active set (matured/unknown) → caller falls back."""
    m = pt_market_by_addr(pt_addr)
    return m["liquidity_usd"] if m and m["liquidity_usd"] > 0 else None
