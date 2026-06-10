# DAI depeg — 2023-03-11 (USDC-SVB contagion)

DAI was ~73% USDC-collateralized via the PSM. When USDC fell on the SVB scare, DAI followed. On a sighted (market-price) lending oracle this liquidates DAI-collateral positions; on a hardcoded $1.00 oracle the impairment is hidden bad debt. DAI recovered with USDC by 2023-03-13.

## On-chain depeg timeline (Chainlink DAI/USD 0xAed0c38402a5d19df6E4c03F4E2DcED6e29c1ee9, MEASURED)
The depeg WAS reflected on-chain — the protocol oracle moved. Reads across the window:
- 2023-03-11 00:00Z (blk 16801143): 0.99890 (-0.1%)
- 2023-03-11 04:00Z (blk 16802331): 0.95374 (-4.6%)
- 2023-03-11 06:00Z (blk 16802921): 0.94500 (-5.5%)
- **2023-03-11 07:19:59Z (blk 16803316): 0.89110864 (-10.89%) — on-chain FLOOR, round freshly updated 07:18:47Z**
- 07:15–07:40Z whole window sits in the -10% to -11% band (robust, not a one-block artifact)
- 2023-03-11 09:00Z (blk 16803809): 0.94012 (-6.0%) — recovering
- 2023-03-11 12:00Z (blk ~16804702): 0.92998 (-7.0%) — partially recovered
- 2023-03-13 18:00Z (blk 16820707): 0.99776 (-0.22%) — recovered in-band

## Re-anchor (this revision)
A prior data-only backfill anchored the depeg cases at NOON (block ~16804702), where the on-chain
feed read only -7.0% — SHORT of the labelled catastrophic depth. The ~$0.897 low was real but earlier
in the UTC morning. RE-ANCHORED the depeg cases to block **16803316** (2023-03-11T07:19:59Z), the
on-chain DAI/USD floor at **0.89110864 (-10.89%)**, which bears the labelled CRITICAL (>=10%) tier.
The recovered FP-trap is re-anchored to block **16820707** (2023-03-13T18:00Z, -0.22%, cleanly silent).
should_fire / must_not_fire / severities UNCHANGED — only the anchor block + measured inputs moved.

## Anchors
- Depeg block: 16803316 (2023-03-11T07:19:59Z). DAI totalSupply 5568713805161949974669060911 raw (re-measured @ that block, Alchemy archive).
- Recovery block: 16820707 (2023-03-13T17:59:59Z).
- Sources: MakerDAO forum, on-chain Chainlink DAI/USD, USDC-SVB post-mortems.
