/**
 * Scallop (Sui) 렌딩 어댑터 — 공개 REST(sdk.api.scallop.io/api/market, 무인증).
 * pools[]: supply/borrow(human)·utilizationRate·coinPrice. collaterals[]: collateralFactor(=maxLtv). symbol 로 join.
 */
import type { NonEvmReserve } from "./nonevm-types";

const API = "https://sdk.api.scallop.io/api/market";

interface ScallopPool { symbol?: string; coinPrice?: number; supplyCoin?: number; borrowCoin?: number; utilizationRate?: number }
interface ScallopCollateral { symbol?: string; collateralFactor?: number }

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export const protocol = "scallop";

export async function fetchReserves(): Promise<NonEvmReserve[]> {
  const r = await fetch(API, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { pools?: ScallopPool[]; collaterals?: ScallopCollateral[] };
  const cf = new Map<string, number>();
  for (const c of j.collaterals ?? []) if (c.symbol) cf.set(c.symbol.toUpperCase(), n(c.collateralFactor));
  const out: NonEvmReserve[] = [];
  for (const p of j.pools ?? []) {
    const price = n(p.coinPrice);
    const supplyUsd = n(p.supplyCoin) * price;
    const borrowUsd = n(p.borrowCoin) * price;
    const ltv = cf.get((p.symbol ?? "").toUpperCase());
    out.push({
      protocol: "scallop", chain: "sui", market: "Scallop",
      symbol: p.symbol ?? "?",
      maxLtv: ltv && ltv > 0 && ltv <= 1 ? Math.round(ltv * 1000) / 1000 : null,
      utilization: n(p.utilizationRate),
      supplyUsd, borrowUsd,
    });
  }
  return out;
}
