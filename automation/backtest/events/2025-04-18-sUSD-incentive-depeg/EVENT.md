# sUSD (Synthetix) SIP-420 incentive-failure depeg — 2025-04-18 (Ethereum)

## Summary
sUSD, Synthetix's SNX-collateralized stablecoin, slid from ~$1.00 to a low of **~$0.66–0.68
around 2025-04-18** — a roughly **31–34% depeg**. The cause was **SIP-420**, a governance change
that removed the protocol's reflexive peg-defense incentive. This is a **crypto-collateral
incentive-mechanism failure** — categorically distinct from a fiat-reserve depeg (USDC/FDUSD/DAI
SVB), a redemption-rule revaluation (USD0++), or a flash exploit.

## The mechanism (SIP-420)
- Synthetix shipped **SIP-420** in early April 2025 to improve capital efficiency.
- It **lowered the staker collateral C-ratio from ~750% to ~200%**, letting users mint far more
  sUSD per unit of SNX → structural oversupply.
- It **socialized staker debt into a single shared pool** (and forgave ~$60m of staker debt over
  12 months), replacing the old model where each staker owned their own debt.
- Old peg defense: when sUSD traded below $1, individual stakers had a direct incentive to **buy
  discounted sUSD to repay their own debt** at a profit — a reflexive force pulling price back to $1.
- SIP-420 **removed that individual incentive**: with debt socialized, no single minter is motivated
  to buy back cheap sUSD. The self-correcting mechanism broke, oversupply was never absorbed, and the
  price ground down over multiple weeks.

## Timeline
- **Early April 2025**: SIP-420 deployed; sUSD begins slipping (The Block noted a slip to ~$0.96
  amid sell-off).
- **~2025-04-18**: trough at **~$0.66–0.68** (~31–34% off peg). This is a **slow multi-week grind**,
  not a flash crash. ainvest headline: "sUSD Depegs 31% After Protocol Shift."
- sUSD comprised **>75% of the major Curve sUSD pools** at the trough — holders exited into the
  other pool legs, leaving the pool heavily imbalanced toward sUSD.
- **May 2025**: secondary low ~$0.73; recovered to ~$0.93 by mid-August via Synthetix buybacks
  (50% of Perps revenue → sUSD buyback) and supply reduction.
- **~Oct 2025**: recovered to **~$0.998 (Oct 13) / ~$0.999 (Oct 15)** — effectively re-pegged.
  (Note: some trackers cite a much deeper transient ~$0.21 print in Aug 2025 on thin venues; the
  documented, widely-cited slow-grind trough used for this label is the ~$0.66 April figure.)

## Classification
- **NOT fiat-reserve**: backing is on-chain SNX collateral, intact — no reserve insolvency.
- **NOT a redemption-rule change**: no protocol-promised floor was repriced (unlike USD0++).
- **NOT a flash exploit**: no hack, no oracle manipulation, no single-block event.
- **IS a governance-induced incentive failure** on a crypto-collateralized stablecoin: a NEW depeg
  mechanism for the backtest. Tests d08 DEPEG on a deep, slow crypto-collateral depeg.

## On-chain anchor (fidelity)
- Token: sUSD `0x57Ab1ec28D129707052df4dF418D58a2D46d5f51`, Ethereum mainnet, **decimals 18**
  (`eth_call 0x313ce567` → 0x12).
- **Block 22295741**, ts 1744977599 (**2025-04-18T11:59:59Z**), `totalSupply` (`0x18160ddd`) =
  **32,798,321.96 sUSD** — read on-chain via Alchemy Ethereum archive.
- Caveat: the canonical Ethereum sUSD float is small (~33M); the bulk of sUSD liquidity and the
  Curve sUSD pools live on **Optimism**, which this Ethereum-only Alchemy key cannot faithfully
  capture. The snapshot uses the Ethereum token as the on-chain anchor and models a representative
  market-priced crypto-collateral edge; the depeg PRICE (the load-bearing fact) is injected via
  `peg_probes` and is documented from secondary-market/Curve coverage — it does not depend on the
  Ethereum supply figure.

## FIDELITY
- **Mechanism (SIP-420, C-ratio 750%→200%, socialized debt, removed peg defense)**: HIGH —
  directly from Synthetix governance and multiple post-mortems.
- **~$0.66 April-18 trough / ~31–34% off peg**: MEDIUM-HIGH — documented secondary-market/Curve
  price across several outlets (CoinCentral, ainvest, Cointelegraph, The Defiant). Exact venue print
  varies slightly ($0.66–0.68).
- **>75% Curve pool composition**: MEDIUM — reported in coverage; modeled qualitatively as a deep,
  imbalanced market-priced venue.
- **~$0.998 Oct-2025 recovery**: HIGH — multiple sources cite ~$0.998 (Oct 13) / ~$0.999 (Oct 15).
- **Ethereum totalSupply/decimals/block**: HIGH (on-chain).

## Sources
- Cointelegraph — "What happened to sUSD? How a crypto-collateralized stablecoin depegged":
  https://cointelegraph.com/explained/what-happened-to-susd-how-a-crypto-collateralized-stablecoin-depegged
- ainvest — "Synthetix's sUSD Depegs 31% After Protocol Shift":
  https://www.ainvest.com/news/synthetix-susd-depegs-31-protocol-shift-2504/
- CoinCentral — "Synthetix's sUSD … Drops as Low as $0.66":
  https://coincentral.com/synthetixs-susd-stablecoin-continues-to-struggle-with-depeg-drops-as-low-as-0-66/
- The Defiant — "sUSD Slides Further Away from Peg After Protocol Update":
  https://thedefiant.io/news/defi/synthetix-s-susd-slides-further-away-from-peg-after-protocol-update
- The Block — "Synthetix's sUSD stablecoin slips below dollar peg to $0.96 amid sell-off":
  https://www.theblock.co/post/295074/synthetix-susd-depeg
- Blockworks — "Synthetix's sUSD continued depeg to $0.86":
  https://blockworks.co/news/synthetixs-stablecoin-depeg-susd-discord
- Synthetix blog — "Rebuilding sUSD" / "sUSD Peg Update":
  https://blog.synthetix.io/rebuilding-susd/ , https://blog.synthetix.io/synthetix-susd-peg-update/
- On-chain: Alchemy Ethereum archive, sUSD totalSupply @ block 22295741 (2025-04-18T11:59:59Z).
