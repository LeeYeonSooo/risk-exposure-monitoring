# FDUSD (First Digital USD) confidence-run depeg — 2025-04-02

## One-line
A major fiat-backed stablecoin (~$2.2-2.3B supply) lost its peg to ~$0.87 on the secondary
market within hours of a public insolvency allegation against its issuer, then recovered to
~$0.99 the next day. The backing (US T-bills) was **contested in public but never impaired
on-chain** — total supply barely moved. This is a CONFIDENCE-RUN depeg, distinct from the
LST/oracle depegs (ezETH, stETH) and the algorithmic freeze (LUNA) already in the suite.

## Timeline (UTC)
- **2025-04-02 ~morning:** Tron founder Justin Sun publicly claims First Digital Trust (FDT),
  the entity managing FDUSD reserves, is "effectively insolvent and unable to fulfill client
  fund redemptions," and urges holders to exit FDUSD. Root cause traced to a separate ~$456M
  dispute between Techteryx and First Digital over misused **TUSD** (not FDUSD) reserves.
- **2025-04-02 (within hours):** FDUSD slides from ~$0.996 to a trough around **~$0.87** on
  secondary venues (a ~13% depeg) as holders rush to exit. ~94% of FDUSD supply (~$2.2B) trades
  on Binance, so the dislocation is a secondary-market confidence run, not an on-chain mint/burn.
- **2025-04-02 (later) → 2025-04-03:** First Digital denies the claims ("Every dollar backing
  FDUSD is completely secure ... US-backed T-Bills"), processes redemptions (reportedly ~$26M),
  and FDUSD recovers toward ~$0.99 (≈1:0.99 vs USDT) by the morning of Apr 3.

## On-chain facts captured (Ethereum mainnet, Alchemy archive)
- Token: **FDUSD**, `0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409`, 18 decimals (symbol/decimals
  read on-chain).
- **Depeg block 22181387** (2025-04-02T12:59:59Z): totalSupply = **2,341,751,540 FDUSD**
  (~$2.34B), matching the ~$2.2B reported.
- Pre-event block 22166759 (2025-03-31T11:59:59Z): totalSupply = 2,328,524,138 FDUSD.
- **Supply delta over the surrounding ~2 days: +0.57%** — essentially flat. The depeg was a
  PRICE event; there was no supply collapse, no anomalous mint, and no on-chain backing failure.

## Why this is mechanically distinct
- Not an LST exchange-rate slip (ezETH/stETH), not an oracle freeze (LUNA), not an unbacked
  mint (xUSD). It is a **fiat-backed stablecoin confidence run** where the secondary price
  detached from an intact (but publicly contested) reserve. The on-chain monitor's only true
  signal is the **price DEPEG**; supply/backing detectors must stay SILENT (the engine must not
  invent a backing failure from a price wobble + a tweet).

## What SHOULD fire vs NOT
- A fund holding FDUSD as **lending collateral** (modeled isolated FDUSD/USDC market, LT 0.91,
  market-price FDUSD/USD oracle) is liquidated once secondary price drops below the LT. At the
  ~$0.87 trough (below 0.91 LT) this is a realized-liquidation depeg → **DEPEG CRITICAL** on the
  lending edge.
- A fund holding FDUSD as **DEX liquidity** (no liquidation path) sees a real but non-catastrophic
  dislocation → **DEPEG WARN** on the DEX edge.
- During the **recovery** (~$0.93), price is back above the 0.91 LT: still out of the tight
  10-bps stable band, so DEPEG persists but de-escalates to **WARN** on both edges. Tests that the
  engine de-escalates as price recovers rather than latching CRITICAL.
- At the **recovered/benign** level (~$0.9996, within ~4 bps of peg): the depeg must be SILENT.
  No DEPEG ≥ WARN. (FP-trap: the engine must not keep alarming once a stablecoin is effectively
  back at peg, and must not over-alarm on a sub-10-bps wobble for a healthy stable.)
- Supply/unbacked/mint-burn detectors must NOT fire at any point — supply was flat and backing
  was never impaired on-chain.

## Sources
- DailyHodl, Decrypt, Cointelegraph, BeInCrypto, NFTevening, MoneyTransmitterLaw (First Digital
  $26M redemption + denial), TronWeekly. Prices ~$0.87 trough, recovery to ~$0.99 by Apr 3.
- On-chain: Alchemy Ethereum archive reads at blocks 22181387 (depeg) and 22166759 (pre-event).
