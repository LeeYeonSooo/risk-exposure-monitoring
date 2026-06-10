# Aave V3 (Ethereum) wstETH price-oracle SOURCE change — CAPO migration (2024-03-18)

## What factually happened (on-chain MEASURED)
On 2024-03-18, the Aave V3 (Ethereum) protocol changed the on-chain **price-oracle
source** for its **wstETH** collateral. `AaveOracle.getSourceOfAsset(wstETH)` returned a
different aggregator address across a single block:

- **BEFORE** (block **19461330**): source = `0x8b6851156023f4f5a66f68bea80851c3d905ac93`
- **AFTER**  (block **19461331**, ts **2024-03-18T11:17:47Z**): source = `0xb4ab0c94159bc2d8c133946e7241368fc2f2a010`
- wstETH token: `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` (Lido wrapped staked ETH).
- Lender: **Aave V3** — a **shared-pool ("mono_pool")** money market. Aave runs a single,
  governance-controlled `AaveOracle` with ONE price source per asset. Swapping that source
  is a privileged, DAO-gated `AaveOracle.setAssetSources([wstETH],[newSource])` call (vs.
  immutable isolated markets like Morpho Blue where a market's oracle can NEVER change).

The swap was effected by an Aave Governance on-chain proposal — the **BGD Labs CAPO
(Correlated-Asset Price Oracle)** migration for LSTs. The new source `0xb4ab…a010` is the
`WstETHPriceCapAdapter`: it reads the wstETH/stETH exchange ratio from Lido, applies a
**maximum-yearly-growth CAP** to that ratio (a circuit breaker against ratio/oracle
manipulation that would artificially inflate LST collateral value), then multiplies by the
Chainlink stETH/ETH × ETH/USD feeds to produce wstETH/USD. The OLD source `0x8b68…ac93`
was the prior (uncapped) wstETH price feed.

## What the change WAS (governance — documented)
This is the Aave **LST oracle migration to the BGD CAPO "correlated/capped-price" adapter**,
NOT a price event and NOT an exploit:
- 2024-01-10: BGD "Correlated-Asset Price Oracle" proposal opened on the Aave governance forum.
- 2024-02-05: ARFC Snapshot vote announced.
- 2024-03-12: on-chain AIP created to activate CAPO adapters (incl. wstETH) on Aave V3 Ethereum.
- 2024-03-18: the `setAssetSources` execution lands → the oracle source for wstETH flips
  from `0x8b68…ac93` to the `WstETHPriceCapAdapter` `0xb4ab…a010` (block 19461331).

Governance rationale: protect highly-correlated LST/stablecoin collaterals from
exchange-rate-oracle manipulation by capping the maximum rate at which the reported
ratio can grow. (The very same CAPO adapter family, when its snapshotRatio/timestamp
later fell out of sync, caused the March-2026 wstETH mis-liquidation incident — which only
underscores that a change of THIS trust root is a material, page-worthy event.)

## Why an oracle-SOURCE change matters to a risk monitor
The price oracle is the **trust root** of a lending market: every LTV, health-factor, and
liquidation decision for wstETH collateral is computed from whatever address
`getSourceOfAsset(wstETH)` returns. On a governance-controlled mono_pool lender, that
address can be re-pointed by a privileged call. From the *outside, at the moment of the
swap,* a monitor **cannot distinguish** benign hardening (this CAPO migration) from a
malicious/compromised repoint (a governance compromise pointing collateral at an
attacker-controlled feed). Both look identical on-chain: the source address changed.

Therefore the only safe behavior is to **surface ANY oracle-source swap on a major
collateral for human review** — at least HIGH. This is distinct from the LUNA
ORACLE_FREEZE case (the source stayed the same but went STALE): here the source itself is
*replaced*. Our set previously had a freeze but no source-change; this event tests the
ORACLE_CHANGE signal's recall, plus two precise false-positive traps (no-change calm, and
absent→present field population on a new listing).

## FIDELITY
- **MEASURED on-chain (real archive reads):** the OLD source `0x8b6851156023f4f5a66f68bea80851c3d905ac93`,
  the NEW source `0xb4ab0c94159bc2d8c133946e7241368fc2f2a010`, the swap block **19461331**,
  and its timestamp **2024-03-18T11:17:47Z**, via `AaveOracle.getSourceOfAsset(0x7f39…2Ca0)`
  at blocks 19461330 (before) and 19461331 (after). The address change across one block is
  ground truth, not modeled.
- **DOCUMENTED (governance):** that the new source is the BGD CAPO `WstETHPriceCapAdapter`
  and that the swap was the Aave-DAO CAPO migration AIP. Sources: Aave governance forum
  "BGD. Correlated-asset price oracle" (t/16133), bgd-labs/aave-capo + aave-dao/aave-price-feeds
  repos, Aave docs (Oracle / CAPO), Chaos Labs / The Block / BeInCrypto CAPO post-mortems.
- **SNAPSHOT MODELING:** the three snapshots carry the SAME edge `wstETH-aave_v3-collateral`
  (Aave V3, mono_pool, wstETH collateral); they differ ONLY in the edge's recorded oracle
  source address: `_old` = `0x8b68…ac93`, `_new` = `0xb4ab…a010`, `_none` = absent/null
  (models a newly-listed asset or a transient collector miss where the field is not yet
  populated). No price/peg moved in any snapshot — this is a pure config/trust-root event.
