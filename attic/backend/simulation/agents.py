"""
Agent logic reverse-engineered from MEV/liquidation bot behavior.

LiquidationAgent:
  Real bots scan mempool for HF < 1, race to execute.
  We model: find all HF < 1 → execute optimal (50% debt) liquidation.
  Profit condition: liquidation_bonus * debt_repaid > gas_cost.

ArbAgent:
  Real bots close price gaps between DEX spot and oracle.
  We model: if DEX price < oracle * (1 - fee_threshold), buy.
  This is the stabilizing force that prevents infinite depeg spiral.

Price Impact Models (근사 모델 — exact CLMM/invariant 재현 아님):
  univ3_price_impact  — Uniswap V3 CLMM 근사 (집중 유동성 heuristic)
  curve_price_impact  — Curve StableSwap 근사 (A-factor 기반 단순화)
"""

import math
from copy import deepcopy
from typing import List, Optional, Tuple
from .positions import Position


GAS_COST_USD = 80  # realistic Ethereum mainnet liquidation gas cost


# ── Price impact models ──────────────────────────────────────────────────────

def univ3_price_impact(
    sell_usd: float,
    pool_liq_usd: float,
    concentration_range: float = 0.10,
) -> float:
    """
    Uniswap V3 CLMM 근사 price impact (단순화된 concentration-aware 모델).

    Models a pool where liquidity is concentrated in ±concentration_range around
    the current price. rsETH/WETH pools typically use ±5–15% ranges.

    Within range:
      Virtual liquidity = pool_liq / (2 * (√(1+r) - √(1-r)))
      For r=0.10: conc_factor ≈ 5.1×  (vs. 10.1× for r=0.05)
      impact = 1 - (1 / (1 + sell/V_virtual))²   [exact CLMM in price space]

    Outside range (liquidity cliff):
      Once the sell exceeds in-range depth (~pool_liq × r), remaining volume hits
      very thin out-of-range liquidity → steep incremental impact.

    Args:
        sell_usd:            USD value being sold into the pool.
        pool_liq_usd:        Total pool TVL in USD.
        concentration_range: Half-width of the concentrated range (0.10 = ±10%).
    """
    if pool_liq_usd <= 0:
        return 0.99

    r = concentration_range
    # Virtual liquidity amplification from concentration
    conc_factor = 1.0 / (2.0 * (math.sqrt(1.0 + r) - math.sqrt(1.0 - r)))
    virtual_liq = pool_liq_usd * conc_factor

    # Approx. in-range depth: one-sided capacity ≈ pool_liq * r
    in_range_capacity = pool_liq_usd * r

    if sell_usd <= in_range_capacity:
        # Fully within range — use exact CLMM formula
        x = sell_usd / virtual_liq
        impact = 1.0 - (1.0 / (1.0 + x)) ** 2
    else:
        # Drain in-range liquidity first
        x_in = in_range_capacity / virtual_liq
        impact_in = 1.0 - (1.0 / (1.0 + x_in)) ** 2

        # Remainder hits thin out-of-range liquidity (~5% of pool as constant product)
        overflow = sell_usd - in_range_capacity
        thin_liq = max(pool_liq_usd * 0.05, 1.0)
        overflow_ratio = overflow / thin_liq
        impact_out = overflow_ratio + overflow_ratio ** 2   # steep constant-product fallback

        # Combine: additional impact layered on top
        impact = impact_in + impact_out * (1.0 - impact_in)

    return min(impact, 0.99)


def curve_price_impact(
    sell_usd: float,
    pool_liq_usd: float,
    A: float = 50.0,
    imbalance: float = 0.0,
) -> float:
    """
    Curve StableSwap 근사 price impact (A-factor 기반 단순화 모델).

    Near peg (imbalance ≈ 0), Curve behaves like a pool with A× amplified
    liquidity. As the pool imbalances, it degrades toward constant product (A→1).

    StableSwap invariant (2-pool, simplified):
      Effective liquidity ≈ A × pool_liq × (1 - imbalance)²
      where imbalance = |x - y| / (x + y)  at current reserves

    Typical A values:
      stETH/ETH:   A = 150–300  (very stable, tight pegging)
      LRT pools:   A = 50–100   (moderately stable)

    Args:
        sell_usd:    USD value being sold into the pool.
        pool_liq_usd: Total pool TVL in USD.
        A:           Amplification coefficient (higher = more stable near peg).
        imbalance:   Current pool imbalance (0 = balanced, 1 = fully drained).
    """
    if pool_liq_usd <= 0:
        return 0.99

    # Effective amplification degrades with imbalance
    # At imbalance=0: A_eff = A.  At imbalance=1: A_eff = 1 (constant product).
    a_eff = max(1.0, A * (1.0 - imbalance) ** 2)
    effective_liq = pool_liq_usd * a_eff

    # Curve invariant: near-peg slippage is extremely low (stiff)
    # Away from peg: degrades. Model as ratio / (1 + ratio*(A_eff-1)/A_eff)
    ratio = sell_usd / effective_liq
    # Blends between "constant sum" (no impact) near peg and constant product far from peg
    impact = ratio / (1.0 + ratio * (a_eff - 1.0) / a_eff)

    return min(impact, 0.99)


class LiquidationAgent:
    def __init__(self, gas_cost_usd: float = GAS_COST_USD):
        self.gas_cost_usd = gas_cost_usd

    def scan(self, positions: List[Position], price_usd: float) -> List[Position]:
        """Return positions with HF < 1, sorted worst-first."""
        underwater = [p for p in positions if p.is_liquidatable(price_usd)]
        return sorted(underwater, key=lambda p: p.health_factor(price_usd))

    def liquidate(
        self, position: Position, price_usd: float
    ) -> Tuple[float, float]:
        """
        Execute one liquidation.
        Returns (sell_pressure_usd, bad_debt_usd).

        Liquidator repays up to 50% of debt, seizes collateral + bonus.
        If collateral value < debt repaid → bad debt.
        """
        max_repay_usd = position.debt_usd * 0.50
        bonus = position.liquidation_bonus
        profit = max_repay_usd * bonus - self.gas_cost_usd

        if profit <= 0:
            # Liquidation not profitable for external liquidators (low bonus or gas > bonus).
            collateral_value = position.collateral_rseth * price_usd
            if collateral_value < position.debt_usd:
                # Collateral already underwater: true bad debt, no liquidator can cover.
                # Realise bad debt and remove position so it is not re-counted next tick.
                bad_debt = position.debt_usd - collateral_value
                position.collateral_rseth = 0.0
                position.debt_usd = 0.0
                return 0.0, bad_debt
            else:
                # Collateral still > debt: position can survive further price drops
                # before becoming actual bad debt. Leave it on the book — it will
                # be re-evaluated next tick as price continues to fall.
                # (Previously this was zeroed out, causing bad-debt underestimation.)
                return 0.0, 0.0

        collateral_seized_usd = max_repay_usd * (1 + bonus)
        collateral_seized_rseth = collateral_seized_usd / price_usd

        # Check if enough collateral exists
        if collateral_seized_rseth > position.collateral_rseth:
            # Partial seizure: seize all remaining collateral.
            # Bad debt = total debt minus what was actually recovered from collateral.
            # Previous code used (max_repay - seized) which only covered the 50%
            # tranche, leaving the other 50% as phantom debt (never counted).
            actual_seized_usd = position.collateral_rseth * price_usd
            bad_debt = max(position.debt_usd - actual_seized_usd, 0.0)
            sell_pressure = actual_seized_usd
            position.collateral_rseth = 0.0
            position.debt_usd = 0.0
        else:
            bad_debt = 0.0
            sell_pressure = collateral_seized_usd
            position.collateral_rseth -= collateral_seized_rseth
            position.debt_usd -= max_repay_usd

        return sell_pressure, bad_debt


class ArbAgent:
    """
    Stabilizing force. Buys rsETH on DEX when price < oracle.
    Also models DEX slippage for large sells.

    Pool model selection:
      pool_type='univ3'  — Uniswap V3 CLMM (default for rsETH/WETH)
      pool_type='curve'  — Curve StableSwap (stETH/ETH reference)
      pool_type='legacy' — Original ratio+ratio² approximation (backward-compat)
    """

    # Arb threshold: price must be below oracle by at least this much
    ARB_FEE_THRESHOLD = 0.004  # 0.4% (0.3% pool fee + gas)

    # rsETH/WETH Uniswap V3: typical LP range ±10% around spot
    UNIV3_CONCENTRATION_RANGE = 0.10

    # Curve A for reference stETH/ETH pool
    CURVE_A = 150.0

    def __init__(
        self,
        pool_type: str = 'univ3',
        concentration_range: float = None,
        curve_A: float = None,
        impact_curve: Optional[List[Tuple[float, float]]] = None,
    ):
        """
        Args:
            pool_type:           'univ3' | 'curve' | 'legacy'
            concentration_range: UniV3 ±range (default 0.10). Overrides class default.
            curve_A:             Curve amplification (default 150). Overrides class default.
            impact_curve:        Real on-chain measured impact curve — list of
                                 (sell_usd, impact_fraction) sorted by sell_usd.
                                 When provided, overrides all formula-based models.
                                 Built via Anvil fork + Fluid DEX estimateSwapIn for backtest.
        """
        self.pool_type = pool_type
        self.concentration_range = concentration_range or self.UNIV3_CONCENTRATION_RANGE
        self.curve_A = curve_A or self.CURVE_A
        self.impact_curve: Optional[List[Tuple[float, float]]] = (
            sorted(impact_curve, key=lambda t: t[0]) if impact_curve else None
        )

    def price_impact(self, sell_amount_usd: float, pool_liquidity_usd: float) -> float:
        """
        Price impact of selling sell_amount_usd into the pool.

        Priority:
          1. impact_curve (real on-chain data from Anvil fork) — backtest mode
          2. Formula models (univ3 / curve / legacy) — live / fallback mode

        Returns fractional price drop (0.0–0.99).
        """
        if self.impact_curve:
            return self._interpolate_impact(sell_amount_usd)
        if self.pool_type == 'univ3':
            return univ3_price_impact(
                sell_amount_usd, pool_liquidity_usd, self.concentration_range
            )
        elif self.pool_type == 'curve':
            return curve_price_impact(
                sell_amount_usd, pool_liquidity_usd, self.curve_A
            )
        else:  # legacy
            if pool_liquidity_usd <= 0:
                return 0.99
            ratio = sell_amount_usd / pool_liquidity_usd
            return min(ratio + ratio ** 2, 0.99)

    def _interpolate_impact(self, sell_usd: float) -> float:
        """
        Linear interpolation / extrapolation from real measured impact curve.
        impact_curve is sorted list of (sell_usd, impact_fraction) tuples.
        """
        curve = self.impact_curve
        if not curve:
            return 0.0
        if sell_usd <= curve[0][0]:
            # Below minimum sample — scale linearly from origin
            return min(curve[0][1] * (sell_usd / curve[0][0]), 0.99) if curve[0][0] > 0 else 0.0
        if sell_usd >= curve[-1][0]:
            # Beyond maximum sample — cap at 0.99 (full depeg)
            return min(curve[-1][1], 0.99)
        # Binary search for bracketing interval
        lo, hi = 0, len(curve) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if curve[mid][0] <= sell_usd:
                lo = mid
            else:
                hi = mid
        x0, y0 = curve[lo]
        x1, y1 = curve[hi]
        t = (sell_usd - x0) / (x1 - x0) if x1 != x0 else 0.0
        return min(y0 + t * (y1 - y0), 0.99)

    def arb_buy_pressure(
        self, dex_price: float, oracle_price: float, pool_liquidity_usd: float
    ) -> float:
        """
        How much USD arb bots will buy to close price gap.
        Bots buy until: (oracle - dex) / oracle < ARB_FEE_THRESHOLD.
        Returns USD buy amount.
        """
        if oracle_price <= 0:
            return 0.0
        discount = (oracle_price - dex_price) / oracle_price
        if discount <= self.ARB_FEE_THRESHOLD:
            return 0.0
        # Bots capture (discount - fee_threshold) of the gap
        capturable = discount - self.ARB_FEE_THRESHOLD
        # Engage up to 40% of pool liquidity to close gap
        return capturable * pool_liquidity_usd * 0.40
