# LUNA oracle freeze → Venus Protocol $11.2M bad debt (2022-05-13)

## What factually happened
During the Terra/LUNA collapse (May 2022), Chainlink's LUNA/USD aggregator stopped
updating once the reported price fell to its hard floor (`minAnswer` ≈ $0.107). The real
market price of LUNA kept crashing toward ~$0.01, but on-chain consumers that read the
Chainlink feed continued to see a FROZEN, grossly-too-high $0.107.

Venus Protocol (a Compound-fork money market) priced LUNA collateral off that frozen feed.
Two accounts deposited ~230,000,000 LUNA (nominally valued at >$24M at the stale $0.107)
and borrowed ~$13.5M of other assets against it. Because the collateral was worth a fraction
of its frozen price, the loans could never be liquidated profitably. Venus took ~**$11.2M**
of bad debt and **paused the protocol** in response. Chainlink later confirmed it had
intentionally halted the feed at the floor.

Sources: BeInCrypto, Cointelegraph, The Record (Recorded Future), Halborn post-mortem,
Venus official statement, ChainCatcher. (LUNA crash, 2022-05-11..13.)

## Why this is an exposure event a risk monitor MUST catch
This is the canonical ORACLE-FREEZE failure mode. The danger is NOT that the price moved —
it is that the price feed a lending venue trusts went **STALE / pinned at a floor** while the
true asset value collapsed. A monitor that only watches the venue's own (frozen) oracle is
blind by construction. Two independently-sufficient red flags were live:
  1. **Staleness**: `latestRoundData.updatedAt` stopped advancing — the feed had not updated
     for many heartbeats (Chainlink LUNA/USD heartbeat was ~1h; it sat frozen for hours).
  2. **Fresh-but-wrong / reference divergence**: even taking the feed's last answer at face
     value ($0.107), it diverged ~90% from any honest cross-reference (DEX/CEX spot ≈ $0.01).
Either alone is an actionable ORACLE_FREEZE; together they are unambiguous.

## On-chain anchor (real archive read, this snapshot)
- Token: **LUNA (Wormhole)** ERC-20 on Ethereum, `0xbd31ea8212119f94a611fa969881cba3ea06fa3d`,
  decimals **6**.
- Block **14770000**, timestamp **1652480014** = 2022-05-13T22:13:34Z (mid-collapse).
- `totalSupply` (real, on-chain) = **1,441,854,478.623179 LUNA** — confirms the bridge-inflow
  surge as holders fled Terra to BSC/ETH via Wormhole.
- NOTE / CAPTURE LIMITATION: the ACTUAL Venus exploit was on **BSC** (LUNA bep20
  `0x156ab3346823B651294766e23e6Cf87254d68962`). `capture.py` CANNOT reach BSC
  (`ALCHEMY_SUBDOMAIN` has no `bsc` entry → `rpc_url('bsc')` is None), so the BSC token is
  uncapturable. The Ethereum Wormhole LUNA used here is the same asset at the same time and
  gives a genuine historical on-chain anchor. The lending-market exposure edge + the frozen
  oracle round are MODELED on the isolated-market architecture (the engine dispatches on
  architecture, never on token symbol), with the oracle freeze injected via `oracle_probes`
  exactly as the harness contract expects (round history is not capturable via view calls —
  see capture.py FIDELITY notes).

## Expected monitor behavior (the label)
- At the frozen-feed moment, `ORACLE_FREEZE` MUST fire on the LUNA lending edge — at least HIGH
  (stale beyond heartbeat) and CRITICAL is appropriate (stale ≫ 3× limit AND a ~90% reference
  divergence). This is the should_fire case.
- A NORMAL, healthy LUNA-feed snapshot from days earlier (feed fresh, answer ≈ market) MUST stay
  silent → ORACLE_FREEZE must_not_fire (FP-trap). A monitor that pages on a fresh, correct feed
  is uselessly noisy.
