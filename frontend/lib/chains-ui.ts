/**
 * Single source of truth for the chain selector — used by BOTH 관계맵 and 흐름맵 so the
 * checkbox list is identical. These are the chains we can actually load real data for
 * (DeFiLlama + Morpho + public-RPC, i.e. flow-core's CHAIN_MAP). A token's own exposure
 * chains are unioned on top so nothing the token is actually on is ever missing.
 *
 * **EVM 전용** (팀 결정 2026-06-12, 멘토 피드백 "EVM 우선"): 비-EVM(Solana·Tron·Sui·
 * Aptos·Starknet)은 선택지·수집 경로에서 제거됨 — 어댑터 코드도 함께 삭제(git 이력에 보존).
 *
 * 최종 기준(2026-06-12, 팀 확정): **이더리움 메인넷 · Base · Arbitrum 3개만** — 이 셋을
 * 확실하게 (그래프·실시간 30분·평소 24h 풀 파이프라인). 다른 체인은 전부 제외.
 */
export const SUPPORTED_CHAINS: { key: string; label: string }[] = [
  { key: "ethereum", label: "Ethereum" },
  { key: "base", label: "Base" },
  { key: "arbitrum", label: "Arbitrum" },
];

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
