import type { Address } from "viem";

import { getDexQuote } from "@/lib/dex-onchain";
import { rpcFor } from "@/lib/rpc";

/**
 * DeFiLlama 무료 가격 API — coins.llama.fi.
 * 토큰 USD 가격을 배치로 조회 (스냅샷 amountUsd 정확도용).
 * 키 불필요. 실패 시 null (호출부가 price=1 fallback).
 */

const COINS_URL = "https://coins.llama.fi/prices/current/";

const _cache = new Map<string, number>();

/** 단일 토큰 USD 가격 (ethereum). 캐시. 실패 시 null. */
export async function getTokenPriceUsd(token: Address): Promise<number | null> {
  const key = `ethereum:${token.toLowerCase()}`;
  if (_cache.has(key)) return _cache.get(key)!;
  try {
    const res = await fetch(COINS_URL + key);
    if (!res.ok) return null;
    const data = (await res.json()) as { coins: Record<string, { price?: number }> };
    const price = data.coins?.[key]?.price;
    if (typeof price === "number" && price > 0) {
      _cache.set(key, price);
      return price;
    }
    return null;
  } catch {
    return null;
  }
}

/** 여러 토큰 가격 배치 조회. address(lower) → price. chain = DeFiLlama 체인명(소문자: ethereum/base/arbitrum).
 *  ⚠ 40개씩 청크 — 한 URL 에 다 이어붙이면(예: 플로우 자산 250~390개) URL 길이 초과로 fetch 가 통째 실패해
 *  amount_usd 가 전부 null 이 되던 버그(2026-06-11 발견). 청크별 독립 실패 허용(부분 가격이라도 채움). */
export async function getTokenPricesUsd(tokens: Address[], chain = "ethereum"): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tokens.length === 0) return out;
  const uniq = [...new Set(tokens.map((t) => t.toLowerCase()))];
  const CHUNK = 40;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const batch = uniq.slice(i, i + CHUNK);
    const keys = batch.map((t) => `${chain}:${t}`);
    try {
      const res = await fetch(COINS_URL + keys.join(","), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { coins: Record<string, { price?: number }> };
      for (const t of batch) {
        const k = `${chain}:${t}`;
        const p = data.coins?.[k]?.price;
        if (typeof p === "number" && p > 0) { out.set(t, p); _cache.set(k, p); }
      }
    } catch {
      /* 이 청크만 스킵 — 나머지는 계속 */
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 온체인-우선 가격/유동성 (coins.llama 대체, 폴백 보존) — 사용자 결정 2026-06: "가격·유동성도 RPC로".
//   1) decimals 배치읽기  2) getDexQuote(온체인 DEX 시장가+유동성)  3) 미커버 토큰만 coins.llama 폴백.
//   → depeg·value_drift 등이 오프체인 API 대신 온체인 DEX 시장가 기반이 됨(블록귀속·조작투명·다운무관).
// ─────────────────────────────────────────────────────────────
const DECIMALS_ABI = [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
const CHAIN_NAME: Record<number, string> = { 1: "ethereum", 8453: "base", 42161: "arbitrum" };

// decimals 는 불변값 → (chainId:token) 영구 캐시. cron 주기마다의 decimals multicall 제거(정확도 무관, 순수 절감).
//   ⚠ 성공 읽기만 캐시 — 일시적 RPC 실패를 18 로 캐싱하면 오염되므로 실패는 이번 호출만 18 폴백하고 다음에 재시도.
const _decCache = new Map<string, number>();

export interface OnchainPrice { priceUsd: number; liquidityUsd: number | null; source: string; }

/** 단일 토큰 온체인-우선 가격(USD). 미커버는 coins.llama 폴백. 실패 시 null. */
export async function getTokenPriceOnchainFirst(token: Address, chainId: number, nowMs: number): Promise<number | null> {
  const m = await getTokenPricesOnchainFirst([token], chainId, nowMs);
  return m.get(token.toLowerCase())?.priceUsd ?? null;
}

/** 토큰들의 온체인-우선 가격+유동성. address(lower)→{priceUsd, liquidityUsd, source}. 미커버는 coins.llama 폴백. */
export async function getTokenPricesOnchainFirst(tokens: Address[], chainId: number, nowMs: number): Promise<Map<string, OnchainPrice>> {
  const out = new Map<string, OnchainPrice>();
  const uniq = [...new Set(tokens.map((t) => t.toLowerCase()))] as Address[];
  if (uniq.length === 0) return out;

  // 1) decimals — 불변값이라 캐시. 미캐시 토큰만 multicall(성공만 캐시, 실패는 18 폴백+다음 호출 재시도).
  const decKey = (t: string) => `${chainId}:${t}`;
  const uncached = uniq.filter((t) => !_decCache.has(decKey(t)));
  if (uncached.length) {
    try {
      const r = await rpcFor(chainId).multicall({ contracts: uncached.map((t) => ({ address: t, abi: DECIMALS_ABI, functionName: "decimals" as const })), allowFailure: true });
      uncached.forEach((t, i) => { if (r[i]?.status === "success") _decCache.set(decKey(t), Number(r[i].result)); });
    } catch { /* 캐시 안 함 — 다음 호출 재시도, 이번엔 18 폴백 */ }
  }
  const decs = uniq.map((t) => _decCache.get(decKey(t)) ?? 18);

  // 2) 온체인 DEX 견적 — 동시성 제한(청크 10)으로 RPC 부하 분산.
  const CHUNK = 10;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const quotes = await Promise.all(slice.map((t, j) => getDexQuote(t, chainId, decs[i + j], nowMs).catch(() => null)));
    slice.forEach((t, j) => {
      const q = quotes[j];
      if (q && q.priceUsd > 0) out.set(t, { priceUsd: q.priceUsd, liquidityUsd: q.liquidityUsd, source: q.source });
    });
  }

  // 3) coins.llama 폴백 — 온체인 미커버 토큰만(풀 없음/Curve·Balancer 유동성 등).
  const missing = uniq.filter((t) => !out.has(t));
  if (missing.length) {
    const ll = await getTokenPricesUsd(missing, CHAIN_NAME[chainId] ?? "ethereum").catch(() => new Map<string, number>());
    for (const t of missing) {
      const p = ll.get(t);
      if (p && p > 0) out.set(t, { priceUsd: p, liquidityUsd: null, source: "coins.llama" });
    }
  }
  return out;
}
