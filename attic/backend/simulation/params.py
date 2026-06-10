"""
Protocol parameters sourced from research:
- Aave V3 rsETH onboarding proposal (Proposal #205)
- Post-2026-04-18 Kelp DAO exploit incident reports
- LlamaRisk rsETH collateral assessment
"""

# FALLBACK ONLY — used when live oracle is unavailable. Production code paths
# must override this by passing an explicit price; see simulation_runner.run_simulation
# (the response will set data_quality.price_source="fallback_constant" if this is hit).
RSETH_PRICE_USD = 2500.0  # pre-hack baseline (~1.05 ETH * $2380)

AAVE_V3 = {
    "normal": {
        "ltv": 0.72,
        "liquidation_threshold": 0.75,
        "liquidation_bonus": 0.10,  # liquidationBonus=11000 → 1.10x collateral → +10% profit
    },
    "emode": {
        "ltv": 0.93,
        "liquidation_threshold": 0.93,
        "liquidation_bonus": -0.05,  # liq_bonus=9500 → 95% payout → liquidator loses 5%
    },
}

COMPOUND_V3 = {
    "collateral_factor": 0.80,
    "liquidation_factor": 0.85,
    "liquidation_bonus": 0.05,
}

# FALLBACK ONLY — Uniswap V3 WETH/rsETH pool (0x059615...1d3) conservative estimate.
# Overridden by live on-chain liquidity via simulation_runner whenever cached_stats is fresh.
DEX_LIQUIDITY_USD = 30_000_000

# EigenLayer / Kelp DAO rsETH collateral basket
RSETH_BASKET = {
    "native_eth": 0.70,
    "ethx": 0.25,
    "steth": 0.05,
}

# EigenLayer slashing: max realistic single-event slash
EIGENLAYER_MAX_SLASH_PCT = 0.15

# Oracle update lag (blocks). Chainlink heartbeat = 1h or 0.5% deviation
ORACLE_LAG_BLOCKS = 300  # ~1 hour
