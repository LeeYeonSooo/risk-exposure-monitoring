# 2023-11-18 — GHO structural soft-peg discount (NORMAL-period CONTROL, must stay quiet)

## Type
NEGATIVE CONTROL (closed:true). A blue-chip CDP/soft-peg stablecoin trading a few percent
*below* $1.00 as its EXPECTED structural equilibrium — NOT a distress depeg. The monitor must
not raise a HIGH/CRITICAL distress DEPEG on it. This is the rotation's control case (pairs with
the prior depeg/unbacked incidents) and is the nearest-to-threshold soft-peg FP-trap.

## What GHO is and why ~$0.975 was NORMAL, not distress
GHO is Aave's native decentralized stablecoin: minted as over-collateralized debt against
Aave V3 collateral (a CDP-style mint, like DAI), with the peg held by (a) interest-rate policy,
(b) a Stability Module (GSM) added later, and (c) third-party arbitrage. Through most of H2-2023
GHO traded persistently in the ~$0.96–0.98 band. This was NOT a reserve failure or a run:
- GHO has **no 1:1 fiat redemption floor** (unlike USDC/USDT). The only "redemption" was repaying
  your own debt at a notional $1.00, which is not an arb the open market can do at scale, so the
  market price floated below par whenever mint demand < sell pressure.
- The discount was **structural and slow-moving** (weeks at ~$0.97), the opposite of a crash.
- Every GHO is still fully backed by over-collateralized Aave debt positions; there was no
  unbacked supply, no insolvency, no liquidation cascade caused by the $0.97 mark.
- Aave governance publicly acknowledged the sub-peg as a known peg-mechanism gap and addressed it
  later (GSM, rate hikes) — i.e. it was a *design* state, treated as expected, not an incident.

So for an exposure-risk monitor, a persistent ~2.5% below-par mark on a fully-backed CDP stable
with no liquidation venue under water is at most low-severity informational, NOT an actionable
HIGH/CRITICAL page. It is the stablecoin analogue of the Pendle-PT / RWA "by_design_discount"
control: the correct reference is the asset's structural equilibrium, not a naive $1.00.

## On-chain capture (real, Ethereum archive @ block 18,600,000)
- GHO token: `0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f` (Ethereum mainnet)
- totalSupply @ 18600000 = 32,540,788,803,215,004,587,924,050 raw (18dp) = **32,540,788.80 GHO**
- block 18600000 timestamp = **2023-11-18T16:45:59Z** (Alchemy eth archive)
- Source: `capture.total_supply('ethereum', GHO, 18600000)` + `capture.block_timestamp(...)`.
  Supply is genuinely historical (archive point-in-time read), not today's value.

## Price reference
GHO/USD ~ **$0.975** on 2023-11-18 (sustained ~$0.96–0.98 band through the period; CoinGecko /
DefiLlama / Aave governance "GHO peg" discussions). Injected as a per-case peg_probe.

## Label intent (faithful to facts, NOT to engine behavior)
- `must_not_fire`: a distress DEPEG on the GHO lending edge. A persistent, fully-backed soft-peg
  discount is not an actionable exposure event.
- Noise ceiling: assert no HIGH-or-above signal on the snapshot (`max_emitted` HIGH count 0). A low
  INFO/WARN "trading below par" housekeeping note is tolerable; a HIGH/CRITICAL page is a false
  positive that would wake the operator for a known design state — the exact overnight FP we test for.

## Sources
CoinGecko GHO history; DefiLlama stablecoins (GHO peg); Aave Governance forum "GHO peg"
threads (2023 H2); Etherscan GHO contract `0x40D1…6C2f`. See on-chain capture above.
