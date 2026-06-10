# Ampleforth (AMPL) by-design REBASE — FP-discipline control + adversarial unauthorized-mint recall (July 2020)

- **Token:** Ampleforth (AMPL) — `0xD46bA6D942050d489DBd938a2C909A5d5039A161`, Ethereum mainnet, **9 decimals**.
- **Type:** **Rebasing / elastic-supply token.** `totalSupply` is mutated **daily** by a global scalar (a "rebase") to push the market price toward AMPL's target (~1 inflation-adjusted 2019 USD). Snapshots carry the host-fed flag **`rebasing: true`**.
- **Date framed:** July 2020 (AMPL's largest expansionary cycle to date).

## What actually happened (the FACTS)

### AMPL's rebase is a designed supply mechanism, not a mint/burn incident
AMPL applies a rebase **once every 24 hours (at ~02:00 UTC)**. The protocol transfers volatility from price to **supply**: when AMPL trades **above** target it **expands** supply, when **below** it **contracts** supply. The adjustment is applied **universally and proportionally across every wallet's balance** — it is **non-dilutive**: a holder of 1% of supply still holds 1% after the rebase. Crucially, a rebase is **NOT** a `Transfer`/mint to any specific address and produces **no `mint_event`**; it is a scalar restatement of every balance at once. The protocol is **stateless** (no memory of yesterday's supply), so it recomputes the supply delta each day from the latest price.

### July 2020: a sustained positive-rebase run
During roughly late June → late July 2020, AMPL had a strong price run that sat **above target for almost a month straight**, producing **daily positive rebases** (supply expansion). Ampleforth's market cap rose from ~$13.5M (Jun 29, 2020) to **>$700M (Jul 27, 2020)**. On the strongest days the **per-day supply expansion exceeded +10%** — large supply swings of **±5–15%/day (occasionally more)** are AMPL's **NORMAL designed behavior**, not an anomaly.

**Why this is the FP this control guards.** A naive aggregate supply-change monitor (TOTAL_SUPPLY_SPIKE / SUPPLY_DELTA_ANOMALY) that simply diffs `totalSupply` day-over-day would **FALSE-ALARM on every single rebase** during the July 2020 run — a fresh CRITICAL/HIGH supply-spike alert daily, for a month, all of them false. The whole point of the host-fed `rebasing: true` flag is to tell the monitor that for this token, supply elasticity is **by-design** and aggregate supply-delta signals must be **suppressed**.

### Adversarial twist: a rebasing token can STILL be exploited by a real mint
"By-design supply elasticity" does **NOT** mean "any supply increase is fine." A rebase touches **all balances proportionally and emits no mint to a single address**. A genuine **unauthorized mint** — a single `Transfer` from `0x0` to one (attacker) address, for a large %-of-supply, **beyond** the rebase scalar — is a **real exploit** and must STILL fire. The `rebasing` flag must suppress only the **aggregate supply-delta** family; it must **NOT** blind the **single-transaction mint** check (LARGE_SINGLE_MINT / UNMATCHED_MINT). An attacker who knows the token is rebasing might *expect* a supply monitor to be silenced — that is exactly why the single-tx mint path must remain live.

## The two snapshots / cases

### CONTROL — `ampl-by-design-rebase-quiet`
- prev `snapshots/ampl_prev.json` (~100.0M supply, `rebasing: true`, `mint_events: []`)
- snapshot `snapshots/ampl_rebase.json` (~111.0M supply = **+11% positive rebase in one day**, `rebasing: true`, `mint_events: []`)
- now `2020-07-15T00:00:00Z`
- **EXPECT: total silence.** A +11% day-over-day supply increase is a **by-design positive rebase**, exactly the kind of move AMPL made repeatedly in July 2020. There is **no `mint_event`** (a rebase mints nothing to anyone). TOTAL_SUPPLY_SPIKE and SUPPLY_DELTA_ANOMALY on `token:AMPL` **must NOT fire**. Noise ceiling: `max_emitted {WARN, 0}` (INFO housekeeping tolerable; nothing WARN-or-above).

### INCIDENT — `ampl-rebasing-unauthorized-mint`
- prev `snapshots/ampl_rebase.json` (~111.0M)
- snapshot `snapshots/ampl_unauth_mint.json` (~120.0M; contains a **single `mint_event` of 20.0M AMPL to `0xattacker`**, `tx 0xevil`, NOT an authorized minter — `authorized_minters: ["0xampl_policy"]`)
- now `2020-07-16T00:00:00Z`
- **EXPECT: LARGE_SINGLE_MINT on `token:AMPL`, min_severity HIGH.** The 20.0M AMPL single-tx mint to a non-authorized address is **16.7% of the ~120M supply** (20M / 120M), delivered to one attacker in one transaction — this is **beyond** the rebase scalar (the rebase is the proportional 111M→ baseline, the mint is a discrete extra to a single address). A rebasing token is **not immune** to a real mint; the `rebasing` flag must not blind this check. Floor **HIGH** (not CRITICAL): a single unauthorized ~16.7%-of-supply mint is a near-certain real incident and urgent, but it is a single signal short of the near-total-supply / multi-signal-corroborated catastrophe reserved for CRITICAL. HIGH admits HIGH-or-CRITICAL as a pass.
- **UNMATCHED_MINT may also fire** (the mint is not matched by an equal burn and is not from an authorized issuer). Listed as `should_fire` WARN — judged faithful: an unauthorized, unreconciled single mint is by definition unmatched. (If the engine treats it differently, it can be moved to triage; it is not the load-bearing expectation.)
- `must_not_fire: []` — nothing benign needs to be silenced in this case; the rebase-vs-mint distinction is carried by the CONTROL case.

## FIDELITY

- The **+11% positive rebase** in `ampl_rebase.json` is **representative** of AMPL's July-2020 positive rebases — supply expanded daily, frequently by double-digit percent, during the late-June→late-July run that drove mkt cap from ~$13.5M to >$700M. The exact +11% figure is a faithful **stand-in** for "a large by-design positive rebase," not a claim about one specific calendar day's scalar.
- The **`rebasing: true` flag is host-fed** (the monitor host classifies AMPL as a rebasing/elastic-supply token; it is not inferred on-chain by the engine). This is a deliberate snapshot/classification input, mirroring how the production host tags known elastic-supply tokens.
- The **20.0M unauthorized mint** in `ampl_unauth_mint.json` is a **synthetic adversarial construct** (no such mint historically occurred on AMPL). Its purpose is to prove the `rebasing` suppression does not over-reach into the single-tx mint path. The `to: 0xattacker`, `tx_hash: 0xevil`, and `authorized_minters: ["0xampl_policy"]` values are placeholder identifiers, not real addresses.
- Supply values are in 9-decimal base units: prev `100000000000000000` = 100.0M, rebase `111000000000000000` = 111.0M, unauth-mint `120000000000000000` = 120.0M, mint amount `20000000000000000` = 20.0M AMPL.

## Sources
- Collab+Currency / Stephen McKeon, "The Rise and Fall (and Rise and Fall) of Ampleforth — Part I" (mkt cap ~$13.5M Jun 29 → >$700M Jul 27 2020; ~a month of daily positive rebases): https://medium.com/collab-currency/the-rise-and-fall-and-rise-and-fall-of-ampleforth-part-i-cda716dea663
- Finematics, "How does Ampleforth work? AMPL Explained" (daily rebase, expand >5% above target, proportional across wallets): https://finematics.com/ampleforth-explained/
- Gemini Cryptopedia, "Ampleforth Protocol (AMPL)" (elastic supply, target ~1 inflation-adjusted 2019 USD): https://www.gemini.com/cryptopedia/ampleforth-protocol-ampl-coin-stablecoin
- Chainlink case study, "Decentralizing Ampleforth's Rebasing Mechanism" (24h rebase at ~02:00 UTC, stateless): https://chain.link/case-studies/ampleforth
- Coin Tools, AMPL Rebase History (per-day rebase % record): https://www.coin-tools.com/ampl/ampl-rebase-history/
