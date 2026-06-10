# Elixir deUSD — redemption-run supply collapse + catastrophic depeg (Nov 4–7, 2025)

**Event ID:** `2025-11-07-deUSD-redemption-run`
**Class:** SUPPLY_DELTA_ANOMALY (mass-redemption supply collapse) + catastrophic DEPEG.
**Status:** closed.
**Token:** deUSD, Ethereum mainnet ERC20, `0x15700B564Ca08D9439C58cA5053166E8317aa138`
(ERC1967 proxy; impl `0x4c835B1374EcCa0c5963987fa3Ea2B8bE779Dc59`). **decimals = 18**
(verified on Etherscan).

## TL;DR
deUSD was Elixir's "fully collateralized synthetic dollar." Elixir had parked **~65% of
deUSD's backing — ~$68M — into Stream Finance** via private Morpho vaults, taking Stream's
xUSD as collateral. On **Nov 4, 2025** Stream disclosed a **~$93M loss** by an off-chain
"external fund manager" (~$285M total interconnected DeFi debt) and froze withdrawals. As
xUSD imploded (~-77%), deUSD's backing effectively vanished. Holders ran for the exit:
**~80% of deUSD holders redeemed** before the protocol halted, **circulating supply
collapsed**, and the price fell from **~$1.00 to a trough of ~$0.015 (≈ -98%)** over
Nov 4–7. Elixir then announced it would **wind down deUSD**, snapshot remaining balances,
and let non-Stream holders claim ~$1 in USDC. Stream itself held ~90% of the *remaining*
supply (~$75M) and refused to repay.

This is the distinct test this event adds to our set: a **redemption-run supply collapse**
(a sharp, sustained contraction of circulating supply as holders flee) layered on top of a
**catastrophic depeg**. Our existing labels cover depegs, an oracle-freeze, and the xUSD
*unbacked-mint* (same Stream/Elixir cluster) — but none exercise a TVL-shock / mass-redemption
/ supply-collapse pattern. The label is built to fire on the supply-delta + depeg signature
**without** re-using xUSD's unbacked Σsupply > backing signature (deUSD's break is a *run*,
not primarily a recursive-loop over-mint).

## What deUSD was
- deUSD = Elixir's synthetic dollar, marketed as fully collateralized via a delta-neutral
  ETH-funding strategy. sdeUSD = staked deUSD.
- Critically, a large slice of "backing" was a **loan to Stream Finance** (~$68M, ~65%),
  collateralized by Stream's own xUSD. So deUSD's solvency was downstream of an opaque,
  off-chain-managed counterparty — the part that broke was not verifiable on a block explorer.

## Mechanism (why a *run*, not just a depeg)
1. **Nov 4:** Stream discloses ~$93M external-manager loss, halts withdrawals. xUSD craters
   (~-77%). deUSD's ~$68M Stream loan is now impaired/illiquid → deUSD is effectively
   under-backed and its $1 redemption promise is in doubt.
2. **Confidence break → redemption run:** holders rush to redeem deUSD for USDC while they
   still can. Elixir processed redemptions for **~80% of holders** before suspending. Each
   redemption **burns deUSD**, so **circulating supply contracts sharply and sustainedly** —
   the canonical SUPPLY_DELTA_ANOMALY / mass-redemption signature (distinct from a mint-spike).
3. **Depeg:** secondary-market price decoupled: reported path **$1.00 → ~$0.40 → brief bounce
   to ~$0.99 → liquidation cascade → ~$0.03 → trough ~$0.015** ("traded down to $0.015 within
   hours" per FXStreet). Net ≈ **-98%**.
4. **Wind-down (Nov 7):** Elixir announces it is sunsetting deUSD; remaining (non-Stream)
   holders claim ~$1 USDC against a balance snapshot. Stream holds ~90% of the *residual*
   ~$75M supply and will not repay.

deUSD was used as collateral across **Euler / Morpho / Silo / Gearbox** (and
Compound-style) markets; ~$285M direct debt exposure was tied to the broader deUSD/xUSD cluster.

## Magnitudes (best available)
| Quantity | Value | Confidence | Source |
|---|---|---|---|
| Supply ~Oct 25, 2025 (pre-event, calm) | **~150.41M deUSD** (≈ $150M mcap, ~$1.00) | MEDIUM-HIGH | CoinGecko snapshot |
| Pre-run baseline supply (just before Nov 4) | ~150M (order-of-magnitude; redemptions had not yet started) | MEDIUM | inferred from Oct 25 figure |
| Post-run / wind-down supply | **~92.15M deUSD** (current max supply on Etherscan, post most redemptions) | MEDIUM | Etherscan token page |
| Price (calm, pre-event) | **~$1.00** | HIGH | CoinGecko / multiple |
| Price trough (Nov 5–7) | **~$0.015** (intraday; also reported ~$0.025–$0.03) | MEDIUM-HIGH | FXStreet, Cryptopolitan, BeInCrypto |
| Depeg magnitude | **≈ -98%** | HIGH | multiple |
| Holders redeemed pre-halt | **~80%** | HIGH | Elixir statement, multiple |
| Elixir loan to Stream | **~$68M (~65% of backing)** | HIGH | BeInCrypto, BlockEden |
| Total cluster debt exposure | **~$285M** (Euler/Morpho/Silo/Gearbox) | HIGH | BlockEden, FXStreet |

Note on the supply-delta magnitude: the *fully verifiable* on-chain contraction by the time
of the wind-down is roughly **150M → 92M ≈ -39%**, and Σredemptions account for ~80% of
*holders* (not necessarily 80% of supply, since Stream — the largest single holder — did NOT
redeem and is stuck holding ~90% of the residual). The capture should resolve the *actual*
supply curve from on-chain `totalSupply()` at the three target blocks rather than rely on
these reported aggregates. Even the conservative ~-39% verified contraction over ~2–3 days is
a large, anomalous supply drop for a "stable" token.

## Approximate Ethereum blocks (resolve exact by timestamp at capture)
Anchored to the repo's own verified xUSD snapshot: **block 23,725,820 = 2025-11-04 12:00Z**
(~12s/block, ~7200 blocks/day).
- **Calm pre-event (~Oct 8, 2025 12:00Z):** ≈ **23,531,400** (−27 d)
- **Pre-run baseline (~Nov 3, 2025 18:00Z, just before disclosure):** ≈ **23,720,400** (−18 h)
- **Collapse trough (~Nov 6, 2025 12:00Z):** ≈ **23,740,200** (+2 d)

## FIDELITY (be honest)
**On-chain verifiable on Ethereum (HIGH confidence, our Alchemy key is Ethereum-only):**
- deUSD contract, decimals (18), proxy structure — verified on Etherscan.
- `totalSupply()` at any historical block → the **supply-collapse curve is directly
  measurable** on Ethereum. This is the strongest part of the label: the redemption-run
  supply contraction is a first-class on-chain fact (burn-on-redeem), readable from
  `totalSupply()` at the calm / baseline / trough blocks. **This is the spine of the INCIDENT
  case** and the part we should lean on for the floor.

**Researcher-asserted / off-chain (MEDIUM confidence):**
- The exact **price trough (~$0.015)** is a secondary-market quote (CEX/DEX), not an on-chain
  protocol oracle reading; reports vary ($0.015 / $0.025 / $0.03). For the label we treat the
  depeg as catastrophic (≥ -90%) regardless of which trough quote is exact — that conclusion
  is robust to the spread. Price enters the engine via a `peg_probes` value, not by reading a
  contract.
- The **~$68M Stream loan / ~65% backing / ~$285M cluster debt** are off-chain/curated figures.
  We do **NOT** assert UNBACKED_SUPPLY for deUSD in this label: that is xUSD's tested signature,
  and deUSD's break is fundamentally a *run* (holders fleeing → supply burn + depeg), not a
  provable Σsupply > on-chain-backing breach from a single deUSD snapshot. Conflating the two
  would just re-test xUSD and would require off-chain NAV we cannot verify on Ethereum.
- "80% of holders redeemed" is an Elixir statement (holder-count, not supply-fraction). The
  capture resolves the real supply-fraction from on-chain totalSupply.

**Confidence summary:** supply collapse = HIGH (on-chain). Depeg magnitude (catastrophic) =
HIGH; exact trough = MEDIUM. Backing/loan figures = MEDIUM and intentionally NOT load-bearing
for any signal in this label.

## Sources
- Yahoo Finance — "Elixir Shuts Down deUSD Stablecoin After Stream Finance's $93M Loss"
  https://finance.yahoo.com/news/elixir-shuts-down-deusd-stablecoin-104937488.html
- Cryptopolitan — "Elixir's deUSD drops 98% — What's happening?"
  https://www.cryptopolitan.com/elixirs-deusd-drops-98-whats-happening/
- BeInCrypto — "Elixir Winds Down deUSD Following Stream Finance Fallout"
  https://beincrypto.com/elixir-deusd-stablecoin-collapse-stream-finance-loss/
- BlockEden — "Anatomy of a $285M DeFi Contagion: The Stream Finance xUSD Collapse"
  https://blockeden.xyz/blog/2025/11/08/m-defi-contagion/
- FXStreet — "Elixir deUSD stablecoin collapse, Stream Finance loss 2025"
  https://www.fxstreet.com/cryptocurrencies/news/elixir-deusd-stablecoin-collapse-stream-finance-loss-2025-202511071458
- CoinGecko — Elixir deUSD (supply ~150.41M / mcap ~$150M as of Oct 25, 2025)
  https://www.coingecko.com/en/coins/elixir-deusd
- Etherscan — deUSD token (decimals=18, supply, proxy)
  https://etherscan.io/token/0x15700B564Ca08D9439C58cA5053166E8317aa138
- Companion event in this repo: `2025-11-04-xUSD-unbacked` (same Stream/Elixir cluster).
