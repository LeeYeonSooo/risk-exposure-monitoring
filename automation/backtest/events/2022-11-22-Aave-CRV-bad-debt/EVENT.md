# Aave V2 CRV market — REALIZED bad debt (~$1.6–1.7M) — 2022-11-22, Ethereum

## What happened
On **2022-11-22** Avraham "Avi" Eisenberg (the Mango Markets exploiter) ran a leveraged
**CRV-short attack** against **Aave V2 on Ethereum**. He deposited large USDC collateral and
**borrowed ~92M CRV** (roughly $40M+ notional drawn over the episode), then dumped the borrowed
CRV across DEXes and CEXes to try to **crash the CRV price** and trigger a self-reinforcing
liquidation/insolvency spiral on Aave (a "toxic liquidation spiral").

The crash **failed**: CRV did not collapse — instead the price **rose** while his position was
being unwound. As CRV climbed, his short position went underwater and was **force-liquidated**.
But the forced liquidations **could not fully cover his outstanding CRV debt**: the rising CRV
price created a mismatch between the (liquidation-discounted) USDC collateral seized and the CRV
loan value owed, so a residual slice of CRV debt was left with **no recoverable collateral behind
it**.

## The realized impairment (the signal)
Aave V2 was left holding **~2.64M CRV of irretrievable debt ≈ ~$1.6–1.7M** at the time — a
**reserve deficit / REALIZED BAD DEBT**. This is the key fact for a fund: it is not a price blip
or an oracle wobble — it is **outstanding debt > recoverable collateral** in a lending market, so
**depositors in that market cannot be made whole**. Post-mortems consistently report this as the
documented deficit; reported figures cluster at **~$1.5M / $1.6M / $1.7M** (= 2.64M CRV at the
time), with the most-cited round number being **~$1.6M**.

## Aftermath / remediation
- Aave contributors immediately (2022-11-23) put forth governance proposals to handle the fallout
  (freezing CRV and other v2 markets, parameter changes, and recapitalizing the CRV market).
- In **January 2023** the Aave DAO voted to **repay the excess CRV debt using aUSDC from the Aave
  treasury**, with **~$280,000 subsidized by Gauntlet's insolvency fund**. The deficit was deemed
  small relative to total debt and **within the Safety Module's limits**, but the DAO chose direct
  treasury/insolvency-fund recapitalization over drawing the Safety Module — i.e. depositors were
  ultimately made whole by the protocol's backstop capital, NOT by liquidations.

The point for the monitor: between the liquidation shortfall (2022-11-22/23) and the later
treasury repayment, the CRV market **carried a realized ~$1.6M deficit** — exactly the impairment
a depositor needs alerted on.

## Sources
- The Defiant — "Major CRV Trade on Aave Leaves Money Market With $1.6M in Bad Debt": https://thedefiant.io/news/defi/crv-trade-aave-bad-debt
- Blockworks — "Feature or Flaw? Aave Left With $1.7M in Bad Debt": https://blockworks.co/news/aave-curve-bad-debt
- Cointelegraph — "Aave proposes governance changes after failed $60M short attack": https://cointelegraph.com/news/aave-proposes-governance-changes-after-failed-60m-short-attack
- Aave Governance — "[ARC] Repay excess debt in CRV market for Aave V2 ETH": https://governance.aave.com/t/arc-repay-excess-debt-in-crv-market-for-aave-v2-eth/10779
- Kaiko Research — "CRV, Aave, and the Art of Liquidation": https://research.kaiko.com/insights/crv-aave-liquidation
- arXiv 2302.04068 — "Short Squeeze in DeFi Lending Market: Decentralization in Jeopardy?": https://arxiv.org/abs/2302.04068
- Decrypt — "Aave Feeling the Squeeze Even After Failed Attempt by Mango Hacker": https://decrypt.co/115596/aave-feeling-the-squeeze-even-after-failed-attempt-by-mango-hacker
- DL News — DeFi lenders limit exposure to Curve-founder loans: https://www.dlnews.com/articles/defi/defi-lenders-hustle-to-limit-exposure-to-curve-founder-loans/

## FIDELITY
- **The ~$1.6M bad-debt figure is the documented post-mortem deficit, not a reconstruction.**
  Sources report it as ~$1.5M / $1.6M / $1.7M (= 2.64M CRV at the time); the snapshot encodes the
  most-cited round value, **`lending_risk.bad_debt_usd = 1600000`**, host-fed (a USD deficit a host
  computes off-chain: outstanding CRV debt minus recoverable collateral, valued at CRV price). The
  monitor does not derive this number — it consumes it.
- **On-chain anchors identity, not magnitude.** `snapshot_block 16040000` (≈ 2022-11-23, post-
  liquidation) pins the **Aave V2 CRV market** identity; the healthy control uses `15870000`
  (≈ 2022-11-01, pre-attack). Token = CRV `0xD533a949740bb3306d119CC777fa900bA034cd52`; protocol =
  Aave V2 LendingPool `0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9`. Edge identity:
  **`CRV-aave_v2-collateral`** (`protocol_class: lending`, `edge_type: collateral_shared`).
- **This is a DISTINCT signal class.** The exploit *causes* (oracle-manip / price-crash attempts)
  are upstream signals; the **realized impairment** — a lending market left insolvent so depositors
  can't be made whole — is what `BAD_DEBT` exists to surface. It is keyed off the host-fed
  `lending_risk.bad_debt_usd` deficit, independent of any peg/oracle probe.
- **Severity rationale.** ~$1.6M is a real, actionable market deficit (≥ the ~$1M actionable
  floor) → **HIGH**. It is **not** a systemic ≥ $50M hole, so **not CRITICAL**. The control
  (`bad_debt_usd = 0`) must stay fully silent.
