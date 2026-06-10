# RWA yield token accrues ABOVE $1 by design — FP-discipline control (USYC)

**Date / block:** Behavioral control, dated 2025-06-01T00:00:00Z (no incident — there is no event).
**Token / edge:** USYC (Hashnote US Yield Coin) `0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b`,
6 decimals, Ethereum mainnet. Edge `USYC-morpho-collateral` (USYC supplied as collateral in a
Morpho Blue isolated USDC market, lltv 0.92, depeg_sensitive collateral).

## What happened (the FACTS)
Nothing broke. This control captures a NORMAL, by-design state that a naive "$1 peg" scanner
mis-reads as a depeg:

- USYC is the on-chain representation of the Hashnote International Short Duration Yield Fund
  (SDYF), which holds short-dated US Treasury bills and reverse-repo on Treasuries. It is a
  TOKENIZED MONEY-MARKET / T-bill yield token, NOT a $1 stablecoin.
- Yield is NOT paid as a coupon or rebase. Instead the fund's net asset value (NAV) accrues
  daily as Treasury/repo interest compounds, and the USYC token price tracks NAV (price = NAV /
  supply, published on-chain daily via an oracle). So USYC LEGITIMATELY trades ABOVE $1 and the
  premium GROWS over time. Its price has reached ~$1.12 (CoinGecko all-time high $1.12); ~$1.127
  is a representative NAV used here. Redemption is at NAV (T+0 into USDC, 24/7).
- This is a whole CLASS of yield-bearing RWAs, not a USYC quirk: Ondo USDY accrues a growing
  premium above $1.00 against USD (not a stablecoin); OUSG/BUIDL recognize yield by increasing
  NAV-per-token. All redeem at NAV. DeFiLlama's depeg scanner flagged USYC at $1.127 as
  "0.127 off-peg" — a FALSE POSITIVE, because the correct peg for an accruing RWA IS its NAV.

## Why this is the correct expectation (ground truth)
Two independent points, both of which the monitor must honor:

1. CORRECT MODELING (peg = NAV): if the peg is set to the NAV ($1.127), then price == peg and
   there is ZERO deviation. The monitor must be FULLY SILENT (no DEPEG on the edge). This is the
   right way to model an accruing RWA: there is no peg to break.

2. SIGN DIRECTION / catastrophe ceiling (peg naively = $1.00): even if an operator misconfigures
   the peg to a flat $1.00, the deviation is UPWARD (+12.7%): the collateral is worth MORE than
   par. For a COLLATERAL token, an upward price move is the SAFE direction — it INCREASES
   over-collateralization and REDUCES liquidation risk. A depeg that threatens lenders is a
   DOWNWARD break (collateral worth less than assumed). Therefore an upward excursion must NEVER
   produce a catastrophic (HIGH/CRITICAL) page. At most a benign WARN ("trading above band /
   peg likely misconfigured") is tolerable as a config-hygiene nudge; a HIGH/CRITICAL liquidation-
   risk page on an upward move is the exact false alarm this control forbids.

The asymmetry is the whole point: depeg severity must be sign-aware. A −12.7% break of a
collateral token is an incident; a +12.7% accrual is not.

## Cases
- `usyc-nav-peg-quiet` — peg correctly = NAV (1.127). price==peg, no deviation. should_fire [];
  must_not_fire DEPEG on `USYC-morpho-collateral`; max_emitted {WARN, 0} (zero WARN-or-above).
- `usyc-naive-1dollar-peg-no-catastrophe` — peg naively = 1.00, price 1.127 (+12.7% UP).
  should_fire []; must_not_fire []; max_emitted {HIGH, 0} (zero HIGH-or-above; a lone WARN for a
  misconfigured-peg/above-band nudge is acceptable, a catastrophic page is not).

## Provenance / fidelity
- Snapshot: `snapshots/usyc.json` (event-local), host-fed graph: token:USYC + protocol:morpho,
  edge `USYC-morpho-collateral` (collateral_isolated, lltv 0.92, oracle = "USYC NAV oracle
  (accrues above $1)"). market_cap ~$600M; edge core_weight ~$112.7M (100M USYC @ $1.127).
- Price/peg are supplied via `peg_probes` in the label (1.127 NAV is representative, not a tick
  read from chain). asset_class "rwa", by_design_discount false in both cases — the discrimination
  here is sign-direction + peg==NAV, not a by-design-discount path.
- This is a BEHAVIORAL FP-control: ~$1.127 is a representative NAV (USYC has traded ~$1.12+), so
  fidelity rests on the by-design-above-$1 mechanism (well sourced) rather than on a specific
  block read. No prev, no baselines.

## Sources
- USYC docs — Introduction (NAV accrues, T+0 redeem): https://usyc.docs.hashnote.com/
- Circle — USYC tokenized money market fund: https://www.circle.com/usyc
- CoinGecko — Circle USYC price (all-time high $1.12): https://www.coingecko.com/en/coins/hashnote-usyc
- Nansen — What is Hashnote USYC (Treasuries + reverse repo, NAV tracking): https://nansen.ai/post/what-is-hashnote-usyc
- Ondo USDY (premium above $1 grows, not a stablecoin): https://ondo.finance/usdy
- Ondo OUSG / yield via NAV increase (OUSG holds BUIDL + USYC): https://docs.ondo.finance/qualified-access-products/ousg/yield
- Top tokenized treasury funds (BUIDL/OUSG/USDY NAV accrual): https://eco.com/support/en/articles/15210582-top-tokenized-treasury-funds-2026-buidl-ousg-usdy-benji-compared
