"""
dex_liquidity.py — the DEX (Uniswap) liquidity edge, gated by oracle type.

Paper basis:
  - Cifuentes-Ferrucci-Shin (2005), Lehar-Parlour: liquidation → DEX sell → price
    impact → mark-to-market loss → MORE liquidation (fire-sale feedback). Recovery
    falls as the liquidation size approaches DEX depth.
  - Aave CAPO docs: LST/LRT (and PT) are priced by NAV / exchange-rate with an upper
    cap — the oracle does NOT follow DEX spot down. So the fire-sale channel is OFF
    for these (liquidation is via redemption at NAV, not a DEX dump). This is exactly
    teammate-2's point, validated by the CAPO mechanism.

So: recovery is asset-type-aware. NAV/CAPO assets → no DEX haircut. DEX-priced assets
→ recovery = base × (1 − price_impact(liquidation / dex_depth)).

`dex_depth_usd` is the input Uniswap (or aggregate DEX) liquidity would wire in; until
that data is connected, callers pass None and recovery is unchanged (safe fallback).
"""
from __future__ import annotations

# Assets priced by NAV / exchange-rate / CAPO oracles (DEX spot does NOT feed bad debt).
_NAV_CAPO = {
    "wstETH", "weETH", "stETH", "eETH", "rsETH", "wrsETH", "ezETH", "osETH",
    "rETH", "cbETH", "mETH", "sfrxETH", "frxETH",
    "sUSDe", "sUSDS", "sdeUSD", "sUSDS", "stUSR", "wstUSR",
}

# Approximate AGGREGATE on-chain DEX liquidity (Uniswap v3 + Curve + Balancer), in USD,
# that a liquidation can sell into with bounded slippage. Order-of-magnitude, curated;
# REPLACE with live pool TVL when a depth feed is wired (effective_recovery takes the
# value as an argument, so swapping the source needs no formula change). Only DEX-priced
# (non-NAV) collateral matters — NAV/CAPO assets redeem at NAV and bypass this channel.
_DEX_DEPTH_USD: dict[str, float] = {
    "WETH": 3_000_000_000, "ETH": 3_000_000_000,
    "WBTC": 600_000_000, "cbBTC": 250_000_000, "tBTC": 60_000_000, "LBTC": 80_000_000,
    "LINK": 80_000_000, "AAVE": 50_000_000, "UNI": 60_000_000, "CRV": 25_000_000,
    "LDO": 20_000_000, "MKR": 30_000_000, "SKY": 25_000_000, "ENA": 40_000_000,
    "PENDLE": 25_000_000, "COMP": 15_000_000, "SNX": 12_000_000,
}
_DEX_DEPTH_DEFAULT = 8_000_000   # unknown DEX-priced long-tail: shallow → fire-sale bites


def dex_depth_for(symbol: str) -> float:
    """USD DEX depth for `symbol` (0 for NAV/CAPO assets — channel off). Prefers LIVE
    Uniswap-v3 pooled liquidity; falls back to the curated registry, then a default."""
    if oracle_type(symbol) == "nav":
        return 0.0
    try:
        from . import dex_depth_live as _ddl
        live = _ddl.dex_depth_live(symbol)
        if live and live > 0:
            return live
    except Exception:
        pass
    return _DEX_DEPTH_USD.get(symbol, _DEX_DEPTH_DEFAULT)


# Auto BASE liquidation recovery (before the DEX fire-sale haircut, which M2 applies on top).
# Grounded in the liquidation incentive each asset type actually pays:
#   - NAV/CAPO (LST/LRT/PT, staked stables): liquidation redeems at NAV / exchange-rate, minimal
#     friction (small gas + redemption discount) → ~0.98.
#   - DEX-priced: the liquidator takes a ~5% bonus (a haircut on what the lender recovers) plus
#     gas → ~0.95 base; M2 fire-sale then cuts further by liquidation-size/DEX-depth.
_AUTO_RECOVERY_NAV = 0.98
_AUTO_RECOVERY_DEX = 0.95


def auto_base_recovery(symbol: str) -> float:
    """Per-ASSET fallback base recovery from oracle type (used when no protocol-specific
    liquidation parameter is available). Prefer the per-market values below when possible."""
    return _AUTO_RECOVERY_NAV if oracle_type(symbol) == "nav" else _AUTO_RECOVERY_DEX


# ── PRECISE base recovery from each protocol's real liquidation incentive ──
# Base recovery = 1 / LIF, where LIF (liquidation incentive factor) is the premium the
# liquidator takes — i.e. collateral worth debt×LIF is seized to repay debt, so only 1/LIF
# of seized value covers debt. M2 fire-sale is an ADDITIONAL haircut on top (DEX assets).
_MORPHO_LIQ_CURSOR = 0.3      # Morpho Blue LIQUIDATION_CURSOR
_MORPHO_MAX_LIF = 1.15        # Morpho Blue MAX_LIQUIDATION_INCENTIVE_FACTOR


def morpho_recovery_from_lltv(lltv_wad) -> float | None:
    """Morpho Blue per-market base recovery from its LLTV (exact protocol formula):
        LIF = min(1.15, 1 / (1 − 0.3·(1 − LLTV))),  recovery = 1/LIF.
    `lltv_wad` is the market LLTV in WAD (1e18). None if unparseable."""
    try:
        lltv = float(lltv_wad) / 1e18
    except (TypeError, ValueError):
        return None
    if not (0.0 < lltv < 1.0):
        return None
    lif = min(_MORPHO_MAX_LIF, 1.0 / (1.0 - _MORPHO_LIQ_CURSOR * (1.0 - lltv)))
    return round(1.0 / lif, 4)


def recovery_from_penalty(penalty_pct) -> float | None:
    """Aave/Spark per-reserve base recovery from the liquidation penalty (bonus) in PERCENT:
        recovery = 1 / (1 + penalty/100).  None if unparseable."""
    try:
        p = float(penalty_pct)
    except (TypeError, ValueError):
        return None
    if p < 0:
        return None
    return round(1.0 / (1.0 + p / 100.0), 4)


def oracle_type(symbol: str) -> str:
    """'nav' (NAV/CAPO/exchange-rate, fire-sale OFF) | 'dex' (market-priced, fire-sale ON)."""
    if symbol in _NAV_CAPO or symbol.startswith("PT-") or symbol.startswith("PT_"):
        return "nav"
    return "dex"


def lp_exit_fraction(rho: float) -> float:
    """Fraction of DEX liquidity that flees during a run of intensity ρ (LPs pull to avoid
    toxic flow). Convex, capped: thinner book under stress → worse fire-sale recovery.
    This is the liquidity→fire-sale link (run shrinks depth → solvency recovery falls)."""
    if rho <= 0:
        return 0.0
    return round(min(0.7, 0.8 * rho), 4)


def price_impact(liquidation_usd: float, dex_depth_usd: float) -> float:
    """Fraction of value lost to slippage when dumping `liquidation_usd` into a pool of
    depth `dex_depth_usd`. Convex, capped at 50%."""
    if not dex_depth_usd or dex_depth_usd <= 0:
        return 0.0
    return min(0.5, 0.5 * (liquidation_usd / dex_depth_usd))


def firesale_recovery(base_recovery: float, liquidation_usd: float, depth_usd: float | None) -> float:
    """Fire-sale recovery using an EXPLICIT depth, applied UNCONDITIONALLY (no oracle-type
    gating). Used for Pendle PT, which is NAV-classified but DOES have market-price risk in
    its own Pendle AMM pool — so we pass the Pendle pool liquidity as `depth_usd`."""
    if not depth_usd or depth_usd <= 0:
        return base_recovery
    return max(0.4, base_recovery * (1.0 - price_impact(liquidation_usd, depth_usd)))


def effective_recovery(symbol: str, base_recovery: float,
                       liquidation_usd: float = 0.0,
                       dex_depth_usd: float | None = None) -> float:
    """
    Recovery factor adjusted for the DEX fire-sale channel, gated by oracle type.
    - NAV/CAPO asset  → redemption at NAV, no DEX impact → base_recovery unchanged.
    - DEX-priced asset → base_recovery × (1 − price_impact); needs dex_depth_usd, else base.
    """
    if oracle_type(symbol) == "nav":
        return base_recovery
    if not dex_depth_usd:
        return base_recovery  # safe fallback until Uniswap depth is wired
    return max(0.4, base_recovery * (1.0 - price_impact(liquidation_usd, dex_depth_usd)))
