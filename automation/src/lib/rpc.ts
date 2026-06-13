import { arbitrum, base } from "viem/chains";
import { type Chain, createPublicClient, http, type PublicClient } from "viem";

import { CHAIN, env, RPC_URL } from "@/config/chains";

/**
 * 체인별 RPC 클라이언트 (멀티체인). Multicall3 는 모든 체인에서 정규 주소
 * (0xcA11…)라 viem 의 체인 객체가 자동으로 배칭에 사용 → 토큰당 1콜로 경량.
 *
 * 우선순위(체인별): 명시 환경변수(BASE_RPC_URL 등) > Alchemy(키 있으면)
 *   > 공개 RPC(publicnode). Alchemy 앱에 해당 네트워크가 활성화돼 있으면
 *   메인넷과 동일한 신뢰도(아카이브·레이트리밋)로 깊게 조회.
 *
 * 2026-06-12 스코프 축소: 이더리움·베이스·아비트럼 3체인. 신규 체인은 viem 내장 체인 객체
 * (contracts.multicall3 자동 보유)로 여기 + config/chains.ts EVM_CHAINS 에 추가하면 된다.
 */
const ALCHEMY_KEY = env.ALCHEMY_API_KEY;
const alchemyUrl = (sub: string) =>
  ALCHEMY_KEY ? `https://${sub}.g.alchemy.com/v2/${ALCHEMY_KEY}` : "";

const CHAIN_RPC: Record<number, { chain: Chain; url: string }> = {
  1: { chain: CHAIN as Chain, url: RPC_URL },
  8453: { chain: base, url: process.env.BASE_RPC_URL || alchemyUrl("base-mainnet") || "https://base-rpc.publicnode.com" },
  42161: { chain: arbitrum, url: process.env.ARBITRUM_RPC_URL || alchemyUrl("arb-mainnet") || "https://arbitrum-one-rpc.publicnode.com" },
};

const _clients = new Map<number, PublicClient>();

export function rpcFor(chainId = 1): PublicClient {
  const cached = _clients.get(chainId);
  if (cached) return cached;
  // 미등록 체인은 메인넷으로 폴백하되 반드시 경고 — 조용한 폴백은 "엉뚱한 체인에 eth_call" 류 버그가 됨.
  if (!CHAIN_RPC[chainId]) console.warn(`[rpc] chainId ${chainId} 미등록 — ethereum 폴백 (CHAIN_RPC 에 추가 필요)`);
  const cfg = CHAIN_RPC[chainId] ?? CHAIN_RPC[1];
  const client = createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.url, { retryCount: 3, retryDelay: 600, timeout: 30_000 }),
  }) as PublicClient;
  _clients.set(chainId, client);
  return client;
}

/** 메인넷 클라이언트 (하위호환). */
export function rpc(): PublicClient {
  return rpcFor(1);
}
