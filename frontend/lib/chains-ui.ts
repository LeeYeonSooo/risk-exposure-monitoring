/**
 * Single source of truth for the chain selector — used by BOTH 관계맵 and 흐름맵 so the
 * checkbox list is identical. These are the chains we can actually load real data for
 * (DeFiLlama + Morpho + public-RPC, i.e. flow-core's CHAIN_MAP). A token's own exposure
 * chains are unioned on top so nothing the token is actually on is ever missing.
 */
// 2026-06-12 스코프 축소: 이더리움·베이스·아비트럼 3체인 완성 우선 (비EVM 제거).
// 다른 EVM 체인은 3체인 완성 후 여기 + flow-core CHAIN_MAP + /api/transactions ALCHEMY_NET 에 추가.
export const SUPPORTED_CHAINS: { key: string; label: string }[] = [
  { key: "ethereum", label: "Ethereum" },
  { key: "base", label: "Base" },
  { key: "arbitrum", label: "Arbitrum" },
];

/** 라이브 트랜잭션 입자를 지원하는 체인 = /api/transactions 의 ALCHEMY_NET 키와 동일(거울). */
export const LIVE_TX_CHAINS = new Set(["ethereum", "base", "arbitrum"]);
export const hasLiveTx = (chain: string) => LIVE_TX_CHAINS.has(chain.toLowerCase());

const LABELS = new Map(SUPPORTED_CHAINS.map((c) => [c.key, c.label] as const));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** 체인 키 → 표시 이름(Ethereum/Base/Arbitrum…). 미등록 키는 첫 글자 대문자 폴백. */
export function chainLabel(key: string): string {
  return LABELS.get(key.toLowerCase()) ?? cap(key);
}

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
