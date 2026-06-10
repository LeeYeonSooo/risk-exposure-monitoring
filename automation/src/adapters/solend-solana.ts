/**
 * Solend / Save (Solana) 렌딩 어댑터 — 공개 REST(api.solend.fi, 무인증).
 *   1) /v1/markets/configs → 마켓별 reserve 주소 + liquidityToken{symbol,mint}
 *   2) /v1/reserves?ids=… → reserve 라이브 상태(config.loanToValueRatio, liquidity{availableAmount, borrowedAmountWads(WAD 1e18), marketPrice(WAD 1e18), mintDecimals, mintPubkey})
 */
import type { NonEvmReserve } from "./nonevm-types";

const API = "https://api.solend.fi";

interface CfgReserve { address?: string; liquidityToken?: { symbol?: string; mint?: string } }
interface Cfg { name?: string; reserves?: CfgReserve[] }
interface ResResult { reserve?: { config?: { loanToValueRatio?: number }; liquidity?: { availableAmount?: string; borrowedAmountWads?: string; marketPrice?: string; mintDecimals?: number; mintPubkey?: string } } }

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export const protocol = "solend";

export async function fetchReserves(): Promise<NonEvmReserve[]> {
  const cfgR = await fetch(`${API}/v1/markets/configs?scope=all&deployment=production`, { signal: AbortSignal.timeout(20_000) });
  if (!cfgR.ok) return [];
  const cfgs = (await cfgR.json()) as Cfg[];
  const main = cfgs.find((c) => (c.name ?? "").toLowerCase() === "main") ?? cfgs[0];
  if (!main?.reserves?.length) return [];

  const symByMint = new Map<string, string>();
  const ids: string[] = [];
  for (const r of main.reserves) {
    if (r.address) ids.push(r.address);
    if (r.liquidityToken?.mint) symByMint.set(r.liquidityToken.mint, r.liquidityToken.symbol ?? "?");
  }

  const rR = await fetch(`${API}/v1/reserves?ids=${ids.join(",")}`, { signal: AbortSignal.timeout(25_000) });
  if (!rR.ok) return [];
  const { results } = (await rR.json()) as { results?: ResResult[] };

  const out: NonEvmReserve[] = [];
  for (const x of results ?? []) {
    const liq = x.reserve?.liquidity;
    if (!liq) continue;
    const dec = liq.mintDecimals ?? 0;
    const price = n(liq.marketPrice) / 1e18;
    const borrow = n(liq.borrowedAmountWads) / 1e18 / 10 ** dec;
    const supply = n(liq.availableAmount) / 10 ** dec + borrow;
    const ltv = x.reserve?.config?.loanToValueRatio;
    out.push({
      protocol: "solend", chain: "solana", market: main.name ?? "Solend",
      symbol: symByMint.get(liq.mintPubkey ?? "") ?? "?",
      maxLtv: ltv != null && ltv > 0 ? n(ltv) / 100 : null,
      utilization: supply > 0 ? borrow / supply : 0,
      supplyUsd: supply * price, borrowUsd: borrow * price,
    });
  }
  return out;
}
