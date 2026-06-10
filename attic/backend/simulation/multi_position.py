"""
Multi-collateral / multi-debt position model.

Implements the real Aave V3 health-factor formula:

    HF = Σ(collateral_i.amount × collateral_i.price_usd × LT_i)
         ─────────────────────────────────────────────────────────
                  Σ(debt_j.amount × debt_j.price_usd)

Reference: Aave V3 Technical Paper §3.4 (calculateUserAccountData) and the
canonical implementation in [aave-v3-core] ReserveLogic.calculateUserAccountData.

The eMode wrinkle: when a user opts into an eMode category, **all collateral**
in that category uses the eMode LT (not the per-asset LT). The single-asset
`Position` collapses this into one LT field; the multi-asset version computes
the LT per leg from `emode_category` membership.

This dataclass is additive — the existing single-asset `Position` is preserved
for the rsETH simulation path. Future work (P0-3) will switch wallet-driven
simulations to use MultiPosition.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


# Inf sentinel for HF when there is no debt
HF_INFINITY = float("inf")


@dataclass
class CollateralLeg:
    """One collateral leg of a multi-asset position."""
    asset_symbol: str          # e.g. "wstETH", "rsETH", "weETH"
    amount: float              # token units (NOT USD)
    price_usd: float           # current oracle price for the asset
    lt_normal: float           # per-asset Aave LT, used when not in eMode
    lt_emode: float = 0.0      # eMode LT if asset is in the user's eMode category; 0 otherwise
    in_user_emode: bool = False  # True when this leg's asset is in the user's selected eMode

    @property
    def effective_lt(self) -> float:
        """LT actually used in HF calc — eMode LT if eligible, else normal LT."""
        if self.in_user_emode and self.lt_emode > 0:
            return self.lt_emode
        return self.lt_normal

    @property
    def value_usd(self) -> float:
        return self.amount * self.price_usd

    @property
    def lt_weighted_value_usd(self) -> float:
        """Contribution to the HF numerator."""
        return self.amount * self.price_usd * self.effective_lt


@dataclass
class DebtLeg:
    """One debt leg (variable or stable rate)."""
    asset_symbol: str          # e.g. "USDC", "WETH"
    amount: float              # token units
    price_usd: float           # current oracle price

    @property
    def value_usd(self) -> float:
        return self.amount * self.price_usd


@dataclass
class MultiPosition:
    """A user's position spanning multiple collateral and debt legs.

    `protocol` identifies the lending protocol ("aave_v3" / "compound_v3" /
    "morpho_blue:<market_id>") so that downstream code can pick the right
    liquidation logic. `emode_category` is None when the user is not in eMode.
    """
    id: int
    owner_addr: str                          # wallet address (lowercased)
    protocol: str
    chain: str                               # "ethereum" / "arbitrum" / ...
    collaterals: list[CollateralLeg] = field(default_factory=list)
    debts: list[DebtLeg] = field(default_factory=list)
    emode_category: Optional[int] = None     # Aave eMode category id; None = not in eMode

    # Liquidation incentive for this position. Per-asset bonuses in Aave V3 are
    # taken from the *collateral seized*, so this is a per-position constant
    # only for single-collateral positions; multi-collateral positions take the
    # bonus from whichever leg the liquidator picks.
    # We keep one default but downstream liquidation logic can override.
    liquidation_bonus: float = 0.05

    # ── Core formulas ────────────────────────────────────────────────────────

    @property
    def total_collateral_usd(self) -> float:
        return sum(c.value_usd for c in self.collaterals)

    @property
    def total_debt_usd(self) -> float:
        return sum(d.value_usd for d in self.debts)

    @property
    def weighted_lt_collateral_usd(self) -> float:
        """Numerator of the Aave V3 HF formula."""
        return sum(c.lt_weighted_value_usd for c in self.collaterals)

    def health_factor(self) -> float:
        debt = self.total_debt_usd
        if debt <= 0:
            return HF_INFINITY
        return self.weighted_lt_collateral_usd / debt

    def average_lt(self) -> float:
        """Collateral-value-weighted average LT (Aave's "currentLiquidationThreshold")."""
        coll = self.total_collateral_usd
        if coll <= 0:
            return 0.0
        return self.weighted_lt_collateral_usd / coll

    def current_ltv(self) -> float:
        """debt_usd / collateral_usd."""
        coll = self.total_collateral_usd
        if coll <= 0:
            return float("inf") if self.total_debt_usd > 0 else 0.0
        return self.total_debt_usd / coll

    def is_liquidatable(self) -> bool:
        return self.total_debt_usd > 0 and self.health_factor() < 1.0

    # ── Shock helpers ────────────────────────────────────────────────────────

    def apply_price_shock(self, asset_symbol: str, multiplier: float) -> "MultiPosition":
        """Return a copy with the given asset's price multiplied (shock applied).

        Multiplier examples:
          0.85 → 15% price drop
          1.10 → 10% rally
        Applies to both collateral and debt legs that reference this asset.
        """
        new_colls = [
            CollateralLeg(
                asset_symbol=c.asset_symbol,
                amount=c.amount,
                price_usd=c.price_usd * (multiplier if c.asset_symbol == asset_symbol else 1.0),
                lt_normal=c.lt_normal,
                lt_emode=c.lt_emode,
                in_user_emode=c.in_user_emode,
            )
            for c in self.collaterals
        ]
        new_debts = [
            DebtLeg(
                asset_symbol=d.asset_symbol,
                amount=d.amount,
                price_usd=d.price_usd * (multiplier if d.asset_symbol == asset_symbol else 1.0),
            )
            for d in self.debts
        ]
        return MultiPosition(
            id=self.id, owner_addr=self.owner_addr,
            protocol=self.protocol, chain=self.chain,
            collaterals=new_colls, debts=new_debts,
            emode_category=self.emode_category,
            liquidation_bonus=self.liquidation_bonus,
        )

    def apply_multi_shock(self, shocks: dict[str, float]) -> "MultiPosition":
        """Apply price shocks to multiple assets at once. shocks: {symbol: multiplier}."""
        result = self
        for sym, mult in shocks.items():
            if mult != 1.0:
                result = result.apply_price_shock(sym, mult)
        return result

    # ── Convenience: convert from legacy single-asset Position ──────────────

    @staticmethod
    def from_single_asset(
        pos,
        collateral_symbol: str,
        collateral_price_usd: float,
        debt_symbol: str = "USDC",
        debt_price_usd: float = 1.0,
        owner_addr: str = "",
        chain: str = "ethereum",
        emode_category: Optional[int] = None,
    ) -> "MultiPosition":
        """Wrap a legacy `Position` as a `MultiPosition` with one leg each.

        `pos.liquidation_threshold` is treated as eMode LT iff `emode_category`
        is set, otherwise as the normal LT.
        """
        in_emode = emode_category is not None and pos.mode == "emode"
        leg = CollateralLeg(
            asset_symbol=collateral_symbol,
            amount=pos.collateral_rseth,
            price_usd=collateral_price_usd,
            lt_normal=pos.liquidation_threshold if not in_emode else 0.0,
            lt_emode=pos.liquidation_threshold if in_emode else 0.0,
            in_user_emode=in_emode,
        )
        debt_amount = pos.debt_usd / debt_price_usd if debt_price_usd > 0 else 0.0
        debt_leg = DebtLeg(asset_symbol=debt_symbol, amount=debt_amount, price_usd=debt_price_usd)
        return MultiPosition(
            id=pos.id, owner_addr=owner_addr,
            protocol="aave_v3", chain=chain,
            collaterals=[leg], debts=[debt_leg],
            emode_category=emode_category,
            liquidation_bonus=pos.liquidation_bonus,
        )
