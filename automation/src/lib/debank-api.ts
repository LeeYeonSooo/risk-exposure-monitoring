import type { DebankProfile, DebankProtocolPosition } from "./debank-scrape";

/**
 * DeBank Cloud OpenAPI (공식) — 스크레이프 대안 "다른 우회".
 *
 * 왜: Cloudflare 가 막는 건 헤드리스 브라우저 + DC IP 다. 공식 OpenAPI 는 서버→서버 호출이라
 *   브라우저/Cloudflare 자체를 안 거침 → 어떤 IP(샌드박스 포함)에서도 동작. 단 AccessKey(유료) 필요.
 *   키 없으면 null 반환 → 호출부가 스크레이프/온체인 폴백.
 *
 * Endpoint: https://pro-openapi.debank.com/v1  (header: AccessKey)
 * Env: DEBANK_ACCESS_KEY
 */
const BASE = "https://pro-openapi.debank.com/v1";

export function debankApiAvailable(): boolean {
  return !!process.env.DEBANK_ACCESS_KEY;
}

export async function fetchDebankApi(wallet: string): Promise<DebankProfile | null> {
  const key = process.env.DEBANK_ACCESS_KEY;
  if (!key) return null;
  const headers: Record<string, string> = { AccessKey: key, accept: "application/json" };
  const g = (path: string) =>
    fetch(`${BASE}${path}`, { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  const [tb, pl, tl] = await Promise.all([
    g(`/user/total_balance?id=${wallet}`),
    g(`/user/all_complex_protocol_list?id=${wallet}`),
    g(`/user/all_token_list?id=${wallet}&is_all=false`),
  ]);
  if (!tb && !(Array.isArray(pl) && pl.length)) return null; // 키 무효/데이터 없음 → 폴백

  const protocols: DebankProtocolPosition[] = Array.isArray(pl)
    ? (pl as Array<Record<string, unknown>>).map((p) => {
        const items = (p.portfolio_item_list ?? []) as Array<Record<string, unknown>>;
        const net = items.reduce((s, it) => s + Number((it.stats as Record<string, unknown>)?.net_usd_value ?? 0), 0);
        return {
          protocolName: String(p.name ?? p.id ?? "unknown"),
          chain: String(p.chain ?? "eth"),
          netUsdValue: net,
          positions: items.map((it) => ({ name: String(it.name ?? "position"), detailTypes: (it.detail_types as string[]) ?? [], tokens: [] })),
        };
      })
    : [];

  const walletTokens = Array.isArray(tl)
    ? (tl as Array<Record<string, unknown>>).map((t) => ({
        symbol: String(t.symbol ?? "?"),
        amount: Number(t.amount ?? 0),
        usdValue: Number(t.amount ?? 0) * Number(t.price ?? 0),
        chain: String(t.chain ?? "eth"),
      }))
    : [];

  return {
    address: wallet.toLowerCase(),
    totalUsdValue: Number((tb as Record<string, unknown>)?.total_usd_value ?? 0),
    protocols,
    walletTokens,
    scrapedAt: new Date().toISOString(),
  };
}
