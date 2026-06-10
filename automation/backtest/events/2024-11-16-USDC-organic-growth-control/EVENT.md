# 2024-11-16 USDC organic supply expansion (NORMAL-period CONTROL)

## Classification
NORMAL-period control (`closed: true`). NOT an incident. Exercises the **supply-side**
detectors (d05 total-supply, d10 supply-delta + single-tx mint, d11 mint/burn recon, d09
unbacked) and asserts they stay QUIET during a healthy, authorized, fully-backed expansion.
Prior controls (GHO soft-peg, PT discount, USDC/USDT/wstETH at-peg) all sit on the **price/peg**
axis; none stress the supply/mint reconciliation path. This control closes that gap.

## What actually happened (facts, no engine knowledge)
Across 2024-06 → 2024-11 USDC (Circle's fiat-backed major stablecoin, 6 decimals,
`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` on Ethereum) grew its Ethereum-mainnet ERC20
`totalSupply` from ~$24.25B to ~$27.29B as on-chain demand rose. This was a CALM,
**authorized** expansion:
- Circle is the sole issuer; new USDC is minted by MasterMinter-controlled minters to Circle's
  own treasury against 1:1 reserve deposits, then distributed. Every mint is by an authorized
  issuer; there is no foreign/bridge mint of canonical Ethereum USDC.
- The month-over-month supply moves were organic and modest: roughly +1.18B, +0.37B, +0.96B,
  -0.90B (a normal net redemption month), +1.46B — i.e. ±2-5% wiggles, not a spike.
- USDC held its $1.00 peg throughout; reserves (cash + short T-bills, attested monthly by Circle)
  fully backed circulating supply. No depeg, no unbacked mint, no insolvency, no run.

### On-chain capture (real Alchemy archive reads)
| block    | date (UTC)            | totalSupply (raw, 6dp) | ~USD   |
|----------|-----------------------|------------------------|--------|
| 20000000 | 2024-06-01T22:36:47Z  | 24251286965837135      | 24.25B |
| 20200000 | 2024-06-29T21:23:11Z  | 24209349240720246      | 24.21B |
| 20400000 | 2024-07-27T19:33:47Z  | 25390545214836062      | 25.39B |
| 20600000 | 2024-08-24T17:38:35Z  | 25764203436901927      | 25.76B |
| 20800000 | 2024-09-21T15:59:11Z  | 26723582531731985      | 26.72B |
| 21000000 | 2024-10-19T13:45:47Z  | 25822595541206649      | 25.82B |
| 21200000 | 2024-11-16T11:36:47Z  | 27286857008694271      | 27.29B |

These are the d10 `supply_samples` (chronological, current last). 6 deltas ≥ the 5-sample
minimum, so the robust-z check is ACTIVE (not cold). The modified z-score of the final delta is
~1.26 — well under the 6.0 anomaly threshold. Real growth, real numbers, genuinely sub-threshold.

## Why the monitor MUST stay quiet
- **d05 / d10 (supply growth)**: organic +5.7% over ~5.5 months is demand, not an unbacked mint.
  The robust-z of the latest delta is ~1.26 (< 6.0). A WARN `SUPPLY_DELTA_ANOMALY` here would be
  a wrong-reference FP on a blue-chip stable's normal growth.
- **d10 single-tx mint / d11 unmatched-mint**: the snapshot carries a deliberately large
  authorized issuance (~$1.5B = 549 bps of supply, ABOVE the 500-bps single_tx_mint threshold) to
  Circle's treasury, marked `home: true` AND with the mint `to` in `authorized_minters`. The mint
  is over threshold precisely so the gate test is NON-vacuous: if the home/allowlist exclusion were
  broken the single-tx check WOULD fire. A second snapshot (`usdc_allowlist_only.json`) drops the
  `home` flag so the allowlist branch alone must suppress it. Both detectors are SUPPOSED to exclude
  authorized/home issuance — that is exactly what this control verifies. A LARGE_SINGLE_MINT or
  UNMATCHED_MINT here would be an FP. (The supply *samples* in the table are 100% real on-chain; the
  large mint is a labeled authorized-issuance test vector — USDC's real issuance mechanism.)
- **d09 (unbacked)**: canonical Ethereum USDC has no remote/bridge wrapper in this snapshot, and
  it is 1:1 reserve-backed; Σ(remote) does not exceed home backing, so d09 is trivially silent.
- **d08 (depeg)**: price at $1.00 → no depeg.

## Pass criteria (label)
- `must_not_fire`: SUPPLY_DELTA_ANOMALY, LARGE_SINGLE_MINT, UNMATCHED_MINT, UNBACKED, DEPEG.
- `max_emitted: {severity: WARN, count: 0}` — the snapshot must raise ZERO WARN-or-above signals
  (noise ceiling). INFO housekeeping (e.g. d01 new-market coverage) is tolerable.

## Sources
- On-chain Alchemy archive: USDC `totalSupply` at blocks 20.0M-21.2M (table above), captured via
  `qa/backtest/collect/capture.py`.
- Etherscan USDC token `0xA0b8...eB48` (6 decimals, MasterMinter / FiatToken issuer model).
- Circle monthly reserve attestations (USDC fully reserve-backed throughout 2024).
- CoinGecko/DefiLlama USDC price (held $1.00) and circulating-supply history (2024 H2).
