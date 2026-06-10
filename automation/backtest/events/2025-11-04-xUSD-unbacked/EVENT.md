# Stream Finance xUSD — unbacked recursive stablecoin collapse (Nov 4–7, 2025)

**Event ID:** `2025-11-04-xUSD-unbacked`
**Class:** UNBACKED_SUPPLY (mint > real backing) + downstream DEPEG / contagion.
**Status:** closed.

## TL;DR
Stream Finance's yield-bearing "stable" token **xUSD** was minted and looped far beyond
its real collateral. On-chain analysts flagged ~**$170M of real backing assets against
~$530M of borrowing** (≈**4.1x leverage**) more than a week *before* the blow-up. On
**Nov 4, 2025** Stream disclosed a **~$93M loss** by an off-chain "external fund manager,"
froze withdrawals, and within ~24h xUSD fell from its $1 peg to ~$0.26–$0.30 (≈ -77%),
later trading $0.07–$0.14. The synthetic stablecoin **deUSD** (Elixir), ~65% backed by a
$68M loan to Stream collateralized by xUSD, collapsed ~98% to ~$0.015. Total interconnected
exposed debt across DeFi lending venues: **~$285M**.

This is a textbook **unbacked-supply** event: circulating/looped xUSD claims dollars that the
protocol provably did not hold. The state was *detectable from a single snapshot* (Σ supply
vs. real NAV), which is exactly what the UNBACKED_SUPPLY monitor exists to catch — the
under-collateralization predated the depeg by days.

## What xUSD was
- xUSD = deposit receipt of an on-chain "tokenized hedge fund" (Stream Finance, app domain
  `streamprotocol.money`). sxUSD = staked xUSD. Marketed as a ~$1 yield-bearing stable with a
  flat ~15% APY (a red flag — yields looked manually set, not market-derived).
- Backing was a mix of on-chain positions plus capital handed to **off-chain "external
  managers"** running opaque strategies. The portion that broke it was off-chain and
  unverifiable on a block explorer — so the *on-chain* collateral was already far short of
  circulating xUSD before any loss was disclosed.

## The unbacked / recursive-loop mechanics
xUSD was used as its own collateral and re-borrowed across venues:
> deposit USDC → mint xUSD → post xUSD as collateral on venue A → borrow → re-deposit →
> mint more → post on venue B → borrow → repeat (3–4 cycles).

This turned ~**$160–170M of genuine deposits** into a claimed ~**$520M deployed / ~$530M
borrowed**. The recursion spanned **Morpho, Euler, Silo** (and Gearbox/Compound-adjacent
markets) and multiple curators (TelosC ~$123.6M, Re7, MEV Capital, Treeve, Varlamore, etc.).
Because the same xUSD was rehypothecated, **Σ(xUSD recognized as collateral across venues)
vastly exceeded the real NAV** — the definition of an unbacked-mint state.

## Timeline (UTC)
- **~Oct 28, 2025** — on-chain analyst **CBB0FE** publicly flags ~$170M backing vs ~$530M
  borrowing (4.1x). Under-collateralization is visible BEFORE the loss. (Detection window.)
- **Late Oct** — Stream vault AUM peaks ~$400–520M; TVL ~$204M end-Oct.
- **Nov 4, 2025** — Stream discloses **~$93M loss** from an external fund manager (loss reportedly
  tied to the Oct 2025 Balancer-related blow-ups / opaque strategies); **withdrawals frozen**.
  xUSD falls to ~$0.50 then ~$0.26–$0.30 within 24h (≈ -70% to -77%). ~$160M deposits frozen.
- **Nov 5–6** — Contagion: Elixir **deUSD** (≈65% backed by a $68M xUSD-collateralized loan to
  Stream via a private Morpho market) collapses ~98% → ~$0.015; Elixir halts. Curators
  (Euler/Morpho/Silo markets) left with borrows exceeding xUSD collateral value; bad debt
  crystallizes (e.g. Yei sfastUSD ~$8.6M, MEV Capital ~$650k).
- **Nov 7–8** — xUSD ~$0.07–$0.14, effectively no liquidity. Total exposed debt ~$285M;
  ~$1B+ of outflows across DeFi that week. Stream engages Perkins Coie for investigation.

## Numbers that anchor the label
- **Real on-chain backing (NAV):** ~**$170,000,000** (CBB0FE, ~Oct 28). The honest "dollars we
  actually hold" figure; the off-chain $93M was *part of* what was claimed and then vanished.
- **xUSD recognized supply / borrowing claim:** ~**$530,000,000** borrowed against it; AUM
  claimed up to ~$517–520M; circulating xUSD ~200M tokens (~$200M+ at peg before the crash;
  CoinGecko later shows ~204M tokens total supply).
- **Leverage:** ~4.1x. **Unbacked gap:** circulating/borrowed dollars ≫ NAV by ~3–4x.
- **Depeg low:** ~$0.07–$0.14 (intraday ~$0.26–$0.30 on day one). Off-chain/oracle prices
  stayed stale near $1.06–$1.26 while market was near-zero — i.e. venue oracles were blind,
  exactly the failure mode an *independent* supply-vs-backing monitor is meant to bypass.

## Chains xUSD was live on (CRITICAL for capture)
Per multiple reports, xUSD/xBTC/xETH collateral and borrows spanned:
**Ethereum, Arbitrum, Avalanche, Plasma, Sonic.**
- **Readable by us** {ethereum, arbitrum, optimism, base, polygon}: **Ethereum, Arbitrum**.
- **NOT readable (flagged):** **Avalanche, Plasma, Sonic.** A live Σremote capture will be
  INCOMPLETE — it will UNDER-count circulating xUSD, biasing toward a *false-negative* (looks
  more backed than it was). Therefore prefer a **hand-built snapshot** with researched
  supply/backing numbers, or treat the live capture as a lower bound. Even Ethereum-only
  supply already exceeds the real NAV, so the unbacked state is detectable regardless.

## Contract addresses (Etherscan / explorers)
- **xUSD (Staked Stream USD), Ethereum:** `0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94`
  — `decimals = 6` (NOT 18; load-bearing for base-unit math), name "Staked Stream USD",
  symbol xUSD, LayerZero-style omnichain vault (`app.streamprotocol.money`).
  https://etherscan.io/token/0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94
- **xUSD, Arbitrum:** `0xe80772eaf6e2e18b651f160bc9158b2a5cafca65`
  https://arbiscan.io/token/0xe80772eaf6e2e18b651f160bc9158b2a5cafca65
- **xUSD, Avalanche (NOT readable):** `0x94f9bb5c972285728dcee7eaece48bec2ff341ce` (per CoinGecko)
- **xUSD, Plasma (NOT readable):** `0x6eaf19b2fc24552925db245f9ff613157a7dbb4c` (per CoinGecko)
- **xUSD, Sonic (NOT readable):** address not yet confirmed from a primary source.
- **Authorized minters:** xUSD mint authority sits with the Stream vault/deployer (the
  StreamVault omnichain contract is the canonical minter; Stream's deployer/multisig controls
  it). No primary source enumerates a fixed minter allowlist; reports only say Stream itself
  minted and re-looped. Treat as "minter = StreamVault / Stream deployer," unverified beyond that.

## Decimals caveat
Etherscan reports **xUSD decimals = 6**. The label schema text says "18 decimals unless you
note otherwise" — **noted: xUSD is 6 decimals.** Any base-unit backing/supply figure in the
read-plan below is expressed in **6-decimal base units**.

## Why HIGH (not CRITICAL) for a single snapshot
A single point-in-time snapshot can prove Σ(circulating/remote xUSD) > real backing — a
strong, actionable unbacked-mint signal → **HIGH**. It cannot, from one poll, distinguish a
*persistent* breach from a transient in-flight bridging skew (mid-bridge, remote can momentarily
exceed locked backing). CRITICAL/"page now" is reserved for breaches corroborated across
multiple polls + secondary evidence. Here the breach was in fact persistent and ~3–4x, but the
*defensible* severity for the labeled single-snapshot case is **HIGH**.

## Sources
- Yahoo/Bloomberg — "Stream Finance Loses $93 Million as Stablecoin XUSD Collapses"
  https://finance.yahoo.com/news/stream-finance-loses-93-million-225557903.html
- BlockEden — "Anatomy of a $285M DeFi Contagion: The Stream Finance xUSD Collapse"
  https://blockeden.xyz/blog/2025/11/08/m-defi-contagion/
- Tiger Research — "Collapse of the DeFi Jenga: The Stream Finance breakdown"
  https://reports.tiger-research.com/p/collapse-of-the-defi-jenga-the-stream-eng
- CCN — "Why xUSD depegged: Stream Finance stablecoin crisis explained"
  https://www.ccn.com/education/crypto/why-xusd-depegged-stream-finance-stablecoin-crisis-explained/
- CoinGecko — Staked Stream USD (XUSD): addresses (ETH/Avalanche/Plasma), supply, depeg
  https://www.coingecko.com/en/coins/staked-stream-usd
- Arbitrum forum — "Update: Stream Finance (XUSD) Situation and Impact Assessment"
  https://forum.arbitrum.foundation/t/update-stream-finance-xusd-situation-and-impact-assessment/30206
- Etherscan — xUSD token page (decimals=6, supply, holders)
  https://etherscan.io/token/0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94
- CBB0FE (on-chain analyst, ~Oct 28) — $170M backing vs $530M borrowing / 4.1x leverage (cited in above).

## CAPTURE CORRECTION (orchestrator, on-chain @ block 23725820, 2025-11-04T12:00 UTC)
The earlier claim "even Ethereum-only supply already exceeds NAV" is **WRONG** and is corrected here.
On-chain xUSD `totalSupply` on **Ethereum = 85,818,938** (6dp; verified via Alchemy archive). The
researched real NAV is ~$170M. So **Ethereum-only supply (85.8M) is BELOW backing (170M)** — the
unbacked breach is NOT visible from the readable chain alone. The UNBACKED_SUPPLY detection in this
backtest case therefore depends on the RESEARCHED cross-chain circulating total (~200M tokens across
ETH+Arbitrum+Avalanche+Plasma+Sonic) exceeding the RESEARCHED off-chain NAV (~170M).

FIDELITY: lowest of the corpus. The Alchemy app key is **Ethereum-only** (ARB_MAINNET et al. not
enabled), and xUSD's "backing" was OFF-CHAIN manager-held NAV — so neither a snapshot NOR a full fork
could verify the breach on-chain. This event was, in reality, NOT snapshot-detectable via backing; the
only on-chain signal was the eventual depeg. The case is retained as a transparently-RESEARCHED
exercise of the d09 unbacked-supply logic, with this caveat on the record.
