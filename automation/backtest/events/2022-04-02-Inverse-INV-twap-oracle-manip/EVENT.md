# Inverse Finance INV TWAP oracle-manipulation + bad-debt — 2022-04-02 (Ethereum)

## One-line
An attacker pumped INV ~50x on a THIN SushiSwap INV/WETH pool; Inverse's Keep3r
30-min TWAP oracle sampled the manipulated price only ~15 seconds into the window
(a window-size bug bypassed the `timeElapsed > periodSize` check), so the oracle
returned a FRESH but grossly-OVER-VALUED INV price. The attacker deposited the
mis-priced INV as collateral on Inverse's Anchor/Frontier market and borrowed
~$15.6M (DOLA / ETH / WBTC / YFI), leaving ~$3.65M of DOLA bad debt.

## Assets / addresses
- **Collateral token:** INV `0x41D5D79431A913C4aE7d69a668ecdfE5fF9DFB68` (Inverse DAO
  governance token). ALTCOIN: a volatile governance token, NOT a stablecoin or LST —
  its honest cross-source price legitimately moves several percent, so the appropriate
  deviation band is altcoin-wide (~5%), not hard-stable (~0.1%) or LST (~2%).
- **Loan asset:** DOLA `0x865377367054516e17014CcdED1e7d814EDC9ce4` (Inverse's stablecoin).
- **Protocol:** Inverse Frontier / Anchor (mono_pool lender)
  `0x4dCf7407AE5C07f8681e1659f626E114A7667339`.
- **Oracle:** Keep3r INV/ETH amTWAP (30-min window, sourced from a THIN Sushi INV/WETH
  pool), modeled at synthetic `0xinvkeep3rtwaporacle0000000000000000000a`.
- **Market:** loan_asset DOLA / collateral_asset INV, LLTV 0.6667.

## The oracle design flaw (root cause)
Inverse priced INV collateral with a Keep3r `Keep3rV2Oracle` amTWAP nominally over a
**30-minute** time window. The `_update()` function only records a new TWAP observation
when `timeElapsed > periodSize`. Because **only ~15 seconds** had elapsed since the prior
observation when the attacking bundle landed, that guard was bypassed and the oracle
effectively sampled the **freshly-manipulated spot price** rather than a true 30-min
average. The attacker first pumped INV on the thin Sushi INV/WETH (and INV/DOLA) pool —
~50x — using a bundle submitted directly to miners (so mempool arbitrage bots could not
unwind it. The TWAP then reported INV at a peak around **$20,926** vs an honest market
price of roughly **$8–9**. The feed was FRESH the whole time — the returned price was
simply grossly WRONG. A staleness / heartbeat check is structurally blind to this; only a
**cross-reference** of the oracle answer against an honest INV price (Coinbase / honest
Sushi reference) distinguishes a fresh-but-manipulated price from a calm honest read.

## The attack
1. Withdrew ~901 ETH from Tornado Cash; submitted a transaction **bundle** (direct to
   miners, bypassing the mempool) so arbitrage bots could not bring INV back in line.
2. Swapped ETH → INV through the thin Sushi pool, spiking INV ~50x. The Keep3r amTWAP,
   due to the 15s window-bug, sampled this manipulated price and grossly OVER-VALUED INV.
3. Deposited the mis-priced INV (~1.7k INV) as collateral on Anchor/Frontier and borrowed
   **~$15.6M**: 1,588 ETH, 94 WBTC, 4M DOLA, 39.3 YFI.
4. The over-borrow against worthless-once-repriced collateral left **~$3.65M of DOLA bad
   debt** in the protocol. Inverse paused borrowing in response.
   NOTE: this was NOT a flash-loan attack and was NOT a smart-contract/front-end bug — it
   was purely an oracle TWAP-sampling error.

## What our monitor must catch (and why this event was added)
This is the classic **spot-into-TWAP** oracle manipulation: a thin-pool pump dragged a
short-window TWAP to a value INV never honestly printed. The catching mechanism is the
**cross-reference deviation check**: `|answer/reference_answer - 1|` vs the **asset-class
deviation band**. INV is a volatile altcoin governance token → the appropriate band is
**altcoin-wide (~5%)**, NOT hard-stable. The manipulated divergence is enormous (the
documented TWAP peak ~$20,926 vs ~$8 honest is multi-thousand-percent; even the modeled
probe values of 20.0 vs 8.0 = +150% are far beyond the ~5% band) and MUST page. A benign
~1–2% honest cross-source difference on INV (ordinary altcoin volatility) must NOT.

This event is a DISTINCT FLAVOR of oracle manipulation from the others in the set:
- **UwU (2024)** — Curve `get_p()` INSTANTANEOUS-spot median dragged, sUSDe (LST band).
- **reUSD / Resupply (2025)** — ERC4626 share-price / zero-supply oracle.
- **INV (2022, this one)** — **30-min TWAP** sampled only 15s in, **altcoin governance-
  token** collateral. Same fingerprint (fresh-but-wrong price), different mechanism + asset.

## FIDELITY
- **On-chain anchor:** Ethereum, 2022-04-02, snapshot block 14506358, snapshot ts
  2022-04-02T12:00:00Z. Token / protocol / oracle addresses and the DOLA/INV market are
  modeled in `snapshots/INV.json`.
- **The manipulated and honest INV prices are POST-MORTEM figures**, not live archive
  reads. The Keep3r amTWAP is a composited intra-transaction read (and the manipulation was
  bundled, off-mempool), so the manipulated answer and the honest reference are **injected
  per-case via `oracle_probes`** (host-fed, exactly like peg_probes / the LUNA oracle reads).
  The documented honest INV price was ~$8–9 and the manipulated TWAP peaked ~$20,926; the
  label uses the host-specified modeled values **answer 20.0 / reference_answer 8.0** for the
  incident (a clean, directionally-correct over-valuation far beyond the ~5% altcoin band)
  and **answer 8.1 / reference_answer 8.0** (~1.25%) for the calm control. `asset_class:
  "altcoin"` encodes that INV carries the wide (~5%) altcoin deviation tolerance.
- **updated_at is FRESH** in both cases (near the event `now`) — this is the whole point:
  the manipulated feed was NOT stale (the window-bug made it sample a fresh manipulated
  price), so a freeze/staleness check alone is blind; only the answer-vs-reference
  divergence distinguishes manipulation from a calm honest read.
- **KNOWN RECALL GAP — bad debt is NOT separately detectable.** The ~$3.65M DOLA bad-debt
  aftermath is a real and material part of this incident, but the engine has **no bad-debt
  detector** and the lending model carries **no outstanding-debt field**. Only the
  oracle-manipulation LEG (the grossly over-valued INV oracle) is caught here, via the
  cross-reference-deviation check. We do NOT assert any bad-debt signal. The over-borrow /
  bad-debt consequence is documented context, not a labeled `should_fire`.

## Sources
- Inverse Finance DAO — INV Price Manipulation Incident (official post-mortem):
  https://www.inverse.finance/blog/posts/en-US/inv-price-manipulation-incident
- CertiK — Inverse Finance 02 April 2022:
  https://www.certik.com/resources/blog/inverse-finance-02-april-2022
- RedStone — Oracle Attacks #1: Inverse Finance, $15M stolen:
  https://medium.com/@RedStone_Finance/oracle-attacks-1-inverse-finance-15m-stolen-9fffb03d5171
- Inspex — Inverse Finance's Incident Analysis ($INV Price Manipulation):
  https://inspexco.medium.com/inverse-finances-incident-analysis-inv-price-manipulation-b15c2e917888
- REKT — Inverse Finance:
  https://rekt.news/inverse-finance-rekt
- CoinDesk — DeFi Lender Inverse Finance Exploited for $15.6M:
  https://www.coindesk.com/tech/2022/04/02/defi-lender-inverse-finance-exploited-for-156-million
