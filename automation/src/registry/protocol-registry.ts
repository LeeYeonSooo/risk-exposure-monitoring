/**
 * Canonical Protocol Registry — 모든 contract 주소 → protocol node_id.
 *
 * 핵심 invariant:
 *   같은 protocol의 contract 들은 어떤 토큰을 스캔하든 동일한 node_id 로 매핑.
 *
 * 사용:
 *   import { lookupProtocol, registerNew } from "./protocol-registry"
 *   const p = lookupProtocol("0x5ee5bf7a…")   // → "protocol:aave_v3"
 *
 * 확장:
 *   새 protocol 발견 시 (snapshot/classify.ts 에서 알람)
 *   → 사람이 검토 → 이 파일에 entry 추가 + node_id 부여 → 재배포.
 */

import type { Address } from "viem";

export interface ProtocolRegistryEntry {
  /** lower-case hex */
  address: string;
  /** stable, canonical node id across all token scans */
  protocolNodeId: string;
  /** family identifier (used by adapter dispatch) */
  family: string;
  /** human-readable role of this specific contract within the protocol */
  role: string;
  /** optional asset hint (which token this contract is associated with, if any) */
  associatedToken?: string;
}

// ─────────────────────────────────────────────────────────────
// Aave V3 — single Pool, many aTokens (one per reserve)
// ─────────────────────────────────────────────────────────────
const AAVE_V3: ProtocolRegistryEntry[] = [
  { address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "pool" },
  { address: "0x41393e5e337606dc3821075af65aee84d7688cbd", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "data_provider" },
  // aTokens (one per reserve) — 확장 가능
  { address: "0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "aToken", associatedToken: "WBTC" },
  { address: "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "aToken", associatedToken: "USDC" },
  { address: "0x23878914efe38d27c4d67ab83ed1b93a74d4086a", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "aToken", associatedToken: "USDT" },
  { address: "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "aToken", associatedToken: "WETH" },
  { address: "0x0b925ed163218f6662a35e0f0371ac234f9e9371", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "aToken", associatedToken: "wstETH" },
  { address: "0xbdfa7b7893081b35fb54027489e2bc7a38275129", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "aToken", associatedToken: "weETH" },
  { address: "0x4f5923fc5fd4a93352581b38b7cd26943012decf", protocolNodeId: "protocol:aave_v3", family: "aave_v3", role: "aToken", associatedToken: "sUSDe" },
];

// ─────────────────────────────────────────────────────────────
// Aave V2 (legacy)
// ─────────────────────────────────────────────────────────────
const AAVE_V2: ProtocolRegistryEntry[] = [
  { address: "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9", protocolNodeId: "protocol:aave_v2", family: "aave_v2", role: "pool" },
  { address: "0x9ff58f4ffb29fa2266ab25e75e2a8b3503311656", protocolNodeId: "protocol:aave_v2", family: "aave_v2", role: "aToken", associatedToken: "WBTC" },
];

// ─────────────────────────────────────────────────────────────
// Morpho Blue
// ─────────────────────────────────────────────────────────────
const MORPHO_BLUE: ProtocolRegistryEntry[] = [
  { address: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", protocolNodeId: "protocol:morpho_blue", family: "morpho_blue", role: "core" },
];

// ─────────────────────────────────────────────────────────────
// Compound V3 (Comet contracts, one per base asset)
// ─────────────────────────────────────────────────────────────
const COMPOUND_V3: ProtocolRegistryEntry[] = [
  { address: "0xc3d688b66703497daa19211eedff47f25384cdc3", protocolNodeId: "protocol:compound_v3", family: "compound_v3", role: "comet", associatedToken: "USDC" },
  { address: "0x3afdc9bca9213a35503b077a6072f3d0d5ab0840", protocolNodeId: "protocol:compound_v3", family: "compound_v3", role: "comet", associatedToken: "USDT" },
  { address: "0xa17581a9e3356d9a858b789d68b4d866e593ae94", protocolNodeId: "protocol:compound_v3", family: "compound_v3", role: "comet", associatedToken: "WETH" },
  { address: "0xccf4429db6322d5c611ee964527d42e5d685dd6a", protocolNodeId: "protocol:compound_v3", family: "compound_v3", role: "comet" },
];

// ─────────────────────────────────────────────────────────────
// Spark (Aave V3 fork, Sky DAO)
// ─────────────────────────────────────────────────────────────
const SPARK: ProtocolRegistryEntry[] = [
  { address: "0xc13e21b648a5ee794902342038ff3adab66be987", protocolNodeId: "protocol:spark", family: "spark", role: "pool" },
  { address: "0x4197ba364ae6698015ae5c1468f54087602715b2", protocolNodeId: "protocol:spark", family: "spark", role: "aToken", associatedToken: "WBTC" },
];

// ─────────────────────────────────────────────────────────────
// Maker (WBTC ilks)
// ─────────────────────────────────────────────────────────────
const MAKER: ProtocolRegistryEntry[] = [
  { address: "0xbf72da2bd84c5170618fbe5914b0eca9638d5eb5", protocolNodeId: "protocol:maker", family: "maker", role: "gem_join", associatedToken: "WBTC-A" },
  { address: "0xfa8c996e158b80d77fbd0082bb437556a65b96e0", protocolNodeId: "protocol:maker", family: "maker", role: "gem_join", associatedToken: "WBTC-B" },
  { address: "0x7f62f9592b823331e012d3c5ddf2a7714cfb9de2", protocolNodeId: "protocol:maker", family: "maker", role: "gem_join", associatedToken: "WBTC-C" },
];

// ─────────────────────────────────────────────────────────────
// Fluid (Instadapp)
// ─────────────────────────────────────────────────────────────
const FLUID: ProtocolRegistryEntry[] = [
  { address: "0x52aa899454998be5b000ad077a46bbe360f4e497", protocolNodeId: "protocol:fluid", family: "fluid", role: "liquidity_proxy" },
];

// ─────────────────────────────────────────────────────────────
// Ether.fi BoringVault (eBTC backing)
// ─────────────────────────────────────────────────────────────
const ETHERFI: ProtocolRegistryEntry[] = [
  { address: "0x657e8c867d8b37dcc18fa4caead9c45eb088c642", protocolNodeId: "protocol:etherfi_boringvault", family: "etherfi_boringvault", role: "vault" },
];

// ─────────────────────────────────────────────────────────────
// f(x) protocol (AladdinDAO)
// ─────────────────────────────────────────────────────────────
const FX: ProtocolRegistryEntry[] = [
  { address: "0x250893ca4ba5d05626c785e8da758026928fcd24", protocolNodeId: "protocol:fx", family: "fx", role: "vault" },
];

// ─────────────────────────────────────────────────────────────
// Uniswap V3 / V4 — Factory + Universal Router (개별 pool은 factory 통해 발견)
// ─────────────────────────────────────────────────────────────
const UNISWAP_V3: ProtocolRegistryEntry[] = [
  { address: "0x1f98431c8ad98523631ae4a59f267346ea31f984", protocolNodeId: "protocol:uniswap_v3", family: "uniswap_v3", role: "factory" },
  { address: "0xe592427a0aece92de3edee1f18e0157c05861564", protocolNodeId: "protocol:uniswap_v3", family: "uniswap_v3", role: "swap_router" },
  // 알려진 WBTC pools — 발견 시 자동 등록 가능
  { address: "0x4585fe77225b41b697c938b018e2ac67ac5a20c0", protocolNodeId: "protocol:uniswap_v3", family: "uniswap_v3", role: "pool", associatedToken: "WBTC/WETH 0.05%" },
  { address: "0x99ac8ca7087fa4a2a1fb6357269965a2014abc35", protocolNodeId: "protocol:uniswap_v3", family: "uniswap_v3", role: "pool", associatedToken: "WBTC/USDC 0.3%" },
  { address: "0xcbcdf9626bc03e24f779434178a73a0b4bad62ed", protocolNodeId: "protocol:uniswap_v3", family: "uniswap_v3", role: "pool", associatedToken: "WBTC/WETH 0.3%" },
];
const UNISWAP_V2: ProtocolRegistryEntry[] = [
  { address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f", protocolNodeId: "protocol:uniswap_v2", family: "uniswap_v2", role: "factory" },
  { address: "0xceff51756c56ceffca006cd410b03ffc46dd3a58", protocolNodeId: "protocol:uniswap_v2", family: "uniswap_v2", role: "pair", associatedToken: "WBTC/WETH" },
];
const UNISWAP_UNIVERSAL: ProtocolRegistryEntry[] = [
  { address: "0x000000000004444c5dc75cb358380d2e3de08a90", protocolNodeId: "protocol:uniswap_v3", family: "uniswap_v3", role: "universal_router" },
];

// ─────────────────────────────────────────────────────────────
// Curve / Yield Basis / Aster
// ─────────────────────────────────────────────────────────────
const CURVE: ProtocolRegistryEntry[] = [
  { address: "0xd51a44d3fae010294c616388b506acda1bfaae46", protocolNodeId: "protocol:curve", family: "curve", role: "pool", associatedToken: "tricrypto2" },
  { address: "0x7f86bf177dd4f3494b841a37e810a34dd56c829b", protocolNodeId: "protocol:curve", family: "curve", role: "pool", associatedToken: "tricryptoUSDC" },
  { address: "0xe0438eb3703bf871e31ce639bd351109c88666ea", protocolNodeId: "protocol:curve", family: "curve", role: "pool" },
];
const YIELD_BASIS: ProtocolRegistryEntry[] = [
  { address: "0x313698667d7fdd6789a9bc70821309ff891e729a", protocolNodeId: "protocol:yield_basis", family: "yield_basis", role: "pool", associatedToken: "WBTC-crvUSD" },
  { address: "0xd9ff8396554a0d18b2cfbec53e1979b7ecce8373", protocolNodeId: "protocol:yield_basis", family: "yield_basis", role: "share", associatedToken: "cyb-wbtc" },
];
const ASTER: ProtocolRegistryEntry[] = [
  { address: "0x604dd02d620633ae427888d41bfd15e38483736e", protocolNodeId: "protocol:aster", family: "aster", role: "perp_pool" },
];

// ─────────────────────────────────────────────────────────────
// Bridges — token 메타데이터로 흡수되지만 분류 시점엔 protocol-level 노드 매칭이 필요할 수 있음
// (현재 그래프 모델에선 bridge가 노드 아님; 여기 등록만 해두면 holder 분류 시 bridge 로 마킹됨)
// ─────────────────────────────────────────────────────────────
const BRIDGES: ProtocolRegistryEntry[] = [
  { address: "0xa3a7b6f88361f48403514059f1f16c8e78d60eec", protocolNodeId: "bridge:arbitrum", family: "bridge", role: "canonical_gateway" },
  { address: "0x3ee18b2214aff97000d974cf647e7c347e8fa585", protocolNodeId: "bridge:wormhole", family: "bridge", role: "lock" },
  { address: "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf", protocolNodeId: "bridge:polygon", family: "bridge", role: "predicate" },
  { address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c", protocolNodeId: "bridge:layerzero", family: "bridge", role: "oft_adapter" },
  { address: "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", protocolNodeId: "bridge:optimism", family: "bridge", role: "canonical_gateway" },
  { address: "0x8eb8a3b98659cce290402893d0123abb75e3ab28", protocolNodeId: "bridge:avalanche", family: "bridge", role: "lock" },
  { address: "0xf7a5159085722718dc1276de5979df468975ec11", protocolNodeId: "bridge:gnosis", family: "bridge", role: "lock" },
  { address: "0xc186fa914353c44b2e33ebe05f21846f1048beda", protocolNodeId: "bridge:across", family: "bridge", role: "messaging" },
  { address: "0x312e67b47a2a29ae200184949093d92369f80b53", protocolNodeId: "bridge:sui", family: "bridge", role: "lock" },
  { address: "0x4f4495243837681061c4743b74b3eedf548d56a5", protocolNodeId: "bridge:axelar", family: "bridge", role: "lock" },
];

// ─────────────────────────────────────────────────────────────
// CEX / Custody / Treasury — 그래프 외부지만 분류 위해 등록
// ─────────────────────────────────────────────────────────────
const NON_PROTOCOL: ProtocolRegistryEntry[] = [
  { address: "0xf977814e90da44bba6c66db48c5e96a4d1c84e8f", protocolNodeId: "external:binance", family: "cex", role: "vault" },
  { address: "0x28c6c06298d514db089934071355e5743bf21d60", protocolNodeId: "external:binance", family: "cex", role: "vault" },
  { address: "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43", protocolNodeId: "external:coinbase", family: "cex", role: "deposit" },
];

// ─────────────────────────────────────────────────────────────
// Combined lookup table
// ─────────────────────────────────────────────────────────────

const ALL_ENTRIES: ProtocolRegistryEntry[] = [
  ...AAVE_V3,
  ...AAVE_V2,
  ...MORPHO_BLUE,
  ...COMPOUND_V3,
  ...SPARK,
  ...MAKER,
  ...FLUID,
  ...ETHERFI,
  ...FX,
  ...UNISWAP_V3,
  ...UNISWAP_V2,
  ...UNISWAP_UNIVERSAL,
  ...CURVE,
  ...YIELD_BASIS,
  ...ASTER,
  ...BRIDGES,
  ...NON_PROTOCOL,
];

const _byAddress: Map<string, ProtocolRegistryEntry> = new Map(
  ALL_ENTRIES.map((e) => [e.address.toLowerCase(), e]),
);

export function lookupProtocol(address: Address | string): ProtocolRegistryEntry | null {
  return _byAddress.get(address.toLowerCase()) ?? null;
}

export function listFamily(family: string): ProtocolRegistryEntry[] {
  return ALL_ENTRIES.filter((e) => e.family === family);
}

export function allEntries(): ProtocolRegistryEntry[] {
  return [...ALL_ENTRIES];
}
