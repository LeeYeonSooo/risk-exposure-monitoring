/**
 * Vesu (Starknet) 렌딩 어댑터 — 공개 REST(api.vesu.xyz/pools, 무인증).
 * DeFiLlama lendBorrow 에 Starknet 렌딩이 전무(매칭 0)라 프로토콜 API 직독 경로가 필수.
 *
 * pools[]: isDeprecated(스킵)·name. assets[]: symbol·decimals·usdPrice{value,1e18}·
 *   stats{ totalSupplied{value,decimals}·totalDebt{value,decimals}·currentUtilization{value,1e18} }.
 * LTV 는 (담보,부채) 페어 단위라 단일 reserve maxLtv 없음 → null(util-only, Drift 와 동일).
 */
import type { NonEvmReserve } from "./nonevm-types";

const API = "https://api.vesu.xyz/pools";

interface VesuDecimal { value?: string; decimals?: number }
interface VesuAsset {
  symbol?: string;
  decimals?: number;
  usdPrice?: VesuDecimal;
  stats?: { totalSupplied?: VesuDecimal; totalDebt?: VesuDecimal; currentUtilization?: VesuDecimal };
}
interface VesuPool { name?: string; isDeprecated?: boolean; assets?: VesuAsset[] }

const dec = (d: VesuDecimal | undefined, fallbackDecimals = 18): number => {
  if (!d?.value) return 0;
  try { return Number(BigInt(d.value)) / Math.pow(10, d.decimals ?? fallbackDecimals); } catch { return 0; }
};

export const protocol = "vesu";

export async function fetchReserves(): Promise<NonEvmReserve[]> {
  const r = await fetch(API, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { data?: VesuPool[] } | VesuPool[];
  const pools = Array.isArray(j) ? j : (j.data ?? []);
  const out: NonEvmReserve[] = [];
  for (const p of pools) {
    if (p.isDeprecated) continue;
    for (const a of p.assets ?? []) {
      const price = dec(a.usdPrice, 18);
      if (!(price > 0)) continue;
      const supply = dec(a.stats?.totalSupplied, a.decimals ?? 18);
      const debt = dec(a.stats?.totalDebt, a.decimals ?? 18);
      const supplyUsd = supply * price;
      const borrowUsd = debt * price;
      if (!Number.isFinite(supplyUsd) || supplyUsd <= 0 || supplyUsd > 50e9) continue; // bogus 가드
      const util = dec(a.stats?.currentUtilization, 18);
      out.push({
        protocol: "vesu", chain: "starknet", market: p.name ?? "Vesu", symbol: a.symbol ?? "?",
        maxLtv: null, // 페어 단위 LTV — reserve 단일값 없음
        utilization: util > 0 && util <= 1 ? util : supply > 0 ? debt / supply : 0,
        supplyUsd, borrowUsd,
      });
    }
  }
  return out;
}
