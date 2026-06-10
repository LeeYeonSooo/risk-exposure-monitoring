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
import { detectBridgeOutflow, loadVerifiedBridgeAddrs } from "@/lib/wallet-bridge-guard";
import { closePool, query } from "@/db/client";
import { debankApiAvailable, fetchDebankApi } from "@/lib/debank-api";
import { closeDebankBrowser, scrapeDebankPortfolio, type DebankProfile } from "@/lib/debank-scrape";

// 급감 임계 — 직전 스냅샷 대비.
const MIN_USD = 500_000;      // 이 미만 지갑은 노이즈 → 알림 스킵
const DROP_WARN = 0.30;       // 30% 급감 → warning
const DROP_CRIT = 0.50;       // 50% 급감 → critical
const GAP_MS = 4_000;         // 지갑 사이 간격(rate-limit 보호)
const SKIP_DEBANK = process.env.WALLET_SKIP_DEBANK === "1"; // 차단 환경 → 온체인-매핑만

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

// ── 온체인 "매핑 지갑" 가치 — 우리가 추적하는 토큰들에 대한 지갑 노출(USD). DeBank 차단 시에도 신뢰성 있게 동작.
// 우리 토큰 주소(이더리움) ∩ 지갑 ERC20 잔액 → DeFiLlama coins(price+decimals) 로 USD 합산.
let _priceDec: Map<string, { price: number; decimals: number }> | null = null;

async function ourEthTokenAddrs(): Promise<string[]> {
  const r = await query<{ addr: string }>(
    `SELECT DISTINCT lower(address) AS addr FROM nodes
     WHERE type IN ('Token','TokenProtocol') AND chain='ethereum' AND address ~* '^0x[0-9a-f]{40}$'`,
  );
  return r.rows.map((x) => x.addr);
}

async function loadPriceDecimals(addrs: string[]): Promise<Map<string, { price: number; decimals: number }>> {
  const out = new Map<string, { price: number; decimals: number }>();
  for (let i = 0; i < addrs.length; i += 80) {
    const batch = addrs.slice(i, i + 80);
    const keys = batch.map((a) => `ethereum:${a}`).join(",");
    try {
      const d = (await fetch(`https://coins.llama.fi/prices/current/${keys}`).then((r) => r.json())) as
        { coins?: Record<string, { price?: number; decimals?: number }> };
      for (const [k, v] of Object.entries(d.coins ?? {})) {
        const addr = k.split(":")[1]?.toLowerCase();
        if (addr && v.price != null && v.decimals != null) out.set(addr, { price: v.price, decimals: v.decimals });
      }
    } catch { /* batch skip */ }
  }
  return out;
}

async function onchainMappedUsd(wallet: string): Promise<{ usd: number; tokens: { symbol: string; usdValue: number; chain: string }[] }> {
  if (!_priceDec) _priceDec = await loadPriceDecimals(await ourEthTokenAddrs());
  let usd = 0;
  const tokens: { symbol: string; usdValue: number; chain: string }[] = [];
  try {
    const bals = await getAllTokenBalances(wallet as Address);
    for (const [addr, raw] of bals) {
      const pd = _priceDec.get(addr);
      if (!pd || pd.price <= 0) continue;
      // BigInt 스케일로 정밀도 보존(1e6 단위) 후 USD 환산
      const amt = Number((raw * 1_000_000n) / 10n ** BigInt(pd.decimals)) / 1_000_000;
      const v = amt * pd.price;
      if (v > 1) { usd += v; tokens.push({ symbol: addr.slice(0, 8), usdValue: Math.round(v), chain: "ethereum" }); }
    }
  } catch (e) {
    console.warn(`[wallets] onchain 가치 실패 ${shortAddr(wallet)}:`, (e as Error).message);
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

async function prevTotal(wallet: string, beforeTs: string): Promise<number | null> {
  const r = await query<{ total_usd: string }>(
    `SELECT total_usd FROM wallet_snapshots WHERE wallet=$1 AND snapshot_ts < $2 ORDER BY snapshot_ts DESC LIMIT 1`,
    [wallet, beforeTs],
  );
  return r.rows.length ? Number(r.rows[0].total_usd) : null;
}

async function insertAlert(a: {
  snapshotTs: string; severity: string; kind: string; token: string;
  message: string; detail: Record<string, unknown>;
}): Promise<boolean> {
  const dup = await query<{ n: number }>(
    `SELECT count(*)::int n FROM alerts
     WHERE kind=$1 AND detail->>'wallet' = $2 AND created_at > now() - interval '26 hours'`,
    [a.kind, String(a.detail.wallet ?? "")],
  ).catch(() => ({ rows: [{ n: 0 }] }) as { rows: { n: number }[] });
  if ((dup.rows[0]?.n ?? 0) > 0) return false;
  await query(
    `INSERT INTO alerts (snapshot_ts, severity, kind, token, protocol_node_id, message, detail, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [a.snapshotTs, a.severity, a.kind, a.token, null, a.message, JSON.stringify(a.detail), "wallet-track"],
  );
  return true;
}

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
  let ok = 0, alerts = 0;
  const verifiedBridges = await loadVerifiedBridgeAddrs(query); // P2-7: bridge_authorities 검증 주소(브릿지 in-flight 가드용)

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

      // 밸류 급감 감시 — 직전 스냅샷 대비.
      const prev = await prevTotal(w, snapshotTs);
      if (prev != null && prev >= MIN_USD) {
        const dropPct = (prev - total) / prev;
        if (dropPct >= DROP_WARN) {
          let sev = dropPct >= DROP_CRIT ? "critical" : "warning";
          let note = "자금 이탈/디리스킹 의심";
          // P2-7: 자금이 known 브릿지로 갔으면 in-flight/settling(Optimistic 7일 챌린지 등) → FP 가드.
          //   페이지를 막되(severity→info) 기록은 남긴다. (ALCHEMY 키 없으면 가드 미작동 = 원래대로 발화.)
          const sinceTs = Math.floor(Date.now() / 1000) - 3 * 86400; // 급감 윈도우(최근 3일) 아웃고잉 확인
          const bridgeHit = await detectBridgeOutflow(w, sinceTs, verifiedBridges).catch(() => null);
          if (bridgeHit) {
            sev = "info";
            note = `브릿지 in-flight/settling 추정 — ${bridgeHit.chain} 아웃고잉이 known 브릿지(${bridgeHit.to.slice(0, 10)}…)로 (7일 챌린지 가능). FP 가드`;
          }
          const added = await insertAlert({
            snapshotTs, severity: sev, kind: "wallet_value_drop", token: tw.source_token || tag,
            message: `지갑 밸류 급감: ${tag} ${(dropPct * 100).toFixed(0)}% 하락 ($${Math.round(prev).toLocaleString()} → $${Math.round(total).toLocaleString()}) — ${note}`,
            detail: { wallet: w, label: tw.label, kind: tw.kind, prevUsd: Math.round(prev), currUsd: Math.round(total), dropPct: Number(dropPct.toFixed(3)), bridgeInFlight: !!bridgeHit, bridgeTo: bridgeHit?.to ?? null, bridgeChain: bridgeHit?.chain ?? null },
          });
          if (added) alerts++;
        }
      }
    } catch (e) {
      console.warn(`[wallets] ${tag} 실패:`, (e as Error).message);
    }
    await sleep(SKIP_DEBANK ? 0 : GAP_MS);
  }

  if (!SKIP_DEBANK) await closeDebankBrowser();
  console.log(`[wallets] 완료 — 스냅샷 ${ok}/${wallets.length} · 급감알림 ${alerts}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
