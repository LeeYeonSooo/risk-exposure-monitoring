import { NextResponse } from "next/server";

import { PROTOCOL_TOKENS } from "@/lib/protocol-tokens";

/**
 * GET /api/portfolio?address=0x...
 *
 * 다중 전략 — 가능한 모든 신호 합쳐서 wallet 의 exposure 도출:
 *
 *   1) Alchemy `alchemy_getTokenBalances` — wallet 의 모든 ERC20 잔액 (1 round-trip).
 *      → 우리 registry 의 receipt token (aToken, vault share, etc.) 매칭.
 *
 *   2) DeBank scrape (Playwright, in-process) — protocol-level 포지션.
 *      → Morpho Blue / Maker CDPs / Fluid / f(x) 처럼 transferable receipt 없는
 *        포지션까지 캡쳐. 전문가 권장 우회 방식.
 *
 *   3) Public RPC per-token balanceOf — fallback (no Alchemy key).
 *
 * 결과는 모든 source 의 union.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_URL = process.env.RPC_URL ?? "https://eth.llamarpc.com";
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const ENABLE_DEBANK = process.env.ENABLE_DEBANK_SCRAPE !== "false"; // default on
const BALANCE_OF_SELECTOR = "0x70a08231";

// ─────────────────────────────────────────────────────────────
// Mappings
// ─────────────────────────────────────────────────────────────

const DEBANK_NAME_TO_NODE: Record<string, string> = {
  aave: "protocol:aave_v3",
  "aave-v3": "protocol:aave_v3",
  "aave-v2": "protocol:aave_v2",
  morpho: "protocol:morpho_blue",
  "morpho-blue": "protocol:morpho_blue",
  compound: "protocol:compound_v3",
  "compound-v3": "protocol:compound_v3",
  spark: "protocol:spark",
  maker: "protocol:maker",
  fluid: "protocol:fluid",
  "ether-fi": "protocol:etherfi_boringvault",
  etherfi: "protocol:etherfi_boringvault",
  "f-x-protocol": "protocol:fx",
  fxprotocol: "protocol:fx",
  "uniswap-v3": "protocol:uniswap_v3",
  "uniswap-v2": "protocol:uniswap_v2",
  curve: "protocol:curve",
};

function debankNameToNodeId(rawName: string): string | null {
  const key = rawName.toLowerCase().replace(/\s+/g, "-");
  if (DEBANK_NAME_TO_NODE[key]) return DEBANK_NAME_TO_NODE[key];
  for (const [k, v] of Object.entries(DEBANK_NAME_TO_NODE)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// GET handler
// ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address")?.trim();
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json(
      { error: "Invalid address — expected 0x-prefixed 40-hex" },
      { status: 400 },
    );
  }

  const sources: Array<{ method: string; nodeIds: string[]; detail?: unknown }> = [];

  // Run in parallel where possible
  const [alchemyRes, debankRes, rpcRes] = await Promise.allSettled([
    ALCHEMY_KEY ? checkViaAlchemy(address) : Promise.resolve(null),
    ENABLE_DEBANK ? checkViaDebank(address) : Promise.resolve(null),
    !ALCHEMY_KEY ? checkViaPublicRpc(address) : Promise.resolve(null),
  ]);

  const allNodeIds = new Set<string>();

  if (alchemyRes.status === "fulfilled" && alchemyRes.value) {
    sources.push({
      method: "alchemy_token_match",
      nodeIds: alchemyRes.value.map((m) => m.protocolNodeId),
      detail: { matchCount: alchemyRes.value.length },
    });
    alchemyRes.value.forEach((m) => allNodeIds.add(m.protocolNodeId));
  } else if (alchemyRes.status === "rejected") {
    sources.push({
      method: "alchemy_token_match",
      nodeIds: [],
      detail: { error: alchemyRes.reason instanceof Error ? alchemyRes.reason.message : "failed" },
    });
  }

  if (debankRes.status === "fulfilled" && debankRes.value) {
    sources.push({
      method: "debank_scrape",
      nodeIds: debankRes.value.nodeIds,
      detail: {
        protocolCount: debankRes.value.protocolCount,
        totalUsd: debankRes.value.totalUsdValue,
      },
    });
    debankRes.value.nodeIds.forEach((n) => allNodeIds.add(n));
  } else if (debankRes.status === "rejected") {
    sources.push({
      method: "debank_scrape",
      nodeIds: [],
      detail: { error: debankRes.reason instanceof Error ? debankRes.reason.message : "failed" },
    });
  }

  if (rpcRes.status === "fulfilled" && rpcRes.value) {
    sources.push({
      method: "public_rpc_fallback",
      nodeIds: rpcRes.value.map((m) => m.protocolNodeId),
      detail: { matchCount: rpcRes.value.length },
    });
    rpcRes.value.forEach((m) => allNodeIds.add(m.protocolNodeId));
  }

  return NextResponse.json({
    address,
    nodeIds: [...allNodeIds],
    sources,
    label: `${address.slice(0, 6)}…${address.slice(-4)}`,
  });
}

// ─────────────────────────────────────────────────────────────
// Strategy 1: Alchemy
// ─────────────────────────────────────────────────────────────

async function checkViaAlchemy(wallet: string) {
  const url = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
  const balances = new Map<string, bigint>();

  let pageKey: string | undefined;
  for (let i = 0; i < 50; i++) {
    const params = pageKey ? [wallet, "erc20", { pageKey }] : [wallet, "erc20"];
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "alchemy_getTokenBalances", params, id: 1 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      result: { tokenBalances: Array<{ contractAddress: string; tokenBalance: string | null; error?: string | null }>; pageKey?: string };
    };
    for (const tb of data.result.tokenBalances) {
      if (tb.error || !tb.tokenBalance) continue;
      try {
        const bal = BigInt(tb.tokenBalance);
        if (bal > BigInt(0)) balances.set(tb.contractAddress.toLowerCase(), bal);
      } catch {
        /* skip */
      }
    }
    if (!data.result.pageKey) break;
    pageKey = data.result.pageKey;
  }

  const matches: Array<{ protocolNodeId: string; label: string; tokenAddress: string }> = [];
  for (const entry of PROTOCOL_TOKENS) {
    if (balances.get(entry.tokenAddress.toLowerCase())) {
      matches.push({
        protocolNodeId: entry.protocolNodeId,
        label: entry.label,
        tokenAddress: entry.tokenAddress,
      });
    }
  }
  return matches;
}

// ─────────────────────────────────────────────────────────────
// Strategy 2: DeBank scrape (Playwright)
// ─────────────────────────────────────────────────────────────

async function checkViaDebank(wallet: string): Promise<{
  nodeIds: string[];
  protocolCount: number;
  totalUsdValue: number;
}> {
  // Dynamic import — playwright is heavy, only load when needed
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const protocolNames: string[] = [];
  let totalUsdValue = 0;
  let protocolCount = 0;

  try {
    const page = await ctx.newPage();
    page.on("response", async (resp) => {
      const url = resp.url();
      if (!url.includes("api.debank.com")) return;
      try {
        const ct = resp.headers()["content-type"] ?? "";
        if (!ct.includes("application/json")) return;
        const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return;
        if (url.includes("complex_protocol_list") && Array.isArray(body.data)) {
          for (const proto of body.data as Array<Record<string, unknown>>) {
            const chain = String(proto.chain ?? "").toLowerCase();
            if (chain !== "eth" && chain !== "ethereum") continue;
            const name = String(proto.name ?? proto.id ?? "");
            if (name) protocolNames.push(name);
            protocolCount++;
          }
        }
        if (url.includes("total_balance") && body.total_usd_value != null) {
          totalUsdValue = Number(body.total_usd_value);
        }
      } catch {
        /* skip */
      }
    });
    await page.goto(`https://debank.com/profile/${wallet}`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);
    await page.close().catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const nodeIds = new Set<string>();
  for (const name of protocolNames) {
    const n = debankNameToNodeId(name);
    if (n) nodeIds.add(n);
  }
  return { nodeIds: [...nodeIds], protocolCount, totalUsdValue };
}

// ─────────────────────────────────────────────────────────────
// Strategy 3: public RPC fallback
// ─────────────────────────────────────────────────────────────

async function checkViaPublicRpc(wallet: string) {
  const padded = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const data = BALANCE_OF_SELECTOR + padded;

  const results = await Promise.all(
    PROTOCOL_TOKENS.map(async (entry, i) => {
      try {
        const res = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: entry.tokenAddress, data }, "latest"],
            id: i + 1,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { result?: string };
        const hex = json.result;
        if (!hex || hex === "0x") return null;
        const bal = BigInt(hex);
        return bal > BigInt(0)
          ? { protocolNodeId: entry.protocolNodeId, label: entry.label, tokenAddress: entry.tokenAddress }
          : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}
