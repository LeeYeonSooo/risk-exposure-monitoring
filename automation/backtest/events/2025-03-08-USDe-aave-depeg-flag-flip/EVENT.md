# Aave V3 (Ethereum) USDe oracle DEPEG-SENSITIVITY flip — fixed-peg adapter migration (2025-03-08)

## What factually happened (on-chain MEASURED)
On 2025-03-08, the Aave V3 (Ethereum) protocol repointed the on-chain **price-oracle
source** for its **USDe** collateral such that the resolved feed's **depeg-sensitivity
flipped from true to false**. `AaveOracle.getSourceOfAsset(USDe)` returned a different
aggregator address across a single block:

- **BEFORE** (block **22002624**): source = `0x55b6c4d3e8a27b8a1f5a263321b602e0fdeecc17`
  — a USDe **MARKET-price** feed (the USDe/USD secondary-market rate). A real USDe depeg
  MOVES this feed, which liquidates USDe/sUSDe borrowers. **DEPEG-SENSITIVE = true.**
- **AFTER** (block **22002625**, ts **2025-03-08T14:01:47Z**): source =
  `0xc26d4a1c46d884cff6de9800b6ae7a8cf48b4ff8` — a **hardcoded USDe = USDT 1:1 stable
  adapter** that returns the USDT/USD price for USDe and **IGNORES a USDe depeg**, so a
  USDe deviation no longer drives liquidations. **DEPEG-SENSITIVE = false.**
- USDe token: `0x4c9EDD5852cd905f086C759E8383e09bff1E68B3` (Ethena synthetic dollar).
- Lender: **Aave V3** — a **shared-pool ("mono_pool")** money market. Aave runs a single,
  governance-controlled `AaveOracle` with ONE price source per asset. Swapping that source
  is a privileged, DAO-gated `AaveOracle.setAssetSources([USDe],[newSource])` call (vs.
  immutable isolated markets like Morpho Blue where a market's oracle can NEVER change).

The two feeds differ in **what they price**, and therefore in their depeg-sensitivity:
the OLD `0x55b6…cc17` tracks the live USDe market quote (a USDe depeg propagates into the
oracle), while the NEW `0xc26d…4ff8` hardcodes USDe to USDT 1:1 and resolves through
USDT/USD (a USDe depeg is invisible to the oracle). This is the load-bearing fact: the
oracle's **depeg-sensitivity FLIPPED true → false** on a major collateral.

## What the change WAS (governance — documented)
This is the Aave **"sUSDe and USDe Price Feed Update"** (ARFC, co-authored by Chaos Labs
and LlamaRisk, opened 2025-01-03), NOT a price event and NOT an exploit:
- Motivation: the LTV of sUSDe-backed positions (~1B sUSDe collateral on Aave) was exposed
  to short-term **USDe secondary-market** price fluctuations. Per the proposal, **~1/4 of
  all sUSDe collateral on Aave would be liquidated if USDe deviated by ~2.5%**, and a ~5%
  USDe drop would put **>$300M of USDe-backed loans at risk of liquidation** — an elevated
  risk of *unexpected* liquidations driven by transient USDe discounts (thin sell-side
  liquidity during high redemptions), not by genuine Ethena insolvency.
- Fix: replace the USDe/USD secondary-market feed with a **hardcoded USDe = USDT 1:1**
  relation, so sUSDe is priced via sUSDe/USDe exchange rate (CAPO adapter) × a fixed
  USDe/USDT 1:1 × Chainlink USDT/USD. USDe is treated as systematically correlated to USDT.
- **Risk transfer (the crux):** by eliminating the oracle's exposure to USDe's market
  price, **borrowers no longer bear the implications of a USDe deviation / Ethena's
  solvency — that risk is shifted ONTO the Aave protocol** (a sustained genuine USDe depeg
  would no longer liquidate underwater positions, leaving latent **bad-debt exposure** on
  the protocol's balance sheet).

The change drew notable community pushback (e.g. "hardcoding USDe to USDT is risky given
USDe isn't really intended to be a stablecoin"), underscoring that this is a material,
review-worthy re-rating of depeg exposure — not routine maintenance.

## Why a depeg-sensitivity FLIP matters to a risk monitor
The price oracle is the **trust root** of a lending market, and *what the resolved feed
prices* determines the market's liquidation behavior under a depeg. Here the feed change
flips the market from **depeg-SENSITIVE → depeg-INSENSITIVE**:

- BEFORE: a USDe depeg liquidates USDe/sUSDe borrowers (depeg risk sits with borrowers).
- AFTER: a USDe depeg is invisible to the oracle → no depeg-driven liquidation → the
  **depeg risk has moved from borrowers to the protocol** as latent bad-debt exposure.

For a fund holding (or lending against) USDe/sUSDe on Aave, this is a **fundamental
re-rating of depeg exposure**: the same nominal position now behaves completely
differently in a stress scenario. A monitor MUST surface this flip for human review — it
is at least **WARN** (re-rates depeg exposure; defensible WARN floor). This is distinct
from a plain oracle SOURCE-change (d04a / wstETH-CAPO, where depeg-sensitivity did NOT
change) and from an oracle FREEZE (LUNA, where the source stayed but went stale): here the
source change specifically **flips the depeg-sensitivity flag**. Our set previously had a
source-change and a freeze but NO depeg-flag flip; this event tests the **DEPEG_FLAG_FLIP**
signal's recall, plus a precise no-flip false-positive trap (calm, same feed both sides).

## FIDELITY
- **MEASURED on-chain (real archive reads):** the OLD source
  `0x55b6c4d3e8a27b8a1f5a263321b602e0fdeecc17`, the NEW source
  `0xc26d4a1c46d884cff6de9800b6ae7a8cf48b4ff8`, the swap block **22002625**, and its
  timestamp **2025-03-08T14:01:47Z**, via `AaveOracle.getSourceOfAsset(0x4c9E…68B3)` at
  blocks 22002624 (before) and 22002625 (after). The address change across one block is
  ground truth, not modeled.
- **CLASSIFIED (feed type + governance):** that the OLD feed is a USDe MARKET-price feed
  (depeg_sensitive=true) and the NEW feed is a hardcoded USDe=USDT 1:1 stable adapter
  (depeg_sensitive=false), and that the swap was the Aave-DAO "sUSDe and USDe Price Feed
  Update" intended to move depeg risk off borrowers onto the protocol. The depeg_sensitive
  boolean is derived from the feed TYPE (live market quote vs fixed-peg adapter) plus the
  documented Aave governance rationale (a USDe deviation moves the OLD feed and liquidates
  borrowers; the NEW feed ignores it). Sources: Aave governance forum "[ARFC] sUSDe and
  USDe Price Feed Update" (t/20495), Aave app proposal #262, LlamaRisk research note, and
  Cointelegraph / The Defiant / Cryptopolitan coverage of the community pushback.
- **SNAPSHOT MODELING:** both snapshots carry the SAME edge `USDe-aave_v3-collateral`
  (Aave V3, mono_pool, USDe collateral, ~$300M representative amount_usd — not
  load-bearing); they differ ONLY in the edge's recorded `oracle.oracle_address`
  (`0x55b6…cc17` vs `0xc26d…4ff8`) and the load-bearing `oracle.depeg_sensitive`
  (true vs false). `oracle_type` is "MARKET" in both. No price/peg moved in any snapshot —
  this is a pure oracle-configuration event that re-rates depeg exposure.
