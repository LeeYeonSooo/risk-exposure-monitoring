/**
 * Registry: ERC-20 receipt token → protocol node ID
 *
 * Used by `/api/portfolio` to detect wallet exposure: if a wallet holds
 * the receipt token for a protocol's WBTC position, we know it has
 * exposure to that protocol.
 *
 * NOTE: 일부 protocol (Morpho Blue, Maker CDP, f(x)) 은 transferable
 * receipt token 이 없어서 여기서 detection 불가. 그건 향후 별도 RPC
 * read 또는 subgraph 쿼리로 보강.
 */

export interface ProtocolTokenEntry {
  /** ERC20 receipt token address (lower case) */
  tokenAddress: string;
  /** matching node id in our graph */
  protocolNodeId: string;
  /** human label shown in import result */
  label: string;
}

export const PROTOCOL_TOKENS: ProtocolTokenEntry[] = [
  // Aave V3 — aEthWBTC (supplied WBTC → wallet holds aEthWBTC)
  {
    tokenAddress: "0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8",
    protocolNodeId: "protocol:aave_v3",
    label: "Aave V3 — aEthWBTC (supplied WBTC)",
  },
  // Aave V2 (legacy) — aWBTC
  {
    tokenAddress: "0x9ff58f4ffb29fa2266ab25e75e2a8b3503311656",
    protocolNodeId: "protocol:aave_v2",
    label: "Aave V2 — aWBTC (legacy supplied)",
  },
  // Spark — spWBTC
  {
    tokenAddress: "0x4197ba364ae6698015ae5c1468f54087602715b2",
    protocolNodeId: "protocol:spark",
    label: "Spark — spWBTC",
  },
  // Compound V3 — cUSDCv3 (USDC base market with WBTC collateral)
  {
    tokenAddress: "0xc3d688b66703497daa19211eedff47f25384cdc3",
    protocolNodeId: "protocol:compound_v3",
    label: "Compound V3 — cUSDCv3 (USDC supplied)",
  },
  // Ether.fi BoringVault — eBTC token (vault share)
  {
    tokenAddress: "0x657e8c867d8b37dcc18fa4caead9c45eb088c642",
    protocolNodeId: "protocol:etherfi_boringvault",
    label: "Ether.fi — eBTC (BoringVault share)",
  },
  // WBTC itself — base holding (always check)
  {
    tokenAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    protocolNodeId: "token:WBTC",
    label: "WBTC (direct holding)",
  },
];
