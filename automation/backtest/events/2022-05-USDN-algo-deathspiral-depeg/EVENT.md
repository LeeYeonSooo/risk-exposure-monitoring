# Neutrino USD (USDN) algorithmic-stablecoin DEATH SPIRAL — Terra/UST contagion (May 2022)

## What factually happened
Neutrino USD (USDN) was a **WAVES-collateralized algorithmic stablecoin** on the Waves
blockchain (Ethereum-bridged ERC-20 at `0x674C6Ad92Fd080e4004b2312b45f796a192D27a0`).
Users locked WAVES into Neutrino smart contracts to mint USDN; redemptions burned USDN to
unlock WAVES. The peg therefore depended **reflexively** on the WAVES price and the
collateral ratio: when WAVES fell, USDN's backing fell, USDN broke peg, the protocol /
arbitrage minted-and-sold more WAVES to defend the peg, which pushed WAVES lower still — a
self-reinforcing **death spiral**, structurally the same family as Terra's UST↔LUNA loop.

USDN broke peg **twice** in 40 days:

1. **First depeg — early April 2022 (~Apr 2–4).** Aggressive USDN selling in the Curve USDN
   pool, coinciding with "WAVES manipulation" accusations (Alameda-vs-WAVES drama), drove
   USDN to roughly **$0.78–$0.82** (CoinDesk: "drops 15%"; Cointelegraph: "falls to $0.82";
   some prints as low as ~$0.65). WAVES sold off hard alongside. USDN clawed back toward par
   but the reflexive fragility was now exposed.

2. **Terminal contagion collapse — May 2022.** When TerraUSD (UST) imploded (UST as low as
   ~$0.23 on May 11), contagion hit every algo-stable. USDN **dropped ~12% to ~$0.88 on
   May 11** and traded as low as **~$0.79 on KuCoin** that day (CoinDesk, 2022-05-11), with
   WAVES down ~26% to ~$9. USDN remained structurally undercollateralized; Waves founder
   Sasha Ivanov later conceded USDN was undercollateralized (CoinDesk, 2022-06-01) and took
   on ~$400–500M in debt to liquidate whale collateral and attempt to restore the peg. USDN
   never durably recovered and was effectively wound down.

### Real Ethereum-readable symptom: the bridged-supply COLLAPSE (mass-redemption exit)
The Ethereum-bridged USDN supply **contracted sharply** as holders fled / redeemed and the
bridge drained:
- **107.4M → 81.4M USDN** over the contagion exit week **May-10 → May-15** = **−24%**
  (real on-chain `totalSupply`: 107,369,748 @ block 14,745,349 → 81,445,200 @ block
  14,776,687; this snapshot pair).
- **~176M (Apr) → ~67M (Jun)** overall = roughly **−62%** as the spiral played out.
This is a textbook downward **supply contraction / redemption exit**, the on-chain signature
of a stablecoin bank-run, distinct from a mint spike.

## Why this is an exposure event a risk monitor MUST catch
USDN is the **REFLEXIVE algorithmic-stable death-spiral** archetype — a DISTINCT failure
mode from its siblings in this suite:
- vs **LUNA (2022-05-13)**: that is an ORACLE-FREEZE (a frozen feed); USDN is a real,
  honestly-priced market DEPEG plus a supply exit.
- vs **deUSD (2025-11-07)**: that is a redemption-run on an externally-*backed* stable;
  USDN's collateral is its own *reflexive* WAVES, so the depeg and the supply exit reinforce
  each other endogenously.
- vs fiat-reserve depegs (USDC/SVB, FDUSD): those are reserve/banking scares, not a reflexive
  collateral-ratio decay.
The two **Ethereum-readable** symptoms are independently sufficient red flags:
  1. **DEPEG** — a deep, sustained break of a $1 peg on a depeg-sensitive collateral venue
     (the Curve/lending edge prices USDN as collateral).
  2. **SUPPLY_DELTA_ANOMALY** — a sudden multi-tens-of-percent **downward** supply
     contraction (−24% in five days), the mass-redemption / bridge-exit signature.

## On-chain anchor (real archive reads, these snapshots)
- Token: **USDN (Ethereum-bridged)** ERC-20, `0x674C6Ad92Fd080e4004b2312b45f796a192D27a0`,
  decimals **18**.
- `prev` (`snapshots/usdn_prev.json`): `totalSupply` = **107,369,748 USDN** @ block
  **14,745,349**, ts **2022-05-10T12:00:00Z** (mid-contagion, pre the sharp exit week).
- `snapshot` (`snapshots/usdn_collapse.json`): `totalSupply` = **81,445,200 USDN** @ block
  **14,776,687**, ts **2022-05-15T12:00:00Z**. `supply_samples` trace the run
  176.3M→150M→130M→120M→107.4M→81.4M.

## FIDELITY
- **Mechanism is off-chain (Waves).** The actual death-spiral driver — the WAVES collateral
  ratio, the mint-and-sell-WAVES defense loop — lives on the **Waves chain**, not Ethereum,
  and is NOT capturable via the Ethereum Alchemy archive (the Alchemy key is Ethereum-only).
  It is described here as fact but not asserted as an on-chain measurement.
- **Depeg is INJECTED via `peg_probes`.** Ethereum has no canonical USDN/USD oracle for this
  venue; the documented secondary-market price is supplied through `peg_probes` exactly as
  the harness contract expects (same pattern as the deUSD / USDC depeg labels).
- **Supply collapse is REAL on Ethereum.** The bridged-USDN `totalSupply` contraction
  (107.4M→81.4M) is a genuine archive read at the two cited blocks — the directly
  Ethereum-readable half of the event.

## Chosen depeg price (for the label)
**USDN = $0.79.** This is the documented intra-day exchange low cited by **CoinDesk
(2022-05-11)** for the May contagion window ("traded at 79 cents on KuCoin"), within the
same band as the April depeg low (~$0.78–$0.82). It is a defensible, *directly-cited*
documented value rather than an extrapolated trough — a **~21% break** from $1.00 on a
depeg-sensitive collateral venue.

## Expected monitor behavior (the label)
- **DEPEG** on edge `USDN-curve-pool` — a ~21% break of a $1 stable on a depeg-sensitive
  collateral/lending venue. Floor **HIGH** (well past USDC's ~13% SVB break that is already a
  page-now incident; collateral materially impaired, liquidations / haircuts in play).
- **SUPPLY_DELTA_ANOMALY** on `token:USDN` — the −24% one-week supply contraction
  (107.4M→81.4M). Floor **WARN**: the direction (a large sustained supply DROP / redemption
  exit) is unambiguous and on-chain, but a one-step delta alone cannot certify panic-vs-orderly
  wind-down, so WARN is the appropriate floor (the DEPEG is what makes the cluster page-now).
- `must_not_fire`: none asserted for this single incident case.

## Sources
- CoinDesk — "Crisis in Terra's UST Stablecoin Spreads to Neutrino USD on Waves Protocol"
  (2022-05-11): https://www.coindesk.com/markets/2022/05/11/crisis-in-terras-ust-stablecoin-spreads-to-neutrino-usd-on-waves-protocol
- CoinDesk — "Waves' USDN Stablecoin Loses Peg, Drops 15% Amid Manipulation Scare"
  (2022-04-04): https://www.coindesk.com/markets/2022/04/04/waves-usdn-stablecoin-loses-peg-drops-15-amid-manipulation-scare
- CoinDesk — "Undercollateralized USDN Stablecoin Needs Tweaking, Waves Founder Says"
  (2022-06-01): https://www.coindesk.com/layer2/2022/06/01/undercollateralized-usdn-stablecoin-needs-tweaking-waves-founder-says
- Cointelegraph — "Neutrino Dollar breaks peg, falls to $0.82 amid WAVES price 'manipulation' accusations":
  https://cointelegraph.com/news/neutrino-dollar-breaks-peg-falls-to-0-82-amid-waves-price-manipulation-accusations
- Crypto Briefing — "Waves Stablecoin Crash Sparks Death Spiral Fears":
  https://cryptobriefing.com/waves-stablecoin-crash-sparks-death-spiral-fears/
- Coinmonks / Medium (Alan Au) — "USDN de-peg events unpacked — Neutrino Protocol / Waves deep-dive":
  https://medium.com/coinmonks/a-blip-on-the-radar-or-inherently-fragile-stablecoin-usdn-de-peg-events-unpacked-and-deep-dive-9de6a172b19e
