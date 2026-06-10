# Aave V3 USDC utilization lockout (Ethereum, ongoing since ~Feb 2026)

## What happened (FACTS)

A pure **utilization-driven liquidity LOCKOUT** on Aave V3's USDC reserve (Ethereum Core).
Borrow demand pinned USDC utilization near 100%, so available liquidity dried up and
**suppliers could not withdraw** their deposits. This was NOT an exploit of USDC, NOT a depeg,
and NOT a supply/backing event — USDC held its $1.00 peg throughout. The risk is that lenders
are *stranded*: their principal exists on paper but cannot be redeemed because borrowers have
drawn down essentially all withdrawable liquidity.

Utilization here = `variableDebt.totalSupply / (USDC.balanceOf(aUSDC) + variableDebt)`
(i.e. borrowed / total supplied). As utilization → 1.0, withdrawable liquidity → 0.

### The real on-chain utilization climb (MEASURED)
- **2025-10-01**: 79.03% — calm / pre-lockout normal (pool size ~$5.60B, ample withdrawable liquidity)
- **2026-02**: ~90.3% — pressure building
- **2026-04-18 → 04-20**: spike to **100.00% peak** (2026-04-20: available liq ~$6,729 against ~$1.9B debt)
- **2026-05-05** (prev snapshot): 92.85% (pool size ~$1.92B)
- **2026-05-15** (incident snapshot): **97.66%** — available liquidity ~$45M vs ~$1.90B debt; lenders cannot meaningfully withdraw

### Trigger and mechanism
The acute spike was triggered by the **KelpDAO rsETH bridge exploit (~$292M, 2026-04-18)**: an
attacker forged cross-chain messages to mint unbacked rsETH, deposited it on Aave, and borrowed
~$200M WETH. News of the resulting bad debt sparked a bank-run: **~$6.6B exited Aave within 24
hours**, draining ALL core markets (WETH, USDT, USDC) to ~100% utilization simultaneously. At
100% utilization "no liquidity is available for withdrawals" and "liquidations can't be
processed" — roughly **$5B in USDT + USDC became effectively locked**, of which ~$2B was USDC.
USDC reported utilization peaked at ~99.87% with available liquidity below ~$3M against a
~$1.89B supplied pool; the market stayed functionally frozen for ~4 consecutive days. By
mid-May 2026 the pool was still elevated (97.66% on 2026-05-15) as it slowly rebuilt.

### Governance response (the rate ceiling)
Circle's Chief Economist **Gordon Liao** submitted an Aave governance proposal on **2026-04-22/23**
to break the lockout by raising USDC borrow rates sharply so high utilization becomes
self-correcting:
- Slope2 raised from ~10% toward a **50% target** (interim risk-steward step ~40%).
- Optimal utilization (U*) dropped from **92% → 85% target** (interim ~87%).
- Effect: at 100% utilization the variable borrow rate would jump to ~53.5% and the supply rate
  to ~48.2%, incentivizing repay/new-supply to restore withdrawable liquidity.
- Implementation proposed via a shared control account (LlamaRisk + Aave Labs) within hours,
  ratified by community vote within 5–7 days.

By May 2026, markets were rebuilding with WETH/USDT/USDC utilization stabilizing back into the
80–90% range; the ~$123M of bad debt from the exploit was addressed via a community-led "DeFi
United" initiative.

## Why this event matters for the monitor

This is a **DISTINCT mechanism** from every other event in the suite: a pure
utilization-driven liquidity LOCKOUT. There is no price move, no oracle event, no supply/backing
anomaly, no config swap. The only observable that moves is **utilization level**. It exercises
the **d07 utilization-LEVEL path (UTIL_LIQUIDITY_DROP)**: utilization beyond the market's
pre-lockout normal tail AND above the ~95% actionable floor, signalling that suppliers can no
longer withdraw.

The actionable distinction the monitor must draw:
- **97.66%** (incident): far beyond the pre-lockout normal (median 83%, p99.9 ≈ 90%) AND above
  the ~95% actionable floor → suppliers stranded → **UTIL_LIQUIDITY_DROP (WARN)**.
- **79.03%** (calm control): within the pre-lockout normal band and below the 95% floor → ample
  withdrawable liquidity → **no alarm**.

## FIDELITY

- **Utilization is on-chain MEASURED**: each snapshot's `lending_risk.utilization` is the real
  Aave V3 USDC value (= variableDebt.totalSupply / (USDC.balanceOf(aUSDC) + variableDebt)) read
  from the Alchemy Ethereum archive at the stated block:
  - lockout 0.9766 @ block 25096819 (2026-05-15)
  - prev 0.9285 @ block 25025077 (2026-05-05) — size-matched (~$1.9B) to the lockout snapshot so
    that ONLY utilization, not pool size, moves between prev → curr
  - calm 0.7903 @ block 23479243 (2025-10-01)
  - calm_prev 0.8469 @ block 23429173 (2025-09-24)
- **The `util_level` baseline is host-fed**, not derived from the two-point snapshot. It is the
  market's PRE-LOCKOUT historical normal utilization distribution (analogous to Morpho's
  host-supplied `historicalState`), keyed `"USDC-aave_v3-supply:util_level"`:
  `{median: 0.83, p_high: 0.90, p_low: 0.65, n: 700, source: "pre-lockout history (2024-2025)"}`.
  Against this baseline, 97.66% is anomalous (well past p99.9 ≈ 90%) AND above the ~95%
  actionable floor → UTIL_LIQUIDITY_DROP. 79.03% sits inside the normal band → silent.
- **Fidelity caveat (honest):** the actionable alarm is the lockout measured *relative to the
  pre-lockout history*. Once 95%+ utilization is sustained for months it would itself become the
  recent "norm" and a purely-adaptive baseline would stop firing; that is why the host feeds the
  fixed pre-lockout baseline — the alert we care about is the lockout vs the historical normal,
  not vs the new locked-in regime.
- **Peg / oracle / supply are NOT in play**: USDC stayed pegged; oracle is MARKET,
  depeg_sensitive=false; no supply/backing probe. DEPEG / supply / oracle signals must NOT fire.

## Sources

- Coindesk — "Aave's core markets hit 100% utilization at once: here's what it means (and it's not good)" (2026-04-21): https://www.coindesk.com/business/2026/04/21/aave-s-core-markets-hit-100-utilization-at-once-here-is-what-it-means-and-it-s-not-good
- Coindesk — "A $300M borrowing spike on Aave signals liquidity crunch after KelpDAO exploit" (2026-04-20): https://www.coindesk.com/markets/2026/04/20/a-usd300m-borrowing-spike-on-aave-signals-liquidity-crunch-after-exploit
- Cryptopolitan — "Circle steps into Aave governance as USDC liquidity locks at 99% utilization": https://www.cryptopolitan.com/circle-steps-into-aave-governance/
- CryptoTimes — "Circle Pushes Aave to Adjust USDC Rates After Utilization Hits 100% for 4 Days" (2026-04-23): https://www.cryptotimes.io/2026/04/23/circle-pushes-aave-to-adjust-usdc-rates-after-utilization-hits-100/
- Bitcoin.com — "Circle Economist Proposes Higher USDC Rates on Aave V3 After KelpDAO Exploit": https://news.bitcoin.com/circle-economist-proposes-higher-usdc-rates-on-aave-v3-after-kelpdao-exploit/
- Bitcoin.com — "DeFi Lender Aave Battles Withdrawal Crisis After KelpDAO rsETH Exploit": https://news.bitcoin.com/defi-lender-aave-battles-withdrawal-crisis-after-kelpdao-rseth-exploit/
- On-chain: Alchemy Ethereum archive reads of Aave V3 USDC reserve (variableDebt + aUSDC USDC balance) at blocks 25096819 / 25025077 / 23479243 / 23429173.
