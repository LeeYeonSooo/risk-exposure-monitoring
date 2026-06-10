import "dotenv/config";
import { mainnet } from "viem/chains";

export const CHAIN = mainnet;
export const CHAIN_ID = 1;

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const ALCHEMY_URL = ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "";
const EXPLICIT_RPC = process.env.RPC_URL ?? "";
const PUBLIC_FALLBACK = "https://eth.llamarpc.com";

/**
 * RPC resolution priority:
 *   1. ALCHEMY_API_KEY set → Alchemy (most reliable, supports advanced APIs like getTokenBalances)
 *   2. RPC_URL set → that exact endpoint
 *   3. Public fallback (warn — Multicall3 + complex struct decoding may be flaky)
 */
function resolveRpcUrl(): string {
  if (ALCHEMY_URL) {
    if (EXPLICIT_RPC && EXPLICIT_RPC !== ALCHEMY_URL) {
      console.warn(
        `[chains] both ALCHEMY_API_KEY and RPC_URL set — using Alchemy (preferred). RPC_URL ignored.`,
      );
    }
    return ALCHEMY_URL;
  }
  if (EXPLICIT_RPC) return EXPLICIT_RPC;
  console.warn(
    "[chains] no ALCHEMY_API_KEY or RPC_URL — falling back to public RPC. Complex contract calls (Aave V3, Compound V3) may fail intermittently. Set ALCHEMY_API_KEY for production.",
  );
  return PUBLIC_FALLBACK;
}

export const RPC_URL = resolveRpcUrl();
export const ALCHEMY_AVAILABLE = !!ALCHEMY_URL;

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

// ─────────────────────────────────────────────────────────────
// 디텍터 공용 EVM 체인 레지스트리 — bridge-authority·backing·mint/burn·로그스캔이 전부 이걸 소비.
// 이전엔 파일마다 7/11체인 사본이 따로 놀았다. backing 은 목록 밖 체인이 하나라도 있으면
// watch 전체를 skip 하므로(정합성 보호), 리스트 불일치가 곧 커버리지 구멍이었다.
// (viem 클라이언트는 lib/rpc.ts CHAIN_RPC — 체인 객체가 필요해 별도. 그래프 파이프라인의
//  Morpho/Aave 대상 체인은 scripts/snapshot-chain.ts CHAINS — pap 주소가 함께 있어 별도.)
// ─────────────────────────────────────────────────────────────
export interface EvmChainCfg {
  chainId: number;
  alchemy?: string;     // Alchemy 네트워크 슬러그 (키 있으면 우선, 전부 실키 프로브 검증됨)
  publicRpc: string;    // 공개 RPC 폴백
  avgBlockSec: number;  // 이벤트 시각 근사용 평균 블록타임(초)
}
export const EVM_CHAINS: Record<string, EvmChainCfg> = {
  ethereum:   { chainId: 1,      alchemy: "eth-mainnet",        publicRpc: "https://ethereum-rpc.publicnode.com",           avgBlockSec: 12 },
  base:       { chainId: 8453,   alchemy: "base-mainnet",       publicRpc: "https://base-rpc.publicnode.com",               avgBlockSec: 2 },
  arbitrum:   { chainId: 42161,  alchemy: "arb-mainnet",        publicRpc: "https://arbitrum-one-rpc.publicnode.com",       avgBlockSec: 0.26 },
  optimism:   { chainId: 10,     alchemy: "opt-mainnet",        publicRpc: "https://optimism-rpc.publicnode.com",           avgBlockSec: 2 },
  polygon:    { chainId: 137,    alchemy: "polygon-mainnet",    publicRpc: "https://polygon-bor-rpc.publicnode.com",        avgBlockSec: 2.1 },
  bsc:        { chainId: 56,     alchemy: "bnb-mainnet",        publicRpc: "https://bsc-rpc.publicnode.com",                avgBlockSec: 3 },
  avalanche:  { chainId: 43114,  alchemy: "avax-mainnet",       publicRpc: "https://avalanche-c-chain-rpc.publicnode.com",  avgBlockSec: 2 },
  gnosis:     { chainId: 100,    alchemy: "gnosis-mainnet",     publicRpc: "https://gnosis-rpc.publicnode.com",             avgBlockSec: 5 },
  scroll:     { chainId: 534352, alchemy: "scroll-mainnet",     publicRpc: "https://scroll-rpc.publicnode.com",             avgBlockSec: 3 },
  linea:      { chainId: 59144,  alchemy: "linea-mainnet",      publicRpc: "https://linea-rpc.publicnode.com",              avgBlockSec: 3 },
  mantle:     { chainId: 5000,   alchemy: "mantle-mainnet",     publicRpc: "https://mantle-rpc.publicnode.com",             avgBlockSec: 2 },
  metis:      { chainId: 1088,   alchemy: "metis-mainnet",      publicRpc: "https://metis-rpc.publicnode.com",              avgBlockSec: 2 },
  unichain:   { chainId: 130,    alchemy: "unichain-mainnet",   publicRpc: "https://unichain-rpc.publicnode.com",           avgBlockSec: 1 },
  worldchain: { chainId: 480,    alchemy: "worldchain-mainnet", publicRpc: "https://worldchain-mainnet.g.alchemy.com/public", avgBlockSec: 2 },
  zksync:     { chainId: 324,    alchemy: "zksync-mainnet",     publicRpc: "https://mainnet.era.zksync.io",                 avgBlockSec: 1 },
  sonic:      { chainId: 146,    alchemy: "sonic-mainnet",      publicRpc: "https://sonic-rpc.publicnode.com",              avgBlockSec: 0.6 },
  celo:       { chainId: 42220,  alchemy: "celo-mainnet",       publicRpc: "https://forno.celo.org",                        avgBlockSec: 1 },
  soneium:    { chainId: 1868,   alchemy: "soneium-mainnet",    publicRpc: "https://rpc.soneium.org",                       avgBlockSec: 2 },
};
export const EVM_CHAIN_KEYS = Object.keys(EVM_CHAINS);

/** 디텍터용 RPC URL — env(${UPPER}_RPC_URL) > Alchemy(키 있으면) > 공개 RPC. 미등록 체인 null. */
export function evmRpcUrl(chain: string): string | null {
  if (chain === "ethereum") return RPC_URL; // 기존 해석(ALCHEMY → RPC_URL → public) 유지
  const cfg = EVM_CHAINS[chain];
  if (!cfg) return null;
  const envUrl = process.env[`${chain.toUpperCase()}_RPC_URL`];
  if (envUrl) return envUrl;
  if (ALCHEMY_KEY && cfg.alchemy) return `https://${cfg.alchemy}.g.alchemy.com/v2/${ALCHEMY_KEY}`;
  return cfg.publicRpc;
}
export function chainIdOf(chain: string): number | null { return EVM_CHAINS[chain]?.chainId ?? null; }
export function avgBlockSecOf(chain: string): number { return EVM_CHAINS[chain]?.avgBlockSec ?? 12; }

export const env = {
  ALCHEMY_API_KEY: ALCHEMY_KEY,
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY ?? "",
  DUNE_API_KEY: process.env.DUNE_API_KEY ?? "",
  // 알림 채널(설계 D#9) — 설정 시에만 warning/critical 발송. 비우면 DB 적재만(기본 zero-cost).
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL ?? "",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL ?? "",
  // 유료 archive RPC(설계 D#12) — 깊은 과거 getLogs 가 필요할 때만. 비우면 publicnode bounded 스캔.
  ARCHIVE_RPC_URL: process.env.ARCHIVE_RPC_URL ?? "",
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  WATCH_LIST_SIZE: Number(process.env.WATCH_LIST_SIZE ?? 100),
  // discovery 토큰 선정 기준:
  //   (a) 누적 커버리지: 출처(Morpho 담보/Aave 리저브)를 큰 순으로 더해 이 비율에
  //       도달할 때까지 포함. 0.95 = 담보 TVL 95% 커버 (Morpho 기준 ~27토큰).
  //       0.80=핵심만, 0.99=롱테일까지. ← 주 기준
  //   (b) 절대 하한: 이 USD 미만은 먼지/테스트로 제외
  DISCOVERY_COVERAGE: Number(process.env.DISCOVERY_COVERAGE ?? 0.95),
  DISCOVERY_MIN_USD: Number(process.env.DISCOVERY_MIN_USD ?? 1_000_000),
  // 이더리움 메인넷 DeFi 발자국(DeFiLlama, Ethereum-only 풀) 기준 누적 커버리지 —
  // Morpho/Aave 너머 메인넷 DeFi 토큰 확보. 0.90 = 메인넷 DeFi TVL 90% 설명 토큰(~40개).
  // ⚠️ 스코프 = Ethereum mainnet 한정. Base(Morpho 담보 42%, cbBTC $2B 등)·L2 미포함 (의도된 범위).
  DISCOVERY_DEFI_COVERAGE: Number(process.env.DISCOVERY_DEFI_COVERAGE ?? 0.9),
  TOP_HOLDERS_LIMIT: Number(process.env.TOP_HOLDERS_LIMIT ?? 200),
  OUTPUT_DIR: process.env.OUTPUT_DIR ?? "./output",

  // ── Breadth tier (DeFiLlama 기준 기반 프로토콜 수집) ──
  // 하드코딩 대신 "TVL 임계 + 카테고리"로 근방 프로토콜을 동적으로 끌어옴.
  BREADTH_MIN_TVL_USD: Number(process.env.BREADTH_MIN_TVL_USD ?? 10_000_000),
  BREADTH_CATEGORIES: (process.env.BREADTH_CATEGORIES ??
    "Lending,CDP,CDP Manager,Yield,Yield Aggregator,Basis Trading,Derivatives,Dexs,Farm")
    .split(",").map((s) => s.trim()).filter(Boolean),
};
