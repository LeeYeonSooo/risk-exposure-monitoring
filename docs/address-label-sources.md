# Address Label Sources

Goal: keep protocol/CEX/bridge/router/solver addresses out of wallet-like EOA clustering.

## Primary

- Dune `labels.addresses`
  - Use for bulk refresh into `frontend/data/known-counterparties.generated.json`.
  - Table fields include `blockchain`, `address`, `name`, `category`, `source`, `updated_at`, `model_name`.
  - Refresh command: `DUNE_API_KEY=... npm run labels:sync -- --limit=25000`.
  - Categories are mapped into local `cex`, `bridge`, `router`, `solver`, `protocol`.

## Paid Point Lookup

- Etherscan V2 `nametag/getaddresstag`
  - Good for precise single-address lookup when a Pro Plus key is available.
  - Rate limit is 2 calls/sec for the metadata endpoint.
  - Do not use as the bulk path unless budget is explicit.

## Public Dumps / Research Fallbacks

- `brianleect/etherscan-labels`
  - Historical JSON/CSV scrape of Etherscan-like labels across top EVM chains.
  - Useful as a one-time seed, but stale.
- `dawsbot/eth-labels`
  - Etherscan-derived public dataset plus local API/scraper.
  - Useful for development and seeding if Dune is unavailable.
- MetaSleuth / BlockSec Address Label API
  - Paid/commercial API that returns entity-style labels across many chains.
  - Good candidate for production fallback if we need richer labels than Dune.

## Local Files

- `frontend/data/known-counterparties.manual.json`: audited manual overrides.
- `frontend/data/known-counterparties.generated.json`: machine-generated bulk labels.
- `frontend/lib/known-counterparties.ts`: normalizes both JSON files into the runtime registry.
