# cbBTC depeg drill (seed event)

**Type:** synthetic seed (not a real incident) — built from `tests/fixtures/cbBTC.json`.
**Why it exists:** to prove the harness runs end-to-end and to serve as a template.

## Cases
- `normal-quiet` — the fixture as-is, no price stress. The monitor must NOT raise any
  DEPEG or WARN+ alert (the 8 INFO `NEW_MARKET` cold-start signals are expected and fine).
- `depeg-morpho-0.88` — inject a peg probe (cbBTC at 0.88 vs 1.0) on the depeg-sensitive
  Morpho market. The monitor MUST emit `DEPEG` (≥WARN) on that edge.

## Replace me
Swap this for REAL labeled incidents (USDC SVB 2023-03, stETH 2022-06, …):
1. `event-scout` discovers candidates, `event-researcher` analyzes the event.
2. `collect/capture` (Alchemy archive) snapshots the relevant block(s) into `snapshots/`.
3. Fill `label.json` with the should_fire / must_not_fire you determined.
4. Keep `closed: false` until the label is complete; then flip to `true` for strict scoring.
