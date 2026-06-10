# CRV liquidation cascade / whale-unwind — 2024-06-12 → 2024-06-13 (Ethereum)

## One-line
Curve founder Michael Egorov's ~9-figure CRV-collateralized borrow positions, spread
across five lending venues, were force-liquidated as CRV crashed ~28-34% in a single
session. On the **Fraxlend CRV/FRAX pair** the CRV collateral backing the lending market
**drained −98.4% over a 24h window** (REAL on-chain measured, Alchemy archive reads of
`CRV.balanceOf(pair)`) as liquidation bots seized and dumped the collateral — a textbook
large-holder unwind / liquidation cascade. This is the first **sustained-drain /
WHALE_UNWIND** event in the labeled set (collateral DRAIN over a 24h window, not a peg break).

## Faithful venue (REAL, on-chain measured)
- **Fraxlend CRV/FRAX pair `0x3835a58CA93Cdb5f912519ad366826aC9a752510`** — a REAL June-2024
  CRV liquidation venue. (An earlier draft used Aave v2 as a *representative* edge; that was
  wrong for June-2024 — Aave v2's CRV market had already been de-risked / frozen (Gauntlet/Chaos
  proposal Aug 2023) and Egorov closed his Aave debt in Sept 2023. Replacing Aave with the live
  Fraxlend pair removes the "representative venue" caveat: the drain below is a REAL measured one.)
- **maxLTV ≈ 0.75** (Fraxlend CRV/FRAX) → label `lltv` 0.75.

## Measured CRV collateral held by the Fraxlend pair (Alchemy archive `balanceOf`)
| Date (UTC) | Block | CRV held by pair | Note |
|---|---|---|---|
| 2024-05-08 (calm) | 19,825,201 | **63,211,604 CRV** | calm-control baseline |
| 2024-06-11 → 06-13 00:00 | 20,079,184 | **~57,927,278 CRV** (stable) | pre-cascade, position intact |
| 2024-06-13 12:00 (cascade) | 20,082,760 | **931,126 CRV** | post-cascade, near-total wipe |
| 2024-06-14 12:00 | — | 648,196 CRV | tail, continued bleed |

→ **24h cascade drain (June 13 00:00 → June 13 12:00): 57,927,278 → 931,126 CRV = −98.4%**
  (REAL on-chain measured, NOT reconstructed). This is a near-total collateral wipe of the
  Fraxlend CRV/FRAX market in a single 24h window.

## Timeline (UTC; Ethereum blocks)
- **2024-05-08 (calm baseline)** — CRV trading in the ~$0.30-0.40 band; Egorov's leveraged
  CRV positions stable, no forced liquidations. Fraxlend pair holds **63,211,604 CRV**
  (block 19,825,201). Calm-control anchor: **2024-05-08T12:00:00Z**.
- **2024-06-12 (night, warning)** — Coverage warnings circulate: addresses tied to Egorov
  borrowing ~$95.7M stablecoins against ~$141M CRV across Inverse, UwU Lend, **Fraxlend**,
  Silo, and Curve's own LlamaLend. CRV grinding toward liquidation thresholds. Fraxlend pair
  still holds ~57,927,278 CRV through **2024-06-13T00:00:00Z** (block 20,079,184).
- **2024-06-13 (Thursday morning, cascade)** — CRV slides ~28-34% intraday (~$0.36 →
  low ~$0.22, settling ~$0.27), an all-time low. Liquidation bots seize CRV collateral
  across venues; the seized CRV is sold into the move, depressing price further and tripping
  the next position (the cascade). On Fraxlend the pair's CRV collateral collapses
  **57,927,278 → 931,126 CRV (−98.4%) by 2024-06-13T12:00:00Z** (block 20,082,760).
  **Cascade "now" anchor: 2024-06-13T12:00:00Z, block 20,082,760.**
- **2024-06-14 12:00** — tail bleed continues to 648,196 CRV.
- **Days after** — ~$10M (reported $10-11.5M across venues, concentrated in Curve LlamaLend)
  of bad debt, of which >$1M on two LlamaLend accounts, was repaid by Egorov within days
  (he received ~$6M USDT from Christian Seale / counterparties).

## Mechanism
Large single-holder leverage. One whale (Egorov) had pledged a very large CRV stack as
collateral to borrow stablecoins across five isolated lending markets, Fraxlend among them.
When CRV fell through the liquidation thresholds, liquidators repaid the stablecoin debt and
seized the CRV collateral at a discount, then dumped it — a self-reinforcing **collateral
drain**: each sale pushed CRV down and pulled the next position into liquidation. From a
fund-risk-monitor view the actionable signal is NOT a peg break (CRV is a free-floating
altcoin, no peg) but a **steep, sustained drain of the CRV collateral backing a lending edge
over ~24h** — the exposure (collateral securing the loan book) is evaporating, i.e.
WHALE_UNWIND.

## Magnitudes
| Quantity | Value | Status |
|---|---|---|
| **Fraxlend CRV/FRAX 24h collateral drain** | **57,927,278 → 931,126 CRV = −98.4%** (June 13 00:00→12:00) | **ON-CHAIN MEASURED** (Alchemy archive balanceOf, blocks 20,079,184 / 20,082,760) |
| CRV price drop (intraday) | ~28-34% (~$0.36 → low ~$0.22, settled ~$0.27) | **DOCUMENTED** (CoinDesk, Decrypt, Protos, DailyCoin) |
| Egorov total CRV collateral BEFORE | ~$141M CRV vs ~$95.7M stablecoin debt, 5 venues | **DOCUMENTED** (Arkham, Decrypt, CoinDesk) |
| Total CRV collateral AFTER cascade | ~$33.9M CRV vs ~$20.6M debt (4 venues) | **DOCUMENTED** (Blockworks) |
| Total CRV liquidated (cascade) | ~$22-27M of CRV across venues | **DOCUMENTED** (Protos $22M; DailyCoin $27M) |
| Per-venue: UwU Lend | ~20M CRV seized | DOCUMENTED (Protos) |
| Bad debt (June 2024) | ~$10-11.5M, concentrated in **Curve LlamaLend** (>$1M on 2 accts); Fraxlend a primary liquidation venue | **DOCUMENTED** (Egorov X post, Decrypt, Arkham, cryptotimes) |

## FIDELITY (measured vs documented vs host-fed)
- **ON-CHAIN MEASURED, HIGH confidence:** the **−98.4% 24h Fraxlend CRV/FRAX collateral drain**
  (57,927,278 → 931,126 CRV, June 13 00:00 → 12:00) and the calm baseline (63,211,604 CRV on
  2024-05-08) are direct Alchemy archive reads of `CRV.balanceOf(0x3835a58C…)` at the cited
  blocks. This is no longer reconstructed — it is a real measured per-venue drain.
- **DOCUMENTED, high confidence:** CRV price crash %; the five lending venues; ~$22-27M CRV
  liquidated; ~$10M bad debt concentrated in Curve LlamaLend with Fraxlend a primary
  liquidation venue.
- **HOST-FED SERIES (by design):** the `window_observations` entry is the **published input the
  monitor receives from history** (host-fed collateral-drain series keyed to the edge), and here
  it is the host-fed representation of the MEASURED drain (change −0.984). It is NOT an engine
  internal. Per the window-observation contract, the monitor flags a cumulative drain beyond the
  market's normal tail AND beyond an absolute floor (~≥25%/24h). The incident obs (−0.984, 24h)
  clears both by a wide margin; the calm obs (−0.01, 24h) is routine noise and must not flag.

## Why this label is correct
- **should_fire WHALE_UNWIND ≥ HIGH** at the cascade: a measured **−98.4%** CRV-collateral drain
  over 24h on the Fraxlend CRV/FRAX edge is a near-total collateral wipe — a severe, sustained
  large-holder unwind, exactly the exposure-evaporation a fund risk monitor must catch. A
  near-total 24h drain is unambiguously HIGH (CRITICAL would also be defensible, so HIGH is the
  floor).
- **must_not_fire DEPEG** at the cascade: CRV is a **free-floating altcoin with no peg**. Its
  ~28-34% price crash is a market sell-off, not a peg break. Firing DEPEG here would be a
  sign/semantics error (treating an unpegged altcoin's price as a peg deviation). The correct
  signal is the collateral DRAIN, not a peg.
- **Calm control (2024-05-08):** stable CRV, 63,211,604 CRV in the Fraxlend pair, no
  liquidations, a routine −0.01 (1%) 24h collateral fluctuation. WHALE_UNWIND /
  UTIL_LIQUIDITY_DROP / DEPEG must all stay silent; max emitted severity WARN with 0 allowed →
  proves the drain detector keys on a genuine large cumulative drain, not on ordinary collateral
  noise.

## Provenance / Sources
- **On-chain:** Alchemy Ethereum archive `eth_call` `CRV.balanceOf(0x3835a58CA93Cdb5f912519ad366826aC9a752510)`
  at blocks 19,825,201 (2024-05-08), 20,079,184 (2024-06-13 00:00), 20,082,760 (2024-06-13 12:00),
  and 2024-06-14 12:00. CRV token `0xD533a949740bb3306d119CC777fa900bA034cd52`.
- CoinDesk — "DeFi Giant Curve Roiled as Founder's Loans Get Liquidated; CRV Slides 30%": https://www.coindesk.com/markets/2024/06/13/crv-slides-30-as-loans-tied-to-curves-founder-face-liquidation-risk
- Decrypt — "Curve Founder Faces $140 Million Liquidation After CRV Price Plunges": https://decrypt.co/235149/curve-founder-liquidation-crv-token
- Protos — "$22M CRV liquidation cascade": https://protos.com/curve-finance-founder-michael-egorov-hit-amid-22m-crv-liquidation-cascade/
- DailyCoin — "CRV Crashes 34% as Founder Egorov Suffers $27M Liquidation": https://dailycoin.com/crv-crashes-34-as-founder-egorov-suffers-27m-liquidation/
- Blockworks — "Curve's Egorov turns to notable counterparties to bail out his DeFi positions" (~$33.9M CRV / ~$20.6M debt after): https://blockworks.com/news/curve-egorov-exit-defi-positions
- cryptotimes fact-check (~78% collateral wiped; bad-debt repaid): https://www.cryptotimes.io/2026/04/27/fact-check-did-michael-egorov-pull-100m-from-crv-to-buy-mansions-and-leave-bad-debt/
- Arkham (on X) — "$140M in CRV liquidated across 5 protocols": https://x.com/arkham/status/1801209817475780658
- DL News — "Aave, Abracadabra and Inverse hustle to protect themselves" (Aave de-risked CRV): https://www.dlnews.com/articles/defi/defi-lenders-hustle-to-limit-exposure-to-curve-founder-loans/
