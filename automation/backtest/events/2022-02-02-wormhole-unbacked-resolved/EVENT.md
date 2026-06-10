# Wormhole bridge hack & resolution — unbacked breach that RESOLVED (Feb 2–4, 2022)

**Event ID:** `2022-02-02-wormhole-unbacked-resolved`
**Class:** UNBACKED_SUPPLY (Σ circulating > backing) → **UNBACKED_RESOLVED** (breach cleared across polls).
**Status:** closed.

## TL;DR
The Wormhole token bridge locks ETH on Ethereum in a custody contract and mints a wrapped
representation (**whETH**) on Solana. On **Feb 2, 2022** an attacker exploited a signature-
verification flaw in the Solana-side bridge to mint **120,000 whETH on Solana with no
backing collateral**. The attacker then **redeemed ~93,750 of that unbacked whETH back to
Ethereum**, draining the locked-WETH custody from ~93,769 WETH down to **~21 WETH**. At that
moment the ~93,769 whETH legitimately circulating on Solana was backed by essentially nothing
— a **catastrophic unbacked-supply state** (Σ supply ≫ backing).

The breach did **not** collapse into a depeg/loss like our xUSD event. Instead, on
**Feb 3–4, 2022 Jump Crypto deposited 120,000 ETH** into the bridge to make the protocol
whole. Custody backing was **restored to ~113,433 WETH** — now *greater* than the ~93,769
whETH obligation — so backing again covered circulating supply and the breach **cleared**.

This is the only event in our set where an **unbacked breach was RESOLVED** rather than
ending in collapse. It exists to test the monitor's *resolve path*: (a) fire UNBACKED_SUPPLY
on the drain, then (b) emit an **UNBACKED_RESOLVED** notice when backing crosses back above
supply across polls.

## The mechanism
- **Bridge model:** lock-and-mint. Ethereum custody `0x3ee18B2214AFF97000D974cf647E7C347E8fa585`
  (the Wormhole token-bridge) holds WETH; an equal amount of whETH is minted on Solana.
  Invariant: `custody WETH (backing) ≥ whETH circulating on Solana`.
- **The exploit:** the attacker bypassed signature verification on the Solana bridge program
  and minted **120,000 whETH** with no deposit — breaking the invariant at the source.
- **The drain:** the attacker bridged ~**93,750** of the freshly-minted unbacked whETH from
  Solana back to Ethereum, withdrawing the *real* locked WETH. Ethereum custody fell from
  **~93,769 WETH → ~21 WETH**. Now ~93,769 whETH still circulated on Solana against ~21 WETH
  of real backing → **UNBACKED**.
- **The backstop (resolve):** Jump Crypto, deeply involved in Wormhole's development, deposited
  **120,000 ETH** into the bridge ~Feb 3–4 to cover the shortfall. On-chain custody was
  restored to **~113,433 WETH**, *exceeding* the ~93,769 whETH obligation → **BACKED again**,
  breach cleared.

## On-chain timeline (Ethereum side, MEASURED)
Real reads of `WETH.balanceOf(0x3ee18B2214AFF97000D974cf647E7C347E8fa585)` (Wormhole custody):

| Phase     | Date (UTC)         | Block      | Custody WETH (backing) | whETH supply (Solana, researched) | State     |
|-----------|--------------------|------------|------------------------|-----------------------------------|-----------|
| Pre-hack  | ~Feb 2, 2022       | —          | ~93,769 WETH           | ~93,769 whETH                     | backed    |
| **BREACH**| Feb 3, 2022        | 14130250   | **~21 WETH**           | ~93,769 whETH                     | UNBACKED  |
| **RESOLVED**| Feb 4, 2022      | 14139392   | **~113,433 WETH**      | ~93,769 whETH                     | backed    |

The pre-hack ~93,769 WETH ≈ the legitimate bridged ETH; the whETH circulating supply
(~93,769) is anchored to that pre-hack backing. After the resolve, backing (~113,433) >
supply (~93,769), so the bridge is over-collateralized and the unbacked alarm must clear.

## Why this is a breach-then-resolve (not a collapse)
The unbacked window was real and catastrophic (backing ≈ 0.02% of the prior level), so the
breach signal MUST fire HIGH at the drain block. But because a solvent backstop (Jump's
120k ETH) refilled custody *above* the outstanding whETH, the invariant `backing ≥ supply`
was re-established. Crossing that threshold back upward across consecutive polls is exactly
the **UNBACKED_RESOLVED** condition: a previously-flagged breach that returns within backing.
This is the inverse of xUSD, where the gap never closed and the token depegged ~77%.

## Snapshots (built by orchestrator; node `token:whETH`, decimals 18)
- `snapshots/wormhole_breach.json` — backing ~21 WETH vs ~93,769 whETH → UNBACKED.
  (`snapshot_block 14130250`, ts `2022-02-03T02:00:00Z`.)
- `snapshots/wormhole_resolved.json` — backing ~113,433 WETH vs ~93,769 whETH → backed/clean.
  (`snapshot_block 14139392`, ts `2022-02-04T12:00:00Z`.)

## FIDELITY (confidence: MEDIUM)
- **MEASURED (HIGH fidelity):** the custody WETH **backing** is a real on-chain read of
  `WETH.balanceOf(Wormhole custody 0x3ee18B2214AFF97000D974cf647E7C347E8fa585)` on Ethereum
  at the cited blocks (Alchemy archive) — 93,769 → 21 → 113,433. This is the quantity that
  drives the breach and the resolve.
- **ASSERTED (researcher, off-chain):** the **whETH circulating supply on Solana (~93,769)** is
  not readable by an Ethereum-only Alchemy key. It is anchored to the well-documented pre-hack
  bridged amount (≈ pre-hack custody). The exact Solana-side mint/burn flux during the 2-day
  window is not independently re-derived here.
- **Net:** the *direction and magnitude* of both the breach (backing crashes far below the
  asserted supply) and the resolve (backing rises back above the asserted supply) are robust
  to reasonable error in the asserted ~93,769, because the backing swing (21 → 113,433) is
  enormous relative to any plausible supply uncertainty. Disclosed **MEDIUM** confidence.

## Sources
- Chainalysis — *Wormhole Hack: Lessons From The Wormhole Exploit* (Feb 2, 2022; 120,000 wETH; ~$320M):
  https://www.chainalysis.com/blog/wormhole-hack-february-2022/
- Halborn — *Explained: The Wormhole Hack (February 2022)*:
  https://www.halborn.com/blog/post/explained-the-wormhole-hack-february-2022
- Merkle Science — *Hack Track: Analysis of the Wormhole Token Bridge Exploit*:
  https://www.merklescience.com/blog/hack-track-analysis-of-wormhole-token-bridge-exploit
- ImmuneBytes — *Wormhole Bridge Hack – Feb 2, 2022 – Detailed Hack Analysis*:
  https://immunebytes.com/blog/wormhole-bridge-hack-feb-2-2022-detailed-hack-analysis/
- Blockworks — *Jump Crypto … Wormhole Hack Recovery* (Jump replaced funds; later counter-exploit):
  https://blockworks.com/news/jump-crypto-wormhole-hack-recovery
- On-chain anchor: `WETH.balanceOf(0x3ee18B2214AFF97000D974cf647E7C347E8fa585)` @ Ethereum
  blocks 14130250 (breach) and 14139392 (resolved), Alchemy archive.
