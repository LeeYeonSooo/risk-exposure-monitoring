# USDC depeg — Silicon Valley Bank reserve scare (2023-03-11)

## What happened (facts, no engine reasoning)
- Circle held ~$3.3B of USDC cash reserves at **Silicon Valley Bank**, which was placed
  into FDIC receivership on **Friday 2023-03-10**. Circle disclosed the SVB exposure late
  Friday (~2023-03-10 ~20:00 PT / 2023-03-11 ~04:00 UTC).
- Over **Saturday 2023-03-11** USDC lost its peg in secondary markets, trading as low as
  **~$0.87–0.88** (Coinbase/Kraken/Curve 3pool all skewed; Curve 3pool went heavily
  USDC-weighted). This was a backing-confidence depeg of the LARGEST regulated stablecoin
  collateral in DeFi (~$39B supply at the time).
- On **Sunday 2023-03-12** the US Treasury/Fed/FDIC announced all SVB depositors would be
  made whole. USDC began recovering and was back to **~$1.00 (≈0.999)** by **2023-03-13**.
- Realized DeFi harm: USDC is a top collateral and borrow asset on Aave/Compound/Morpho.
  The depeg threatened USDC-collateralized loans and any market that prices USDC at a
  hardcoded $1.00. (Note: most blue-chip lenders price USDC at a hardcoded $1.00 by design,
  so on-chain liquidations were *muted* relative to the ~13% market impairment — but the
  exposure was real and several venues paused/limited markets.)

## On-chain anchor (capture)
- USDC token `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Ethereum mainnet.
- Depeg-low block: **16803810**, ts 2023-03-11T09:00:11Z (binary-searched via Alchemy archive).
- `totalSupply()` at that block = **38925924909579550** raw / **38.926B** USDC (6 decimals).
  Matches the historically reported ~$39B USDC supply in March 2023. (Reads via
  `capture.total_supply` + `capture.call_uint(decimals)`.)
- Recovery block (for the FP-trap): use the same snapshot; the recovered price (~0.999) is
  injected per-case via `peg_probes`, since the price is what changed, not the token graph.

## Exposure modeled
Two USDC collateral edges into a generic isolated lending venue, to exercise both oracle regimes:
1. **MARKET-priced (sighted) USDC market** — a venue whose oracle tracks the real USDC/USD
   secondary price. A ~13% depeg of a stablecoin collateral here liquidates leveraged
   positions / accrues bad debt → catastrophic.
2. **HARDCODED $1.00 (blind) USDC market** — the typical blue-chip configuration. On-chain
   it never breaches LT, but the ~13% impairment of $X collateral is real, latent bad debt
   the monitor must still surface (one notch below the sighted venue).

## Sources
Circle blog (SVB reserve statement, 2023-03-11), Reuters, CoinDesk, The Block, Curve 3pool
on-chain skew reports, US Joint Statement (Treasury/Fed/FDIC, 2023-03-12). Prices: low ~$0.87,
recovery ~$0.999 by 2023-03-13.
