# EVENT: controls-benign-baselines (NEGATIVE CONTROLS)

**This is NOT an incident.** It is a CONTROL GROUP of "normal-time" cases — the negative
controls that prove the exposure-risk monitor stays SILENT when nothing is actually wrong.
An alert engine tuned only on disasters (depegs, drains, oracle breaks) tends to over-fire;
these cases lock in the silence by encoding how PT / RWA / stablecoin / LST assets normally
behave. Each `must_not_fire` is defensible purely from real-world asset mechanics, not from
how any detector currently happens to behave.

The principle under test: **a price that is far from a naive $1.00 peg is not, by itself,
evidence of a depeg.** Many sound assets trade well below par by construction. The monitor
must distinguish a *structural* discount from a *stress* discount.

---

## Case 1 — `CTRL-ptUSDe-morpho_blue-collateral_isolated` — by-design discounted PT (MOST IMPORTANT)

**Asset:** A Pendle Principal Token (PT-USDe / PT-sUSDe style), used as isolated collateral
on a Morpho Blue market.

**Observed:** price ≈ **0.86** vs a naive $1.00 peg (a ~14% discount). Normal-time, no stress.

**Why this MUST stay silent (DEPEG):**
- A Pendle PT is the *principal* leg of a yield-bearing asset after the yield has been
  stripped off (the YT). A PT is effectively a zero-coupon claim that pays exactly $1.00 of
  the underlying **only at maturity**. Before maturity it trades at a discount equal to the
  present value of that future $1.00 — i.e. `price ≈ 1 / (1 + implied_yield)^t`.
- At realistic stablecoin-yield levels and a multi-month tenor, a PT *should* sit ~10–15%
  below $1.00. A price of 0.86 is the EXPECTED, healthy mark — it is the discount *converging
  upward toward par* as time passes, the opposite of a depeg (which is price collapsing away
  from par).
- The lending venue knows this: PT isolated markets set their Liquidation Threshold (LT)
  **on the discounted PT price / a PT-aware oracle**, not on $1.00. LT here is ~0.86–0.915,
  i.e. the protocol has already priced in the structural discount. The collateral is not
  under-water; borrowers are not near liquidation merely because PT < $1.
- Therefore a -14% reading against $1.00 is a measurement artifact of the wrong reference,
  not a loss event. Firing DEPEG here would be a textbook false positive.
- Probe flag `by_design_discount: true` exists precisely to tell the monitor "compare against
  NAV/accretion curve, not par." This case asserts that flag is honored and the market is quiet.

**Borderline note:** A *true* PT depeg does exist (e.g. the underlying USDe itself loses
backing, or the PT trades materially *below* its accretion curve / fair discount). That is a
DIFFERENT condition — a deviation from the by-design curve, not from $1.00. This control only
asserts silence for a PT sitting at its NORMAL structural discount; it does not grant blanket
immunity to PT markets.

---

## Case 2 — `CTRL-USDC-aave_v3-collateral` — healthy major stablecoin, normal operations

**Asset:** USDC supplied/collateral on Aave V3 (mono-pool).

**Observed:** price ≈ **0.999**, peg 1.0; normal utilization (~70%). Normal-time.

**Why this MUST stay silent (any WARN-or-above):**
- A fiat-backed major stablecoin oscillating within ~±0.1–0.2% of $1.00 is its *normal*
  trading band — DEX micro-spreads, rounding, and routing noise routinely put the mark at
  0.998–1.002. 0.999 is dead-center healthy.
- ~70% utilization on a deep blue-chip money market is ordinary working capital, not a
  liquidity squeeze (withdrawals are fully serviceable; rates are at normal kink levels).
- This case asserts the **noise ceiling**: no DEPEG, and more strongly `max_emitted` caps the
  whole snapshot at *zero* WARN+ signals. INFO-level housekeeping (new-market, coverage) is
  fine; anything WARN or above on a healthy stable at 0.999 is over-firing.

---

## Case 3 — `CTRL-wstETH-morpho_blue-collateral_isolated` — healthy LST within tolerance

**Asset:** wstETH (Lido wrapped stETH) as isolated collateral on Morpho Blue.

**Observed:** price ≈ **0.995** against its ETH reference (a 0.5% secondary-market discount).
Normal-time.

**Why this MUST stay silent (DEPEG):**
- An LST like stETH/wstETH is redeemable for ETH via Lido's withdrawal queue, but the
  *secondary-market* price floats: small discounts of ~10–60 bps are the steady-state norm,
  driven by exit-queue length, staking-yield arb, and DEX depth. 0.995 (−0.5%) is squarely
  inside routine LST tolerance and has been seen for long benign stretches.
- A genuine stETH depeg event (e.g. 3AC/Celsius forced unwind, 2022) drove the discount to
  ~0.93–0.95 with collapsing depth — an order of magnitude beyond this. −0.5% is not that.
- LST markets are *expected* to trade slightly under reference; LT/LLTV on these markets is
  set with that buffer in mind. A 50 bps discount is well above any liquidation pressure.
- Firing DEPEG at 0.995 would make every normal LST week a false alarm. Silence is correct.

**Borderline note:** This is the one case nearest a threshold. If the engine carries an LST
band (e.g. fire only beyond ~2–3% discount), 0.995 is comfortably benign. I keep DEPEG in
`must_not_fire` because −0.5% on an LST is unambiguously normal behavior, not a depeg.

---

## Case 4 — `CTRL-USDT-aave_v3-collateral` — genuinely fine but heavily used (high-but-normal utilization)

**Asset:** USDT on Aave V3, fully at peg but with elevated utilization.

**Observed:** price ≈ **1.000**; utilization ≈ **85%** (high but below the protocol's
optimal/kink ceiling). Normal-time.

**Why this MUST stay silent (DEPEG + any spurious liquidity/util alert):**
- High utilization on a blue-chip stable is *demand*, not distress. ~85% sits in the healthy
  pre-kink/at-kink zone where borrow rates rise to attract supply — the market's designed
  self-correcting mechanism. There is still available liquidity; lenders can withdraw.
- A liquidity/utilization alert should fire on *pathological* utilization (≈98–100%,
  withdrawals failing, rates pinned) or a sudden spike, not on a stable simply being
  popular. 85% steady-state is not an exposure event.
- Price is exactly at peg, so DEPEG is trivially silent too.

**Borderline note:** Utilization this high *could* warrant a low INFO ("market running hot")
without being a risk event. That is acceptable. What must NOT happen is a WARN+ liquidity or
depeg alert on an asset that is simply well-utilized at par. I keep only DEPEG in
`must_not_fire` (par price → no depeg) and document that any util signal must remain INFO.

---

## Summary of the silence being locked in

| Case | Asset class | Mark | Reference truth | Must stay silent because |
|------|-------------|------|-----------------|--------------------------|
| 1 | Pendle PT (by-design) | 0.86 | accretes to 1.0 at maturity; LT set on discount | structural discount ≠ depeg |
| 2 | USDC stablecoin | 0.999 | ±0.1% is normal band | inside noise floor; cap WARN+ at 0 |
| 3 | wstETH LST | 0.995 | 10–60 bps discount is steady state | within LST tolerance |
| 4 | USDT stablecoin | 1.000 @ 85% util | high util = demand, not distress | popular ≠ stressed |
