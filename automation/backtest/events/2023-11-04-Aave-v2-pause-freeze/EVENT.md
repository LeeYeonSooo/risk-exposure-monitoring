# Aave V2 Ethereum PAUSE / market freeze — funds stranded (2023-11-04)

## What factually happened
On **2023-11-04**, Aave received a bug-bounty report of a **high-severity (later raised to
critical) vulnerability** affecting Aave V2. In response, the **Aave (Community) Guardian
PAUSED the Aave V2 Ethereum Market** and **froze certain assets** on Aave V2/V3 across
multiple chains (Ethereum, Optimism, Arbitrum, Avalanche, Polygon). The stable-rate borrow
feature was also disabled DAO-wide as a precaution.

The pause/freeze persisted while a governance fix was prepared and voted in. Restoration:
- **2023-11-12** — Aave V3 instances (Arbitrum, Avalanche, Optimism, Polygon) unpaused.
- **2023-11-13** — **Aave V2 Ethereum unpaused** (following a ~3-hour liquidation grace
  period). This is the market relevant to this event.
- 2023-11-16 — CRV on Aave V3 Polygon unpaused.

So the V2 Ethereum market was inaccessible for roughly **9 days** (Nov 4 → Nov 13).
Aave repeatedly stated **no user funds were at risk / no funds were lost** — this was a
precautionary freeze, not an exploit.

## The mechanism that matters here (why it is DISTINCT)
This is **not** a price event, **not** an exploit of the supplied asset, and **not** a
supply/backing move. It is a **protocol/market FREEZE/PAUSE that STRANDS funds**: the user's
assets are fine on paper, but they **cannot be withdrawn** for the duration of the pause.

Crucially, the **V2 Ethereum market was PAUSED**, which in Aave is strictly more restrictive
than a mere *freeze*:
- **Frozen reserve**: blocks NEW supply and NEW borrow, but **still allows WITHDRAWALS**,
  repayments, liquidations, rate rebalances. (This was the state of the *other* frozen assets,
  where Aave noted users "could still withdraw and repay from frozen assets.")
- **Paused pool/reserve**: blocks **ALL** interactions — supply, borrow, repay, liquidate,
  aToken transfers, and **WITHDRAWALS**. In Aave V2 the pause is at the whole-pool level
  (`LendingPool.paused() == true`).

The Aave **V2 Ethereum Market was in the PAUSED state**, so a fund with USDC supplied to
Aave V2 Ethereum **could not withdraw** — its principal was effectively **stranded** for ~9
days. That is the exposure the monitor must surface: *"your exposure is in a frozen/paused
market — you cannot exit."*

## On-chain / data anchor
The host feeds a per-edge boolean `lending_risk.is_frozen` derived from the reserve
configuration / pool `paused()` flag. For the Aave V2 Ethereum USDC supply edge this flag
**flips false -> true** when the Guardian pauses the pool on 2023-11-04, and back to false on
restoration (2023-11-13). The monitor's MARKET_FROZEN signal keys on this **false -> true
flip** (a market that was withdrawable becomes non-withdrawable / stranded).

## FIDELITY (what is real vs. representative)
- **REAL (faithful to the event):**
  - The Guardian paused the Aave V2 Ethereum Market on 2023-11-04 and unpaused it on
    2023-11-13 (~9 days), in response to a white-hat-reported critical vulnerability.
  - Withdrawals from the V2 Ethereum pool were blocked for the duration (pause, not mere
    freeze) — funds genuinely stranded, no asset price/exploit involved.
  - The semantic of `is_frozen` flipping `false -> true` correctly models the active ->
    paused (withdrawal-blocked) transition. The two snapshots differ ONLY in this flag
    (`active.json` is_frozen=false, `frozen.json` is_frozen=true); price, supply, oracle,
    utilization, exposure are all held constant — isolating the freeze mechanism.
- **REPRESENTATIVE (not claimed as the exact wei-level on-chain figure):**
  - The **~$80M USDC supply exposure** on the edge is a representative position size for a
    fund's USDC supplied to Aave V2 Ethereum at that time; it is used to exercise the
    systemic ($>=50M$) severity threshold. The event's significance does not depend on the
    precise dollar amount — any sizeable stranded position is the same risk.
  - `is_frozen` is **host-fed**: the backtest does not re-read the chain; it consumes the
    flag the host already resolved from reserve config / `paused()`. Block numbers
    (18500000 active / 18508000 frozen) bracket the 2023-11-03 -> 2023-11-04 window and are
    illustrative anchors, not the exact pause-tx block.

## Expected monitor behavior
- **INCIDENT (active -> paused):** `is_frozen` flips false -> true on
  `USDC-aave_v2-supply` -> emit **MARKET_FROZEN** at **CRITICAL** (~$80M stranded >= the
  $50M systemic line). At minimum this MUST be HIGH; CRITICAL is the correct severity because
  the stranded amount clears the systemic threshold defined in the data contract.
- **CONTROL (active -> active, no flip):** `is_frozen` is false on both sides -> **no**
  MARKET_FROZEN (and nothing WARN-or-above). An active, withdrawable market must not alarm;
  the signal keys on the FLIP into frozen, not on the market merely existing.

## Sources
- Aave governance — "Aave v2/v3 security incident 04/11/2023":
  https://governance.aave.com/t/aave-v2-v3-security-incident-04-11-2023/15335
- DeFiTeller — "Aave November 2023 Security Incident: Bug Bounty Report and Response":
  https://defiteller.com/aave-protocol-security-update-november-2023
- The Block — "Aave lending markets resume normal operations after security scare":
  https://www.theblock.co/post/262757/aave-v3-markets-resume-normal-operations-after-security-scare
- CryptoSlate — "Aave unpauses V2 and V3 markets after addressing critical security bug":
  https://cryptoslate.com/aave-securely-unpauses-v2-and-v3-markets-after-addressing-critical-bug/
- Unchained — "DeFi Protocol Aave Pauses Multiple Markets After 'Issue On A Certain Feature'":
  https://unchainedcrypto.com/defi-protocol-aave-pauses-multiple-markets-after-issue-on-a-certain-feature/
- Aave V2 pause vs. freeze semantics (paused = all interactions incl. withdrawal blocked;
  frozen = withdrawals still allowed): Aave V2 protocol docs / LendingPool —
  https://docs.aave.com/developers/v/2.0/the-core-protocol/lendingpool
