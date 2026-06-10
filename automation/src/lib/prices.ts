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

/** 여러 토큰 가격 배치 조회. address(lower) → price. chain = DeFiLlama 체인명(소문자: ethereum/base/arbitrum). */
export async function getTokenPricesUsd(tokens: Address[], chain = "ethereum"): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tokens.length === 0) return out;
  const keys = tokens.map((t) => `${chain}:${t.toLowerCase()}`);
  try {
    const res = await fetch(COINS_URL + keys.join(","));
    if (!res.ok) return out;
    const data = (await res.json()) as { coins: Record<string, { price?: number }> };
    for (const t of tokens) {
      const k = `${chain}:${t.toLowerCase()}`;
      const p = data.coins?.[k]?.price;
      if (typeof p === "number" && p > 0) {
        out.set(t.toLowerCase(), p);
        _cache.set(k, p);
      }
    }
  } catch {
    /* empty */
  }
  return out;
}
