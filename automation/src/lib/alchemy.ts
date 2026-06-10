import type { Address } from "viem";

import { env, EVM_CHAINS } from "@/config/chains";

/**
 * Alchemy enhanced APIs:
 *   - getTokenHolders — top holders for a token
 *   - getTokenBalances — all ERC20 balances for a wallet (1 call instead of N)
 */

interface AlchemyHoldersResp {
  result: { holders: Array<{ address: string; balance: string }>; pageKey?: string };
}

export async function topHoldersAlchemy(
  tokenAddress: Address,
  limit = 200,
): Promise<Array<{ address: string; quantityRaw: bigint }>> {
  if (!env.ALCHEMY_API_KEY) throw new Error("ALCHEMY_API_KEY not set");
  const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
  const holders: Array<{ address: string; quantityRaw: bigint }> = [];
  let pageKey: string | undefined;

  while (holders.length < limit) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "alchemy_getTokenHolders",
        params: [{ contractAddress: tokenAddress, pageKey }],
        id: 1,
      }),
    });
    if (!res.ok) throw new Error(`Alchemy holders: HTTP ${res.status}`);
    const data = (await res.json()) as AlchemyHoldersResp;
    for (const h of data.result.holders) {
      if (holders.length >= limit) break;
      holders.push({ address: h.address.toLowerCase(), quantityRaw: BigInt(h.balance) });
    }
    if (!data.result.pageKey) break;
    pageKey = data.result.pageKey;
  }
  return holders.sort((a, b) => (a.quantityRaw < b.quantityRaw ? 1 : a.quantityRaw > b.quantityRaw ? -1 : 0));
}

// ─────────────────────────────────────────────────────────────
// alchemy_getTokenBalances — 한 콜에 전 ERC20 잔액
// ─────────────────────────────────────────────────────────────

interface AlchemyBalancesResp {
  result: {
    address: string;
    tokenBalances: Array<{ contractAddress: string; tokenBalance: string | null; error?: string | null }>;
  };
}

/**
 * Get all ERC20 balances for a wallet in one Alchemy call. chain = 공용 레지스트리(EVM_CHAINS) 키.
 * Returns map: tokenAddress (lower) → raw balance.
 */
export async function getAllTokenBalances(wallet: Address, chain = "ethereum"): Promise<Map<string, bigint>> {
  if (!env.ALCHEMY_API_KEY) throw new Error("ALCHEMY_API_KEY not set");
  const slug = EVM_CHAINS[chain]?.alchemy;
  if (!slug) throw new Error(`Alchemy 미지원/미등록 체인: ${chain}`);
  const url = `https://${slug}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
  const balances = new Map<string, bigint>();

  // erc20 모드 — 모든 ERC20 잔액 (한 페이지에 100개 기본)
  let pageKey: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "alchemy_getTokenBalances",
        params: [wallet, "erc20", pageKey ? { pageKey } : undefined].filter(Boolean),
        id: 1,
      }),
    });
    if (!res.ok) throw new Error(`Alchemy balances: HTTP ${res.status}`);
    const data = (await res.json()) as AlchemyBalancesResp & { result: { pageKey?: string } };
    for (const tb of data.result.tokenBalances) {
      if (tb.error || !tb.tokenBalance) continue;
      try {
        const bal = BigInt(tb.tokenBalance);
        if (bal > BigInt(0)) {
          balances.set(tb.contractAddress.toLowerCase(), bal);
        }
      } catch {
        /* skip malformed */
      }
    }
    if (!data.result.pageKey) break;
    pageKey = data.result.pageKey;
  }
  return balances;
}

// ─────────────────────────────────────────────────────────────
// alchemy_getAssetTransfers — 지갑의 최근 아웃고잉 전송 (P2-7 브릿지 in-flight 가드용)
// ─────────────────────────────────────────────────────────────

export interface OutTransfer { to: string; value: number; asset: string; tsSec: number; }

/**
 * 지갑(fromAddress)의 최근 아웃고잉 전송 — external(네이티브)+erc20. desc 정렬, sinceUnixSec 이후만.
 * Alchemy enhanced API(getLogs 아님)라 무료티어 OK. 키 없거나 미지원 체인이면 빈 배열.
 * 체인 슬러그는 공용 레지스트리(EVM_CHAINS) — 5체인 사본이던 것을 18체인으로 통일.
 */
export async function getOutgoingTransfers(wallet: string, chain: string, sinceUnixSec = 0, maxCount = 25): Promise<OutTransfer[]> {
  if (!env.ALCHEMY_API_KEY) return [];
  const net = EVM_CHAINS[chain]?.alchemy;
  if (!net) return [];
  const url = `https://${net}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers",
        params: [{ fromAddress: wallet, category: ["external", "erc20"], order: "desc", maxCount: `0x${maxCount.toString(16)}`, withMetadata: true, excludeZeroValue: true }],
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { result?: { transfers?: Array<{ to?: string; value?: number; asset?: string; metadata?: { blockTimestamp?: string } }> } };
    const out: OutTransfer[] = [];
    for (const t of data.result?.transfers ?? []) {
      const tsSec = t.metadata?.blockTimestamp ? Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000) : 0;
      if (sinceUnixSec && tsSec && tsSec < sinceUnixSec) continue;
      out.push({ to: (t.to ?? "").toLowerCase(), value: Number(t.value ?? 0), asset: t.asset ?? "", tsSec });
    }
    return out;
  } catch { return []; }
}
