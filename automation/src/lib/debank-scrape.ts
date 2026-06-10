import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * DeBank 우회 스크레이프 — 전문가 인터뷰의 권장 방식.
 *
 * 동작:
 *   1. Headless Chromium 으로 debank.com/profile/<wallet> 로드
 *   2. 페이지가 내부 XHR (`/v1/protocol/...`) 응답 받을 때까지 대기
 *   3. 그 응답을 가로채서 protocol 포지션 리스트 추출
 *
 * 비용: $0 (DeBank API key 안 씀)
 *
 * 사용:
 *   const ports = await scrapeDebankPortfolio(walletAddress)
 *   ports.protocols → [{ name, chain, tvlUsd, positions: [...] }, ...]
 *
 * Caveats:
 *   - DeBank 가 페이지 구조 바꾸면 fragile
 *   - rate-limit: 분당 10건 이하 권장
 *   - Cloudflare anti-bot 회피 위해 navigator overrides 적용
 */

export interface DebankProtocolPosition {
  protocolName: string;
  chain: string;
  netUsdValue: number;
  /** Raw position details from DeBank — protocol-specific JSON */
  positions: Array<{
    name: string;
    detailTypes?: string[];
    tokens?: Array<{ symbol: string; amount: number; usdValue: number }>;
  }>;
}

export interface DebankProfile {
  address: string;
  totalUsdValue: number;
  protocols: DebankProtocolPosition[];
  walletTokens: Array<{ symbol: string; amount: number; usdValue: number; chain: string }>;
  scrapedAt: string;
}

// ── 환경 옵션 (우회 성공률↑) ──
//   DEBANK_HEADFUL=1       → 헤드풀(보이는 브라우저). Cloudflare 가 헤드리스보다 덜 챌린지.
//   DEBANK_PROFILE_DIR=경로 → 영속 프로필. CF clearance 쿠키를 재사용 → 1회 통과 후 계속 됨(핵심).
//   DEBANK_CF_WAIT_MS      → 페이지 로드 후 추가 대기(챌린지 수동해결/지연 XHR 용, 기본 3500).
const HEADFUL = process.env.DEBANK_HEADFUL === "1";
const USER_DATA_DIR = process.env.DEBANK_PROFILE_DIR || "";
const CF_WAIT_MS = Number(process.env.DEBANK_CF_WAIT_MS ?? 3500);
// 주거용 프록시 — 데이터센터 IP 차단 우회의 핵심. 예: http://user:pass@host:port (Bright Data/Oxylabs 등)
const PROXY = process.env.DEBANK_PROXY || "";

const CTX_OPTS = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  timezoneId: "America/New_York",
};
const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

let _browser: Browser | null = null;
let _ctx: BrowserContext | null = null;

// 컨텍스트 1개를 재사용(쿠키/CF clearance 유지 + 지갑 사이 빠름). 영속 프로필이면 디스크에 저장.
async function getContext(): Promise<BrowserContext> {
  if (_ctx) return _ctx;
  const proxy = PROXY ? { server: PROXY } : undefined;
  if (USER_DATA_DIR) {
    _ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: !HEADFUL, args: LAUNCH_ARGS, proxy, ...CTX_OPTS });
  } else {
    _browser = await chromium.launch({ headless: !HEADFUL, args: LAUNCH_ARGS, proxy });
    _ctx = await _browser.newContext(CTX_OPTS);
  }
  await _ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return _ctx;
}

/**
 * Scrape a wallet's DeBank portfolio. Intercepts XHR responses while page loads.
 */
export async function scrapeDebankPortfolio(walletAddress: string): Promise<DebankProfile> {
  const ctx = await getContext();
  const page: Page = await ctx.newPage();

  const protocols: DebankProtocolPosition[] = [];
  const walletTokens: DebankProfile["walletTokens"] = [];
  let totalUsdValue = 0;
  let apiResponses = 0; // DeBank 내부 API 응답 가로챈 수 — 0 이면 CF 차단/엔드포인트 변경 진단용

  // XHR 가로채기
  page.on("response", async (resp) => {
    const url = resp.url();
    // DeBank 내부 API 엔드포인트 패턴
    if (!url.includes("api.debank.com")) return;
    apiResponses++;
    try {
      const ct = resp.headers()["content-type"] ?? "";
      if (!ct.includes("application/json")) return;
      const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return;

      // /v1/user/all_complex_protocol_list — 모든 protocol 포지션
      if (url.includes("complex_protocol_list") && Array.isArray(body.data)) {
        for (const proto of body.data as Array<Record<string, unknown>>) {
          const positions = ((proto.portfolio_item_list ?? []) as Array<Record<string, unknown>>).map(
            (p) => ({
              name: String(p.name ?? "position"),
              detailTypes: (p.detail_types as string[] | undefined) ?? [],
              tokens: (
                ((p.detail as Record<string, unknown>)?.supply_token_list as
                  | Array<Record<string, unknown>>
                  | undefined) ?? []
              ).map((t) => ({
                symbol: String(t.symbol ?? "?"),
                amount: Number(t.amount ?? 0),
                usdValue: Number((t.amount as number) ?? 0) * Number((t.price as number) ?? 0),
              })),
            }),
          );
          protocols.push({
            protocolName: String(proto.name ?? proto.id ?? "unknown"),
            chain: String(proto.chain ?? "ethereum"),
            netUsdValue: Number(proto.net_usd_value ?? 0),
            positions,
          });
        }
      }

      // /v1/user/total_balance — wallet 직접 보유 토큰
      if (url.includes("total_balance") && body.total_usd_value != null) {
        totalUsdValue = Number(body.total_usd_value);
      }

      // /v1/user/all_token_list — 전 체인 토큰 잔액
      if (url.includes("all_token_list") && Array.isArray(body.data)) {
        for (const t of body.data as Array<Record<string, unknown>>) {
          walletTokens.push({
            symbol: String(t.symbol ?? "?"),
            amount: Number(t.amount ?? 0),
            usdValue: Number(t.amount ?? 0) * Number(t.price ?? 0),
            chain: String(t.chain ?? "ethereum"),
          });
        }
      }
    } catch {
      /* 가끔 응답 파싱 실패 — 무시 */
    }
  });

  try {
    await page.goto(`https://debank.com/profile/${walletAddress}`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    // 추가 안전 대기 — 일부 XHR 는 networkidle 이후에도 도착(헤드풀+챌린지 시 더 길게).
    await page.waitForTimeout(CF_WAIT_MS);
  } catch (e) {
    console.warn("[debank-scrape] navigation timeout:", (e as Error).message);
  } finally {
    await page.close().catch(() => {});
    // 컨텍스트는 재사용(닫지 않음) — 쿠키/CF clearance 유지. 종료 시 closeDebankBrowser().
  }

  if (apiResponses === 0) {
    console.warn(
      `[debank-scrape] ${walletAddress.slice(0, 8)}… DeBank API 응답 0건 — Cloudflare 챌린지/차단 또는 엔드포인트 변경 의심.\n` +
      `  → DEBANK_HEADFUL=1 + DEBANK_PROFILE_DIR=~/.debank-profile 로 1회 수동 통과 후 재시도 권장.`,
    );
  }

  return {
    address: walletAddress.toLowerCase(),
    totalUsdValue,
    protocols,
    walletTokens,
    scrapedAt: new Date().toISOString(),
  };
}

export async function closeDebankBrowser(): Promise<void> {
  if (_ctx) {
    await _ctx.close().catch(() => {}); // 영속 컨텍스트면 프로필 디스크에 flush
    _ctx = null;
  }
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
