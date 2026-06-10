"""
LST/LRT Depeg Cascade Simulator
Usage: python -m simulation.main [--scenario all|oracle|bridge|slash|withdrawal]
"""

import argparse
import sys
from .params import RSETH_PRICE_USD, DEX_LIQUIDITY_USD
from .positions import generate_positions
from .engine import CascadeSimulator
from .scenarios import build_scenarios
from .visualize import print_result, print_comparison


def run_all():
    scenarios = build_scenarios()
    positions_base = generate_positions(rseth_price=RSETH_PRICE_USD)

    print(f"\n  기준 포지션 장부:")
    print(f"  rsETH 기준가: ${RSETH_PRICE_USD:,}")
    print(f"  DEX 유동성:   ${DEX_LIQUIDITY_USD/1_000_000:.0f}M")
    print(f"  총 포지션 수: {len(positions_base)}")
    total_collateral = sum(p.collateral_rseth for p in positions_base)
    total_debt = sum(p.debt_usd for p in positions_base)
    print(f"  총 담보:      {total_collateral:,.0f} rsETH (${total_collateral * RSETH_PRICE_USD / 1e6:.1f}M)")
    print(f"  총 부채:      ${total_debt / 1e6:.1f}M")

    results = []
    for s in scenarios:
        liquidity = s.dex_liquidity_override or DEX_LIQUIDITY_USD
        sim = CascadeSimulator(
            dex_liquidity_usd=liquidity,
            initial_price=RSETH_PRICE_USD,
        )
        result = sim.run(
            scenario=s.display_name,
            shock_description=s.shock_description,
            initial_price_override=s.shocked_price,
            oracle_start_price=s.oracle_start_price,
            oracle_freezes=s.oracle_freezes,
            direct_bad_debt_usd=s.direct_bad_debt_usd,
        )
        result.scenario = s.display_name  # preserve display name for comparison
        print_result(result)
        results.append(result)

    print_comparison(results)


def run_one(name: str):
    scenarios = {s.name: s for s in build_scenarios()}
    if name not in scenarios:
        print(f"알 수 없는 시나리오: {name}")
        print(f"사용 가능: {', '.join(scenarios.keys())}")
        sys.exit(1)

    s = scenarios[name]
    liquidity = s.dex_liquidity_override or DEX_LIQUIDITY_USD
    sim = CascadeSimulator(dex_liquidity_usd=liquidity, initial_price=RSETH_PRICE_USD)
    result = sim.run(
        scenario=s.display_name,
        shock_description=s.shock_description,
        initial_price_override=s.shocked_price,
        oracle_freezes=s.oracle_freezes,
    )
    print_result(result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LST/LRT Depeg Cascade Simulator")
    parser.add_argument(
        "--scenario",
        default="all",
        choices=["all", "oracle_manipulation", "bridge_hack", "eigenlayer_slashing", "mass_withdrawal"],
        help="실행할 시나리오 (기본: all)",
    )
    args = parser.parse_args()

    if args.scenario == "all":
        run_all()
    else:
        run_one(args.scenario)
