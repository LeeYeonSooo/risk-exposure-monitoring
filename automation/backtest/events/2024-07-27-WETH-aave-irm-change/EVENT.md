# Aave V3 (Ethereum) WETH reserve INTEREST-RATE-MODEL (IRM) change — v3.1 unified rate-strategy migration (2024-07-27)

## What factually happened (on-chain MEASURED)
On 2024-07-27, the Aave V3 (Ethereum) protocol changed the on-chain **interest-rate-strategy
contract** (IRM / interest-rate model) of its **WETH** reserve. `Pool.getReserveData(WETH)`
returned a different `interestRateStrategyAddress` across a single block:

- **BEFORE** (block **20398673**): IRM = `0x42ec99a020b78c449d17d93bc4c89e0189b5811d`
- **AFTER**  (block **20398674**, ts **2024-07-27T15:06:35Z**): IRM = `0x847a3364cc5fe389283bd821cfc8a477288d9e82`
- WETH token: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (canonical wrapped ETH).
- Lender: **Aave V3** — a **shared-pool ("mono_pool")** money market. A reserve's rate
  strategy is a per-reserve pointer that **governance can swap** via the privileged
  `Pool.setReserveInterestRateStrategyAddress(asset, newStrategy)` call. This is structurally
  distinct from immutable isolated markets (e.g. Morpho Blue), where the IRM is baked into the
  market id at creation and can NEVER be changed.

## What the change WAS (governance — documented)
This swap is the **Aave v3.1 unified / refactored interest-rate-strategy migration** by **BGD
Labs** (the Aave DAO service provider). Aave v3.1 replaces the original per-reserve
`DefaultReserveInterestRateStrategy` deployments with a single, **stateful**
`DefaultReserveInterestRateStrategyV2` contract per pool, into which each reserve's rate
parameters are loaded (so one shared contract serves every asset, with per-reserve params
stored in state). The new WETH IRM `0x847a3364cc5fe389283bd821cfc8a477288d9e82` is, per
Etherscan's verified label and source, exactly that `DefaultReserveInterestRateStrategyV2`
(from `aave-v3-origin`), deployed **2024-07-08** (block 20261940). The v3.1 upgrade wired this
shared strategy to "every asset with the current production parameters," which is why the SAME
`0x847a33…` address was adopted across many reserves (not just WETH) — confirming this is the
unified-strategy migration, not a one-off curve tweak.

Governance / migration trail (DOCUMENTED):
- BGD "Aave v3.1 and Aave Origin" governance proposal/forum thread (governance.aave.com t/17305).
- `bgd-labs/protocol-v3.1-upgrade` `UpgradePayload.sol`: connects the new stateful interest-rate
  strategy to every asset with current production parameters.
- Aave v3.1 on-chain upgrade proposal (vote.onaave.com proposalId 132) executed across active v3
  instances, incl. the Ethereum main market; the WETH reserve's `interestRateStrategyAddress`
  flips to `0x847a33…` at block 20398674 on 2024-07-27.

Rationale: a stateful, consolidated rate strategy reduces config-mistake surface and lets
governance update rate params across assets more coordinatedly. This was a **benign protocol
refactor**, NOT a price/peg event and NOT an exploit.

## Why an IRM change matters to a risk monitor
The interest-rate strategy is the **rate-risk root** of a lending reserve: it defines the base
rate, optimal-utilization kink, and slope1/slope2 that map utilization -> borrow/supply APR.
Swapping it changes borrow-rate dynamics, the utilization response, and therefore the
**liquidation economics and carry/rate risk** of every position in the WETH reserve. On a
governance-controlled mono_pool lender this pointer can be re-set by a single privileged call.
From the *outside, at the moment of the swap,* a monitor **cannot distinguish** a benign
refactor (this v3.1 migration) from a malicious/compromised swap to an adversarial rate curve
(e.g. one that pins rates to extremes to force or block liquidations, or to drain a reserve).
Both look identical on-chain: the `interestRateStrategyAddress` changed.

Therefore the only safe behavior is to **surface ANY IRM swap on a major shared-pool reserve
for human review** — at least HIGH. This is distinct from the wstETH ORACLE_CHANGE case (the
trust root being repointed there is the *price oracle*; here it is the *rate model*). Our set
had an oracle-source change (d04a-class) but NO interest-rate-model change; this event tests the
IRM_CHANGE signal's RECALL plus two precise false-positive traps (no-change calm, and
absent->present field population on a newly-added reserve / collector miss).

## FIDELITY
- **MEASURED on-chain (real archive reads):** the OLD IRM `0x42ec99a020b78c449d17d93bc4c89e0189b5811d`,
  the NEW IRM `0x847a3364cc5fe389283bd821cfc8a477288d9e82`, the swap block **20398674**, and its
  timestamp **2024-07-27T15:06:35Z**, via `Pool.getReserveData(0xC02a…756Cc2).interestRateStrategyAddress`
  at blocks 20398673 (before) and 20398674 (after). The address change across one block is ground
  truth, not modeled.
- **DOCUMENTED (governance + contract identity):** that the new IRM is the v3.1
  `DefaultReserveInterestRateStrategyV2` (Etherscan-verified contract name/source from
  `aave-v3-origin`, deployed 2024-07-08 / block 20261940), adopted via the BGD Aave v3.1 upgrade.
  Sources: Etherscan `0x847a3364cc5fe389283bd821cfc8a477288d9e82` (verified label/source);
  governance.aave.com "BGD. Aave v3.1 and Aave Origin" (t/17305); `bgd-labs/protocol-v3.1-upgrade`
  (UpgradePayload.sol); Aave docs (Interest Rate Strategy); vote.onaave.com proposalId 132.
- **SNAPSHOT MODELING:** the three snapshots carry the SAME edge `WETH-aave_v3-reserve` (Aave V3,
  mono_pool, WETH reserve); they differ ONLY in the edge's recorded `lending_risk.irm_address`:
  `_old` = `0x42ec…811d`, `_new` = `0x847a…9e82`, `_none` = absent/null (models a newly-added
  reserve whose IRM field is not yet populated, or a transient collector miss). No price/peg/rate
  value moved in any snapshot — this is a pure config / rate-model-root event.
