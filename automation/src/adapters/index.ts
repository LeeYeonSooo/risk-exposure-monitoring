/**
 * Adapter registry — family → adapter instance.
 * snapshot/snapshot-token.ts dispatches based on the protocol family
 * returned by `lookupProtocol()` for each holder.
 */

import type { Address } from "viem";

import { aaveV2Adapter } from "./aave-v2";
import { aaveV3Adapter } from "./aave-v3";
import { compoundV3Adapter } from "./compound-v3";
import { fluidAdapter } from "./fluid";
import { makeGenericBalanceAdapter } from "./generic-balance";
import { morphoBlueAdapter } from "./morpho-blue";
import { sparkAdapter } from "./spark";
import type { ProtocolAdapter } from "./types";

// ─────────────────────────────────────────────────────────────
// Generic-balance adapters (no dedicated param fetch yet)
// ─────────────────────────────────────────────────────────────

const makerAdapter = makeGenericBalanceAdapter({
  family: "maker",
  protocolNodeId: "protocol:maker",
  label: "Maker (WBTC ilks)",
  address: "0xbf72da2bd84c5170618fbe5914b0eca9638d5eb5",
  architecture: "cdp",
  governance: "Sky",
  edgeType: "cdp_collateral",
  venueType: "cdp",
  protocolClass: "cdp",
  watchAddresses: [
    "0xbf72da2bd84c5170618fbe5914b0eca9638d5eb5" as Address, // WBTC-A
    "0xfa8c996e158b80d77fbd0082bb437556a65b96e0" as Address, // WBTC-B
    "0x7f62f9592b823331e012d3c5ddf2a7714cfb9de2" as Address, // WBTC-C
  ],
});

// Fluid → 전용 어댑터(./fluid). LiquidityResolver 로 실 utilization/liquidity/총공급.
// (이전 generic-balance balanceOf-only 대체)

const etherfiAdapter = makeGenericBalanceAdapter({
  family: "etherfi_boringvault",
  protocolNodeId: "protocol:etherfi_boringvault",
  label: "Ether.fi BoringVault",
  address: "0x657e8c867d8b37dcc18fa4caead9c45eb088c642",
  architecture: "multi_asset_basket",
  governance: "Ether.fi",
  edgeType: "mint_backing",
  venueType: "vault",
  protocolClass: "wrapper",
  watchAddresses: ["0x657e8c867d8b37dcc18fa4caead9c45eb088c642" as Address],
  wrapper: {
    issuedToken: "eBTC",
    backingShare: null,
    coBackingTokens: null,
    redemption: "BoringVault exit()",
    manager: "Ether.fi",
  },
});

const fxAdapter = makeGenericBalanceAdapter({
  family: "fx",
  protocolNodeId: "protocol:fx",
  label: "f(x) protocol",
  address: "0x250893ca4ba5d05626c785e8da758026928fcd24",
  architecture: "leveraged_stable_cdp",
  governance: "AladdinDAO",
  edgeType: "mint_backing",
  venueType: "cdp",
  protocolClass: "wrapper",
  watchAddresses: ["0x250893ca4ba5d05626c785e8da758026928fcd24" as Address],
  wrapper: {
    issuedToken: "fxBTC / fxUSD",
    backingShare: null,
    coBackingTokens: null,
    redemption: "leveraged stable mechanism",
    manager: "AladdinDAO",
  },
});

const uniV3Adapter = makeGenericBalanceAdapter({
  family: "uniswap_v3",
  protocolNodeId: "protocol:uniswap_v3",
  label: "Uniswap V3",
  address: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  architecture: "clamm",
  governance: "Uniswap DAO",
  edgeType: "lp_pair",
  venueType: "pool",
  protocolClass: "dex",
  watchAddresses: [
    "0x4585fe77225b41b697c938b018e2ac67ac5a20c0" as Address,
    "0x99ac8ca7087fa4a2a1fb6357269965a2014abc35" as Address,
    "0xcbcdf9626bc03e24f779434178a73a0b4bad62ed" as Address,
    "0x000000000004444c5dc75cb358380d2e3de08a90" as Address, // universal router
  ],
});
const uniV2Adapter = makeGenericBalanceAdapter({
  family: "uniswap_v2",
  protocolNodeId: "protocol:uniswap_v2",
  label: "Uniswap V2",
  address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
  architecture: "amm_v2",
  governance: "Uniswap DAO",
  edgeType: "lp_pair",
  venueType: "pool",
  protocolClass: "dex",
  watchAddresses: ["0xceff51756c56ceffca006cd410b03ffc46dd3a58" as Address],
});

const curveAdapter = makeGenericBalanceAdapter({
  family: "curve",
  protocolNodeId: "protocol:curve",
  label: "Curve",
  address: "0xd51a44d3fae010294c616388b506acda1bfaae46",
  architecture: "tricrypto + stableswap",
  governance: "Curve DAO",
  edgeType: "lp_pair",
  venueType: "pool",
  protocolClass: "dex",
  watchAddresses: [
    "0xd51a44d3fae010294c616388b506acda1bfaae46" as Address,
    "0x7f86bf177dd4f3494b841a37e810a34dd56c829b" as Address,
    "0xe0438eb3703bf871e31ce639bd351109c88666ea" as Address,
  ],
});
const yieldBasisAdapter = makeGenericBalanceAdapter({
  family: "yield_basis",
  protocolNodeId: "protocol:yield_basis",
  label: "Yield Basis",
  address: "0x313698667d7fdd6789a9bc70821309ff891e729a",
  architecture: "curve_based_btc_vault",
  governance: "Yield Basis",
  edgeType: "lp_pair",
  venueType: "pool",
  protocolClass: "dex",
  watchAddresses: [
    "0x313698667d7fdd6789a9bc70821309ff891e729a" as Address,
    "0xd9ff8396554a0d18b2cfbec53e1979b7ecce8373" as Address,
  ],
});
const asterAdapter = makeGenericBalanceAdapter({
  family: "aster",
  protocolNodeId: "protocol:aster",
  label: "Aster",
  address: "0x604dd02d620633ae427888d41bfd15e38483736e",
  architecture: "perp_dex",
  governance: "Aster",
  edgeType: "lp_pair",
  venueType: "pool",
  protocolClass: "dex",
  watchAddresses: ["0x604dd02d620633ae427888d41bfd15e38483736e" as Address],
});

// ─────────────────────────────────────────────────────────────
// Dispatch map
// ─────────────────────────────────────────────────────────────

export const ADAPTERS_BY_FAMILY: Record<string, ProtocolAdapter> = {
  aave_v3: aaveV3Adapter,
  aave_v2: aaveV2Adapter,
  morpho_blue: morphoBlueAdapter,
  compound_v3: compoundV3Adapter,
  spark: sparkAdapter,
  maker: makerAdapter,
  fluid: fluidAdapter,
  etherfi_boringvault: etherfiAdapter,
  fx: fxAdapter,
  uniswap_v3: uniV3Adapter,
  uniswap_v2: uniV2Adapter,
  curve: curveAdapter,
  yield_basis: yieldBasisAdapter,
  aster: asterAdapter,
};

export function allAdapters(): ProtocolAdapter[] {
  return Object.values(ADAPTERS_BY_FAMILY);
}
