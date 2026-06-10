# 2025-10-11 — USDe (Ethena) Binance $0.65 wick (OFF-CHAIN single-venue, must stay quiet)

## Type
NEGATIVE CONTROL (`closed: true`). Pure FALSE-POSITIVE discipline. A scary headline
("USDe depegged to $0.65!") where the ON-CHAIN state stayed healthy. The ~$0.62-0.65
print existed ONLY on Binance's internal order book; on-chain / on Curve the peg HELD at
~$0.99-1.00. The monitor ingests the ON-CHAIN price, so it MUST STAY QUIET (no distress
DEPEG). This control guards against ingesting a CEX wick / off-chain single-venue noise as
a real depeg.

## What actually happened (facts, no engine knowledge)
On ~2025-10-10/11, a Trump 100%-China-tariff announcement triggered a market-wide
liquidation cascade — roughly **$19B liquidated across markets** in ~24h. During the chaos:

- USDe (Ethena's delta-neutral synthetic dollar, `0x4c9EDD5852cd905f086C759E8383e09bff1E68B3`,
  18 decimals, Ethereum mainnet) briefly printed as low as **~$0.62-0.65 ON BINANCE ONLY**.
- **The cause was Binance-local, not a USDe failure.** Binance had **no primary-dealer
  relationship** with Ethena (unlike Bybit and others), so market-makers on Binance could not
  directly mint/redeem USDe through Ethena to arbitrage the price back. Worse, **Binance's
  internal pricing oracle referenced only its own (thin, stressed) order book**, not external
  venues like Curve. As its own book dropped, its oracle marked those lows as "real,"
  triggering **~$1B of forced liquidations** inside Binance's unified-collateral system — a
  self-reinforcing local loop entirely contained to that one venue.

### The ON-CHAIN truth (the load-bearing claim)
- **On Curve / on-chain the peg HELD.** CoinDesk: "Price deviations on Curve were **less than
  100 basis points**" — i.e. USDe stayed within ~$0.99-1.00 on-chain, oscillating minimally
  around ~$0.99 in deep AMM pools. The documented on-chain mark is **~$0.997** (well inside
  the stable band), NOT $0.65.
- **Primary-dealer mint/redeem kept working.** Redemptions functioned without interruption:
  Ethena processed **>$2B of withdrawals over 24h**, and founder Guy Young noted supply could
  redeem cleanly "without any basis positions needing to be unwound" — evidence of a resilient
  redemption mechanism, not a run on broken collateral.
- **Overcollateralization stayed intact.** Throughout the ordeal USDe remained
  **overcollateralized (~$66M surplus)**, confirmed by independent attestors **Chaos Labs,
  Chainlink, Llama Risk, and Harris & Trotter**. No insolvency, no unbacked supply.
- **The supply drawdown was CLEAN, not a collapse.** Circulating USDe contracted from a peak
  **above ~$14.6B to ~$5.9-6B** over the surrounding weeks as holders redeemed at par through
  the working primary-dealer channel. This is an orderly, fully-honored redemption drawdown —
  the SYSTEM WORKING — not a depeg or a fire-sale.

So the only artifact resembling a "depeg" was an **off-chain, single-venue (Binance) oracle
wick** driven by that venue's own thin book and missing dealer plumbing. An exposure monitor
that ingests the **on-chain** price (~$0.997, within band) correctly sees no depeg; the $0.65
is off-chain and is correctly NOT ingested as the `peg_probe`.

## Fidelity note (what the monitor actually ingests)
- The **load-bearing fact** is that the ON-CHAIN price held ~$0.997 (documented Curve
  deviation < 100 bps). That is the value injected as the `peg_probe` for the lending edge.
- The **$0.65 Binance wick is deliberately EXCLUDED** — it is an off-chain, single-CEX print
  from a venue with no primary-dealer plumbing and a self-referential oracle. Ingesting it
  would be the exact contamination this control guards against. The snapshot models the
  edge's oracle as `oracle_type: MARKET`, `depeg_sensitive: true`, so the DEPEG path IS live
  on this edge — the control is NON-vacuous: it fires if (and only if) a bad off-chain price
  leaks in. At the true on-chain ~$0.997 it must stay silent.

## Snapshot (`snapshots/usde.json`)
- Token node `token:USDe` — `0x4c9EDD5852cd905f086C759E8383e09bff1E68B3`, 18 decimals,
  representative `market_cap_usd` for the event window (~$6B post-drawdown circulating).
- One lending collateral edge `USDe-aave_v3-collateral` on protocol `aave_v3`
  (architecture `mono_pool`): `oracle.depeg_sensitive=true`, `oracle.oracle_type="MARKET"`,
  `lending_risk.lt ~0.90`. The on-chain price (~$0.997) is injected per-case via `peg_probes`.
- This is a representative/labeled exposure snapshot, not an archive point-in-time read; the
  Alchemy key is Ethereum-only and the load-bearing facts here are the off-chain-vs-on-chain
  price split and the attested collateralization, which are documentary, not a single block read.

## Label intent (faithful to facts, NOT to engine behavior)
- `must_not_fire`: a DEPEG on the USDe lending edge. The price the monitor ingests is the
  on-chain ~$0.997 (within band); the off-chain $0.65 is not ingested.
- Noise ceiling: no WARN-or-above signal on the snapshot (`max_emitted` WARN count 0). A low
  INFO housekeeping note is tolerable; any WARN/HIGH/CRITICAL page here would be the exact
  off-chain-noise FP this control exists to prevent.

## Sources
- CoinDesk, "No, Ethena's USDe Didn't De-peg During Friday's Crash" (2025-10-13) —
  https://www.coindesk.com/markets/2025/10/13/no-ethena-s-usde-didn-t-de-peg
  (Curve deviation < 100 bps; >$2B redeemed in 24h; overcollateralized ~$66M; attestors
  Chaos Labs / Chainlink / Llama Risk / Harris & Trotter; supply $9B→$6B redeemed cleanly).
- CoinDesk, "Ethena's USDe Briefly Loses Peg During $19B Crypto Liquidation Cascade"
  (2025-10-11) — https://www.coindesk.com/markets/2025/10/11/ethena-s-usde-briefly-loses-peg-during-usd19b-crypto-liquidation-cascade
- CCN, "Did USDe Really Depeg? Inside Ethena's $0.65 Binance Crash" —
  https://www.ccn.com/education/crypto/ethena-usde-depeg-binance-crash-explained/
  (Binance had no primary-dealer relationship; oracle referenced only its own order book).
- BeInCrypto, "Ethena USDe 'Depeg', What Really Happened?" —
  https://beincrypto.com/binance-usde-ethena-depeg/
- Medium (Cynthia Cheng), "Ethena's USDe Fell to $0.65 Despite 110% Collateral. Here's Why." —
  https://medium.com/@pycheng9/ethenas-usde-fell-to-0-65-despite-110-collateral-here-s-why-2ca974ac4a2a
- Etherscan: USDe `0x4c9EDD5852cd905f086C759E8383e09bff1E68B3` (18 decimals).
