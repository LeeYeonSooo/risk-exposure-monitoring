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
