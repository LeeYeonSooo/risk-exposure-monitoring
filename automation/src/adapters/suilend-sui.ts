/**
 * Suilend (Sui) 렌딩 어댑터 — 공개 REST 없음 → 온체인 LendingMarket 오브젝트 1콜(sui_getObject).
 *   45개 reserve 가 content.fields.reserves[] 에 인라인. Alchemy Sui RPC(키) 우선, 공개 풀노드 폴백.
 *
 * reserve.fields: available_amount(base units, u64) · borrowed_amount(Decimal value/1e18, base units) ·
 *   price(Decimal value/1e18, USD) · mint_decimals · config.fields.open_ltv_pct(=maxLtv ×100) · coin_type.fields.name.
 */
import { env } from "@/config/chains";
import type { NonEvmReserve } from "./nonevm-types";

const LENDING_MARKET = "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1"; // Main Market
const SUI_RPC = env.ALCHEMY_API_KEY ? `https://sui-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : "https://fullnode.mainnet.sui.io:443";
const SUI_FALLBACK = "https://fullnode.mainnet.sui.io:443";

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

interface SuiReserve {
  fields?: {
    coin_type?: { fields?: { name?: string } };
    mint_decimals?: string | number;
    available_amount?: string | number;
    borrowed_amount?: { fields?: { value?: string } };
    price?: { fields?: { value?: string } };
    config?: { fields?: { open_ltv_pct?: string | number } };
  };
}

export const protocol = "suilend";

export async function fetchReserves(): Promise<NonEvmReserve[]> {
  let reserves: SuiReserve[] = [];
  for (const url of [SUI_RPC, SUI_FALLBACK]) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sui_getObject", params: [LENDING_MARKET, { showContent: true }] }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { result?: { data?: { content?: { fields?: { reserves?: SuiReserve[] } } } } };
      reserves = j.result?.data?.content?.fields?.reserves ?? [];
      if (reserves.length) break;
    } catch { /* try fallback */ }
  }

  const out: NonEvmReserve[] = [];
  for (const rv of reserves) {
    const f = rv.fields;
    if (!f) continue;
    const symbol = String(f.coin_type?.fields?.name ?? "").split("::").pop() || "?";
    const dec = n(f.mint_decimals);
    const avail = n(f.available_amount);
    const bor = n(f.borrowed_amount?.fields?.value) / 1e18;          // Decimal → base units
    const price = n(f.price?.fields?.value) / 1e18;                  // Decimal → USD
    if (!(price > 0)) continue;
    const totalBase = avail + bor;
    const supplyUsd = (totalBase / 10 ** dec) * price;
    const borrowUsd = (bor / 10 ** dec) * price;
    if (!Number.isFinite(supplyUsd) || supplyUsd > 50e9) continue;   // bogus/test reserve 가드(합계 폭발 방지)
    const ltvPct = n(f.config?.fields?.open_ltv_pct);
    out.push({
      protocol: "suilend", chain: "sui", market: "Suilend Main", symbol,
      maxLtv: ltvPct > 0 ? ltvPct / 100 : null,
      utilization: totalBase > 0 ? bor / totalBase : 0,
      supplyUsd, borrowUsd,
    });
  }
  return out;
}
