"""
Synthetic position generator — calibrated to 2026-04-18 Kelp/rsETH hack data.

Real Aave V3 rsETH parameters (verified on-chain):
  eMode cat1 (ETH-correlated):
    LT = 93%,  liquidationBonus = 9500 → liquidator receives 0.95x collateral = -5% loss
    → liq_bonus = -0.05  →  NO PROFITABLE LIQUIDATION  →  cascading sell pressure = 0
  Normal mode:
    LT = 75%,  liquidationBonus = 11000 → liquidator receives 1.10x collateral = +10% profit
    → liq_bonus = 0.10
  Compound (used as proxy for other protocols with rsETH collateral):
    LT = 85%,  liq_bonus = 0.05

eMode liquidation behavior in LiquidationAgent:
  profit = max_repay_usd * liq_bonus - gas_cost
  With liq_bonus = -0.05: profit is always negative → no liquidation executed → bad debt only
"""

import random
from dataclasses import dataclass, field
from typing import List


@dataclass
class Position:
    """A single-asset Aave-style position.

    The field name `collateral_rseth` is historical — it actually holds the
    collateral amount in WHATEVER asset the simulation is running against
    (rsETH, wstETH, weETH, ...). The `collateral_amount` alias makes this
    explicit; both refer to the same value.
    """
    id: int
    collateral_rseth: float
    debt_usd: float
    liquidation_threshold: float
    # Profit rate for liquidator: positive = profitable, negative = unprofitable.
    # eMode: -0.05 (9500 basis pts → 95% of collateral returned → 5% loss for liquidator)
    # Normal: 0.10 (11000 basis pts → 110% of collateral returned → 10% profit)
    liquidation_bonus: float
    mode: str  # "emode" | "normal" | "compound"

    @property
    def collateral_amount(self) -> float:
        """Asset-neutral alias for collateral_rseth."""
        return self.collateral_rseth

    @collateral_amount.setter
    def collateral_amount(self, v: float) -> None:
        self.collateral_rseth = v

    def current_ltv(self, price_usd: float) -> float:
        """Current LTV ratio at given oracle price."""
        return self.debt_usd / (self.collateral_rseth * price_usd)

    def health_factor(self, price_usd: float) -> float:
        if self.debt_usd <= 0:
            return float('inf')
        return (self.collateral_rseth * price_usd * self.liquidation_threshold) / self.debt_usd

    def is_liquidatable(self, price_usd: float) -> bool:
        return self.debt_usd > 0 and self.health_factor(price_usd) < 1.0


def generate_positions(
    rseth_price: float,
    total_collateral_atoken: float = 20_000.0,
    seed: int = 42,
) -> List[Position]:
    """
    Generate a pre-hack (2026-04-17) synthetic position book for rsETH.

    Distribution based on Aave V3 eMode usage patterns:
    - 40% eMode (high leverage): LTV 85–92%, liq_bonus = -0.05 (UNPROFITABLE — no cascade)
    - 40% Aave normal: LTV 55–68%, liq_bonus = 0.10 (profitable liquidation)
    - 20% Compound: LTV 60–75%, liq_bonus = 0.05

    Key: eMode positions create BAD DEBT when underwater (no sell pressure),
    while normal-mode positions trigger cascading sell pressure via profitable liquidation.
    """
    random.seed(seed)
    positions = []
    pid = 0

    # eMode positions: high leverage, but liquidation IS NOT PROFITABLE (bonus = -5%)
    # Real Aave V3 eMode cat1: LT=93%, liquidationBonus=9500 → liquidator gets 0.95x → loses 5%
    emode_collateral = total_collateral_atoken * 0.40
    allocated = 0.0
    while allocated < emode_collateral:
        size = random.uniform(50, 500)
        size = min(size, emode_collateral - allocated)
        ltv = random.uniform(0.85, 0.92)
        debt = size * rseth_price * ltv
        positions.append(Position(
            id=pid, collateral_rseth=size, debt_usd=debt,
            liquidation_threshold=0.93,
            liquidation_bonus=-0.05,  # unprofitable: -5% for liquidator
            mode="emode"
        ))
        allocated += size
        pid += 1

    # Aave normal positions: lower leverage, profitable liquidation (bonus = +10%)
    # Real Aave V3 rsETH normal: LT=75%, liquidationBonus=11000 → liquidator gets 1.10x
    normal_collateral = total_collateral_atoken * 0.40
    allocated = 0.0
    while allocated < normal_collateral:
        size = random.uniform(10, 200)
        size = min(size, normal_collateral - allocated)
        ltv = random.uniform(0.55, 0.68)
        debt = size * rseth_price * ltv
        positions.append(Position(
            id=pid, collateral_rseth=size, debt_usd=debt,
            liquidation_threshold=0.75,
            liquidation_bonus=0.10,
            mode="normal"
        ))
        allocated += size
        pid += 1

    # Compound positions
    compound_collateral = total_collateral_atoken * 0.20
    allocated = 0.0
    while allocated < compound_collateral:
        size = random.uniform(10, 150)
        size = min(size, compound_collateral - allocated)
        ltv = random.uniform(0.60, 0.75)
        debt = size * rseth_price * ltv
        positions.append(Position(
            id=pid, collateral_rseth=size, debt_usd=debt,
            liquidation_threshold=0.85,
            liquidation_bonus=0.05,
            mode="compound_v3"
        ))
        allocated += size
        pid += 1

    return positions
