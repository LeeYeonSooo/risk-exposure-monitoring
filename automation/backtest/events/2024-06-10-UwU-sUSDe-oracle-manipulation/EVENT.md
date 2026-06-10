# UwU Lend sUSDe oracle-manipulation drain — 2024-06-10 (Ethereum)

## One-line
A flash-loan attacker manipulated UwU Lend's sUSDe price oracle (which folded Curve
`get_p()` INSTANTANEOUS spot into its median) to a value sUSDe never honestly printed,
borrowing low and liquidating high to drain ~$19.5M, then ~$3.7M more three days later.

## Assets / addresses
- **Collateral token:** sUSDe `0x9D39A5DE30e57443BfF2A8307A4256c8797A3497`
  (Ethena Staked USDe). YIELD-BEARING / staked: it accrues and trades slightly ABOVE
  $1 — it is NOT a hard fiat $1 stablecoin, so its honest cross-source price legitimately
  varies more than a hard-stable (LST-like tolerance, ~2%, not ~0.1%).
- **Protocol:** UwU Lend (mono_pool lender) `0x2409aF0251DCB89EE3dee572629291f9B087c668`.
- **Oracle:** UwU custom median price oracle (modeled at synthetic
  `0xcustomuwuoracle000000000000000000000001`).
- **Market:** loan_asset USDe / collateral_asset sUSDe, LLTV 0.92.

## The oracle design flaw (root cause)
UwU's sUSDe price was the **median of 11 USDE price sources** drawn from Curve and Uni-V3
pools. **5 of those 11 were Curve `get_p()` instantaneous spot** reads. Because a majority
share of the median came from manipulable single-block spot, a large single-transaction
swap could move enough of the 11 inputs to drag the **median** itself. The oracle was
**FRESH** the whole time (no staleness, the feed updated normally) — the price it returned
was simply, grossly **WRONG**. Staleness / heartbeat checks are structurally blind to this:
the only thing that catches a fresh-but-wrong price is a **cross-reference** of the oracle
answer against an honest reference (a manipulation-resistant feed / TWAP / second source).

## The attack
1. Flash-loaned **~$3.796B** across Aave V3, Aave V2, Uniswap V3, Balancer, Maker, Spark
   and Morpho (one of the largest single-trade borrows ever).
2. Swapped USDe through the Curve pool to **suppress the sUSDe spot (~$0.988)**, dragging
   the oracle median DOWN; borrowed large amounts of sUSDe cheaply against base collateral.
3. Reverse-swapped to **spike the sUSDe spot (~$1.032)**, dragging the oracle median UP;
   used the inflated collateral value to borrow / liquidate, draining the pools.
   The oracle median swung roughly **~$0.988 ⇄ ~$1.032** — values sUSDe never truly printed.
4. Net first-day drain **~$19.5M (≈$19.3–19.4M reported)**. Three days later (2024-06-13)
   the same attacker reused ~60M sUSDe from the first hack to drain **~$3.7M more**.

## What our monitor must catch (and why this event was added)
Our set already has oracle **FREEZE** (LUNA — stale + divergent), oracle **SOURCE-CHANGE**
(wstETH — config repoint), and depeg **FLAG-FLIP** (USDe). It had **no oracle-MANIPULATION**
case: a **FRESH but grossly WRONG** price. Staleness/heartbeat logic cannot see this. The
catching mechanism is the **cross-reference deviation check**: `|answer/reference_answer - 1|`
vs the **asset-class deviation band**. sUSDe is yield-bearing → the appropriate band is
**LST-like (~2%)**, NOT hard-stable (~0.1%). The ~3.4% manipulated divergence is far beyond
honest LST variance and must page; a benign ~0.2% honest cross-source difference must not.

## FIDELITY
- **On-chain anchor:** Ethereum, 2024-06-10, snapshot block 20037000, snapshot ts
  2024-06-10T12:00:00Z. Token / protocol / oracle addresses and the sUSDe/USDe market are
  modeled in `snapshots/sUSDe.json`.
- **The manipulated and honest oracle values are POST-MORTEM figures**, not live archive
  reads. The custom-oracle median is not a simple archive call (it composites 11 spot/TWAP
  sources intra-transaction), so the manipulated answer (~1.032) and the honest reference
  (~0.998) are **injected per-case via `oracle_probes`** (host-fed, exactly like peg_probes /
  the LUNA oracle reads). `asset_class: "lst"` encodes that sUSDe is yield-bearing and so
  carries the LST (~2%) deviation tolerance, not a hard-stable tolerance.
- **updated_at is FRESH** in both cases (near the event `now`) — this is the whole point:
  the manipulated feed was NOT stale, so a freeze/staleness check alone is blind; only the
  answer-vs-reference divergence distinguishes manipulation from a calm honest read.

## Sources
- SlowMist — Analysis of the UwU Lend Hack:
  https://slowmist.medium.com/analysis-of-the-uwu-lend-hack-9502b2c06dbe
- QuillAudits — Decoding UwU Lend's $19.4 Million Exploit:
  https://www.quillaudits.com/blog/hack-analysis/uwu-lend-hack
- Cyvers — UwU Lend Exploit: Oracle Vulnerabilities Exposed:
  https://cyvers.ai/blog/uwu-lend-23m-exploit-oracle-vulnerabilities-exposed
- CryptoSlate — Hacker drains $19.5 million from UwU Lend in price oracle exploit:
  https://cryptoslate.com/hacker-drains-19-5-million-from-uwu-lend-in-price-oracle-exploit/
- The Block — UwU Lend drained for $3.7 million in second exploit this week:
  https://www.theblock.co/post/299901/uwu-lend-second-hack-this-week
- Unchained — UwU Lend Hacker Steals Another $3.7 Million From Protocol:
  https://unchainedcrypto.com/uwu-lend-hacker-steals-another-3-7-million-from-protocol/
