"""
CascadeSimulator: block-level feedback loop.

Each tick = 1 Ethereum block (~12 seconds). Default scale_steps=20 subdivides
each abstract "round" into 20 finer ticks, giving ~100–160 block-level data
points total — matching the Chaos Labs 150-block methodology.

Per-tick oracle rate is derived automatically:
    tick_rate = 1 - (1 - round_rate) ** (1 / scale_steps)

This preserves total oracle convergence while giving block granularity.

CRITICAL FIX [Bug #2]:
  Aave/Compound ALWAYS use oracle price for HF calculation, NOT DEX price.

Oracle lag model:
  - oracle_freezes=True: oracle STUCK at oracle_start_price (manipulation scenario)
  - oracle_freezes=False: oracle gradually follows DEX at rate oracle_catchup_rate
    * bridge_hack: 0.30/round (fast emergency update)
    * eigenlayer_slashing: 0.20/round (on-chain NAV update)
    * mass_withdrawal: 0.12/round (slow, Chainlink 0.5% deviation threshold)
"""

from copy import deepcopy
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from .positions import Position, generate_positions
from .agents import LiquidationAgent, ArbAgent
from .params import DEX_LIQUIDITY_USD, RSETH_PRICE_USD
from .oracle import ChainlinkOracleModel


@dataclass
class RoundResult:
    round_num: int
    dex_price: float
    oracle_price: float
    positions_liquidated: int
    sell_pressure_usd: float
    bad_debt_usd: float
    price_impact_pct: float
    arb_recovery_pct: float
    liquidated_protocols: List[str] = field(default_factory=list)  # e.g. ["emode","normal","compound"]
    oracle_stale_blocks: int = 0   # blocks since last oracle update (0 = updated this tick)


@dataclass
class SimulationResult:
    scenario: str
    shock_description: str
    initial_price: float
    final_dex_price: float
    oracle_price_at_end: float
    depeg_pct: float
    total_liquidated_usd: float
    total_bad_debt_usd: float
    rounds: List[RoundResult] = field(default_factory=list)
    converged: bool = True


class CascadeSimulator:
    def __init__(
        self,
        dex_liquidity_usd: float = DEX_LIQUIDITY_USD,
        initial_price: float = RSETH_PRICE_USD,
        max_rounds: int = 8,
        scale_steps: int = 20,
        impact_curve: Optional[List[Tuple[float, float]]] = None,
    ):
        self.dex_liquidity_usd = dex_liquidity_usd
        self.initial_price = initial_price
        self.max_rounds = max_rounds
        # Each "round" is subdivided into scale_steps blocks.
        # Total ticks = max_rounds * scale_steps  (~160 by default).
        self.scale_steps = scale_steps
        self.liq_agent = LiquidationAgent()
        # impact_curve: real Fluid DEX data from Anvil fork (backtest).
        # When None, ArbAgent falls back to formula models (live / synthetic).
        self.arb_agent = ArbAgent(impact_curve=impact_curve)

    def run(
        self,
        scenario: str,
        shock_description: str,
        initial_price_override: float = None,
        oracle_start_price: float = None,
        positions: List[Position] = None,
        oracle_freezes: bool = True,
        oracle_catchup_rate: float = 0.30,
        oracle_model: Optional[ChainlinkOracleModel] = None,
        direct_bad_debt_usd: float = 0.0,
        emergency_freeze_ticks: int = None,
        passive_arb_enabled: bool = True,
        oracle_sequence: Optional[List[float]] = None,
    ) -> SimulationResult:
        """
        Run one cascade simulation at block-level granularity.

        Oracle update modes (applied only when oracle_freezes=False):
          oracle_sequence set → Real on-chain CAPO prices per tick (backtest mode).
                                Overrides oracle_model and oracle_catchup_rate.
                                oracle_sequence[i] is the CAPO latestAnswer() value at tick i.
                                Ticks beyond len(oracle_sequence) fall back to last known price.
          oracle_model set    → Chainlink deviation+heartbeat model (P2-8).
                                Oracle jumps in discrete steps when DEX moves >= deviation_threshold
                                OR heartbeat_blocks have elapsed since last update.
          oracle_model=None   → Legacy: smooth exponential catchup at oracle_catchup_rate per round.
                                tick_rate = 1 - (1 - oracle_catchup_rate) ** (1 / scale_steps)
        """
        if positions is None:
            positions = generate_positions(rseth_price=self.initial_price)
        positions = deepcopy(positions)
        positions = [p for p in positions if p.collateral_rseth > 0.01]

        dex_price = initial_price_override if initial_price_override else self.initial_price
        oracle_price = oracle_start_price if oracle_start_price else self.initial_price

        # Per-tick oracle rate (legacy smooth catchup, used when oracle_model=None)
        if self.scale_steps > 1 and not oracle_freezes:
            tick_oracle_rate = 1.0 - (1.0 - oracle_catchup_rate) ** (1.0 / self.scale_steps)
        else:
            tick_oracle_rate = oracle_catchup_rate

        # Chainlink oracle state (used when oracle_model is set and oracle_freezes=False)
        last_oracle_update_tick: int = 0   # tick index of last oracle update

        result = SimulationResult(
            scenario=scenario,
            shock_description=shock_description,
            initial_price=self.initial_price,
            final_dex_price=dex_price,
            oracle_price_at_end=oracle_price,
            depeg_pct=0.0,
            total_liquidated_usd=0.0,
            total_bad_debt_usd=direct_bad_debt_usd,
        )

        no_activity_streak = 0
        # Frozen oracle can never trigger new liquidations — exit quickly.
        # Non-frozen: oracle may still drop into liquidation territory, so wait longer.
        convergence_patience = 6 if oracle_freezes else max(self.scale_steps * 2, 6)

        tick = 0
        for round_num in range(1, self.max_rounds + 1):
            for sub in range(1, self.scale_steps + 1):
                tick += 1

                # ── Emergency market freeze (e.g. Aave governance response) ──
                if emergency_freeze_ticks is not None and tick >= emergency_freeze_ticks:
                    result.converged = True
                    result.final_dex_price = dex_price
                    result.oracle_price_at_end = oracle_price
                    result.depeg_pct = (
                        (self.initial_price - dex_price) / self.initial_price * 100
                    )
                    return result

                # ── Oracle update ──────────────────────────────────────────
                oracle_updated_this_tick = False
                if oracle_sequence is not None:
                    # Real on-chain CAPO sequence (backtest mode) — highest priority.
                    # oracle_sequence is indexed by tick (0-based).
                    seq_idx = tick - 1
                    seq_price = (
                        oracle_sequence[seq_idx]
                        if seq_idx < len(oracle_sequence)
                        else oracle_sequence[-1]  # hold last known price
                    )
                    if seq_price != oracle_price:
                        oracle_price = seq_price
                        last_oracle_update_tick = tick
                        oracle_updated_this_tick = True
                elif not oracle_freezes:
                    if oracle_model is not None:
                        # Chainlink deviation+heartbeat model
                        blocks_since = tick - last_oracle_update_tick
                        if oracle_model.should_update(dex_price, oracle_price, blocks_since):
                            oracle_price = dex_price
                            last_oracle_update_tick = tick
                            oracle_updated_this_tick = True
                    else:
                        # Legacy: smooth exponential catchup
                        oracle_price = (
                            oracle_price * (1 - tick_oracle_rate)
                            + dex_price * tick_oracle_rate
                        )
                        oracle_updated_this_tick = True

                oracle_stale = tick - last_oracle_update_tick if not oracle_updated_this_tick else 0

                # ── Liquidation scan ───────────────────────────────────────
                liquidatable = self.liq_agent.scan(positions, oracle_price)

                if not liquidatable:
                    # Passive arb: when oracle > DEX by more than fee threshold,
                    # arb bots buy the discount, recovering DEX price toward oracle.
                    # Disabled (passive_arb_enabled=False) for scenarios where rsETH itself
                    # is worthless — no one buys into fundamentally broken collateral.
                    arb_recovery_frac = 0.0
                    if passive_arb_enabled and oracle_price > dex_price * (1.0 + self.arb_agent.ARB_FEE_THRESHOLD):
                        arb_buy = self.arb_agent.arb_buy_pressure(
                            dex_price, oracle_price, self.dex_liquidity_usd
                        )
                        arb_recovery_frac = (
                            self.arb_agent.price_impact(arb_buy, self.dex_liquidity_usd) * 0.5
                        )
                        dex_price = min(dex_price * (1.0 + arb_recovery_frac), oracle_price)

                    result.rounds.append(RoundResult(
                        round_num=tick,
                        dex_price=dex_price,
                        oracle_price=oracle_price,
                        positions_liquidated=0,
                        sell_pressure_usd=0.0,
                        bad_debt_usd=0.0,
                        price_impact_pct=0.0,
                        arb_recovery_pct=arb_recovery_frac * 100,
                        oracle_stale_blocks=oracle_stale,
                    ))

                    # Arb still closing the gap — not yet converged
                    if arb_recovery_frac > 0.001:
                        no_activity_streak = 0
                        continue

                    oracle_gap = (
                        (oracle_price - dex_price) / oracle_price
                        if oracle_price > 0 else 0
                    )
                    oracle_still_catching_up = (
                        not oracle_freezes
                        and oracle_gap > 0.015
                        and tick < (self.max_rounds * self.scale_steps) // 2
                    )
                    if oracle_still_catching_up:
                        # Oracle may drop far enough to trigger liquidations later
                        no_activity_streak += 1
                        continue

                    no_activity_streak += 1
                    if no_activity_streak >= convergence_patience:
                        result.converged = True
                        result.final_dex_price = dex_price
                        result.oracle_price_at_end = oracle_price
                        result.depeg_pct = (
                            (self.initial_price - dex_price) / self.initial_price * 100
                        )
                        return result
                    continue

                tick_sell = 0.0
                tick_bad_debt = 0.0
                liquidated_count = 0
                tick_protocols: List[str] = []

                for pos in liquidatable:
                    sell_usd, bad_debt = self.liq_agent.liquidate(pos, dex_price)
                    tick_sell += sell_usd
                    tick_bad_debt += bad_debt
                    if sell_usd > 0 or bad_debt > 0:
                        liquidated_count += 1
                        tick_protocols.append(pos.mode)

                # Only reset streak when liquidations generated real sell or bad debt.
                # Positions that are HF < 1 but not yet profitably liquidatable
                # (collateral > debt, F8 fix) return (0, 0) and should not block
                # convergence — treat this tick the same as no-activity.
                if tick_sell > 0.0 or tick_bad_debt > 0.0:
                    no_activity_streak = 0
                else:
                    no_activity_streak += 1
                    if no_activity_streak >= convergence_patience:
                        result.converged = True
                        result.final_dex_price = dex_price
                        result.oracle_price_at_end = oracle_price
                        result.depeg_pct = (
                            (self.initial_price - dex_price) / self.initial_price * 100
                        )
                        return result

                positions = [
                    p for p in positions
                    if p.collateral_rseth > 0.01 and p.debt_usd > 0.01
                ]

                # ── DEX price impact ───────────────────────────────────────
                impact = self.arb_agent.price_impact(tick_sell, self.dex_liquidity_usd)
                price_before_arb = dex_price * (1 - impact)

                # ── Arb stabilization ──────────────────────────────────────
                arb_buy = self.arb_agent.arb_buy_pressure(
                    price_before_arb, oracle_price, self.dex_liquidity_usd
                )
                arb_recovery = (
                    self.arb_agent.price_impact(arb_buy, self.dex_liquidity_usd) * 0.5
                )
                dex_price = price_before_arb * (1 + arb_recovery)
                dex_price = max(dex_price, 1.0)

                result.rounds.append(RoundResult(
                    round_num=tick,
                    dex_price=dex_price,
                    oracle_price=oracle_price,
                    positions_liquidated=liquidated_count,
                    sell_pressure_usd=tick_sell,
                    bad_debt_usd=tick_bad_debt,
                    price_impact_pct=impact * 100,
                    arb_recovery_pct=arb_recovery * 100,
                    liquidated_protocols=tick_protocols,
                    oracle_stale_blocks=oracle_stale,
                ))

                result.total_liquidated_usd += tick_sell
                result.total_bad_debt_usd += tick_bad_debt

        result.converged = False
        result.final_dex_price = dex_price
        result.oracle_price_at_end = oracle_price
        result.depeg_pct = (self.initial_price - dex_price) / self.initial_price * 100
        return result
