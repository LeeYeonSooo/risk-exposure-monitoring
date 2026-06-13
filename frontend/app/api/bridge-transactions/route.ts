import { NextResponse } from "next/server";

import type { FlowTx } from "@/lib/flow-types";

/**
 * GET /api/bridge-transactions?token=USDC
 *     &tokenAddrs=ethereum:0xa0b8..,base:0x8335..
 *     &bridges=ethereum:0x03d1..:Chainlink CCIP|base:0x6378..:Chainlink CCIP
 *
 * 브릿지 뷰 전용 실시간 피드 — 흐름맵의 /api/transactions 와 달리 토큰의 전역 전송을
 * 훑지 않고, **브릿지 컨트랙트 주소로/에서의 전송만** 직접 조회한다(Alchemy fromAddress/
 * toAddress 필터). 브릿지 거래는 체인내 DeFi 활동보다 빈도가 낮아 전역 최신 1000건 스캔으로는
 * 거의 잡히지 않기 때문 — 주소 직접 조회 + 더 넓은 윈도우로 실제 브릿지 처리량을 정직하게 본다.
 *
 * 정직성: 단일 체인 사실만 본다 —
 *   · to=브릿지   → 그 체인에서 브릿지로 USDC 유입(락/예치). 입자: 체인→브릿지.
 *   · from=브릿지 → 브릿지에서 그 체인으로 USDC 유출(릴리즈). 입자: 브릿지→체인.
 *   · from=브릿지·to=0x0 → 소각(번-민트 브릿지가 그 체인에서 USDC 소각). 입자: 체인→브릿지.
 * 어느 경우도 "어느 체인에서 왔다"를 주장하지 않는다(크로스체인 출처 날조 금지, MANUAL §17).
 *
 * Source: Alchemy alchemy_getAssetTransfers. Prices: DeFiLlama.
 */
export const dynamic = "force-dynamic";

const KEY = process.env.ALCHEMY_API_KEY;

const DELAY_SEC = 60;             // 1분 정산 버퍼
const WINDOW_SEC = 60 * 60;       // 브릿지는 저빈도 — 60분 윈도우로 충분한 거래를 모은다
const MAX_RETURN = 240;
const PER_DIR_MAX = 80;           // 브릿지·방향당 최신 N건

const ALCHEMY_NET: Record<string, string> = {
  ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet",
};
const CHAIN_PREFIX: Record<string, string> = {
  ethereum: "ethereum", base: "base", arbitrum: "arbitrum",
};
const ZERO = "0x0000000000000000000000000000000000000000";

interface AlchemyTransfer { hash?: string; from?: string; to?: string; value?: number; asset?: string; metadata?: { blockTimestamp?: string } }

/** 한 방향(fromAddress 또는 toAddress)으로 특정 토큰 컨트랙트의 전송만 조회 */
async function fetchDirected(
  net: string, token: string, opts: { from?: string; to?: string }, maxCount = PER_DIR_MAX,
): Promise<AlchemyTransfer[]> {
  const url = `https://${net}.g.alchemy.com/v2/${KEY}`;
  const params: Record<string, unknown> = {
    contractAddresses: [token], category: ["erc20"], order: "desc",
    maxCount: `0x${maxCount.toString(16)}`, withMetadata: true, excludeZeroValue: true,
  };
  if (opts.from) params.fromAddress = opts.from;
  if (opts.to) params.toAddress = opts.to;
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [params] }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { result?: { transfers?: AlchemyTransfer[] } };
    return j.result?.transfers ?? [];
  } catch { return []; }
}

async function fetchPrices(items: { chain: string; addr: string }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = items.filter(({ chain }) => CHAIN_PREFIX[chain]);
  if (!wanted.length) return out;
  const byLlamaKey = new Map<string, string>();
  const reqKeys: string[] = [];
  for (const { chain, addr } of wanted) {
    const a = addr.toLowerCase();
    const lk = `${CHAIN_PREFIX[chain]}:${a}`;
    if (!byLlamaKey.has(lk.toLowerCase())) { byLlamaKey.set(lk.toLowerCase(), `${chain}:${a}`); reqKeys.push(lk); }
  }
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${reqKeys.map(encodeURIComponent).join(",")}`, { cache: "no-store" });
    if (!r.ok) return out;
    const j = (await r.json()) as { coins?: Record<string, { price?: number }> };
    for (const [k, v] of Object.entries(j.coins ?? {})) {
      const key = byLlamaKey.get(k.toLowerCase());
      if (key && v.price != null) out.set(key, v.price);
    }
  } catch { /* ignore */ }
  return out;
}

export async function GET(req: Request) {
  if (!KEY) return NextResponse.json({ txs: [], error: "ALCHEMY_API_KEY not set" });
  const url = new URL(req.url);
  const token = (url.searchParams.get("token") ?? "").toUpperCase() || "?";

  // chain → token contract addr
  const tokenAddrByChain = new Map<string, string>();
  for (const pair of (url.searchParams.get("tokenAddrs") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":"); if (i < 0) continue;
    const chain = pair.slice(0, i).toLowerCase();
    const addr = pair.slice(i + 1).toLowerCase();
    if (ALCHEMY_NET[chain] && /^0x[0-9a-f]{40}$/.test(addr)) tokenAddrByChain.set(chain, addr);
  }

  // bridges: chain:addr:label
  const bridges: { chain: string; addr: string; label: string }[] = [];
  for (const pair of (url.searchParams.get("bridges") ?? "").split("|").map((s) => s.trim()).filter(Boolean)) {
    const parts = pair.split(":");
    if (parts.length < 2) continue;
    const chain = parts[0].toLowerCase();
    const addr = parts[1].toLowerCase();
    const label = parts.slice(2).join(":") || "브릿지";
    if (ALCHEMY_NET[chain] && /^0x[0-9a-f]{40}$/.test(addr)) bridges.push({ chain, addr, label });
  }
  if (!bridges.length) return NextResponse.json({ txs: [], windowSec: WINDOW_SEC, delaySec: DELAY_SEC });

  const nowSec = Math.floor(Date.now() / 1000);
  const hiTs = nowSec - DELAY_SEC;
  const loTs = nowSec - DELAY_SEC - WINDOW_SEC;

  // price each chain's token contract
  const priceTargets = [...tokenAddrByChain.entries()].map(([chain, addr]) => ({ chain, addr }));
  const prices = await fetchPrices(priceTargets);

  const tsOf = (t: AlchemyTransfer) => (t.metadata?.blockTimestamp ? Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000) : 0);

  const perBridge = await Promise.all(bridges.map(async ({ chain, addr, label }) => {
    const tokenAddr = tokenAddrByChain.get(chain);
    if (!tokenAddr) return [] as FlowTx[];
    const net = ALCHEMY_NET[chain];
    const price = prices.get(`${chain}:${tokenAddr}`) ?? 0;
    const [inflow, outflow] = await Promise.all([
      fetchDirected(net, tokenAddr, { to: addr }),    // → 브릿지 (락/예치)
      fetchDirected(net, tokenAddr, { from: addr }),  // 브릿지 → (릴리즈/소각)
    ]);
    const out: FlowTx[] = [];
    const seen = new Set<string>();
    const push = (t: AlchemyTransfer, dir: "in" | "out") => {
      const ts = tsOf(t);
      if (!ts || ts > hiTs || ts < loTs) return;
      const hash = t.hash ?? ""; if (!hash) return;
      const from = (t.from ?? "").toLowerCase(), to = (t.to ?? "").toLowerCase();
      const dedupe = `${hash}:${from}:${to}`; if (seen.has(dedupe)) return; seen.add(dedupe);
      const burn = to === ZERO, mint = from === ZERO;
      out.push({
        hash, chain, token, from, to, valueUsd: (t.value ?? 0) * price, ts,
        // 방향 = 브릿지 기준 유입/유출. 소각(번-민트)도 체인→브릿지(USDC가 이 체인을 떠남)로 본다.
        direction: dir,
        kind: burn ? "burn" : mint ? "mint" : dir === "in" ? "deposit" : "withdraw",
        counterparty: label, counterpartyAddr: addr, marketHint: null, reasons: [],
      });
    };
    for (const t of inflow) push(t, "in");
    for (const t of outflow) push(t, "out");
    return out.sort((a, b) => b.ts - a.ts).slice(0, PER_DIR_MAX * 2);
  }));

  const all = perBridge.flat();
  const total = all.length;
  const txs = all.sort((a, b) => b.ts - a.ts).slice(0, MAX_RETURN);

  return NextResponse.json({
    txs,
    delaySec: DELAY_SEC, windowSec: WINDOW_SEC,
    generatedAt: new Date().toISOString(),
    counts: { total, returned: txs.length, bridges: bridges.length },
  });
}
