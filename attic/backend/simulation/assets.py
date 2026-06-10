"""
Asset registry — minimal viable schema for asset-agnostic simulation.

This module is an EXPERIMENT (P0-1 step 1): we add wstETH alongside rsETH and
let the friction tell us what fields a full MarketContext abstraction needs.

Do not generalize prematurely. Once a 2nd and 3rd asset are added we will
extract the schema into a proper dataclass and remove the per-asset paths.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class AssetSpec:
    """Minimal per-asset metadata needed to drive a single-asset simulation.

    Discovered (so far) as the union of fields hardcoded for rsETH across:
      - onchain_fetcher.fetch_onchain_stats   (Aave reserve + DEX liquidity)
      - simulation.params                      (price, dex liquidity fallback, basket)
      - simulation.scenarios                   (shock magnitudes, basket weights)
      - graph_data                              (graph node id, issuer node id)
      - portfolio_fetcher                       (aToken address, token-to-node map)
    """

    symbol: str
    token_addr: str
    decimals: int

    # Aave V3 Ethereum
    aave_reserve_addr: str           # usually == token_addr (the underlying asset addr)
    aave_atoken_addr: str
    aave_emode_category: Optional[int]  # 1 for ETH-correlated cluster; None if not in any eMode

    # On-chain price oracle (Aave's aggregator wrapper; resolves to Chainlink under the hood)
    aave_oracle_asset_addr: str      # passed to PriceOracle.getAssetPrice()

    # DEX liquidity discovery (DeFiLlama `symbol` substring match — naïve but works)
    # Some assets use the wrapped form (wstETH) while their main pool uses the underlying (stETH).
    dex_symbol_aliases: tuple[str, ...]

    # Graph topology hooks
    graph_node_id: str               # token node id in graph_data.NODES
    issuer_node_id: str              # protocol that mints the token (lido / kelp / rocket-pool / ...)

    # Category label drives which scenario family applies (LST vs LRT have different depeg risks)
    category: str                    # "lst" | "lrt" | "stablecoin" | ...

    # Fallback / pre-hack baseline used ONLY when live oracle fetch fails. Production paths
    # MUST override; the simulation runner attaches data_quality.price_source so the UI can warn.
    fallback_price_usd: float

    # Basket composition (for LRTs that aggregate other LSTs). Empty for pure LSTs.
    # Maps underlying symbol → weight (must sum to ≤ 1; remainder = native ETH).
    basket_composition: dict[str, float] = field(default_factory=dict)

    # Which scenario family applies to this asset.
    # Drives which subset of simulation.scenarios.build_scenarios() is shown in the UI
    # and which threat_config keys are meaningful.
    #   "lrt"  → restaking_slash, basket_nav_drop, oracle_cap_lift, rate_provider_compromise
    #   "lst"  → validator_slashing, peg_break_curve, governance_attack
    #   "stable" → bank_run, collateral_undercollateralization (future)
    scenario_family: str = "lrt"


# ──────────────────────────────────────────────────────────────────────────────
# Registered assets
# ──────────────────────────────────────────────────────────────────────────────

RSETH = AssetSpec(
    symbol="rsETH",
    token_addr="0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
    decimals=18,
    aave_reserve_addr="0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
    aave_atoken_addr="0x2d62109243b87c4ba3ee7ba1d91b0dd0a074d7b1",
    aave_emode_category=1,
    # rsETH uses a CAPO wrapper (0x7292C95A...) registered on the Aave PriceOracle
    aave_oracle_asset_addr="0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
    dex_symbol_aliases=("rseth",),
    graph_node_id="rseth",
    issuer_node_id="kelp",
    category="lrt",
    fallback_price_usd=2500.0,
    basket_composition={"native_eth": 0.70, "ethx": 0.25, "steth": 0.05},
    scenario_family="lrt",
)

WSTETH = AssetSpec(
    symbol="wstETH",
    token_addr="0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    decimals=18,
    aave_reserve_addr="0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    aave_atoken_addr="0x0B925eD163218f6662a35e0f0371Ac234f9E9371",
    aave_emode_category=1,
    aave_oracle_asset_addr="0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    dex_symbol_aliases=("wsteth", "steth"),
    graph_node_id="wsteth",
    issuer_node_id="lido",
    category="lst",
    fallback_price_usd=3000.0,
    basket_composition={},
    scenario_family="lst",
)

# ── LRTs ─────────────────────────────────────────────────────────────────────

WEETH = AssetSpec(
    symbol="weETH",
    token_addr="0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
    decimals=18,
    aave_reserve_addr="0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
    aave_atoken_addr="0xBdfa7b7893081B35Fb54027489e2Bc7A38275129",
    aave_emode_category=1,
    aave_oracle_asset_addr="0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
    dex_symbol_aliases=("weeth",),
    graph_node_id="weeth",
    issuer_node_id="etherfi",
    category="lrt",
    fallback_price_usd=2700.0,
    # weETH NAV ≈ all-stETH-backed, no basket diversification (Ether.fi runs own validators + EL)
    basket_composition={"native_eth": 1.0},
    scenario_family="lrt",
)

EZETH = AssetSpec(
    symbol="ezETH",
    token_addr="0xbf5495Efe5DB9ce00f80364C8B423567e58d2110",
    decimals=18,
    aave_reserve_addr="0xbf5495Efe5DB9ce00f80364C8B423567e58d2110",
    # ezETH is NOT listed on Aave V3 Ethereum (only L2s). Reserve fetch will return zeros.
    aave_atoken_addr="0x0000000000000000000000000000000000000000",
    aave_emode_category=None,
    aave_oracle_asset_addr="0xbf5495Efe5DB9ce00f80364C8B423567e58d2110",
    dex_symbol_aliases=("ezeth",),
    graph_node_id="ezeth",
    issuer_node_id="renzo",
    category="lrt",
    fallback_price_usd=2600.0,
    basket_composition={"native_eth": 0.80, "steth": 0.20},
    scenario_family="lrt",
)

# ── LSTs (additional) ────────────────────────────────────────────────────────

CBETH = AssetSpec(
    symbol="cbETH",
    token_addr="0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
    decimals=18,
    aave_reserve_addr="0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
    aave_atoken_addr="0x977b6fc5dE62598B08C85AC8Cf2b745874E8b78c",
    aave_emode_category=1,
    aave_oracle_asset_addr="0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
    dex_symbol_aliases=("cbeth",),
    graph_node_id="cbeth",
    issuer_node_id="coinbase_lst",
    category="lst",
    fallback_price_usd=2900.0,
    basket_composition={},
    scenario_family="lst",
)

RETH = AssetSpec(
    symbol="rETH",
    token_addr="0xae78736Cd615f374D3085123A210448E74Fc6393",
    decimals=18,
    aave_reserve_addr="0xae78736Cd615f374D3085123A210448E74Fc6393",
    # Aave V3 rETH listed but aToken: leaving zero — verify via portfolio_fetcher later
    aave_atoken_addr="0xCc9EE9483f662091a1de4795249E24aC0aC2630f",
    aave_emode_category=1,
    aave_oracle_asset_addr="0xae78736Cd615f374D3085123A210448E74Fc6393",
    dex_symbol_aliases=("reth",),
    graph_node_id="reth",
    issuer_node_id="rocket_pool",
    category="lst",
    fallback_price_usd=3050.0,  # rETH/ETH ratio ~1.18
    basket_composition={},
    scenario_family="lst",
)


REGISTRY: dict[str, AssetSpec] = {
    "rseth":  RSETH,  "rsETH":  RSETH,
    "wsteth": WSTETH, "wstETH": WSTETH,
    "weeth":  WEETH,  "weETH":  WEETH,
    "ezeth":  EZETH,  "ezETH":  EZETH,
    "cbeth":  CBETH,  "cbETH":  CBETH,
    "reth":   RETH,   "rETH":   RETH,
}


def get_asset(symbol: str) -> AssetSpec:
    """Lookup by symbol (case-insensitive). Raises KeyError on unknown asset."""
    key = symbol.lower()
    for k, v in REGISTRY.items():
        if k.lower() == key:
            return v
    raise KeyError(
        f"Unknown asset symbol: {symbol!r}. Known: {sorted(set(s.symbol for s in REGISTRY.values()))}"
    )


def list_supported() -> list[AssetSpec]:
    """De-duplicated list of all registered assets."""
    seen: set[str] = set()
    out: list[AssetSpec] = []
    for spec in REGISTRY.values():
        if spec.symbol not in seen:
            seen.add(spec.symbol)
            out.append(spec)
    return out
