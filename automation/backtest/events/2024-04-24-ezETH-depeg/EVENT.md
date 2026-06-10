# Renzo ezETH (LRT) depeg — April 24, 2024

**Event ID:** `2024-04-24-ezETH-depeg`
**Type:** REAL incident (liquid-restaking-token depeg vs ETH + cascading liquidation of leveraged loops).
**Token:** ezETH — Renzo Restaked ETH, a liquid restaking token (LRT). Pegged to ETH (NOT to $1).
**Home chain:** Ethereum mainnet.
**Token contract:** `0xbf5495Efe5DB9ce00f80364C8B423567e58d2110` (Renzo Restaked ETH, ezETH). Verified on Etherscan.
**Depeg window:** 2024-04-24, oracle first dipped below 1.0 at **02:25 UTC**; trough / cascade in the
following ~30–60 min. Reference block for `now`: **19722430** (Apr-24-2024 03:02 UTC).

## What ezETH is (and why "peg = 1 ETH", not "$1")
ezETH is Renzo's liquid restaking token. Each ezETH represents staked+restaked ETH and should be worth
**≈ its ETH-backing value (its underlying exchange rate, ~1.0× ETH and slowly accruing)**. So the correct
peg frame is ETH-relative: `peg = 1.0` means "1 ETH-equivalent of backing," and the depeg is measured as
the ezETH/ETH ratio falling below that. A healthy LRT trades at a tiny discount (single-digit-to-tens of
bps) to its backing. ezETH had **no native withdrawals** at the time — the only exit was selling into a
thin on-chain DEX pool — which is the structural reason a sentiment shock turned into a price depeg.

## Trigger (WHY it depegged)
1. **REZ airdrop backlash.** Renzo announced REZ tokenomics: only ~5% of supply to the airdrop, half of
   that routed to a 1-week Binance launchpool → ~2.5% effective to the community, plus a misleading
   distribution pie chart. Holders were dissatisfied and the **Season 1 points window was ending**
   (reward deadline ~Apr 26), removing the incentive to keep holding.
2. **No native withdrawals → thin exit.** ezETH could not be redeemed 1:1 for the underlying. The only
   way out was selling into DEX liquidity (a large share of which sat in a ~$200M pool on Blast L2).
   A rush of exits hit shallow liquidity.
3. **Loop unwind / cascade.** Leveraged "loopers" (supply ezETH → borrow ETH → buy more ezETH) began
   unwinding; their forced selling and on-chain liquidations fed the slippage, which fed more
   liquidations — a reflexive cascade.

## The depeg — ETH-relative terms (the load-bearing framing)
- **Sustained intraday depeg: ezETH fell to roughly 0.80–0.85 of its ETH-backing value** on the deeper,
  more liquid venues / oracle reads during the event. This ~15–20% discount below ETH backing is the
  economically meaningful level — an order of magnitude past an LRT's normal steady-state discount
  (~10–60 bps). This is the level that mattered for collateral health and is what `should_fire` is built on.
- **Flash low (thin-print spike): ~0.20–0.27 ratio (≈ $688–$750 vs ETH ~$3,100–$3,300).** A momentary
  Uniswap print driven by slippage/sandwiching in a thin pool. NOT a sustained value — it recovered within
  minutes/hours. We DO NOT label off this artifact; it is the kind of single-venue spike a robust monitor
  should treat as the tail, not the signal. The Morpho oracle (an averaged ezETH/ETH market-price feed)
  registered a **much smaller depeg than the $688 Uniswap print** — but still broke below 1.0 enough to
  liquidate loops at the 0.86 line.
- **Recovery:** ezETH re-converged toward ETH parity within hours the same day.

## Morpho exposure — the market that liquidated
ezETH was a major Morpho Blue collateral against WETH. The most affected market (per Gauntlet's
post-mortem) was the **ezETH/WETH market with LLTV = 0.86** (additional ezETH/WETH markets at 0.77 and
0.625 LLTV also existed):
- **Oracle:** a **market-price ezETH/ETH oracle** (averaged Chainlink/RedStone ezETH/ETH feed) — i.e. it
  tracked the actual ezETH/ETH ratio, NOT a hardcoded 1.0 redemption rate. This is precisely why the depeg
  was actionable on-chain: when the oracle dipped below 1.0 toward ~0.86, looped positions crossed the
  **0.86 LLTV** and were liquidated. (Contrast with the USD0++ hardcoded-$1.00 market, where a blind oracle
  shielded on-chain liquidation. Here the oracle was *not* blind, so loops actually blew up.)
- **Market size:** **~7.6k WETH supplied** to the ezETH/WETH/0.86 market (~$23M at ~$3,000/ETH), of which
  the Gauntlet LRT Core Vault supplied ~5k WETH. This matches the widely-cited **~$23M of liquidations on
  Morpho**.
- **Realized damage:** **10.96 WETH of insolvencies (bad debt)** accrued on the 0.86 market, of which
  **7.12 WETH was socialized to the Gauntlet LRT Core Vault** (~11 bps of that vault's WETH supply).

## Aggregate impact
- **~$60M+ in DeFi liquidations** across the event; **Morpho ≈ $23M** (~10,000 ezETH) and **Gearbox a
  comparable ~10,000 ezETH** (Gearbox lost ~half its ezETH TVL). Reported protocol-level losses ~$34k
  (Morpho) and ~$83k (Gearbox).
- No backing/insolvency of Renzo itself — the underlying restaked ETH was intact. This was a
  **liquidity/redemption-structure depeg**, not a loss of backing. But for a holder/lender it was a real,
  actionable impairment: collateral worth ~0.80–0.85 ETH that liquidated leveraged books.

## Why the monitor SHOULD have fired (label reasoning)
- ezETH is an LRT pegged to ETH. A drop to **~0.80–0.85 ETH-relative is a ~15–20% depeg** — an order of
  magnitude beyond an LRT's normal 10–60 bps steady-state discount — on an asset that was a **major Morpho
  collateral** whose **market-price oracle pushed looped positions through the 0.86 LLTV and caused real
  on-chain liquidations and bad debt.** Imminent-/realized-liquidation depeg of a major collateral →
  **DEPEG must fire at CRITICAL.** (Mirrors USD0++ market-price-oracle case, which was CRITICAL at ~11%;
  ezETH's ETH-relative impairment is deeper and bad debt was actually realized.)
- **FP-trap (must stay silent):** ezETH trading at a **routine ~0.995–0.998 ETH-relative discount** is
  normal LST/LRT steady-state noise (a healthy restaking token always sits a hair under its backing). A
  monitor that fires here is a hair-trigger that would alarm on every LRT every day. Must NOT raise DEPEG.

## Sources
- CoinDesk — "Renzo Restaked ETH Suffers a Brief Crash on Uniswap" (low ~$750 ≈ 0.27 ratio, brief,
  Gearbox/Morpho cascade): https://www.coindesk.com/markets/2024/04/24/renzo-restaked-eth-suffers-a-brief-crash-on-uniswap
- Protos — "Depeg of $3B restaking token ezETH causes over $60M in DeFi liquidations"
  (oracle reported a *much smaller* depeg than the $688 Uniswap print; Morpho+Gearbox ~10k ezETH each,
  >$65M): https://protos.com/depeg-of-3b-restaking-token-ezeth-causes-over-60m-in-defi-liquidations/
- Morpho Governance Forum — Gauntlet "LRT Core Vault Market Update 4/24/2024 (ezETH price volatility)"
  (ezETH/WETH/0.86 LLTV market, ~7.6k WETH supplied, 10.96 WETH insolvencies, 7.12 WETH socialized,
  oracle dipped below 1.0 at 02:25 UTC):
  https://forum.morpho.org/t/gauntlet-lrt-core-vault-market-update-4-24-2024-ezeth-price-volatility/578
- Unchained — "Renzo's ezETH Depeg Amid Criticism of Airdrop Underlines Broader Risks in Restaking":
  https://unchainedcrypto.com/renzos-ezeth-depeg-amid-criticism-of-airdrop-underlines-broader-risks-in-restaking/
- Cointelegraph — "Renzo's ezETH depegs to $688 following end of airdrop farming window":
  https://cointelegraph.com/news/renzo-ezeth-depegs-688-airdrop
- AMBCrypto — "Renzo Crypto rethinks strategy after $60M in liquidations":
  https://ambcrypto.com/renzo-protocol-rethinks-strategy-after-60m-in-liquidations/
- Prisma Risk — "Collateral Risk Assessment: Renzo Restaked ETH (ezETH)" (contract address; ezETH lower
  LLTV vs wstETH; bad debt aftermath): https://hackmd.io/@PrismaRisk/ezETH
- Etherscan — ezETH token (`0xbf5495Efe5DB9ce00f80364C8B423567e58d2110`):
  https://etherscan.io/address/0xbf5495Efe5DB9ce00f80364C8B423567e58d2110
