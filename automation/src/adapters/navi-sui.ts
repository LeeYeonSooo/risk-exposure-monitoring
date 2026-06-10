/**
 * NAVI Protocol (Sui) 렌딩 어댑터 — 공개 REST(open-api.naviprotocol.io, 무인증).
 * /api/navi/pools → 풀별 ltvValue·totalSupplyAmount·borrowedAmount·token{decimals,price}.
 */
import type { NonEvmReserve } from "./nonevm-types";

const API = "https://open-api.naviprotocol.io/api/navi/pools";

interface NaviPool {
  ltvValue?: number;
  ltv?: string;
  totalSupplyAmount?: string | number;
  borrowedAmount?: string | number;
  token?: { symbol?: string; decimals?: number; price?: number };
}

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export const protocol = "navi";

export async function fetchReserves(): Promise<NonEvmReserve[]> {
  const r = await fetch(API, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { data?: NaviPool[] };
  const out: NonEvmReserve[] = [];
  for (const p of j.data ?? []) {
    // NAVI 는 amount 를 토큰 decimals 가 아니라 **고정 1e9 정규화** 단위로 보고함.
    //   실데이터 검증: USDC raw 2.38e16 → /1e6 이면 $23.8B(폭발), /1e9 이면 $23.8M(정상). SUI·haSUI·WETH·NAVX 모두 /1e9 에서만 합리적.
    const price = n(p.token?.price);
    const supply = n(p.totalSupplyAmount) / 1e9;
    const borrow = n(p.borrowedAmount) / 1e9;
    const supplyUsd = supply * price;
    const borrowUsd = borrow * price;
    const maxLtv = p.ltvValue != null ? n(p.ltvValue) : (p.ltv != null ? n(p.ltv) / 1e27 : null);
    out.push({
      protocol: "navi", chain: "sui", market: "NAVI",
      symbol: p.token?.symbol ?? "?",
      maxLtv: maxLtv && maxLtv > 0 && maxLtv <= 1 ? maxLtv : null,
      utilization: supply > 0 ? borrow / supply : 0,
      supplyUsd, borrowUsd,
    });
  }
  return out;
}
