# 2022-06-13 — Lido stETH ETH-relative depeg (Celsius / 3AC deleveraging cascade)

## What happened (facts, sourced — NOT from engine behavior)
- stETH (Lido Staked Ether, `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84`) is an LST pegged
  **to ETH** (1 stETH ≈ 1 staked-ETH-equivalent), NOT to USD. Its reference is the ETH-relative
  exchange ratio; peg = 1.0 means 1 ETH-equivalent.
- In June 2022 stETH had **no native redemption**: ETH withdrawals were not enabled until the
  Shanghai upgrade (April 2023). The ONLY exit was the secondary market (Curve stETH/ETH pool +
  CEX). So the 1:1 redemption right existed in principle but was **non-exercisable on-chain** at
  the time — the price was set purely by secondary-market liquidity.
- During the Terra→Celsius→3AC forced-deleveraging cascade, the Curve stETH/ETH pool went heavily
  imbalanced and large holders (Alameda, Celsius, 3AC) dumped stETH into thin liquidity. The
  ETH-relative ratio slid: ~0.97 in May → ~0.95 early Fri Jun 10 → **trough ~0.93–0.935 on Mon
  Jun 13** (≈ 6.5–7% below ETH peg). It did NOT approach a USD-stablecoin "broke-the-buck" depth;
  the impairment was a sustained mid-single-digit-percent ETH-relative discount under stress.
- This was a **liquidity/market dislocation, NOT a backing failure**: every stETH was still 1:1
  backed by staked ETH on the beacon chain. There was no unbacked mint, no minter compromise.
- Real liquidation risk: stETH was a major lending collateral (Aave v2 stETH market, Maker
  wstETH vaults). Looped stETH/ETH positions (notably on Aave) faced liquidation pressure as the
  ratio fell and ETH itself dropped; the cascade is what forced the Curve dumping. On a venue whose
  oracle tracks the **market** stETH/ETH ratio (not a hardcoded 1.0), the discount is a real
  collateral haircut.

## Why this is a TRUE positive (should fire), NOT by-design discount
- Unlike USD0++ (a **contractual** early-redemption discount → `by_design_discount=True`) or a PT/RWA
  wrapper structurally < $1, the stETH June-2022 discount is a **distress signal**: a 6.5–7%
  ETH-relative gap is ~1–2 orders of magnitude past an LST's normal steady-state (a healthy stETH
  trades within ~10–40 bps of ETH). A risk monitor for a lender holding stETH collateral MUST surface
  this — it is exactly the collateral-impairment / liquidation-contagion exposure the desk watches.
- So `by_design_discount = False`. At ~6.5–7% the depeg is below the 10% `depeg_catastrophic_magnitude`
  override, so it should land in the **HIGH/WARN** band on a depeg-sensitive lending venue — NOT
  CRITICAL (no realized bad debt / no LT crossing was the on-chain outcome; positions deleveraged
  rather than cascading to mass liquidation on the stETH market itself). That is the honest severity.

## Capture (real on-chain, Alchemy archive) — RE-ANCHORED 2026-06
- **Decisive input = the stETH/ETH ratio, MEASURED on-chain** via the Curve stETH/ETH pool
  `0xDC24316b9AE028F1497c275EB9192a3Ea0f67022` `get_dy(1 stETH → 0 ETH, dx=1e18)` (coin0 = ETH
  `0xeeee…eeee`, coin1 = stETH, verified on-chain). 100% of the case's decisive inputs are measured
  (`snapshots/fidelity.json`, measured_pct=100).
- **Why re-anchored:** the original anchor block 14955378 (2022-06-13T10:00Z) sat in a *partially-
  recovered* window — the on-chain marginal print there was only 0.9434 (~5.7% below peg), short of
  the documented ~6.5–7% trough (the deeper number was a CEX/aggregator intraday low at a different
  time). A window scan (Fri Jun 10 → Tue Jun 14, sampled at 6h, then 1h, then 15m resolution, reading
  Curve `get_dy` at each candidate block) located the **on-chain depth-trough ~2 hours later, around
  12:00–15:00Z Mon Jun 13**, where the on-chain venue itself reached the labelled depth. Cases moved to
  those blocks.
- Snapshot anchor block (ethereum): **14955879**, ts 1655121597 = **2022-06-13T11:59:57Z**.
- stETH `totalSupply` @ 14955879 = **4,219,980.057 stETH** (4219980057326744911600826 wei, 18dp),
  read via `capture.total_supply('ethereum', 0xae7ab9…fe84, 14955879)`. Anchors the snapshot's realism.

### Measured on-chain ratios per case (Curve get_dy, raw → human)
| case | block | ts (UTC) | get_dy raw | stETH/ETH | below peg |
|------|-------|----------|------------|-----------|-----------|
| trough-eth-relative-0.935 | 14955879 | 2022-06-13T11:59:57Z | 935006398893112904 | 0.93501 | 6.499% |
| deeper-trough-0.93 | 14956535 | 2022-06-13T14:44:56Z | 934078708122525117 | 0.93408 | 6.592% |
| benign-steady-state-0.998 | 14589816 | 2022-04-15T11:59:48Z | 999964454990240270 | 0.99996 | 0.004% |

## Cases (judgment unchanged from label.json — only the anchor block + measured ratio moved)
1. **trough-eth-relative-0.935** (2022-06-13T12:00Z, measured ratio **0.93501**): a sustained ~6.5%
   ETH-relative discount of a major lending collateral on a market-price (depeg_sensitive) oracle →
   DEPEG must fire, min_severity **WARN** (out of band, real haircut, but below the 10% catastrophic
   override and above LT 0.90 → not HIGH/CRITICAL).
2. **deeper-trough-0.93** (2022-06-13T14:45Z, measured ratio **0.93408**): the absolute on-chain trough
   ~6.6% → DEPEG must fire, min_severity **WARN** (anchors that the monitor alarms across the trough,
   not just one print).
3. **benign-steady-state-0.998** (2022-04-15T12:00Z, measured ratio **0.99996**): a routine ~0.4-bps
   stETH/ETH discount in genuinely-calm, **pre-Terra** conditions → DEPEG must **NOT** fire. FP-trap:
   guards against a hair-trigger that would alarm on the entire restaking/LST book every day.
   RE-ANCHORED from the prior 2022-05-20 block, which the label-reviewer REJECTED: its on-chain
   measurement was 0.98395 (~1.6%) because May 20 sat inside the immediate post-Terra (collapse May
   9–13) aftermath — NOT a calm steady state. 2022-04-15 is well clear of Terra and confirmed in-band.

## Sources
CoinDesk (Nansen forensics), The Defiant, Yahoo Finance, Nansen "Demystifying stETH's De-peg",
HTX/Huobi Research, TokenInsight (Alameda sales) — see WebSearch trail in the iteration journal.
On-chain: Alchemy archive reads (supply @ 14955879; Curve stETH/ETH get_dy @ 14955879 / 14956535 /
14589816). Lido docs (no withdrawals until Shanghai 2023).
