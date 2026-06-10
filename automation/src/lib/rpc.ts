import { arbitrum, base, celo, linea, metis, soneium, sonic, unichain, worldchain, zksync } from "viem/chains";
import { type Chain, createPublicClient, http, type PublicClient } from "viem";

import { CHAIN, env, MULTICALL3, RPC_URL } from "@/config/chains";

/**
 * 체인별 RPC 클라이언트 (멀티체인). Multicall3 는 모든 체인에서 정규 주소
 * (0xcA11…)라 viem 의 체인 객체가 자동으로 배칭에 사용 → 토큰당 1콜로 경량.
 *
 * 우선순위(체인별): 명시 환경변수(BASE_RPC_URL 등) > Alchemy(키 있으면)
 *   > 공개 RPC(publicnode). Alchemy 앱에 해당 네트워크가 활성화돼 있으면
 *   메인넷과 동일한 신뢰도(아카이브·레이트리밋)로 깊게 조회.
 *
 * 신규 체인은 minimal Chain 객체로 정의 — multicall3 주소를 명시해야 client.multicall() 배칭이 동작
 * (viem 빌트인 체인 객체만 contracts.multicall3 를 자동 보유하므로). 0xcA11… 은 전 체인 정규 배포.
 */
const ALCHEMY_KEY = env.ALCHEMY_API_KEY;
const alchemyUrl = (sub: string) =>
  ALCHEMY_KEY ? `https://${sub}.g.alchemy.com/v2/${ALCHEMY_KEY}` : "";

// minimal Chain — multicall3 명시(배칭 필수). 읽기전용 eth_call 용도라 메타데이터는 최소.
function mk(id: number, name: string, url: string): { chain: Chain; url: string } {
  return {
    chain: {
      id, name,
      nativeCurrency: { name, symbol: name.slice(0, 4).toUpperCase(), decimals: 18 },
      rpcUrls: { default: { http: [url] } },
      contracts: { multicall3: { address: MULTICALL3 } },
    } as Chain,
    url,
  };
}
// Alchemy 지원 시 Alchemy, 아니면 공개 RPC (env override 우선).
const pick = (envKey: string, sub: string, pub: string) => process.env[envKey] || alchemyUrl(sub) || pub;

const CHAIN_RPC: Record<number, { chain: Chain; url: string }> = {
  1: { chain: CHAIN as Chain, url: RPC_URL },
  8453: { chain: base, url: process.env.BASE_RPC_URL || alchemyUrl("base-mainnet") || "https://base-rpc.publicnode.com" },
  42161: { chain: arbitrum, url: process.env.ARBITRUM_RPC_URL || alchemyUrl("arb-mainnet") || "https://arbitrum-one-rpc.publicnode.com" },
  // ── Aave V3 온체인 읽기용 (pap 검증됨) — eth·base·arb 와 동일 방식 전 체인 적용 ──
  10: mk(10, "Optimism", pick("OPTIMISM_RPC_URL", "opt-mainnet", "https://optimism-rpc.publicnode.com")),
  137: mk(137, "Polygon", pick("POLYGON_RPC_URL", "polygon-mainnet", "https://polygon-bor-rpc.publicnode.com")),
  43114: mk(43114, "Avalanche", pick("AVALANCHE_RPC_URL", "avax-mainnet", "https://avalanche-c-chain-rpc.publicnode.com")),
  56: mk(56, "BNB Chain", pick("BSC_RPC_URL", "bnb-mainnet", "https://bsc-rpc.publicnode.com")),
  100: mk(100, "Gnosis", pick("GNOSIS_RPC_URL", "gnosis-mainnet", "https://gnosis-rpc.publicnode.com")),
  534352: mk(534352, "Scroll", pick("SCROLL_RPC_URL", "scroll-mainnet", "https://scroll-rpc.publicnode.com")),
  1088: { chain: metis, url: pick("METIS_RPC_URL", "metis-mainnet", "https://metis-rpc.publicnode.com") },
  // ── viem 내장 체인 객체(multicall3 포함 — zksync 는 특수 주소라 내장 필수) + Alchemy 우선 ──
  130: { chain: unichain, url: pick("UNICHAIN_RPC_URL", "unichain-mainnet", "https://unichain-rpc.publicnode.com") },
  480: { chain: worldchain, url: pick("WORLDCHAIN_RPC_URL", "worldchain-mainnet", "https://worldchain-mainnet.g.alchemy.com/public") },
  59144: { chain: linea, url: pick("LINEA_RPC_URL", "linea-mainnet", "https://linea-rpc.publicnode.com") },
  324: { chain: zksync, url: pick("ZKSYNC_RPC_URL", "zksync-mainnet", "https://mainnet.era.zksync.io") },
  146: { chain: sonic, url: pick("SONIC_RPC_URL", "sonic-mainnet", "https://sonic-rpc.publicnode.com") },
  42220: { chain: celo, url: pick("CELO_RPC_URL", "celo-mainnet", "https://forno.celo.org") },
  1868: { chain: soneium, url: pick("SONEIUM_RPC_URL", "soneium-mainnet", "https://rpc.soneium.org") },
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
