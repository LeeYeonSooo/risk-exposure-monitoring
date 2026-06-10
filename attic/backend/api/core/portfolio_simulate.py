"""
Wallet-portfolio simulation endpoint.

Combines:
  - portfolio_fetcher.fetch_wallet_portfolio   → per-asset collateral breakdown
  - wallet_fetcher Aave eth_call (inline)      → total debt, account-level HF, lt_weighted
  - simulation.assets.REGISTRY                 → recognise which holdings are simulatable
  - simulation.scenarios                        → scenario shock magnitudes
  - simulation.multi_position                   → proper Σ HF formula

Output: per-scenario new_hf and per-asset shock contributions for the user.

LIMITATIONS:
  - Only Aave V3 aToken collateral counts toward HF. Wallet-held LST/LRT (not
    pledged) is shown but does not affect HF.
  - Scenario → shock mapping uses Scenario.shocked_price / initial_price as
    the per-target-asset price multiplier. Other assets in the same `family`
    are assumed to move by the same multiplier (very rough — proper
    correlation needs P1-13).
  - Debt is treated as USD-denominated (its dollar value does not move under
    LST/LRT shocks). This is exact for stablecoin debt and a good
    approximation for WETH debt under LST depeg.
"""

from __future__ import annotations
import asyncio
import httpx
import os
import re
from typing import Optional

from Crypto.Hash import keccak

from simulation.assets import REGISTRY, list_supported, AssetSpec
from simulation.scenarios import build_scenarios, Scenario, scenarios_for_family
from simulation.multi_position import MultiPosition, CollateralLeg, DebtLeg
from ..fetchers.portfolio_fetcher import fetch_wallet_portfolio


_ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
RPC_ENDPOINTS = (
    [f"https://eth-mainnet.g.alchemy.com/v2/{_ALCHEMY_KEY}"] if _ALCHEMY_KEY else []
) + [
    "https://eth-pokt.nodies.app",
    "https://virginia.rpc.blxrbdn.com",
]

AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _sel(sig: str) -> str:
    h = keccak.new(digest_bits=256)
    h.update(sig.encode())
    return "0x" + h.hexdigest()[:8]


SEL_ACCOUNT = _sel("getUserAccountData(address)")


def _addr_arg(addr: str) -> str:
    return "000000000000000000000000" + addr[2:].lower()


def _words(hex_result: str) -> list[int]:
    data = hex_result[2:] if hex_result.startswith("0x") else hex_result
    return [int(data[i:i + 64], 16) for i in range(0, len(data), 64)]


async def _fetch_aave_account_data(wallet: str) -> dict:
    """Returns total_collateral_usd, total_debt_usd, lt_weighted, hf, available_borrows."""
    user_arg = _addr_arg(wallet)
    async with httpx.AsyncClient(timeout=10.0) as client:
        for rpc in RPC_ENDPOINTS:
            try:
                resp = await client.post(rpc, json={
                    "jsonrpc": "2.0", "method": "eth_call",
                    "params": [{"to": AAVE_POOL, "data": SEL_ACCOUNT + user_arg}, "latest"],
                    "id": 1,
                })
                resp.raise_for_status()
                raw = resp.json().get("result", "")
                if not raw or raw == "0x":
                    continue
                w = _words(raw)
                hf_raw = w[5]
                return {
                    "total_collateral_usd": w[0] / 1e8,
                    "total_debt_usd":       w[1] / 1e8,
                    "available_borrows_usd": w[2] / 1e8,
                    "lt_weighted":          w[3] / 10_000,
                    "ltv":                   w[4] / 10_000,
                    "health_factor":        hf_raw / 1e18 if hf_raw < 2**128 else float("inf"),
                }
            except Exception:
                continue
    raise RuntimeError("All RPC endpoints failed for getUserAccountData")


def _shock_magnitude_per_asset(scenario: Scenario, target_assets: list[str], spec_by_symbol: dict[str, AssetSpec]) -> dict[str, float]:
    """Map symbol → price multiplier for this scenario.

    Approximation: the scenario was built using one base price (`scenario.shocked_price`
    and the implied initial). We extract a single multiplier M = shocked_price / initial_price
    and apply it to every target asset that shares the scenario's `families`.

    Assets whose family is not in scenario.families get multiplier 1.0 (untouched).
    """
    # We don't have the implicit initial; reconstruct from shocked_price + shock_description
    # Easier: use shocked_price / max(shocked_price, oracle_start_price) — but oracle_start_price
    # is sometimes equal to shocked_price (eMode shock scenarios), so we just normalise:
    # the Scenario object was built with build_scenarios(rseth_price=initial). The shocked_price
    # IS the post-shock value, so multiplier = shocked_price / initial. We pass the initial in.
    return {}  # filled by caller


def _apply_scenario_to_position(
    mp: MultiPosition,
    scenario: Scenario,
    initial_prices: dict[str, float],
    spec_by_symbol: dict[str, AssetSpec],
) -> tuple[MultiPosition, dict[str, float]]:
    """
    Returns (shocked_position, multipliers_applied).

    Multiplier rule (P0-3 minimum, P1-13 will refine):
      For each collateral asset in the position:
        - If asset.scenario_family in scenario.families:
              multiplier = scenario.shocked_price / initial_prices[base_asset]
              (use base asset's initial as the reference)
        - else:
              multiplier = 1.0
    """
    # Pick a reference base asset: the one whose family the scenario primarily targets
    # (rsETH for LRT scenarios, wstETH for LST scenarios). Use the first family.
    primary_family = scenario.families[0] if scenario.families else "lrt"
    base = next(
        (a for a in spec_by_symbol.values() if a.scenario_family == primary_family),
        None,
    )
    if base is None or initial_prices.get(base.symbol, 0) <= 0:
        return mp, {}

    multiplier = scenario.shocked_price / initial_prices[base.symbol]
    multipliers: dict[str, float] = {}
    for leg in mp.collaterals:
        spec = spec_by_symbol.get(leg.asset_symbol)
        if spec is None:
            continue
        if spec.scenario_family in scenario.families:
            multipliers[leg.asset_symbol] = multiplier

    shocked = mp.apply_multi_shock(multipliers) if multipliers else mp
    return shocked, multipliers


def _build_multi_position_from_portfolio(
    address: str,
    portfolio: dict,
    account_data: dict,
    spec_by_symbol: dict[str, AssetSpec],
) -> MultiPosition:
    """Build a MultiPosition from the wallet's Aave V3 aToken holdings.

    Wallet-held (non-Aave) holdings are intentionally ignored — they are not
    collateral so they don't enter the HF formula.

    Debt is collapsed into one synthetic USDC leg using the user's
    total_debt_usd from getUserAccountData (we don't fetch per-debt-asset
    breakdown here; a follow-up should call getUserReserveData for the user's
    borrowed reserves).
    """
    legs: list[CollateralLeg] = []
    # A symbol can appear twice (wallet vs aave_collateral); index ALL entries per symbol.
    holdings_by_symbol: dict[str, list[dict]] = {}
    for h in portfolio.get("holdings", []):
        holdings_by_symbol.setdefault(h["symbol"].lower(), []).append(h)

    # eMode detection: if the wallet's lt_weighted is ≥ 0.85, treat all
    # ETH-correlated (cat 1) legs as eMode. This is a heuristic; exact eMode
    # category lookup requires getUserEMode(user) which we don't call here.
    is_emode = account_data.get("lt_weighted", 0) >= 0.85
    emode_category = 1 if is_emode else None

    for sym, spec in spec_by_symbol.items():
        candidates = holdings_by_symbol.get(sym.lower(), [])
        # Prefer the aave_collateral entry; ignore wallet-held (doesn't enter HF).
        h = next((c for c in candidates if c.get("source") == "aave_collateral"), None)
        if not h:
            continue
        bal = h.get("balance", 0)
        price = h.get("price_usd", spec.fallback_price_usd)
        if bal <= 0 or price <= 0:
            continue
        leg_in_emode = is_emode and (spec.aave_emode_category == emode_category)
        legs.append(CollateralLeg(
            asset_symbol=spec.symbol,
            amount=bal,
            price_usd=price,
            # We don't have the per-asset normal LT here — would need fetch_market_params.
            # Use the account-level lt_weighted as a placeholder for normal LT.
            lt_normal=account_data.get("lt_weighted", 0.75),
            lt_emode=0.93 if leg_in_emode else 0.0,
            in_user_emode=leg_in_emode,
        ))

    debt_usd = account_data.get("total_debt_usd", 0)
    debts = [DebtLeg("USDC", debt_usd, 1.0)] if debt_usd > 0 else []

    return MultiPosition(
        id=0, owner_addr=address.lower(),
        protocol="aave_v3", chain="ethereum",
        collaterals=legs, debts=debts,
        emode_category=emode_category,
    )


async def simulate_portfolio(address: str, scenarios_filter: Optional[list[str]] = None) -> dict:
    """Main entry point. Fetches portfolio + Aave account, runs all applicable scenarios."""
    address = address.strip()
    if not _ADDR_RE.match(address):
        return {"error": "Invalid Ethereum address"}

    portfolio, account_data = await asyncio.gather(
        fetch_wallet_portfolio(address),
        _fetch_aave_account_data(address),
    )

    # Detect which registered assets the user actually holds (in Aave or wallet)
    held_symbols = {h["symbol"].lower() for h in portfolio.get("holdings", [])}
    spec_by_symbol = {
        spec.symbol: spec
        for spec in list_supported()
        if spec.symbol.lower() in held_symbols
    }

    if not spec_by_symbol:
        return {
            "address": address,
            "has_simulatable_position": False,
            "message": "지갑에 시뮬레이션 가능한 자산이 없습니다.",
            "registered_assets": [s.symbol for s in list_supported()],
            "holdings_symbols": list(held_symbols),
        }

    # Pick the user's primary asset (largest Aave-collateral value among registered)
    aave_legs = [
        h for h in portfolio.get("holdings", [])
        if h.get("source") == "aave_collateral"
        and h["symbol"] in spec_by_symbol
    ]
    if not aave_legs:
        return {
            "address": address,
            "has_simulatable_position": False,
            "message": "Aave V3 담보로 예치된 등록 자산이 없습니다 (지갑에만 보유 중).",
            "wallet_only_assets": [h["symbol"] for h in portfolio.get("holdings", [])],
        }

    aave_legs.sort(key=lambda x: x["value_usd"], reverse=True)
    primary = spec_by_symbol[aave_legs[0]["symbol"]]

    # Initial prices map (for shock multiplier)
    initial_prices = {h["symbol"]: h.get("price_usd", 0) for h in aave_legs}

    # Build the base MultiPosition
    mp = _build_multi_position_from_portfolio(address, portfolio, account_data, spec_by_symbol)
    if not mp.collaterals:
        return {
            "address": address,
            "has_simulatable_position": False,
            "message": "MultiPosition 빌드 실패 (담보 정보 누락).",
        }

    base_hf = mp.health_factor()

    # Pick applicable scenarios (filter by primary asset's family, or by caller-specified list)
    scenarios = build_scenarios(rseth_price=initial_prices[primary.symbol])
    if scenarios_filter:
        scenarios = [s for s in scenarios if s.name in scenarios_filter]
    else:
        scenarios = [s for s in scenarios if primary.scenario_family in s.families]

    results = []
    for s in scenarios:
        shocked, mults = _apply_scenario_to_position(mp, s, initial_prices, spec_by_symbol)
        new_hf = shocked.health_factor()
        results.append({
            "scenario": s.name,
            "display_name": s.display_name,
            "confidence": s.confidence,
            "applied_multipliers": {k: round(v, 4) for k, v in mults.items()},
            "base_hf": round(base_hf, 3) if base_hf != float("inf") else None,
            "new_hf": round(new_hf, 3) if new_hf != float("inf") else None,
            "delta_hf": (
                round(new_hf - base_hf, 3)
                if base_hf != float("inf") and new_hf != float("inf")
                else None
            ),
            "liquidated": new_hf < 1.0,
            "post_shock_collateral_usd": round(shocked.total_collateral_usd, 2),
            "post_shock_lt_weighted_usd": round(shocked.weighted_lt_collateral_usd, 2),
        })

    return {
        "address": address,
        "has_simulatable_position": True,
        "primary_asset": primary.symbol,
        "primary_family": primary.scenario_family,
        "aave_account": {
            "total_collateral_usd": round(account_data["total_collateral_usd"], 2),
            "total_debt_usd": round(account_data["total_debt_usd"], 2),
            "lt_weighted": account_data["lt_weighted"],
            "live_hf": (
                round(account_data["health_factor"], 3)
                if account_data["health_factor"] != float("inf") else None
            ),
            "is_likely_emode": mp.emode_category is not None,
        },
        "multi_position_summary": {
            "collaterals": [
                {
                    "symbol": c.asset_symbol,
                    "amount": round(c.amount, 4),
                    "price_usd": round(c.price_usd, 2),
                    "value_usd": round(c.value_usd, 2),
                    "effective_lt": c.effective_lt,
                    "in_emode": c.in_user_emode,
                }
                for c in mp.collaterals
            ],
            "total_debt_usd": round(mp.total_debt_usd, 2),
            "computed_hf": round(mp.health_factor(), 3) if mp.health_factor() != float("inf") else None,
        },
        "scenarios": results,
        "data_quality": {
            "limitation_per_asset_lt": (
                "Per-asset normal LT was set to the wallet's overall lt_weighted as a "
                "proxy — accurate LT requires fetch_market_params per asset."
            ),
            "limitation_debt_breakdown": (
                "Debt is collapsed into one synthetic USDC leg. Per-debt-asset shocks "
                "(e.g. WETH-denominated debt under LST depeg) are not yet modeled."
            ),
            "limitation_correlation": (
                "Multi-asset shocks use a single multiplier derived from the scenario's "
                "primary target. Per-asset correlation (P1-13) will refine this."
            ),
        },
    }
