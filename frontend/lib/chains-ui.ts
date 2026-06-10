/**
 * Single source of truth for the chain selector — used by BOTH 관계맵 and 흐름맵 so the
 * checkbox list is identical. These are the chains we can actually load real data for
 * (DeFiLlama + Morpho + public-RPC, i.e. flow-core's CHAIN_MAP). A token's own exposure
 * chains are unioned on top so nothing the token is actually on is ever missing.
 */
export const SUPPORTED_CHAINS: { key: string; label: string }[] = [
  { key: "ethereum", label: "Ethereum" },
  { key: "solana", label: "Solana" },
  { key: "tron", label: "Tron" },
  { key: "sui", label: "Sui" },
  { key: "aptos", label: "Aptos" },
  { key: "starknet", label: "Starknet" },
  { key: "base", label: "Base" },
  { key: "arbitrum", label: "Arbitrum" },
  { key: "optimism", label: "Optimism" },
  { key: "polygon", label: "Polygon" },
  { key: "bsc", label: "BSC" },
  { key: "avalanche", label: "Avalanche" },
  { key: "gnosis", label: "Gnosis" },
  { key: "linea", label: "Linea" },
  { key: "scroll", label: "Scroll" },
  { key: "sonic", label: "Sonic" },
  { key: "unichain", label: "Unichain" },
  { key: "berachain", label: "Berachain" },
  { key: "mantle", label: "Mantle" },
  { key: "mode", label: "Mode" },
  { key: "blast", label: "Blast" },
  { key: "fraxtal", label: "Fraxtal" },
  { key: "ink", label: "Ink" },
  { key: "metis", label: "Metis" },
  { key: "zksync", label: "ZKsync" },
  // 비-EVM — 그래프(익스포저·프로토콜·마켓)는 DeFiLlama 라이브로 동일하게 구성.
  // 라이브 트랜잭션 입자는 Alchemy getAssetTransfers(EVM 전용)라 미지원 — UI 가 정직하게 표기.
  { key: "solana", label: "Solana" },
  { key: "sui", label: "Sui" },
  { key: "tron", label: "Tron" },
  { key: "aptos", label: "Aptos" },
  { key: "starknet", label: "Starknet" },
];

/** 라이브 트랜잭션 입자를 지원하는 체인 = /api/transactions 의 ALCHEMY_NET 키와 동일(거울). */
export const LIVE_TX_CHAINS = new Set([
  "ethereum", "base", "arbitrum", "optimism", "polygon", "avalanche", "bsc", "gnosis",
  "linea", "scroll", "unichain", "zksync", "blast", "mantle", "berachain",
]);
export const hasLiveTx = (chain: string) => LIVE_TX_CHAINS.has(chain.toLowerCase());

const LABELS = new Map(SUPPORTED_CHAINS.map((c) => [c.key, c.label] as const));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** comprehensive list = supported set ∪ the token's own exposure chains (so none are missing). */
export function chainOptions(tokenChains?: string[]): { key: string; label: string }[] {
  const out = [...SUPPORTED_CHAINS];
  const have = new Set(SUPPORTED_CHAINS.map((c) => c.key));
  for (const c of tokenChains ?? []) {
    const k = c.toLowerCase();
    if (!have.has(k)) { out.push({ key: k, label: LABELS.get(k) ?? cap(k) }); have.add(k); }
  }
  return out;
}
