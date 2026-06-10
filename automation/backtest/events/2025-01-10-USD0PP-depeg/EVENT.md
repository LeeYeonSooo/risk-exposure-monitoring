# USD0++ (Usual) depeg — January 10–13, 2025

**Event ID:** `2025-01-10-USD0PP-depeg`
**Type:** REAL incident (governance-induced stablecoin/bond depeg + lending contagion).
**Token:** USD0++ (Usual) — the "liquid bond" / 4-year-locked staked form of USD0.
**Home chain:** Ethereum mainnet.
**Token contract:** `0x35D8949372D46B7a3D5A56006AE77B215fc69bC0` (USD0++ , Usual). Verified on Etherscan.

## What USD0++ is (and why a $1 peg was assumed)
USD0++ is a tokenized 4-year bond on top of USD0 (Usual's RWA/T-bill-backed stablecoin).
Holders staked USD0 → USD0++ expecting an eventual 1:1 redemption to USD0 ($1). The market
and, critically, several Morpho lending markets treated USD0++ as a ~$1 asset. It was NOT a
free-floating asset — its "$1" was a *protocol promise*, which made it vulnerable to a
governance/redemption-rule change rather than to market flows alone.

## Timeline (UTC, approximate)
- **2025-01-09 → 2025-01-10 (morning):** Usual published a notice changing USD0++ redemption.
  The original implicit 1:1 redemption was replaced with a **dual-exit** model:
  - a *conditional* exit (forfeit accrued USUAL rewards) closer to par, and
  - an **unconditional exit with a hard floor of $0.87** per USD0++ (stated to gradually
    re-peg toward $1 over time).
- **2025-01-10:** Within hours USD0++ broke peg. It traded down to roughly **$0.89** intraday
  (sources cite a low band of ~$0.89–$0.92), then hovered ~$0.92–$0.935. ~8–11% off peg.
- **2025-01-10 → 2025-01-13:** The Curve USD0/USD0++ pool went heavily imbalanced
  (~92% USD0++ / ~8% USD0) as holders exited. Pendle USD0++ PTs repriced sharply (PT buyers
  took losses; Usual's Pendle TVL roughly halved). Looping / circular-leverage positions on
  Morpho unwound; liquidations hit the market-price (Chainlink) Morpho market.

## WHY it depegged
This was a **governance-induced revaluation, not a backing failure.** The collateral behind
USD0 was largely intact; what changed was the *redemption contract*. By introducing an
**unconditional $0.87 floor**, Usual effectively told the market that immediate, guaranteed
liquidity for USD0++ was worth $0.87, not $1.00. The market repriced toward that floor.
The $0.87 floor sat *just above* Morpho's 86% liquidation line (0.86), which is why the
depeg was so dangerous for leveraged collateral: a small additional slip past 0.86 would
trigger liquidations even though the asset was "worth" ~$0.87 by protocol design.

## Morpho exposure — the CRITICAL oracle nuance
USD0++ was a **major Morpho Blue collateral**, with reported **$200m+ of borrows** backed by
USD0++ across markets. Morpho Blue markets are isolated; each market hard-wires its own
oracle. Two distinct oracle regimes coexisted, and they behaved OPPOSITELY in the depeg:

1. **Hardcoded-$1.00 oracle market(s).** The oracle returned a fixed $1.00 for USD0++,
   *blind to the depeg.* On-chain, collateral never appeared to lose value, so the LLTV (86%)
   was never breached and **on-chain liquidations did NOT trigger** (the largest liquidation
   on the hardcoded market was reportedly ~$500 — i.e., effectively none). This market
   *temporarily shielded* borrowers but created systemic risk: lenders/suppliers, seeing the
   oracle was blind to a real ~11% loss, **fled** (supplier exodus), spiking borrow rates.
   The exposure was REAL even though that venue's liquidation path was frozen.

2. **Market-price (Chainlink) oracle market(s), LLTV 86%.** The oracle tracked the real
   ~$0.89–0.92 price. When USD0++ fell, leveraged positions crossed the **86% LLTV** and
   **liquidations DID trigger** immediately. This is where the actual on-chain liquidation /
   contagion happened.

**Resolution:** MEV Capital (a major Morpho curator) deployed new isolated markets — a
"naked floor price" market pegging USD0++ at its $0.87 redemption value, plus Chainlink
market-price markets (some with very high LLTV up to ~96.5%) — to let borrowers refinance
and to prevent bad debt from accruing to suppliers. Bad debt was largely avoided.

## Liquidation / contagion impact
- Immediate liquidations of leveraged (looped) USD0++ positions on the market-price Morpho
  markets as price crossed 0.86.
- Curve USD0/USD0++ pool drained to ~92/8 imbalance; deep on-pool discount.
- Pendle USD0++ PT discounts widened; Usual Pendle TVL ~halved.
- No protocol-insolvency / no permanent backing loss — this was a redemption-rule repricing.

## Why the monitor SHOULD have fired (label reasoning)
An ~11% depeg of a token that is a **major Morpho collateral** ($200m+ borrows) is a real,
actionable exposure risk regardless of which oracle a given venue used:
- On the **market-price market**, the depeg pushed positions THROUGH the 86% LT and caused
  real liquidations → this is the most severe case → **DEPEG should fire at CRITICAL/HIGH**.
- On the **hardcoded-$1 market**, the venue's liquidation path was *blind*, but our exposure
  to USD0++ collateral was just as real (an ~11% impairment of collateral the venue is
  pretending is whole). A risk monitor exists precisely to see what a blind oracle cannot →
  **DEPEG should STILL fire (≥WARN/HIGH)**. Silence here would be the dangerous failure mode:
  the on-chain venue says "all fine," and a monitor that trusts the venue oracle inherits the
  blindness. The monitor judges the *price of the asset*, not the venue's oracle.
- A token sitting AT or very near $1 (a benign, recovered, or never-stressed asset) must stay
  silent — that's the FP-trap guard.

## Sources
- Blockworks — "Usual protocol's depeg spurs instability in DeFi markets":
  https://blockworks.co/news/usual-depeg-spurs-defi-instability
- Leviathan News — "Collateral Damage: USD0++ Depeg Leaves Farmers in the Red":
  https://leviathannews.substack.com/p/collateral-damage-usd0-depeg-leaves
- ChainCatcher — "Is USD0++ the next UST?":
  https://www.chaincatcher.com/en/article/2161846
- Gate Learn — "Usual Explained: USD0++ Depegging and Circular Loans' Liquidation":
  https://www.gate.com/learn/articles/usual-explained-the-hidden-issues-behind-usd0-depegging-and-circular-loans-liquidation/6030
- Robdog (X) — "$200m+ of borrows on Morpho with USD0++ as collateral … above 86% LLTV":
  https://x.com/robdogeth/status/1877621647911309429
- Etherscan — USD0++ token (`0x35d8949372d46b7a3d5a56006ae77b215fc69bc0`):
  https://etherscan.io/address/0x35d8949372d46b7a3d5a56006ae77b215fc69bc0
