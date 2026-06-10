# Protocol logos

Drop a protocol's logo here as `<slug>.svg` (or change the extension in
`components/graph/ProtocolMark.tsx`) and graph nodes will use the real logo
instead of the brand-coloured monogram fallback.

Slugs (see `components/graph/protocols.ts`):

| slug         | protocol     |
|--------------|--------------|
| morpho       | Morpho Blue  |
| aave         | Aave V3      |
| spark        | Spark        |
| pendle       | Pendle       |
| lido         | Lido         |
| etherfi      | ether.fi     |
| renzo        | Renzo        |
| kelp         | Kelp         |
| rocketpool   | Rocket Pool  |
| coinbase     | Coinbase     |
| sky          | Sky          |
| frax         | Frax         |
| stader       | Stader       |
| mantle       | Mantle       |

Example: save Morpho's logo as `morpho.svg` here. No code change needed —
`ProtocolMark` loads `/protocols/morpho.svg` automatically and falls back to the
monogram if the file is missing.
