"""
sky_cdp.py — Sky (formerly MakerDAO) CDP venue, ilk-level.

Distinct from SparkLend (Sky's Aave-fork lending arm, already a venue): the CDP is a
collateralized-debt-position system where users mint USDS/DAI against collateral (ETH,
wstETH, WBTC) at a per-ilk liquidation ratio. A collateral depeg can push a vault below
its ratio → liquidation auction → if the auction can't cover the minted debt, the system
takes BAD DEBT (covered by the surplus buffer / MKR dilution).

ABSORPTION (same shape as lending, with the CDP's liquidation-ratio trigger):
  triggered  if  collateral·(1−δ) < debt · liq_ratio        (vault undercollateralized)
  bad_debt   =   max(0, debt − collateral·(1−δ)·recovery)   (auction shortfall)
CDP vaults are deeply over-collateralized, so this is ~0 for small δ and only bites at
severe shocks — exactly the right behavior, and a useful contrast to lending venues.

DATA: per-ilk collateral/debt/ratio. makerburn / a vat feed would supply these live; until
wired, a curated registry of the major ilks (documented public vault stats) is used — the
absorption is computed LIVE, only the balances are curated (swap-in ready).
"""
from __future__ import annotations

# collateral symbol -> [ {ilk, collateral_usd, debt_usd (USDS/DAI minted), liq_ratio} ]
_ILKS: dict[str, list[dict]] = {
    "wstETH": [
        {"ilk": "WSTETH-A", "collateral_usd": 380_000_000, "debt_usd": 150_000_000, "liq_ratio": 1.50},
        {"ilk": "WSTETH-B", "collateral_usd": 250_000_000, "debt_usd": 110_000_000, "liq_ratio": 1.50},
    ],
    "WETH": [
        {"ilk": "ETH-A", "collateral_usd": 300_000_000, "debt_usd": 120_000_000, "liq_ratio": 1.45},
        {"ilk": "ETH-B", "collateral_usd": 40_000_000,  "debt_usd": 20_000_000,  "liq_ratio": 1.30},
        {"ilk": "ETH-C", "collateral_usd": 200_000_000, "debt_usd": 60_000_000,  "liq_ratio": 1.70},
    ],
    "WBTC": [
        {"ilk": "WBTC-A", "collateral_usd": 45_000_000, "debt_usd": 18_000_000, "liq_ratio": 1.45},
        {"ilk": "WBTC-C", "collateral_usd": 30_000_000, "debt_usd": 9_000_000,  "liq_ratio": 1.75},
    ],
}

_ALIAS = {"stETH": "wstETH", "ETH": "WETH", "cbBTC": "WBTC"}


def has_ilks(collateral_symbol: str) -> bool:
    return bool(_ILKS.get(collateral_symbol) or _ILKS.get(_ALIAS.get(collateral_symbol, "")))


def cdp_shock(collateral_symbol: str, delta: float, recovery: float = 1.0) -> dict:
    """Shock `collateral_symbol` by δ across Sky CDP ilks; return aggregated bad debt.
    bad debt arises only where the vault is pushed below its liquidation ratio AND the
    auction (collateral·(1−δ)·recovery) can't cover the minted debt."""
    ilks = _ILKS.get(collateral_symbol) or _ILKS.get(_ALIAS.get(collateral_symbol, "")) or []
    rows = []
    total_bad = 0.0
    n_liquidatable = 0
    for it in ilks:
        c, d, lr = it["collateral_usd"], it["debt_usd"], it["liq_ratio"]
        if d <= 0:
            continue
        c_after = c * (1.0 - delta)
        hf = c_after / (d * lr)                       # <1 → undercollateralized
        recoverable = c_after * recovery
        bad = max(0.0, d - recoverable) if hf < 1.0 else 0.0
        if hf < 1.0:
            n_liquidatable += 1
        if bad > 0:
            total_bad += bad
        rows.append({"ilk": it["ilk"], "collateral_usd": c, "debt_usd": d,
                     "liq_ratio": lr, "hf_after": round(hf, 3), "bad_debt_usd": round(bad)})
    return {
        "available": bool(ilks), "venue": "Sky CDP",
        "asset": collateral_symbol, "delta": delta,
        "n_ilks": len(ilks), "n_liquidatable": n_liquidatable,
        "total_bad_debt_usd": round(total_bad),
        "ilks": sorted(rows, key=lambda r: -r["bad_debt_usd"]),
        # bad debt is borne by the surplus buffer (DAI/USDS), exposed like a supplier sink
        "bad_debt_by_asset": {"USDS/DAI (surplus buffer)": round(total_bad)} if total_bad > 0 else {},
    }
