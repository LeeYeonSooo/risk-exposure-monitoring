# 2026-03-22 Resolv USR compromised-signer unbacked-mint + catastrophic depeg (Ethereum)

**Class:** Unauthorized large-mint exploit via a **compromised off-chain mint-signer key with NO
on-chain max-mint cap** → ~80M unbacked USR minted against ~$100K collateral → catastrophic
stablecoin depeg. This is a DISTINCT unbacked-mint mechanism from prior labeled exploits:
- vs **PAID** (2021): contract-owner-key **burn-then-remint** that kept NET supply flat (evasion).
- vs **xUSD** (recursive-loop self-collateralization yielding provable Σsupply > backing).
- vs **deUSD** (mass-**redemption** run that CONTRACTS supply via burn-on-redeem).
USR is the opposite of all three on the supply axis: a single off-chain signer, compromised, mints
a huge amount of NEW supply **upward** with NO cap — so the on-chain fingerprint is a large
**upward** total-supply spike + a single huge unauthorized mint + a near-total depeg, all at once.

**One-line:** A compromised privileged signing key (AWS-KMS `SERVICE_ROLE`, the off-chain service
that signs off how much USR to mint) minted **~80M unbacked USR** against an estimated **~$100K
(≈100k–200k USDC)** of collateral. The smart contract enforced **NO maximum mint limit** — it only
verified that a valid signature existed — so there was no on-chain cap to stop it. USR
flash-crashed to **~$0.025 on Curve** within minutes; the attacker extracted **~$25M** (≈11,409 ETH
/ ≈$23.7M). Resolv paused the protocol.

## Token
- **Token:** Resolv USR, ERC-20, **18 decimals**.
- **Contract:** `0x66a1E37C9b0eAddca17d3662D6c05F4DECf3e110` (Ethereum mainnet, chain_id 1).
- **Home chain:** ethereum. (USR / staked wstUSR also used as collateral on Morpho & Gauntlet — the
  contagion surface, but the mint and depeg are on Ethereum mainnet / Curve.)
- **Attacker / mint recipient (NOT an authorized issuer):** `0xa27a69ae180e202fde5d38189a3f24fe24e55861`.

## Timeline (2026-03-22, UTC)
- **~02:21Z** — exploit begins; attacker, in control of the off-chain `SERVICE_ROLE` signing key
  (AWS-KMS environment compromise), starts authorizing arbitrary USR mints.
- Between block **24709326 (Mar-22 00:00Z)** and block **24711714 (Mar-22 08:00Z)** USR
  `totalSupply` jumps **102,507,700 → 178,655,619 USR (+76,147,919, +74%)** — REAL on-chain.
- A **single mint of 50,000,000 USR** (tx
  `0xfe37f25efd67d0a4da4afe48509b258df48757b97810b28ce4c649658dc33743`) goes from `0x0` to attacker
  `0xa27a69ae…55861`; a further **~30M** mint to the same attacker completes the ~80M.
- Within ~17 min USR **flash-crashes to ~$0.025 on Curve** (~-97.5% off the $1 peg) as the attacker
  dumps; ~$25M (≈11,409 ETH) is extracted; ~$1.1M wstUSR held in another address.
- Opportunistic traders borrow USDC against USR at its hardcoded $1 oracle valuation on
  Morpho/Gauntlet vaults, draining stablecoin liquidity (contagion). Resolv **pauses** all protocol
  functions; later partial recovery toward ~$0.85.

## Mechanism (compromised off-chain signer, NO on-chain cap)
1. USR minting is a **two-step off-chain process**: a user deposits USDC and submits a request; an
   **off-chain service holding a privileged private key (`SERVICE_ROLE`)** reviews it and calls back
   the contract to finalize the USR amount to mint.
2. The attacker compromised the **AWS-KMS environment** holding that key and used Resolv's OWN
   minting key to authorize arbitrary mints.
3. The on-chain contract **only checked that a valid signature existed** — there was **NO
   max-mint cap, no oracle/amount check, no multisig**. So a single compromised key could mint ~80M
   USR against ~$100K of real collateral. No smart-contract bug — the contracts executed exactly as
   designed; the failure is the **missing on-chain mint cap** + single-key trust.

## Magnitudes (on-chain MEASURED)
- **Supply jump:** 102,507,700 → 178,655,619 USR = **+76,147,919 USR (+74.3%)** across blocks
  24709326 → 24711714 (Mar-22 00:00 → 08:00Z). ✔ on-chain
- **Single largest mint:** **50,000,000 USR** (`50000000e18` base units, 18 dp), `0x0` → attacker
  `0xa27a69ae…55861`, tx `0xfe37f25e…33743`. ✔ on-chain
  - As % of post-mint supply: 50,000,000 / 178,655,619 = **27.99% ≈ 2799 bps**.
  - As % of pre-mint supply: 50,000,000 / 102,507,700 = **48.78%**.
- **Backing ratio:** ~80M USR minted against ~$100K collateral → grossly unbacked (orders of
  magnitude below 1:1). (Backing context is off-chain / reported, not the load-bearing on-chain read.)
- **Depeg:** USR ~$1.00 → **~$0.025 on Curve** (≈ **-97.5%**). Catastrophic for a $1-pegged stable.
- **Extracted:** ~$25M (≈11,409 ETH ≈ $23.7M).

## What the on-chain facts IMPLY (reasoned from the data, not from any detector)
1. **Net total supply spikes sharply UPWARD** (+74%): a CHANGE-in-total-supply / spike-over-baseline
   signal has a large, unambiguous, on-chain basis. → **TOTAL_SUPPLY_SPIKE fires** (catastrophic
   magnitude; this is NOT PAID's net-flat evasion — supply genuinely jumps).
2. **A single transaction mints ~28% of supply to a NON-authorized address.** → **LARGE_SINGLE_MINT
   fires**: one unauthorized mint of ~28% of supply to attacker `0xa27a69ae…` is the attack's
   standalone fingerprint, and unlike PAID it is CORROBORATED by the supply spike.
3. **Abnormal supply growth vs the token's normal supply trajectory** (samples climb gently
   100M→102.5M over the prev window, then explode to 178.66M). → **SUPPLY_DELTA_ANOMALY fires**:
   the period-over-period delta is far outside USR's normal drift.
4. **A $1-pegged stable trading at ~$0.025** on a real venue (Curve) is a near-total peg break,
   ~9x past USDC's catastrophic 13% SVB depeg. → **DEPEG fires at the most severe end.**

These FOUR signals are mutually corroborating (supply spike + single mint + abnormal delta + depeg),
which is exactly why this incident should page at the highest confidence, unlike the single
uncorroborated PAID mint.

## FIDELITY (on-chain MEASURED vs documented)
**HIGH-confidence on-chain reads (Alchemy archive, USR `0x66a1E3…e110`, 18 dp):**
- totalSupply 102,507,700 → 178,655,619 USR across blocks 24709326 → 24711714. ✔ MEASURED
- Single 50,000,000 USR mint, tx `0xfe37f25e…33743`, `0x0` → `0xa27a69ae…55861`. ✔ MEASURED
- The ~30M second mint to the same attacker (completing ~80M) — on-chain, summarized in the +76M
  aggregate supply delta. ✔ MEASURED (aggregate); the 50M tx is the single-mint anchor in the snapshot.

**Documented (multi-source, load-bearing for the DEPEG case via injected peg_probe):**
- **USR ~$0.025 on Curve** post-mint — reported across The Block, Decrypt, Chainalysis, Blockaid,
  Halborn, Sentora, AMBCrypto, CoinDesk. The depeg price is INJECTED via `peg_probes`
  (`USR-curve-collateral`, price 0.025, peg 1.0, stable, by_design_discount=false), consistent with
  the deUSD label's depeg-via-peg_probe convention.
- ~$25M / ≈11,409 ETH extracted; ~$100K(–200K) collateral; AWS-KMS `SERVICE_ROLE` key compromise;
  NO on-chain max-mint cap — reported (mechanism context, not a per-signal numeric input).

## Why these labels
- **INCIDENT @ mint (`usr-compromised-mint-and-depeg`; snapshot `usr_mint.json`, prev `usr_prev.json`,
  now 2026-03-22T08:00:00Z; peg_probe USR-curve-collateral @ $0.025):** FOUR corroborating facts,
  all must be caught:
  - **TOTAL_SUPPLY_SPIKE (token:USR, ≥HIGH):** +74% upward supply jump (102.5M→178.66M) is a
    genuine, catastrophic-magnitude spike — corroborated by the depeg and the single mint. Floor
    HIGH (admits HIGH or CRITICAL): a near-certain, on-chain, page-worthy supply explosion.
  - **LARGE_SINGLE_MINT (token:USR, ≥HIGH):** one tx mints 50M USR ≈ 28% of supply to a
    non-authorized attacker — an unmistakable unauthorized-mint fingerprint. Floor HIGH (admits
    HIGH or CRITICAL); ~28% to an attacker is squarely page-worthy.
  - **DEPEG (USR-curve-collateral, ≥CRITICAL):** ~$0.025 ≈ -97.5% off a $1 stable on Curve — a
    near-total collapse of a pegged collateral asset, the canonical CRITICAL. Floor CRITICAL.
  - **SUPPLY_DELTA_ANOMALY (token:USR, ≥HIGH):** the period delta (+76M) is far outside USR's
    normal supply drift — abnormal growth. Floor HIGH.
  - **must_not_fire: []** — every plausible signal here SHOULD fire; there is no FP-trap to silence
    in the incident snapshot (no benign offsetting structure as in PAID's matched burn).
- **CALM CONTROL (`usr-calm-pre-attack`; snapshot `usr_calm.json`, prev `usr_calm_prev.json`, now
  2026-03-20T12:00:00Z; peg_probe USR-curve-collateral @ $0.999):** same token, ~2 days BEFORE the
  attack — supply stable ~102.2M→102.3M (routine sub-threshold drift), no mint events, price at par
  (~$0.999). ALL incident signals must stay SILENT (TOTAL_SUPPLY_SPIKE, LARGE_SINGLE_MINT, DEPEG,
  SUPPLY_DELTA_ANOMALY); noise ceiling WARN/0 (INFO housekeeping tolerable). Proves the incident
  signals are SPECIFIC to the exploit, not to USR-the-token — without this, the incident GREEN is hollow.

## Sources
- The Block — https://www.theblock.co/post/394582/resolvs-usr-stablecoin-depegs-after-attacker-mints-80-million-unbacked-tokens-extracts-roughly-25-million
- Blockaid — https://blockaid.io/blog/how-a-compromised-key-minted-80m-in-resolvs-usr-stablecoin-and-triggered-a-depeg
- Chainalysis — https://www.chainalysis.com/blog/lessons-from-the-resolv-hack/
- Halborn — https://www.halborn.com/blog/post/explained-the-resolv-hack-march-2026
- Sentora — https://sentora.com/research/articles/the-resolv-hack-25m-from-a-single-compromised-key
- Decrypt — https://decrypt.co/361984/resolv-labs-stablecoin-depegs-plunges-74-after-25m-exploit
- CoinDesk — https://www.coindesk.com/markets/2026/03/23/resolv-stablecoin-drops-70-after-usd80-million-exploit-after-attacker-mints-usr
- AMBCrypto — https://ambcrypto.com/resolv-exploit-triggers-usr-depeg-after-80m-uncollateralized-mint/
- Web3Firewall — https://www.web3firewall.xyz/resolv-exploit
- DEV (missing max-mint check) — https://dev.to/ohmygod/the-resolv-usr-exploit-how-a-missing-max-mint-check-let-an-attacker-print-25m-from-100k-522j
