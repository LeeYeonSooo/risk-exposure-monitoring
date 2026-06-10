# Resupply Protocol — reUSD ERC4626-donation oracle manipulation (2025-06-26, Ethereum)

## What factually happened

On **2025-06-26** (attack tx ~01:53 UTC), the Resupply lending protocol lost **~$9.56M**
(borrowed ~**10,000,000 reUSD** against just **1 wei** of collateral). reUSD is Resupply's
native stablecoin (`0x57aB1E0003F623289CD798B1824Be09a793e4Bec`).

The vulnerable market (`0x6e90…`, a CurveLend `wstUSR`-class pair) had gone live only ~1.5h
earlier. Its price oracle was a freshly-deployed, **empty ERC4626 wrapper** (`cvcrvUSD`,
vault `0x0114…`). The attack was a classic ERC4626 **first-deposit / donation** share-price
manipulation:

1. Flash-loaned ~4,000 USDC from Morpho, swapped to ~3,999 crvUSD.
2. **Donated 2,000 crvUSD** directly into the empty cvcrvUSD ERC4626 wrapper (the oracle),
   then deposited ~2 crvUSD to **mint 1 share** (1 wei cvcrvUSD).
3. With `totalSupply = 1 wei` and `totalAssets ≈ 2,000e18`, the wrapper's reported
   **share price overflowed/inflated past 1e36** (≈ `2 * 10^36`).
4. Resupply computes the lending exchange rate as `exchangeRate = 1e36 / oracle.getPrices()`.
   With the price inflated past 1e36, **integer (floor) division rounded the exchange rate to
   ZERO**.
5. `_exchangeRate = 0` ⇒ computed **`_ltv = 0`** ⇒ the `_isSolvent` health check trivially
   passed for ANY borrow ⇒ effectively **infinite borrowing power**.
6. The attacker borrowed **~10M reUSD** against **1 wei** of cvcrvUSD collateral, swapped and
   redistributed the proceeds. Net profit **~$9.56M**.

### Timeline
- ~01:53 UTC — exploit transaction executed.
- 02:26 UTC — BlockSec Phalcon issued a public warning (had detected the suspicious tx the day
  prior and was unable to reach the team).
- 02:53:23 UTC — Resupply team paused the protocol.

## Why this is the ORACLE_FREEZE / dead-feed recall path (NOT spot-manipulation)

This is a **distinct oracle-failure mode** from UwU's sUSDe spot-price manipulation. UwU's
oracle returned a *wrong-but-nonzero* manipulated price (caught by cross-reference deviation).
Here the oracle/exchange-rate **READ returns a DEAD / garbage ZERO value** — the canonical
"empty-ERC4626-donation share-price overflow → exchange-rate floor-divides to 0" failure.

A price/exchange-rate oracle answering **≤ 0** is, by definition, a dead/crashed/manipulated
feed: it zeroes every downstream health/LTV/liquidation check on a live lending market, which
is catastrophic regardless of cause. The monitor's **"answer ≤ 0 = dead/crashed feed →
ORACLE_FREEZE (CRITICAL)"** check is exactly this failure mode, and it is a separate recall
path from the cross-reference-deviation check (a 0 answer vs a 1.0 honest reference is also a
~100% deviation, but the ≤0 dead-read rule is the primary, unambiguous trigger).

## Fidelity of the backtest snapshot

- **On-chain anchor**: snapshot `snapshots/reUSD.json` pins token + market identity at block
  **22785000** (2025-06-26): reUSD token `0x57aB1E0003F623289CD798B1824Be09a793e4Bec`,
  Resupply protocol (`architecture: isolated_markets`), and edge
  `reUSD-resupply-wstUSR_market` whose oracle is the cvcrvUSD ERC4626 share-price wrapper
  (`oracle_address 0x0114b1c4f5e0e0e0e0e0e0e0e0e0e0e0e0e0e001`, `depeg_sensitive: true`,
  market `loan_asset reUSD` / `collateral_asset wstUSR` / `lltv 0.97`).
- **The attack mechanism is the oracle read**, not a balance-sheet change, so the decisive
  signal — the exchange-rate read collapsing to **0** — is **injected per-case via
  `oracle_probes`** (host-fed contract), exactly as the LUNA oracle-freeze event injects the
  frozen answer. The INCIDENT case sets `answer: 0.0` (the documented zeroed exchange-rate
  read) against an honest `reference_answer: 1.0`; the CONTROL sets a healthy `answer: 1.0`.
- `now: 2025-06-26T02:00:00Z` sits inside the live-exploit window (after the 01:53 tx, before
  the 02:26 BlockSec public warning and 02:53 pause) — the moment a monitor SHOULD have paged.

## should_fire (summary)

- **INCIDENT** `reusd-erc4626-oracle-zeroed` (now 2025-06-26T02:00:00Z, `answer 0.0` /
  `reference_answer 1.0`, stable): **ORACLE_FREEZE** on `reUSD-resupply-wstUSR_market`,
  min_severity **CRITICAL**. A dead/zeroed price oracle on a live lending market disables
  liquidations and health checks — the exact condition that let the attacker mint borrowing
  power from nothing.
- **CONTROL** `reusd-healthy-oracle` (now 2025-06-25T12:00:00Z, `answer 1.0` /
  `reference_answer 1.0`, stable, fresh): nothing fires; **ORACLE_FREEZE must stay silent**;
  `max_emitted {WARN, 0}`. A healthy, fresh, correct exchange-rate read must not alarm — guards
  against a hair-trigger that pages on every normal oracle read.

## Sources
- BlockSec — In-depth Analysis and Reflections on the Resupply Protocol Attack Incident:
  https://blocksecteam.medium.com/blocksec-in-depth-analysis-and-reflections-on-the-resupply-protocol-attack-incident-932be23e1433
- SolidityScan (X) — donation attack, exchangeRate=0, 1 wei → $10M reUSD, ~$9.56M:
  https://x.com/SolidityScan/status/1938515716384403635
- crypto.news — Resupply protocol exploited for $9.5M via price manipulation:
  https://crypto.news/resupply-protocol-exploited-price-manipulation-2025/
- Ackee Blockchain — ResupplyFi Hack Analysis: https://ackee.xyz/blog/resupply-hack-analysis/
- QuillAudits — Resupply Hack: How a donation attack led to $9.5m in Losses:
  https://www.quillaudits.com/blog/hack-analysis/resupply-hack-analysis
- Rekt — ResupplyFi: https://rekt.news/resupplyfi-rekt
- The Block — Attacker drains over $9M from Resupply stablecoin protocol:
  https://www.theblock.co/post/359764/resupply-exploited-blocksec
