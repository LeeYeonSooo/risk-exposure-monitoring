# EOA Flow Agent Handoff

Updated: 2026-06-16
Branch: `grahahahahahahaha`
Repo remote: `ChainSpiral/risk-exposure-monitoring`

## Repo Split

This repo, `/Users/link/risk-exposure-monitoring-flowmap`, is the main UI and
Next.js API surface. It owns:

- `/frontend/app/eoa-flow/page.tsx`: EOA/Safe flow UI.
- `/frontend/components/eoa-flow/EoaFlowGraph.tsx`: React Flow graph, node and
  edge panels.
- `/frontend/app/api/eoa-flow/route.ts`: proxy/enrichment API used by the UI.
- `/frontend/app/api/wallet-portfolio/route.ts`: pseudo-DeBank wallet snapshot.
- `/frontend/lib/wallet-clusters.ts`: EOA/Safe/contract-wallet cluster logic.
- `/frontend/lib/known-counterparties.ts` and `/frontend/data/*`: known protocol,
  CEX, bridge, router, solver registry.

The paired repo, `/Users/link/defi-dagggg`, is the data/crawler/prototype engine.
It owns:

- `feeder/eoa_timeline.py`: EOA transfer/semantic timeline and wallet DFS.
- `mock_server.py`: local API on `127.0.0.1:8000`.
- `graphs/frontend/eoa.*.json`: generated EOA-flow artifacts.
- legacy token relation graph crawler and frontend artifacts.

The local UI usually runs from this repo on `http://127.0.0.1:3002`, while
`defi-dagggg/mock_server.py` serves graph data on `http://127.0.0.1:8000`.

## What Was Built

- Added `/eoa-flow` for address-centric flow inspection.
- Added two graph modes:
  - `d0`: center address plus protocols.
  - `d-inf`: wallet-to-wallet cluster view; protocol nodes are excluded.
- Reworked graph layout to keep the seed address centered and arrange connected
  wallets/clusters around it.
- Added straight center-to-boundary edges, selected-node highlighting, and edge
  detail panels.
- Moved event details off standalone event nodes. Events now live on edges and
  in the side panel.
- Added wallet-cluster SCC logic:
  - strong edges for mutual transfers and deployer relationships.
  - weak directed edges for one-way transfers.
  - cluster clouds around SCC-style groups.
- Added pseudo-DeBank wallet snapshot:
  - wallet token balances
  - Morpho positions
  - Aave/Spark receipt/debt-token inference
  - ERC-4626 vault share inference
  - external outflows to known infra, CEX, bridges, routers, solvers, EOA/Safe,
    contracts
  - redeemability notes
- Added Morpho borrower analysis hooks and panel fields for borrower risk inputs.
- Added known-counterparty registry and sync script scaffolding.
- Fixed fake/spoof token display by filtering unpriced/fake outflow rows.
- Fixed Kelp exploiter seed receive display:
  - `0x85d456...8ef3 -> 0x8b1b...0d3b`
  - `116,500 rsETH`
  - tx `0x1ae232...4222`
  - shown in `mint/receive 전체` as `token_receive`.
- Split fast graph load from slow portfolio enrichment:
  - initial graph load defaults to `includeClusterPortfolio=false`
  - cluster portfolio is lazy-loaded afterward.
- Added file-backed caches for expensive classification and portfolio work:
  - `eth_getCode`
  - contract creation
  - wallet portfolio full response

## Important Semantics

- `0x8b1b...0d3b` is the Kelp exploiter seed/root distribution wallet in the UI,
  not necessarily the first human attacker or first exploit caller.
- The first visible seed receive is:
  - from `0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3`
  - to `0x8b1b6c9a6db1304000412dd21ae6a70a82d60d3b`
  - `116,500 rsETH`
  - block `24908285`
  - tx `0x1ae232da212c45f35c1525f851e4c41d529bf18af862d9ce9fd40bf709db4222`
- It is classified as `token_receive`, not `token_mint`, because the ERC20
  Transfer `from` is not the zero address even if the bridge path is
  LayerZero/OFT-like.
- `infra out all` means aggregate outflows to known CEX/bridge/router/solver/
  protocol categories over the scanned history. It is not a proof that all infra
  destinations are fully known.
- `wallet out all` means aggregate outflows to cluster-eligible EOA/Safe/
  contract-wallet-like addresses.

## Current Performance Model

The intended UI behavior is:

1. Load graph and wallet cluster quickly.
2. Render immediately.
3. Lazy-load cluster portfolio/address portfolios afterward.
4. Use cache aggressively on repeated inspection.

Observed on the Kelp seed after the speed changes:

- graph-only API: about `0.36s`
- lazy cluster portfolio first fetch: about `9.6s`
- lazy cluster portfolio cached fetch: about `1.5s`

## Verification Commands

From `/Users/link/risk-exposure-monitoring-flowmap/frontend`:

```bash
npm run typecheck
```

Fast graph-only API:

```bash
curl -s 'http://127.0.0.1:3002/api/eoa-flow?address=0x8B1b6c9A6DB1304000412dd21Ae6A70a82d60D3b&depth=99&maxAddresses=20&maxNeighbors=80&includePortfolio=false&includeClusterPortfolio=false&force=1'
```

Lazy portfolio API:

```bash
curl -s 'http://127.0.0.1:3002/api/eoa-flow?address=0x8B1b6c9A6DB1304000412dd21Ae6A70a82d60D3b&depth=99&maxAddresses=20&maxNeighbors=80&includePortfolio=false&includeClusterPortfolio=true'
```

Open UI:

```text
http://127.0.0.1:3002/eoa-flow?address=0x8B1b6c9A6DB1304000412dd21Ae6A70a82d60D3b&view=d-inf&depth=99&maxAddresses=20&maxNeighbors=80&includePortfolio=false
```

## Active Branches Pushed

- `risk-exposure-monitoring`: `grahahahahahahaha`
- `defi-dagggg` remote repo `ultra-automated-token-accelerator-the-god-kuromi`:
  `grahahahahahahaha`

Keep both branches aligned when changing the EOA-flow pipeline, because the UI
depends on the data API/artifacts from `defi-dagggg`.
