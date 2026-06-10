# 2024-06-12 — crvUSD spot dislocation (FALSE-POSITIVE DISCIPLINE CONTROL, must stay quiet)

## Type
NEGATIVE CONTROL (closed:true). A transient ON-CHAIN SPOT dislocation where the
manipulation-resistant crvUSD EMA aggregator — the price a lending monitor actually
ingests — HELD peg. The monitor (which consumes the aggregator, not thin pool spot) must
NOT raise a DEPEG. This complements the USDe CEX-wick control (2025-10-11, an OFF-chain CEX
wick) with an ON-CHAIN spot-vs-EMA-oracle case: in both, the real price an exposure monitor
ingests never left the peg band, only a thin/transient venue wicked.

## What happened (the spot wicked, the ingested price did not)
On 2024-06-12, a UwU Lend exploit (June 10) left a large CRV-collateralized crvUSD borrow
position that, as CRV fell, became liquidatable. To carry out the liquidations, demand for
crvUSD spiked because the borrower's debt was denominated in crvUSD. Liquidators bought
crvUSD to repay debt, and crvUSD SPOT prices in individual (thin) Curve pools briefly wicked
**UPWARD toward ~$1.10** — a transient *upward* dislocation, not a downward break.

Two facts make this a benign control rather than a real depeg:

1. **The PegKeeper V2 deviation check reverted.** crvUSD PegKeepers normally mint/burn crvUSD
   into their pools to dampen peg deviation. Their deviation check (a ±0.0005 band on the
   pool-vs-aggregator price) caused the `update()` calls to revert while volatility exceeded
   the band, so the PegKeepers could not supply crvUSD for ~45 minutes (the first successful
   update was ~525 blocks after the depeg began). This *let* spot float above peg transiently
   — but it is a property of thin pool spot, not of the ingested oracle.

2. **The aggregator / price-oracle (EMA) HELD peg.** All Curve LlamaLend markets denominate
   price against the manipulation-resistant crvUSD **aggregator** (an EMA over the pool
   prices), NOT raw pool spot. The aggregator lagged and damped the spot spike, staying inside
   the peg band throughout. The system "worked as intended": the exploiter's position was fully
   liquidated (OTC soft-liquidation) with **no bad debt** accrued to Curve Lend.

So the price a lending/exposure monitor consumes (the aggregator EMA) **never left the peg
band**. Only thin spot pools wicked, transiently and upward. Firing a DEPEG here would be a
wrong-source artifact: alerting on a venue price the monitor does not (and should not) ingest.

## On-chain capture (REAL, Ethereum archive @ block 20,075,607)
- crvUSD token: `0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E` (Ethereum mainnet, 18dp)
- crvUSD **aggregator / price-oracle**: `0x18672b1b0c623a30089A280Ed9256379fb0E4E62`
- **aggregator `price()` @ block 20075607 = `998427599842524685` raw (18dp) = `$0.99842759…` ≈ $0.9984**
  (Alchemy `eth_call`, selector `0xa035b1fe`) — **REAL ON-CHAIN MEASURED**, the load-bearing fact.
- crvUSD `totalSupply()` @ block 20075607 = **725,352,070 crvUSD** (selector `0x18160ddd`, 18dp) — REAL on-chain.
- block 20075607 timestamp = **2024-06-12T11:59:59Z** (Alchemy `eth_getBlockByNumber`), matches the case `now` of 12:00Z.

## Price reference
- **Ingested price (aggregator EMA): $0.9984** — REAL on-chain @ block 20075607. Inside the
  peg band (−0.16% vs $1.00). This is what a lending monitor consumes → injected as the per-case peg_probe.
- **Transient spot (thin pools): ~$1.10** — DOCUMENTED transient (the LlamaRisk incident report
  charts the upward spot spike during the cascade; the ±0.0005 PegKeeper band + 45-minute revert
  window are quoted). This is NOT the ingested price; it appears only in context, not as the probe.

## Label intent (faithful to facts, NOT to engine behavior)
- `must_not_fire`: a DEPEG on the crvUSD LlamaLend edge. The price the monitor ingests (the EMA
  aggregator) held $0.9984, inside band — there is no depeg of the ingested mark. The ~$1.10 spot
  wick is a thin-venue transient the monitor neither ingests nor should alert on.
- Noise ceiling: no WARN-or-above signal on the snapshot (`max_emitted` WARN count 0). A purely
  benign on-chain spot dislocation where the ingested oracle held peg must not wake the operator.

## FIDELITY (measured vs documented)
- **ON-CHAIN MEASURED, HIGH confidence:** the aggregator `price()` = **$0.9984** @ block 20075607
  (direct Alchemy archive `eth_call`), plus crvUSD `totalSupply` 725,352,070 and the block timestamp
  2024-06-12T11:59:59Z. This is the case's anchor and is not reconstructed.
- **DOCUMENTED, high confidence:** the ~$1.10 transient SPOT wick, the PegKeeper V2 ±0.0005
  deviation-check revert (~45 min / ~525 blocks), that LlamaLend denominates against the aggregator
  (not spot), the UwU-exploit → liquidation-demand root cause, and the no-bad-debt outcome
  (LlamaRisk incident report).

## Sources
- LlamaRisk — "crvUSD Upward Depeg Event (June 12, 2024) Incident Report":
  https://llamarisk.com/research/crvusd-incident-report-20240612
  (aggregator/EMA held peg vs spot; PegKeeper ±0.0005 deviation-check revert ~45 min/~525 blocks;
  Curve Lend markets denominate against the aggregator; full liquidation, no bad debt.)
- On-chain (Alchemy Ethereum archive): `eth_call` crvUSD aggregator
  `0x18672b1b0c623a30089A280Ed9256379fb0E4E62` `price()` (`0xa035b1fe`) @ block 20075607 =
  `0x0ddb209cb68f3e0d` = `$0.99842759…`; crvUSD `0xf939E0A0…1b4E` `totalSupply()` (`0x18160ddd`)
  @ 20075607 = 725,352,070; `eth_getBlockByNumber` 20075607 ts = 2024-06-12T11:59:59Z.
- Etherscan crvUSD `0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E`; aggregator
  `0x18672b1b0c623a30089A280Ed9256379fb0E4E62`.
