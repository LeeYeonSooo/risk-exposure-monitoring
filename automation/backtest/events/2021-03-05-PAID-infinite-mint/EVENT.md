# 2021-03-05 PAID Network infinite-mint exploit (PAID V1, Ethereum mainnet)

**Class:** Unauthorized large-mint exploit executed as a **burn-then-remint** (compromised owner
key → burn existing supply → re-mint the identical amount to the attacker). This event is the
engine's mint-side recall test, and — crucially — a test of EVASION: the attacker structured the
attack so that **net total supply is flat** and the **mint is matched by an equal burn**, so the
only thing that factually sees the attack is a **single-transaction %-of-supply mint** check.

**One-line:** An attacker controlling PAID's owner/minter key burned **59,471,745.571 PAID** to
zero, then **110 seconds later** minted the **identical 59,471,745.571 PAID** (exactly **10.00% of
supply**) from `0x0` to a **non-authorized** wallet and dumped it on Uniswap. The off-chain price
crashed **~ -85%** (≈$2.86 → ≈$0.32) over 24h. PAID is a **utility token with NO peg** — this is a
supply-inflation market crash, not a depeg.

## Token (the REAL exploited contract)
- **Token:** PAID Network (PAID), ERC-20, **18 decimals**.
- **Exploited contract (V1):** `0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df` (Ethereum mainnet).
  - IMPORTANT: the current `0x1614f18fc94f47967a3fbe5ffcd46d4e7da3d787` is the **POST-HACK V2
    relaunch token** that did NOT exist in March 2021. The address used in the earlier draft was
    therefore the wrong contract. The faithfully-captured, point-in-time exploited token is **V1
    `0x8c86…8df`**. All on-chain reads below are from V1 at the March-2021 blocks.
- **Home chain:** ethereum (chain_id 1). No relevant remote/bridge wrapper at the time.
- **Authorized owner/minter (legit):** `0x53bc21d38281d6acdfe0b92e0b534a19c90344cc`
  (read from `owner()`).
- **Exploiter / mint recipient (NOT authorized):** `0x18738290af1aaf96f0acfa945c9c31ab21cd65be`.

## Timeline (2021-03-05, UTC) — all on-chain, from Alchemy archive
- **18:01:19Z** (block **11979832**, tx `0x3a483dd881…334b9b`) — **BURN**: 59,471,745.571 PAID
  sent `0xd500aa2cffb70f460f4da6afa038ce35bed029bc` → `0x0`. totalSupply
  594,717,455.710 → **535,245,710.139**.
- **18:03:09Z** (block **11979840**, tx `0x4bb10927…77555a0`) — **MINT**: the **identical**
  59,471,745.571 PAID `0x0` → exploiter `0x18738290…cd65be`. totalSupply
  535,245,710.139 → **594,717,455.710** (back to the pre-burn level).
- The burn and mint are **110 seconds apart**.
- ~18:07+ UTC — attacker swaps the minted PAID on Uniswap; price collapses ~ -85% / 24h.
- Snapshot/now is taken **2021-03-05T19:00:00Z** (~1h later), past any short-window settle.

## Mechanism
1. The attacker controlled PAID's owner/minter key. Rather than mint outright (which would inflate
   the headline supply and trip a net-supply monitor), they **first burned** 59,471,745.571 PAID
   from `0xd500aa2c…` to `0x0`.
2. **110 seconds later** they **re-minted the EXACT same 59,471,745.571 PAID** from `0x0` to their
   own non-authorized wallet.
3. Net effect across the window: totalSupply returns to **594,717,455.710** — **ZERO net change**.
   The mint is an ERC-20 Transfer **from `0x0`** to a recipient that is **not** the authorized
   owner/minter, sized at **exactly 10.00% of supply (1000 bps)**.

## Magnitudes (on-chain)
- **Burn:** 59,471,745.571 PAID (`59471745571000000000000000` base units, 18 dp).
- **Mint:** 59,471,745.571 PAID (identical) to non-authorized `0x18738290…cd65be`.
- **Mint as % of supply:** 59,471,745.571 / 594,717,455.710 = **10.00% = 1000 bps**.
- **Net totalSupply delta over the window:** **0** (594,717,455.710 → 594,717,455.710).
- **Price (OFF-CHAIN, context only):** ≈$2.86 → ≈$0.32 (~ -85% / 24h). Utility token, no peg.

## What the on-chain facts IMPLY (reasoned from the data, not from any detector)
1. **Net supply is flat.** A signal that keys on a CHANGE in total supply (curr vs prev, or a
   spike over baseline) has, factually, **nothing to report** — the burn and the equal mint cancel.
   → **TOTAL_SUPPLY_SPIKE has no basis to fire.** This is the deliberate evasion.
2. **The mint is matched.** An equal-amount burn occurs 110s before the mint — well within any
   minutes-scale reconciliation window. A mint↔burn reconciliation that pairs equal amounts in a
   short window would treat this as a **matched pair** (the way a legit cross-chain bridge rebalance
   looks). → **UNMATCHED_MINT factually does not hold** — the mint IS matched (by the burn).
3. **The single mint tx stands alone.** A **single transaction minting 10% of supply to a
   NON-authorized address** is the attack's unmistakable on-chain fingerprint, independent of the
   net-flat supply and the offsetting burn. → **LARGE_SINGLE_MINT is the one signal that
   factually fires.** The burn-then-remint structure is a deliberate evasion of net-supply and
   reconciliation monitoring, leaving the single-tx %-of-supply mint as the only detector with a
   factual basis.

## FIDELITY (on-chain vs off-chain)
**HIGH-confidence on-chain reads (Alchemy archive, V1 `0x8c86…8df`, 18 dp):**
- totalSupply path 594,717,455.710 → 535,245,710.139 → 594,717,455.710 across blocks
  11979831 / 11979832 / 11979840. ✔
- Burn tx `0x3a48…4b9b` (59,471,745.571 PAID, `0xd500aa2c…` → `0x0`, 18:01:19Z). ✔
- Mint tx `0x4bb1…55a0` (59,471,745.571 PAID, `0x0` → `0x18738290…cd65be`, 18:03:09Z). ✔
- `owner()` = `0x53bc…44cc` (authorized minter); exploiter `0x18738290…` is NOT authorized. ✔
- Mint = exactly 10.00% of supply (1000 bps). ✔

**Off-chain context (NOT load-bearing for any signal here):**
- Price ≈$2.86 → ≈$0.32 (~ -85% / 24h), CoinGecko/Uniswap. PAID has no peg, so price drives no
  signal in this label. Listed for narrative only.

## Why these labels
- **INCIDENT @ mint (now 19:00:00Z, snapshot `PAID_mint.json`, prev `PAID_pre.json`):**
  - **should_fire — LARGE_SINGLE_MINT (token:PAID, HIGH floor):** a single unauthorized mint of
    10% of supply to a non-allowlisted address is a near-certain real incident and urgent. HIGH
    (not CRITICAL): it is a single, *uncorroborated* signal (supply-spike and recon are evaded, so
    nothing corroborates it across signals) and 10% of supply, while unauthorized and severe, is
    not the near-total-supply / multi-signal-corroborated catastrophe that the CRITICAL ceiling is
    reserved for. The HIGH floor admits a HIGH or CRITICAL emission as a pass.
  - **must_not_fire — TOTAL_SUPPLY_SPIKE:** net supply is flat (594.7M → 594.7M); there is nothing
    to spike on. This is the evasion, and the label documents it.
  - **must_not_fire — UNMATCHED_MINT:** the mint is matched by the equal burn 110s earlier; within
    a short recon window it pairs off, so "unmatched" factually does not hold. The evasion again.
  - **must_not_fire — DEPEG:** PAID is a utility token with no peg; the price crash is market
    inflation, not a depeg.
- **CALM CONTROL (now 2021-03-03T12:00:00Z, snapshot `PAID_calm.json`, prev `PAID_calm_prev.json`):**
  same token days before the exploit — flat supply (594.7M, identical prev/curr), no mint/burn
  events, no unauthorized issuance. All mint-side + supply + depeg signals must stay silent; WARN/0
  noise ceiling. Guards against a hair-trigger firing on PAID's ordinary pre-exploit life.
