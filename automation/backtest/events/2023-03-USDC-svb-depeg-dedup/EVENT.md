# USDC SVB depeg — DIRECTIONAL DEDUP / anti-spam test (2023-03-10/11, Ethereum)

## What this event tests

This is NOT a fresh detection test (the single-poll USDC depeg is already covered by
`2023-03-11-USDC-svb-depeg`). This event exercises the monitor's **DIRECTIONAL DEDUP /
anti-spam contract** across a multi-poll sequence run through ONE shared dedup engine:

- A DEPEG that **WORSENS** between polls (price drops further → higher severity/score)
  must **RE-EMIT** on the later poll — a fresh page, because the operator MUST be told the
  situation got worse.
- A DEPEG that **HOLDS STEADY** at a **WARN tier** across polls (price unchanged, same
  WARN severity) must be **DEDUP-SUPPRESSED** on the later poll — re-paging an unchanged,
  already-alerted WARN-tier condition within its (long) cooldown is spam.

> **The dedup cooldown is SEVERITY-TIERED.** A **CRITICAL** alert re-pages **frequently**:
> a critical, ongoing situation must keep alerting, and re-paging it is *not* spam. A
> **WARN/HIGH** alert is suppressed for a **much longer** re-page cooldown. That is why the
> anti-spam SUPPRESSION half of this test uses a steady **WARN-tier** depeg, not a CRITICAL
> one: a steady CRITICAL would correctly keep paging (continuous critical alerting), so
> asserting it is suppressed would be wrong. The steady WARN-tier alert is the one that must
> stay silent on the unchanged repeat.

The harness runs the `polls` sequence through one decision engine and grades the **LAST
poll's EMITTED signals**.

> **dedup-suppressed ≠ false negative.** In the steady case the alert ALREADY fired on the
> first poll. Suppressing the unchanged repeat on the second poll is CORRECT anti-spam, not
> a missed detection. The DEPEG is expected to sit in the *suppressed* bucket on the last
> poll, not the *emitted* bucket.

## The facts: USDC price path over the SVB weekend

USDC is the largest regulated, fiat-backed stablecoin in DeFi (~$42B supply / market cap in
Mar 2023). Circle disclosed that ~$3.3B of USDC's cash reserves were stranded at Silicon
Valley Bank, which the FDIC took into receivership on Friday, 2023-03-10 (the $42B SVB
deposit run). A backing-confidence shock, not a permanent insolvency:

| Time (approx, UTC) | USDC secondary price | What happened |
|---|---|---|
| Fri 2023-03-10, daytime | ~$1.00 | Pegged; SVB taken into FDIC receivership ~11:37am ET |
| Fri 2023-03-10, evening | **~$0.97** | First wobble after Circle's ~10pm ET disclosure that $3.3B reserves were stuck at SVB; redemptions spike |
| Sat 2023-03-11, early AM | **~$0.88 (low ~$0.87)** | Deepest depeg; weekend banking closure prevented redemption arbitrage; secondary price on Curve 3pool / Coinbase / Kraken hit ~$0.87–0.88 |
| Sun–Mon 2023-03-12/13 | recovery → ~$0.999 | US Treasury/Fed/FDIC joint backstop (Sun Mar-12) guaranteed all SVB deposits; peg restored within ~72h |

The intermediate ~$0.97 (Fri evening) and the ~$0.88 low (Sat AM) bracket a depeg that
**materially worsened** over the weekend — exactly the directional move under test. The
~$0.97 wobble is a WARN-tier soft depeg (above the market's 0.91 liquidation line); the
~$0.88 low is a CRITICAL-tier depeg (below the liquidation line).

## Why a worsening depeg must re-page, and a steady WARN one must not spam

- **Worsening ($0.97 → $0.88):** the impairment roughly quadrupled in absolute terms (3¢ →
  12¢ off peg) on a depeg-sensitive Morpho market (MARKET oracle, `depeg_sensitive=true`,
  isolated lending). At ~$0.88 the USDC collateral is ~12% impaired and is now well below the
  market's liquidation line (LLTV/LT 0.91 in the snapshot), so leveraged positions liquidate
  and impairment becomes realized loss. The operator who saw the $0.97 page MUST get a fresh,
  higher page when it deteriorates to $0.88 — otherwise they could believe it stabilized.
- **Steady WARN ($0.97 → $0.97):** the condition is unchanged between consecutive polls (same
  ~3%-off price, same WARN severity, same score) and sits above the liquidation line. It
  already paged. Because the dedup cooldown is severity-tiered and a WARN-tier alert has a
  **long** re-page cooldown, the unchanged second poll falls inside that cooldown and must be
  dedup-suppressed. Re-paging an identical WARN condition every poll is alert spam that trains
  operators to ignore the channel.
  - By contrast, a steady **CRITICAL** depeg ($0.88 → $0.88, below the LT line) would re-page
    **frequently** by design — continuous critical alerting is not spam — so it is deliberately
    NOT used as the suppression case.

## Cases (both multi-poll, both `closed: true`)

1. **`depeg-worsens-repages`** — polls: `[$0.97 @ 2023-03-10T22:00:00Z, $0.88 @
   2023-03-11T07:00:00Z]`. should_fire **DEPEG** on `USDC-morpho-collateral`, min_severity
   **HIGH**. The worsened $0.88 (~12% off peg on a depeg-sensitive isolated lending market)
   must RE-PAGE on the last poll because the depeg got materially worse. must_not_fire: [].
2. **`depeg-steady-deduped`** — polls: `[$0.97 @ 2023-03-10T22:00:00Z, $0.97 @
   2023-03-10T23:00:00Z]`. should_fire: []; must_not_fire: []; `max_emitted {WARN, 0}`. The
   depeg is an UNCHANGED **WARN-tier** ~3%-off soft depeg (above the 0.91 LT line) between
   polls, so the second (graded) poll must be DEDUP-SUPPRESSED within the long WARN re-page
   cooldown: no fresh DEPEG in the emitted bucket. The WARN/0 ceiling asserts no new page; the
   DEPEG is correctly in the suppressed bucket (it already fired on poll 1). This pins the
   anti-spam suppression of an unchanged LOWER-severity alert specifically — a steady CRITICAL
   would re-page frequently by design and is not the case under test here.

## Fidelity

- **Prices: MEASURED on-chain, injected per-poll via `peg_probes`.** Each poll's depeg price
  is READ on-chain from the Curve 3pool (DAI/USDC/USDT,
  `0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7`) via `get_dy(USDC->USDT, dx=1e6)` at that poll's
  block (USDT is the dollar-holding sibling reference; DAI itself depegged that weekend). All 4
  poll prices are measured=True in `snapshots/fidelity.json` (measured_pct=100). They are fed
  into the engine per poll via `peg_probes["USDC-morpho-collateral"] = {price, peg:1.0,
  asset_class:"stable", source:"onchain:curve ..."}`.
- **RE-ANCHOR (2026-06-07): the on-chain 3pool dislocation LAGGED the CEX evening print by ~4h.**
  At the originally-labelled poll-1 timestamp `2023-03-10T22:00:00Z` the 3pool was still
  essentially PEGGED (USDC/USDT=0.9978, ~0.2% off) — NOT the documented ~$0.97 CEX wobble. Hourly
  on-chain scan: 0.9997@20:00Z, 0.9978@22:00Z, 0.9950@23:00Z, 0.9921@00:00Z, 0.9898@01:00Z,
  **0.9748@02:00Z**, 0.9785@03:00Z, 0.9399@04:00Z, 0.9309@06:00Z, **0.8784@07:00Z**, 0.8751@08:00Z,
  recover 0.9283@09:00Z. The genuine WARN-tier ~$0.97 soft depeg first appears on-chain in the
  Mar-11 02:00-03:15Z plateau; the ~$0.88 deep low at 07:00-08:00Z. The poll anchors were MOVED
  into those windows so each labelled tier is true at the MEASURED value:
  - `depeg-worsens-repages`: poll1 -> block **16801739** (02:00Z = 0.974823, WARN, above 0.91 LT);
    poll2 -> block **16803216** (07:00Z = 0.878356, deep, below LT) [poll2 was already faithful].
  - `depeg-steady-deduped`: poll1 -> block **16801885** (02:30Z = 0.980799); poll2 -> block
    **16802034** (03:00Z = 0.978479) — a genuinely STEADY same-tier non-worsening WARN pair
    (~0.23% apart, both ~2% off, both above the 0.91 LT line).
  `should_fire`/`must_not_fire`/`severity`/`max_emitted`/`beta` are UNCHANGED — only the anchor
  blocks + `now` moved and prices became measured.
- **Snapshot graph: representative, host-fed.** `snapshots/usdc.json` anchors USDC's real
  address (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, 6 decimals, ~$42B) and exposes ONE
  isolated Morpho lending edge `USDC-morpho-collateral` (MARKET oracle, `depeg_sensitive=true`,
  LLTV/LT 0.91). The exact $50M market size is representative, not a specific on-chain market.
- **Why this faithfully tests dedup:** the snapshot is held CONSTANT across all polls; only
  the injected `price` (and `now`) change. So any difference in the LAST poll's emitted set is
  attributable purely to the dedup engine's directional + severity-tiered logic, not to graph
  changes.
- **The dedup behavior itself is the contract under test** — labeled from how a correct
  anti-spam monitor MUST behave (re-page on worsening; suppress on a steady WARN within its
  long cooldown; keep re-paging a steady CRITICAL), per the firewall: no detector code was read.

## Sources

- CNN Business — Stablecoin USDC breaks dollar peg after revealing $3.3B SVB exposure
  (drop from ~$1.00 Fri 11pm to $0.88 by 7:30am Sat; $3.3B reserves at SVB):
  https://www.cnn.com/2023/03/11/business/stablecoin-circle-silicon-valley-bank
- CNBC — Stablecoin USDC breaks dollar peg after firm reveals $3.3B SVB exposure:
  https://www.cnbc.com/2023/03/11/stablecoin-usdc-breaks-dollar-peg-after-firm-reveals-it-has-3point3-billion-in-svb-exposure.html
- BeInCrypto — USDC Depegs Below $0.90, Circle Confirms Exposure to SVB (low ~$0.87 on
  Coinbase/Curve): https://beincrypto.com/usdc-market-cap-6b-circle-exposure-silicon-valley-bank/
- Federal Reserve FEDS Notes — In the Shadow of Bank Runs (hourly USDC issuance/redemption
  Mar 9–14; redemptions constrained to US banking hours → weekend depeg deepest):
  https://www.federalreserve.gov/econres/notes/feds-notes/in-the-shadow-of-bank-run-lessons-from-the-silicon-valley-bank-failure-and-its-impact-on-stablecoins-20251217.html
- S&P Global — Stablecoins: A Deep Dive into Valuation and Depegging (Sep 2023):
  https://www.spglobal.com/content/dam/spglobal/corporate/en/images/general/special-editorial/stablecoinsadeepdiveintovaluationanddepegging.pdf
- US Joint Statement (Treasury/Fed/FDIC), 2023-03-12 — backstop guaranteeing SVB deposits.
