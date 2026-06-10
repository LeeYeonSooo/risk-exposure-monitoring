# 2024-09→11 cbBTC rapid concentration as Aave V3 collateral (COLLATERAL-ADOPTION incident)

## Classification
INCIDENT on the **collateral-adoption / concentration** axis (`closed: true`). NOT a price/peg
event. This is the first event in the set that exercises **COLLATERAL_ADOPTION**: a token being
adopted as collateral from a zero base, escalated to a systemic severity because a SINGLE venue
(Aave V3) came to hold ~72% of the token's entire supply within ~1 month of listing. Paired with
a CALM control (already-adopted, stable position, no anomalous inflow) so the signal is shown to
key on the adoption *event/inflow*, not on the position merely existing.

## What actually happened (facts, no engine knowledge)
- **cbBTC launch.** Coinbase launched cbBTC (Coinbase Wrapped BTC), an ERC-20 1:1 backed by BTC
  held in Coinbase custody, on **2024-09-12** on Ethereum and Base. Ethereum cbBTC token
  `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`, **8 decimals**. Pre-listing, Aave held 0 cbBTC.
- **Aave V3 listing.** The Aave Chan Initiative's ARFC to onboard cbBTC to Aave v3 (Ethereum +
  Base) is dated **2024-09-10**; the asset was listed shortly after launch (late Sep 2024). By
  **2024-10-04** the DAO already had to file a *supply-cap increase* proposal for cbBTC on Aave V3
  Ethereum — direct governance evidence that adoption was filling the cap that fast.
- **Measured adoption ramp (on-chain).** cbBTC held by the Aave aEthcbBTC aToken
  `0x5c647ce0ae10658ec44fa4e11a51c96e94efd1dd`, vs cbBTC `totalSupply`:

  | date (UTC)   | block     | Aave-held cbBTC | cbBTC total supply | Aave % of supply |
  |--------------|-----------|-----------------|--------------------|------------------|
  | 2024-09-20   | 20780000  | 0               | (pre-listing)      | 0.0%             |
  | 2024-10-01   | —         | 1,190           | 3,293              | 36.1%            |
  | 2024-10-25   | —         | 5,522           | 7,706              | 71.7%            |
  | **2024-11-01** | **21089068** | **7,567**   | **10,575**         | **71.6%**        |

  So within ~1 month of listing, one venue (Aave V3 Ethereum) held **~72% of all cbBTC in
  existence** — ~$530M at cbBTC ≈ $70k.

## Why ~72% concentration in one venue is a systemic risk a fund monitor must surface
- **Single-point-of-failure for ~72% of the supply.** A problem localized to that ONE venue —
  a parameter misconfiguration, an oracle issue, a bad-debt / liquidation cascade, a freeze — now
  touches ~72% of the entire token's supply at once. The token's risk is no longer diversified
  across many venues; it is effectively the risk of one lending market.
- **Two-way contagion.** Conversely a cbBTC-specific shock (a custody/redemption problem at
  Coinbase, a cbBTC depeg) lands almost entirely inside a single Aave market, concentrating the
  liquidation and bad-debt impact rather than spreading it. The Aave community itself flagged the
  custody-centralization concern during the onboarding debate.
- **Speed from a zero base.** This is not a slow drift in an already-mature market: it is a 0 →
  ~72% structural ramp in weeks, which is exactly the regime a concentration monitor exists to
  catch early (before the position is unwound-able quietly). The governance supply-cap chase
  (Oct 4) corroborates the velocity.

For a fund tracking exposure across the top-100 Morpho/Aave collateral tokens, "one protocol now
holds ~72% of this collateral's total supply, up from 0% a month ago" is a HIGH structural-risk
finding: it changes the contagion topology of any position touching cbBTC.

## Why this is HIGH (not WARN, not CRITICAL)
- Adoption *itself* (a token becoming collateral) is INFO/WARN — routine and healthy.
- The escalator is **concentration**: when one protocol holds a large fraction of total supply the
  adoption becomes *systemic*. ~72% of supply in a single venue is squarely in "systemic
  concentration" territory → **HIGH**.
- It is not CRITICAL because nothing has actually broken — there is no depeg, no bad debt, no
  insolvency, no freeze. It is a standing structural/contagion risk to flag and monitor, not an
  in-progress loss event.

## Calm control (must stay silent)
Later period (Feb–Mar 2025): cbBTC is an already-adopted, mature Aave collateral sitting stably at
~7,950 → ~8,021 cbBTC (a ~+0.9% step, no anomalous inflow), total supply having grown so Aave's
share is back to a normal ~40%. There is no adoption *event* here — the position simply exists and
drifts. COLLATERAL_ADOPTION must NOT re-fire: the signal keys on the adoption ramp / abnormal
inflow, not on a large position continuing to exist. A re-alarm here would be the standing-position
FP that would make the signal useless (it would scream every snapshot forever). Noise ceiling:
zero WARN-or-above.

## Pass criteria (label)
- INCIDENT `cbbtc-aave-rapid-adoption-concentration`: should_fire **COLLATERAL_ADOPTION ≥ HIGH** on
  `cbBTC-aave_v3-collateral` (structural 0→~72%-of-supply systemic concentration). must_not_fire
  **DEPEG** (no price event — cbBTC at peg throughout).
- CONTROL `cbbtc-calm-stable-no-adoption`: should_fire []; must_not_fire **COLLATERAL_ADOPTION**;
  `max_emitted {WARN, 0}`.

## FIDELITY
- The **cbBTC amounts and % of total supply are on-chain MEASURED** (Alchemy archive: cbBTC
  `balanceOf(aEthcbBTC)` and cbBTC `totalSupply` at the stated blocks). The 2024-11-01 row
  (block 21089068, 7,567 cbBTC, 71.6%) is the incident snapshot and is real.
- **USD figures are approximate**, derived from cbBTC ≈ $70k (BTC price ~Nov 2024). The risk
  thesis rests on the token-count and %-of-supply, which are exact; USD is illustrative.
- The calm-control amounts (~7,950 / ~8,021 cbBTC) represent a real later stable regime; the exact
  step is a labeled benign-drift test vector on the same real edge.

## Sources
- cbBTC launch 2024-09-12 (Ethereum + Base, 1:1 BTC, Coinbase custody):
  https://www.coindesk.com/business/2024/09/12/coinbases-wrapped-bitcoin-cbbtc-goes-live ;
  https://unchainedcrypto.com/coinbases-wrapped-bitcoin-product-cbbtc-launches-on-base-and-ethereum/
- Aave V3 onboarding ARFC (ACI, dated 2024-09-10) and supply-cap-increase ARFC (2024-10-04, proof
  of rapid cap-filling adoption):
  https://governance.aave.com/t/arfc-onboard-cbbtc-to-aave-v3-on-base-and-mainnet/18988 ;
  https://governance.aave.com/t/arfc-increase-cbbtc-supply-caps-on-aave-v3-ethereum-market-and-base/19304
- Community custody-centralization concern over the cbBTC integration:
  https://cryptoslate.com/aaves-bid-to-integrate-coinbases-cbbtc-sparks-community-concerns/
- On-chain anchor: cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8 dp); Aave aEthcbBTC
  `0x5c647ce0ae10658ec44fa4e11a51c96e94efd1dd`; `balanceOf` / `totalSupply` at block 21089068
  (2024-11-01) and the ramp blocks above (Alchemy archive via `qa/backtest/collect/capture.py`).
