import type { Address } from "viem";

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
