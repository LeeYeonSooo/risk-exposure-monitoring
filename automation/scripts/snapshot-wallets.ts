/**
 * 지갑 추적 스냅샷 + 밸류 급감 감시 (DeBank 우회 스크레이프).
 *
 * 전문가 인터뷰 권장: 큐레이터/고래 지갑 포지션 추적 → "매핑 지갑 밸류 급감"(자금 이탈 =
 * 디리스킹/런 조기경보). DeBank 프로필을 헤드리스 스크레이프해 프로토콜별 포지션+총가치(USD)를
 * wallet_snapshots 에 append 하고, 직전 스냅샷 대비 급감 시 wallet_value_drop 알림.
 *
 * Usage:
 *   npm run snapshot:wallets -- 0xabc... "Steakhouse" curator   # 지갑 추가(화이트리스트) + 즉시 스냅샷
 *   npm run snapshot:wallets                                     # active tracked_wallets 전체 스냅샷
 * Env: DATABASE_URL, ALCHEMY_API_KEY(옵션)
 *
 * ⚠️ DeBank 는 Cloudflare anti-bot — 환경에 따라 차단될 수 있음(graceful: 실패 시 해당 지갑 skip).
 *    rate-limit 보호 위해 지갑 사이 4초 간격. 아직 20분 cron 미편입(필요 시 별도 스케줄).
 */
import process from "node:process";

import type { Address } from "viem";

import { getAllTokenBalances } from "@/lib/alchemy";
import { closePool, query } from "@/db/client";
import { debankApiAvailable, fetchDebankApi } from "@/lib/debank-api";
import { closeDebankBrowser, scrapeDebankPortfolio, type DebankProfile } from "@/lib/debank-scrape";

const GAP_MS = 4_000;         // 지갑 사이 간격(rate-limit 보호)
const SKIP_DEBANK = process.env.WALLET_SKIP_DEBANK === "1"; // 차단 환경 → 온체인-매핑만

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

// ── 온체인 "매핑 지갑" 가치 — 우리가 추적하는 토큰들에 대한 지갑 노출(USD). DeBank 차단 시에도 신뢰성 있게 동작.
// 우리 토큰 주소(체인별 노드) ∩ 지갑 ERC20 잔액(Alchemy getTokenBalances, 체인별 1콜) → llama coins 로 USD 합산.
// 체인 스코프: 큐레이터/고래가 실제로 앉는 주요 5체인(llama coins 슬러그 안정 + 노드 데이터 존재).
const WALLET_CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon"];
let _priceDec: Map<string, { price: number; decimals: number }> | null = null; // 키: `${chain}:${addr}`
let _addrsByChain: Map<string, string[]> | null = null;

async function ourTokenAddrsByChain(): Promise<Map<string, string[]>> {
  const r = await query<{ chain: string; addr: string }>(
    `SELECT DISTINCT chain, lower(address) AS addr FROM nodes
     WHERE type IN ('Token','TokenProtocol') AND chain = ANY($1) AND address ~* '^0x[0-9a-f]{40}$'`,
    [WALLET_CHAINS],
  );
  const m = new Map<string, string[]>();
  for (const row of r.rows) {
    if (!m.has(row.chain)) m.set(row.chain, []);
    m.get(row.chain)!.push(row.addr);
  }
  return m;
}

async function loadPriceDecimals(addrsByChain: Map<string, string[]>): Promise<Map<string, { price: number; decimals: number }>> {
  const out = new Map<string, { price: number; decimals: number }>();
  for (const [chain, addrs] of addrsByChain) {
    for (let i = 0; i < addrs.length; i += 80) {
      const keys = addrs.slice(i, i + 80).map((a) => `${chain}:${a}`).join(",");
      try {
        const d = (await fetch(`https://coins.llama.fi/prices/current/${keys}`).then((r) => r.json())) as
          { coins?: Record<string, { price?: number; decimals?: number }> };
        for (const [k, v] of Object.entries(d.coins ?? {})) {
          if (v.price != null && v.decimals != null) out.set(k.toLowerCase(), { price: v.price, decimals: v.decimals });
        }
      } catch { /* batch skip */ }
    }
  }
  return out;
}

async function onchainMappedUsd(wallet: string): Promise<{ usd: number; tokens: { symbol: string; usdValue: number; chain: string }[] }> {
  if (!_priceDec || !_addrsByChain) {
    _addrsByChain = await ourTokenAddrsByChain();
    _priceDec = await loadPriceDecimals(_addrsByChain);
  }
  let usd = 0;
  const tokens: { symbol: string; usdValue: number; chain: string }[] = [];
  for (const chain of WALLET_CHAINS) {
    if (!(_addrsByChain.get(chain)?.length)) continue; // 그 체인 노드 없음 → 매핑 대상 없음
    try {
      const bals = await getAllTokenBalances(wallet as Address, chain);
      for (const [addr, raw] of bals) {
        const pd = _priceDec.get(`${chain}:${addr}`);
        if (!pd || pd.price <= 0) continue;
        // BigInt 스케일로 정밀도 보존(1e6 단위) 후 USD 환산
        const amt = Number((raw * 1_000_000n) / 10n ** BigInt(pd.decimals)) / 1_000_000;
        const v = amt * pd.price;
        if (v > 1) { usd += v; tokens.push({ symbol: addr.slice(0, 8), usdValue: Math.round(v), chain }); }
      }
    } catch (e) {
      console.warn(`[wallets] onchain 가치 실패 ${shortAddr(wallet)}@${chain}:`, (e as Error).message);
    }
  }
  return { usd, tokens: tokens.sort((a, b) => b.usdValue - a.usdValue).slice(0, 25) };
}

interface TrackedWallet { wallet: string; label: string | null; kind: string | null; source_token: string | null }

async function seedFromArgs(): Promise<void> {
  const args = process.argv.slice(2).filter((s) => !s.startsWith("-"));
  if (args.length === 0) return;
  const wallet = args[0].toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    console.warn(`[wallets] 잘못된 주소 무시: ${args[0]}`);
    return;
  }
  const label = args[1] ?? null;
  const kind = args[2] ?? "manual";
  await query(
    `INSERT INTO tracked_wallets (wallet, label, kind) VALUES ($1, $2, $3)
     ON CONFLICT (wallet) DO UPDATE SET label = COALESCE(EXCLUDED.label, tracked_wallets.label),
       kind = COALESCE(EXCLUDED.kind, tracked_wallets.kind), active = true`,
    [wallet, label, kind],
  );
  console.log(`[wallets] 추적 등록: ${shortAddr(wallet)}${label ? ` (${label})` : ""} · ${kind}`);
}

async function activeWallets(): Promise<TrackedWallet[]> {
  const r = await query<TrackedWallet>(
    `SELECT wallet, label, kind, source_token FROM tracked_wallets WHERE active = true ORDER BY added_at`,
  );
  return r.rows;
}

// 지갑 포트폴리오 스냅샷 전용(wallet_value_drop 알림 제거 2026-06) — wallet_snapshots 시계열만 수집(대시보드/그래프용).

async function main() {
  await seedFromArgs();
  const wallets = await activeWallets();
  if (wallets.length === 0) {
    console.log("[wallets] 추적 지갑 없음. 추가: npm run snapshot:wallets -- 0x… \"Label\" curator");
    await closePool();
    return;
  }
  const snapshotTs = new Date().toISOString();
  console.log(`[wallets] ${wallets.length}개 지갑 스냅샷 @ ${snapshotTs}`);
  let ok = 0;

  for (const tw of wallets) {
    const w = tw.wallet;
    const tag = tw.label || shortAddr(w);
    try {
      // 1) DeBank 포지션 — 공식 OpenAPI(키 있으면, 어떤 IP서도 동작) 우선 → 없으면 우회 스크레이프(헤드풀/프록시).
      //    SKIP_DEBANK=1 면 스크레이프 생략(공식 API 는 그대로 시도). 둘 다 실패해도 아래 온체인 폴백.
      let debankTotal = 0;
      let protocols: { protocolName: string; chain: string; netUsdValue: number }[] = [];
      let debankTokens: { symbol: string; usdValue: number; chain: string }[] = [];
      let profile: DebankProfile | null = null;
      let viaApi = false;
      if (debankApiAvailable()) { profile = await fetchDebankApi(w).catch(() => null); if (profile) viaApi = true; }
      if (!profile && !SKIP_DEBANK) {
        try { profile = await scrapeDebankPortfolio(w); }
        catch (e) { console.warn(`[wallets] ${tag} DeBank scrape skip:`, (e as Error).message); }
      }
      if (profile) {
        const protoSum = profile.protocols.reduce((s, p) => s + (p.netUsdValue || 0), 0);
        const tokenSum = profile.walletTokens.reduce((s, t) => s + (t.usdValue || 0), 0);
        debankTotal = profile.totalUsdValue > 0 ? profile.totalUsdValue : protoSum + tokenSum;
        protocols = profile.protocols.map((p) => ({ protocolName: p.protocolName, chain: p.chain, netUsdValue: Math.round(p.netUsdValue) }));
        debankTokens = profile.walletTokens.filter((t) => t.usdValue > 1000).sort((a, b) => b.usdValue - a.usdValue).slice(0, 25)
          .map((t) => ({ symbol: t.symbol, usdValue: Math.round(t.usdValue), chain: t.chain }));
      }

      // 2) 온체인 "매핑 지갑" 가치 (신뢰성 fallback/primary) — 우리 추적 토큰 노출 USD.
      const onchain = await onchainMappedUsd(w);

      // 총가치: DeBank 가 잡히면 그걸(전 프로토콜 포함), 아니면 온체인-매핑.
      const usingDebank = debankTotal > 0;
      const total = usingDebank ? debankTotal : onchain.usd;
      const source = usingDebank ? `${viaApi ? "debank-api" : "debank"}${onchain.usd > 0 ? "+onchain" : ""}` : "onchain-mapped";
      const tokensTop = debankTokens.length ? debankTokens : onchain.tokens;

      if (total <= 0) {
        console.warn(`[wallets] ${tag}: 총가치 0 (DeBank 차단 + 매핑 토큰 미보유) — 샘플 skip`);
        continue;
      }

      await query(
        `INSERT INTO wallet_snapshots (snapshot_ts, wallet, total_usd, protocol_count, protocols, wallet_tokens, source)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         ON CONFLICT (wallet, snapshot_ts) DO UPDATE SET
           total_usd = EXCLUDED.total_usd, protocol_count = EXCLUDED.protocol_count,
           protocols = EXCLUDED.protocols, wallet_tokens = EXCLUDED.wallet_tokens, source = EXCLUDED.source`,
        [snapshotTs, w, total, protocols.length, JSON.stringify(protocols), JSON.stringify(tokensTop), source],
      );
      ok++;
      console.log(`[wallets] ${tag}: $${Math.round(total).toLocaleString()} (${source}) · ${protocols.length}개 프로토콜 · 매핑토큰 $${Math.round(onchain.usd).toLocaleString()}`);

      // ⚠️ wallet_value_drop 알림 제거(2026-06, 사용자 결정): 추적 지갑이 Dune 상위홀더 넷팅으로 자동발견된
      //   **미식별 주소**(label=주소 placeholder, kind=휴리스틱 추측)라, "지갑 밸류 X%↓"만으로는 행동가능한 신호가
      //   아니다 — 자금이 *어디로*(CEX·프로토콜 등 식별 destination) 갔는지 귀속이 있어야 의미. 단순 밸류 급감은
      //   알림 피드에서 제외한다(스냅샷 데이터는 계속 수집 — 대시보드/그래프용). destination-귀속 재설계는 후속과제.
    } catch (e) {
      console.warn(`[wallets] ${tag} 실패:`, (e as Error).message);
    }
    await sleep(SKIP_DEBANK ? 0 : GAP_MS);
  }

  if (!SKIP_DEBANK) await closeDebankBrowser();
  console.log(`[wallets] 완료 — 스냅샷 ${ok}/${wallets.length}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
