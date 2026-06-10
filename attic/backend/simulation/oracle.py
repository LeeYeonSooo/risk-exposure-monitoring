"""
Chainlink oracle lag simulation.

Real Chainlink behavior (rsETH/ETH, ETH/USD feeds):
  - Deviation trigger: price changes >= 0.5% from last reported -> immediate update
  - Heartbeat:         update every ~3600s (~300 blocks on Ethereum mainnet) regardless of price

This replaces the linear oracle_catchup_rate approximation with a discrete
threshold model. Two distinct behaviors:

  Large initial shock (> deviation_threshold immediately):
    Oracle jumps to DEX price on the FIRST tick — no lag.
    Typical for bridge_hack / mass_withdrawal with sudden 30–40% moves.

  Gradual drift (repeated small moves, each < deviation_threshold):
    Oracle updates in 0.5% steps → staircase lag pattern.
    Creates windows where HF is stale (overestimated) and positions
    approach liquidation without triggering — the "creeping" scenario.

Typical configurations:

  Standard market feed (mass_withdrawal, ezeth_depeg, penpie, raft):
    deviation_threshold=0.005, heartbeat_blocks=300

  On-chain NAV oracle (eigenlayer_slashing, lido_validator_slashing):
    deviation_threshold=0.005, heartbeat_blocks=2
    (LRTOracle reads on-chain restaking accounting -> updates each block)
"""

from dataclasses import dataclass


# Standard Chainlink rsETH/ETH feed parameters
CHAINLINK_DEVIATION_THRESHOLD = 0.005   # 0.5%
CHAINLINK_HEARTBEAT_BLOCKS    = 300     # ~1 hour on mainnet


@dataclass
class ChainlinkOracleModel:
    """
    Simulates Chainlink price feed update behavior.

    An update fires when EITHER condition is met each block:
      1. Deviation:  |dex_price - last_oracle| / last_oracle >= deviation_threshold
      2. Heartbeat:  blocks_since_last_update >= heartbeat_blocks

    When an update fires, oracle_price jumps to current dex_price.
    Between updates, oracle_price stays frozen at the last reported value.

    Args:
        deviation_threshold: Fractional price change required to trigger update.
                             Standard Chainlink rsETH/ETH: 0.005 (0.5%).
        heartbeat_blocks:    Maximum blocks between forced updates.
                             Standard: 300 (~1 hour).  On-chain NAV: 1-2.
    """
    deviation_threshold: float = CHAINLINK_DEVIATION_THRESHOLD
    heartbeat_blocks: int = CHAINLINK_HEARTBEAT_BLOCKS

    def should_update(
        self,
        dex_price: float,
        last_oracle_price: float,
        blocks_since_update: int,
    ) -> bool:
        """Return True if Chainlink should push a new price this block."""
        if last_oracle_price <= 0:
            return True
        deviation = abs(dex_price - last_oracle_price) / last_oracle_price
        return deviation >= self.deviation_threshold or blocks_since_update >= self.heartbeat_blocks


# Pre-built configs for common use cases
STANDARD_FEED = ChainlinkOracleModel(
    deviation_threshold=0.005,
    heartbeat_blocks=300,
)

ONCHAIN_NAV_FEED = ChainlinkOracleModel(
    deviation_threshold=0.005,
    heartbeat_blocks=2,   # LRTOracle reads on-chain accounting each block
)
