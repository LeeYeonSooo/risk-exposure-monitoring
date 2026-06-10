"""
derivatives.py — generic "underlying → derivative token" registry.

A shock to an underlying propagates to any token that is a claim on it (wrapper,
LST/LRT non-rebasing form, Pendle PT). Those derivative tokens are widely used as
COLLATERAL on Morpho/Aave, so this is a real derivative-propagation branch.

Unifies several protocols under ONE mechanism (= they all "plug in" to the sim):
  - Lido    : stETH → wstETH
  - etherFi : eETH  → weETH
  - Pendle  : <underlying> → PT-<underlying>  (via Pendle API, dynamic)

To add a protocol later, append to _WRAPPERS or add a dynamic source like Pendle.
`depeg_factor` = how much the derivative depegs per unit of underlying depeg
(≈1.0 for principal wrappers/PT; could be <1 for partial claims).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

_MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
_PT_DATE_RE = re.compile(r"(?P<d>\d{1,2})(?P<mon>[A-Z]{3})(?P<y>\d{4})$", re.IGNORECASE)


def _pt_maturity_factor(symbol: str, base: float = 1.0) -> float:
    """Maturity-aware PT depeg factor. A PT principal claim converges to the underlying at
    maturity (factor→1), but a long-dated PT carries more time-value cushion that damps a
    transient underlying depeg slightly. factor = base·(1 − 0.08·min(T_years, 2)), ≥0.85."""
    m = _PT_DATE_RE.search((symbol or "").upper())
    if not m:
        return base
    try:
        mat = datetime(int(m.group("y")), _MONTHS[m.group("mon")], int(m.group("d")), tzinfo=timezone.utc)
    except Exception:
        return base
    years = max(0.0, (mat - datetime.now(timezone.utc)).days / 365.0)
    return round(max(0.85, base * (1.0 - 0.08 * min(years, 2.0))), 4)

# Static wrapper map: underlying symbol -> [(derivative symbol, depeg_factor, protocol)]
_WRAPPERS: dict[str, list[tuple[str, float, str]]] = {
    "stETH": [("wstETH", 1.0, "Lido")],
    "eETH":  [("weETH", 1.0, "etherFi")],
    "ETH":   [("wstETH", 1.0, "Lido"), ("weETH", 1.0, "etherFi")],
    # extend here as protocols are added (e.g. "rsETH": [("wrsETH",1.0,"Kelp")])
}

# Stablecoin BACKING dependency: backer -> [(dependent, fraction, issuer)]. A depeg of the
# backer drags the dependent down by `fraction` of its move — the dependent's exposure to the
# backer (PSM / collateral share). Grounded in the March-2023 USDC depeg, where DAI/USDS/FRAX
# followed USDC because a large share of their backing WAS USDC (DAI ~50% via PSM at the time).
_BACKING: dict[str, list[tuple[str, float, str]]] = {
    "USDC":  [("DAI", 0.50, "Sky"), ("USDS", 0.40, "Sky"), ("sDAI", 0.50, "Sky"),
              ("sUSDS", 0.40, "Sky"), ("USDe", 0.30, "Ethena"), ("sUSDe", 0.30, "Ethena"),
              ("FRAX", 0.30, "Frax"), ("GHO", 0.20, "Aave")],
    "DAI":   [("sDAI", 1.0, "Sky"), ("USDS", 0.60, "Sky")],
    "USDS":  [("sUSDS", 1.0, "Sky")],
    "USDe":  [("sUSDe", 1.0, "Ethena")],
}

# Pendle PT collateral symbol format: "PT-<underlying>-<DDMMMYYYY>", e.g.
#   PT-wstETH-25DEC2025, PT-USDe-31JUL2025, PT-apyUSD-18JUN2026.
# Parsing the symbol (data already on every Morpho market) is FAR more robust than the
# Pendle "active markets" API, which drops matured/older PTs (empirically matched only
# 14/126 live PT-collateral markets). We extract the underlying and match by symbol.
_PT_RE = re.compile(r"^PT[-_](?P<under>.+?)[-_]\d{1,2}[A-Z]{3}\d{4}$", re.IGNORECASE)

# normalize a few underlying aliases so an underlying shock catches its PT family
_UNDERLYING_ALIASES: dict[str, str] = {
    "weth": "eth", "wsteth": "wsteth", "wbeth": "wbeth",
}


def parse_pt_underlying(symbol: str | None) -> str | None:
    """'PT-wstETH-25DEC2025' -> 'wstETH'. None if not a PT symbol."""
    if not symbol:
        return None
    m = _PT_RE.match(symbol.strip())
    return m.group("under") if m else None


def _norm(sym: str) -> str:
    s = (sym or "").lower()
    return _UNDERLYING_ALIASES.get(s, s)


def derivatives_of(underlying_symbol: str, markets: list[dict]) -> list[dict]:
    """
    Return derivative-collateral markets for `underlying_symbol`.
    Each item: {label, protocol, depeg_factor, market}  where market is the Morpho
    market whose collateral is a derivative token of the underlying (Lido/etherFi
    wrapper, or a Pendle PT on this underlying).
    """
    out: list[dict] = []

    # 1) static wrappers (Lido, etherFi, …) — match by collateral SYMBOL
    wrappers = {sym: (f, proto) for sym, f, proto in _WRAPPERS.get(underlying_symbol, [])}

    # stablecoin backing dependents (USDC→DAI/USDS/…): a depeg drags them by `fraction`
    backing = {sym: (f, proto) for sym, f, proto in _BACKING.get(underlying_symbol, [])}

    target = _norm(underlying_symbol)
    for m in markets:
        csym = (m.get("collateralAsset") or {}).get("symbol")
        if not csym:
            continue
        # static wrapper match
        if csym in wrappers:
            f, proto = wrappers[csym]
            out.append({"label": csym, "protocol": proto, "depeg_factor": f, "market": m})
            continue
        # stablecoin backing dependent match
        if csym in backing:
            f, proto = backing[csym]
            out.append({"label": csym, "protocol": proto, "depeg_factor": f, "market": m})
            continue
        # Pendle PT — parse the collateral symbol and match its underlying
        pt_under = parse_pt_underlying(csym)
        if pt_under and _norm(pt_under) == target:
            # PT is a principal claim on the underlying; underlying depeg passes to the
            # principal, scaled by a maturity-aware factor (→1 near maturity, damped far out).
            out.append({"label": csym, "protocol": "Pendle",
                        "depeg_factor": _pt_maturity_factor(csym), "market": m})

    return out
