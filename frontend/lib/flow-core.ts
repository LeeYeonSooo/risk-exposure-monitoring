/**
 * flow-core — builds the live FlowGraph (real data) for N tokens × M chains.
 *
 * Sources (keyless, live): DeFiLlama /pools (cached, ~15MB) · Morpho blue-api markets
 * · public-RPC totalSupply (bridge sizing). Within a chain a protocol is ONE shared
 * node (multiple tokens edge into it); markets/vaults are real nodes; a market edges
 * back to every in-graph token it involves → the token⇄market⇄token web.
 */

import { hasFlowAdapter } from "./flow-adapters";
import { erc20Symbol, wrappedUnderlying } from "./lending-pools";
import { gatedGql } from "./rpc-gate";
import type { FlowEdge, FlowGraph, FlowNode, FlowTokenSummary } from "./flow-types";

// 팀 확정(2026-06-12): **이더리움 · Base · Arbitrum 3개만** 확실하게. 여기 매핑이 없으면
// DeFiLlama 풀 집계에서 자연히 걸러진다 (선택지 chains-ui.SUPPORTED_CHAINS 와 동일 집합).
export const CHAIN_MAP: Record<string, string> = {
  Ethereum: "ethereum", Base: "base", Arbitrum: "arbitrum",
};
// Morpho 마켓 chainId → 체인 키 — 지원 집합만.
const CHAINID_KEY: Record<number, string> = { 1: "ethereum", 8453: "base", 42161: "arbitrum" };
const morphoChainKey = (id?: number, net?: string) =>
  (id != null && CHAINID_KEY[id]) || (net || "").toLowerCase().split(" ")[0] || null;

export const DEFAULT_TOKENS = ["stETH", "wstETH", "weETH", "WBTC", "USDe"];
export const DEFAULT_CHAINS = ["ethereum"];

// verified canonical addresses (ethereum) — DeFiLlama 단일-노출 풀로는 주소가 안 풀리는 토큰의
// 정답지 (LST/볼트 풀은 underlying 에 예치자산 WETH/0x0 을 적는다). 출처: 구 lib/flowmap.ts 의
// **온체인 symbol()/decimals() 배치 검증 통과 목록**(git HEAD 에서 복원) + wBETH/mETH 는
// 2026-06-12 publicnode symbol() 직접 검증. 손 타이핑 추가 금지 — 검증 후에만.
const BUILTIN_ADDR: Record<string, Record<string, string>> = {
  ethereum: {
    WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", STETH: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    WSTETH: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", WEETH: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee",
    RSETH: "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7", EZETH: "0xbf5495efe5db9ce00f80364c8b423567e58d2110",
    RETH: "0xae78736cd615f374d3085123a210448e74fc6393", CBETH: "0xbe9895146f7af43049ca1c1ae358b0541ea49704",
    ETHX: "0xa35b1b31ce002fbf2058d22f30f95d405200a15b", OSETH: "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38",
    PUFETH: "0xd9a442856c234a39a81a089c06451ebaa4306a72", FRXETH: "0x5e8422345238f34275888049021821e8e08caa1f",
    WBETH: "0xa2e3356610840701bdf5611a53974510ae27e2e1", METH: "0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa",
    WBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", CBBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
    LBTC: "0x8236a87084f8b84306f72007f36f2618a5634494", EBTC: "0x657e8c867d8b37dcc18fa4caead9c45eb088c642",
    TBTC: "0x18084fba666a33d37592fa2633fd49a74dd93a88", KBTC: "0x73e0c0d45e048d25fc26fa3159b0aa04bfa4db98",
    USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    DAI: "0x6b175474e89094c44da98b954eedeac495271d0f", USDS: "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
    USDE: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", SUSDE: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
    GHO: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", SDAI: "0x83f20f44975d03b1b09e64809b757c47f942beea",
    SUSDS: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", PYUSD: "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
    CRVUSD: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", FRAX: "0x853d955acef822db058eb8505911ed77f175b99e",
    RLUSD: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", USD0: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5",
    USDY: "0x96f6ef951840721adbf46ac996b59e0235cb985c", REUSD: "0x5086bf358635b81d8c47c66d1c8b9e567db70c72",
    FRXUSD: "0xcacd6fd266af91b8aed52accc382b4e165586e29", SYRUPUSDC: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
    DOLA: "0x865377367054516e17014ccded1e7d814edc9ce4", USDTB: "0xc139190f447e929f090edeb554d95abb8b18ac1c",
    AUSD: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", USDG: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
    USD1: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", BOLD: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
    USTB: "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e", OUSG: "0x1b19c19393e2d034d8ff31ff34c81252fcbbee92",
    LINK: "0x514910771af9ca656af840dff83e8264ecf986ca", XAUT: "0x68749665ff8d2d112fa859aa293f07a622782f38",
    AAVE: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", PAXG: "0x45804880de22913dafe09f4980848ece6ecbaf78",
  },
};
const REVALIDATE = 600;

interface LlamaPool {
  chain?: string; project?: string; symbol?: string; tvlUsd?: number;
  apy?: number | null; exposure?: string | null; underlyingTokens?: string[] | null; category?: string | null;
  /** 일/주 거래량 USD — DEX 류 풀만 값이 있음 (DeFiLlama dexs 대시보드 연동 필드) */
  volumeUsd1d?: number | null; volumeUsd7d?: number | null;
}

const symbolParts = (s: string | null | undefined) => (s ?? "").toUpperCase().split(/[-/\s+.]+/).filter(Boolean);
const norm = (a: string) => (/^0x/i.test(a) ? a.toLowerCase() : a);
const usd = (n: number | null | undefined) => (typeof n === "number" && isFinite(n) && n > 0 ? n : 0);

// ── 주소 정합 검증 — LST/볼트 풀은 underlyingTokens 에 "예치 자산"(WETH·네이티브 ETH 0x0·USDC)을
// 적는 경우가 많다. 그 주소를 무검증 선착으로 토큰 주소로 채택하면 (a) 시총이 ETH/USDC 것으로
// 복제되고(실측: 전 LST = $202B) (b) 트랜잭션 피드가 남의 토큰 전송을 보여준다(거짓 피드).
// → 제로주소/네이티브 센티널 제외 + 주소의 실제 심볼이 후보 심볼과 일치할 때만 채택한다. ──
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const isRealAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a) && !/^0x0{40}$/.test(a) && a !== NATIVE_SENTINEL;
const normSymKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// coins.llama.fi 가 보고하는 그 주소의 실제 심볼 (이더리움, 30분 캐시) — 시총 키 검증용 배치 조회
const _llamaSymCache = new Map<string, { at: number; sym: string | null }>();
async function llamaSymbols(addrs: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const need: string[] = [];
  const now = Date.now();
  for (const a of [...new Set(addrs)]) {
    const hit = _llamaSymCache.get(a);
    if (hit && now - hit.at < 30 * 60_000) out.set(a, hit.sym);
    else need.push(a);
  }
  for (let i = 0; i < need.length; i += 70) {
    const chunk = need.slice(i, i + 70);
    try {
      const r = await fetch(`https://coins.llama.fi/prices/current/${chunk.map((a) => `ethereum:${a}`).join(",")}`, { cache: "no-store" });
      const j = r.ok ? ((await r.json()) as { coins?: Record<string, { symbol?: string }> }) : {};
      for (const a of chunk) {
        const sym = (j as { coins?: Record<string, { symbol?: string }> }).coins?.[`ethereum:${a}`]?.symbol ?? null;
        _llamaSymCache.set(a, { at: now, sym });
        out.set(a, sym);
      }
    } catch { for (const a of chunk) out.set(a, null); }
  }
  return out;
}
function inc(m: Map<string, number>, k: string, n: number) { m.set(k, (m.get(k) ?? 0) + n); }
function push<T>(m: Map<string, T[]>, k: string, v: T) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }

// ── 프로토콜 카테고리 (DeFiLlama /protocols) — "렌딩은 TVL, DEX 는 거래량" 분류 기준의 근거 ──
// project 슬러그 → 카테고리 그룹. 6h 캐시(카테고리는 사실상 정적). 미등재 = 풀 category 폴백 → other.
export type ProtoCatGroup = "dex" | "lending" | "staking" | "yield" | "other";
export function catGroupOf(category: string | null | undefined): ProtoCatGroup {
  const c = (category ?? "").toLowerCase();
  if (!c) return "other";
  if (/dex|exchange/.test(c)) return "dex";
  if (/lending|cdp|money market/.test(c)) return "lending";
  if (/staking|restaking/.test(c)) return "staking"; // Liquid (Re)Staking · Staking Pool
  if (/yield|farm|vault/.test(c)) return "yield";
  return "other";
}
let _catCache: { at: number; bySlug: Map<string, string> } | null = null;
let _catInflight: Promise<Map<string, string>> | null = null;
async function protocolCategories(): Promise<Map<string, string>> {
  if (_catCache && Date.now() - _catCache.at < 6 * 3600_000) return _catCache.bySlug;
  if (_catInflight) return _catInflight;
  _catInflight = (async () => {
    const bySlug = new Map<string, string>();
    try {
      const r = await fetch("https://api.llama.fi/protocols", { cache: "no-store" });
      if (r.ok) {
        const arr = (await r.json()) as { name?: string; slug?: string; category?: string }[];
        for (const p of arr) {
          if (!p.category) continue;
          if (p.slug) bySlug.set(p.slug.toLowerCase(), p.category);
          // yields 의 project 키가 slug 와 다른 경우 대비 — 이름 기반 슬러그도 함께 등록
          if (p.name) bySlug.set(p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), p.category);
        }
      }
    } catch { /* 카테고리 실패 → 풀 category 폴백 (선별은 degrade, 실패하지 않음) */ }
    _catCache = { at: Date.now(), bySlug };
    return bySlug;
  })().finally(() => { _catInflight = null; });
  return _catInflight;
}

// ── Curve LP 풀 (공식 API — lpTokenAddress 가 곧 파생 LP 토큰, 1h 캐시) ──
interface CurveLpPool { name: string; lpToken: string | null; lpSymbol: string | null; usdTotal: number; coins: { symbol: string; address: string }[] }
let _curveLpCache: { at: number; pools: CurveLpPool[] } | null = null;
async function curveLpPools(): Promise<CurveLpPool[]> {
  if (_curveLpCache && Date.now() - _curveLpCache.at < 3600_000) return _curveLpCache.pools;
  const REGS = ["main", "factory-stable-ng", "crypto", "factory-crypto", "factory-tricrypto"];
  const pools: CurveLpPool[] = [];
  await Promise.all(REGS.map(async (reg) => {
    try {
      const r = await fetch(`https://api.curve.finance/api/getPools/ethereum/${reg}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return;
      const j = (await r.json()) as { data?: { poolData?: { name?: string; symbol?: string; lpTokenAddress?: string; address?: string; usdTotal?: number; coins?: { symbol?: string; address?: string }[] }[] } };
      for (const p of j.data?.poolData ?? []) {
        const lp = (p.lpTokenAddress ?? p.address ?? "").toLowerCase();
        pools.push({
          name: p.name ?? "", lpToken: /^0x[0-9a-f]{40}$/.test(lp) ? lp : null, lpSymbol: p.symbol ?? null,
          usdTotal: p.usdTotal ?? 0, coins: (p.coins ?? []).map((c) => ({ symbol: c.symbol ?? "?", address: (c.address ?? "").toLowerCase() })),
        });
      }
    } catch { /* 레지스트리 실패 → 그 레지스트리만 생략 */ }
  }));
  if (pools.length) _curveLpCache = { at: Date.now(), pools };
  return pools;
}

let _poolsCache: { at: number; data: LlamaPool[] } | null = null;
let _poolsInflight: Promise<LlamaPool[]> | null = null;
async function fetchLlamaPools(): Promise<LlamaPool[]> {
  const now = Date.now();
  if (_poolsCache && now - _poolsCache.at < REVALIDATE * 1000) return _poolsCache.data;
  if (_poolsInflight) return _poolsInflight;
  _poolsInflight = (async () => {
    const res = await fetch("https://yields.llama.fi/pools", { cache: "no-store" });
    if (!res.ok) throw new Error(`DeFiLlama pools HTTP ${res.status}`);
    const data = ((await res.json()) as { data?: LlamaPool[] }).data ?? [];
    _poolsCache = { at: Date.now(), data };
    return data;
  })().finally(() => { _poolsInflight = null; });
  return _poolsInflight;
}

interface MItem {
  lltv?: string; oracleAddress?: string; loanAsset?: { symbol?: string; address?: string }; collateralAsset?: { symbol?: string; address?: string };
  state?: { supplyAssetsUsd?: number; collateralAssetsUsd?: number; utilization?: number };
  chain?: { id?: number; network?: string }; supplyingVaults?: { name?: string; address?: string }[];
}
async function morphoGql(query: string): Promise<{ data: unknown; errored: boolean }> {
  // 게이트 + 재시도(lib/rpc-gate) — blue-api 의 일시적 실패가 morpho 마켓 노드를 통째로
  // 사라지게 하던 취약점 차단(평소 집계의 morpho 흐름 누락과 같은 클래스).
  const j = await gatedGql<{ data?: unknown; errors?: unknown[] }>("https://blue-api.morpho.org/graphql", query);
  if (!j) return { data: null, errored: true };
  return { data: j.data ?? null, errored: !!j.errors?.length };
}
async function morphoQuery(filter: string, addrs: string[]): Promise<MItem[]> {
  // oracleAddress = the market's REAL price feed (오라클 엣지의 데이터원). If the schema ever
  // rejects the field, retry without it — degrade to no oracle edges, never fail the markets.
  const q = (withOracle: boolean) =>
    `{ markets(first: 400, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { ${filter}: ${JSON.stringify(addrs)} }) { items { lltv ${withOracle ? "oracleAddress " : ""}loanAsset { symbol address } collateralAsset { symbol address } state { supplyAssetsUsd collateralAssetsUsd utilization } chain { id network } supplyingVaults { name address } } } }`;
  const first = await morphoGql(q(true));
  const items1 = ((first.data as { markets?: { items?: MItem[] } } | null)?.markets?.items ?? []);
  if (items1.length || !first.errored) return items1;
  const second = await morphoGql(q(false));
  return ((second.data as { markets?: { items?: MItem[] } } | null)?.markets?.items ?? []);
}

interface VaultMeta { tvl: number; curator: string | null }
/** real TVL + curator names for the Morpho supplying vaults (vault = 큐레이터 운용 주체). */
async function morphoVaultMeta(addrs: string[]): Promise<Map<string, VaultMeta>> {
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
  if (!uniq.length) return new Map();
  interface VItem { address?: string; state?: { totalAssetsUsd?: number }; metadata?: { curators?: { name?: string }[] } }
  const q = (withCurators: boolean) =>
    `{ vaults(first: 200, where: { address_in: ${JSON.stringify(uniq)} }) { items { address state { totalAssetsUsd } ${withCurators ? "metadata { curators { name } }" : ""} } } }`;
  let res = await morphoGql(q(true));
  let items = ((res.data as { vaults?: { items?: VItem[] } } | null)?.vaults?.items ?? []);
  if (!items.length && res.errored) {
    res = await morphoGql(q(false));
    items = ((res.data as { vaults?: { items?: VItem[] } } | null)?.vaults?.items ?? []);
  }
  const out = new Map<string, VaultMeta>();
  for (const v of items) {
    if (!v.address) continue;
    const names = (v.metadata?.curators ?? []).map((c) => c.name).filter(Boolean) as string[];
    out.set(v.address.toLowerCase(), { tvl: usd(v.state?.totalAssetsUsd), curator: names.length ? [...new Set(names)].join(", ") : null });
  }
  return out;
}

// ── real on-chain per-chain totalSupply (public RPC, keyless) — bridged amount per chain ──
const RPC: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com", base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
};
// Euler Earn curator vaults (Goldsky public subgraph, keyless, multichain)
const EULER_ENDPOINTS: Record<string, string> = {
  ethereum: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn",
  base: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-base/latest/gn",
  arbitrum: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-arbitrum/latest/gn",
};

type PriceMap = Map<string, { price: number; decimals: number }>; // key `${chain}:${addrLower}`
async function fetchPrices(pairs: { chain: string; addr: string }[]): Promise<PriceMap> {
  const keys = [...new Set(pairs.filter((p) => /^0x[0-9a-fA-F]{40}$/.test(p.addr)).map((p) => `${p.chain}:${p.addr.toLowerCase()}`))];
  const out: PriceMap = new Map();
  if (!keys.length) return out;
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}`, { cache: "no-store" });
    if (!r.ok) return out;
    const j = (await r.json()) as { coins?: Record<string, { price?: number; decimals?: number }> };
    for (const [k, v] of Object.entries(j.coins ?? {})) if (v.price != null && v.decimals != null) out.set(k.toLowerCase(), { price: v.price, decimals: v.decimals });
    return out;
  } catch { return out; }
}

/** per-chain on-chain totalSupply in USD for one token (addr per chain). */
async function fetchChainSupplies(addrByChain: Record<string, string>, prices: PriceMap): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const chains = Object.keys(addrByChain).filter((c) => RPC[c] && /^0x[0-9a-fA-F]{40}$/.test(addrByChain[c]) && prices.has(`${c}:${addrByChain[c].toLowerCase()}`));
  await Promise.all(chains.map(async (chain) => {
    try {
      const r = await fetch(RPC[chain], { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: addrByChain[chain], data: "0x18160ddd" }, "latest"] }) });
      if (!r.ok) return;
      const j = (await r.json()) as { result?: string };
      if (!j.result || j.result === "0x") return;
      const { price, decimals } = prices.get(`${chain}:${addrByChain[chain].toLowerCase()}`)!;
      const supply = Number(BigInt(j.result)) / Math.pow(10, decimals);
      if (supply > 0) out[chain] = supply * price;
    } catch { /* skip */ }
  }));
  return out;
}

interface EulerVault { name: string; curator: string | null; allocationUsd: number; chain: string }
async function fetchEulerVaults(addrByChain: Record<string, string>, prices: PriceMap): Promise<EulerVault[]> {
  const out: EulerVault[] = [];
  const chains = Object.keys(addrByChain).filter((c) => EULER_ENDPOINTS[c] && /^0x[0-9a-fA-F]{40}$/.test(addrByChain[c]) && prices.has(`${c}:${addrByChain[c].toLowerCase()}`));
  await Promise.all(chains.map(async (chain) => {
    const addr = addrByChain[chain].toLowerCase();
    const query = `{ eulerEarnVaults(first: 40, where: { asset: "${addr}" }) { name curator totalAssets } }`;
    try {
      const r = await fetch(EULER_ENDPOINTS[chain], { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ query }) });
      if (!r.ok) return;
      const j = (await r.json()) as { data?: { eulerEarnVaults?: { name?: string; curator?: string; totalAssets?: string }[] } };
      const { price, decimals } = prices.get(`${chain}:${addr}`)!;
      for (const v of j.data?.eulerEarnVaults ?? []) {
        const allocationUsd = (Number(v.totalAssets ?? 0) / Math.pow(10, decimals)) * price;
        if (allocationUsd >= 50_000) out.push({ name: v.name || "Euler Earn", curator: v.curator && !/^0x0+$/.test(v.curator) ? v.curator : null, allocationUsd, chain });
      }
    } catch { /* skip */ }
  }));
  return out.sort((a, b) => b.allocationUsd - a.allocationUsd);
}

function topByShare<T>(items: T[], sizeOf: (t: T) => number, total: number, pct: number, maxN: number): T[] {
  const sorted = [...items].filter((i) => sizeOf(i) > 0).sort((a, b) => sizeOf(b) - sizeOf(a));
  const out: T[] = []; let cum = 0;
  for (const it of sorted) { out.push(it); cum += sizeOf(it); if (out.length >= maxN) break; if (total > 0 && cum / total >= pct) break; }
  return out.length ? out : sorted.slice(0, 1);
}

export interface BuildOpts {
  tokens?: string[]; chains?: string[]; topPct?: number; maxProtocolsPerToken?: number; maxMarketsPerProtocol?: number;
}

/** Top tokens by market cap (live, for the search picker). 후보 = DeFiLlama 단일-노출 풀 심볼
 *  (DeFi 관련 토큰 universe) + 각 토큰의 이더리움 주소. 순위/표시 = 시가총액(coins/mcaps).
 *  tvlUsd 필드는 호출부 호환을 위해 유지하되 값은 mcap(없으면 풀 TVL 폴백)을 담는다. */
export async function topTokensByTvl(limit = 150): Promise<{ symbol: string; tvlUsd: number }[]> {
  let pools: LlamaPool[] = [];
  try { pools = await fetchLlamaPools(); } catch { return []; }
  const poolUsd = new Map<string, number>();
  const display = new Map<string, string>();
  const addr = new Map<string, string>(); // SYM → ethereum 주소(시총 조회 키)
  for (const p of pools) {
    if (p.exposure !== "single") continue;
    const parts = symbolParts(p.symbol);
    if (parts.length !== 1) continue;
    const sym = parts[0];
    if (sym.length < 2 || sym.length > 12 || /^\d+$/.test(sym)) continue;
    inc(poolUsd, sym, usd(p.tvlUsd));
    if (!display.has(sym)) display.set(sym, (p.symbol ?? sym).split(/[-/\s+.]/)[0]);
    // 이더리움 단일-노출 풀의 underlyingTokens[0] = 그 토큰 주소 후보 (BUILTIN 우선, 제로주소 제외).
    const b = BUILTIN_ADDR.ethereum[sym];
    if (b) addr.set(sym, b);
    else if (!addr.has(sym) && CHAIN_MAP[p.chain ?? ""] === "ethereum" && p.underlyingTokens?.length === 1 && isRealAddr((p.underlyingTokens[0] ?? "").toLowerCase())) {
      addr.set(sym, p.underlyingTokens[0]!.toLowerCase());
    }
  }
  // 풀 TVL 상위 후보만 시총 조회(배치 비용 제한) — 어차피 큰 토큰이 시총도 큼.
  const cands = [...poolUsd.entries()].filter(([, v]) => v > 1_000_000).sort((a, b) => b[1] - a[1]).slice(0, 250);
  // ── 시총 키 주소 정합 검증: 라마가 보고하는 그 주소의 실제 심볼이 후보 심볼과 일치할 때만
  // 시총 키로 쓴다 (BUILTIN 은 검증된 정답지라 통과). 불일치 = LST 풀의 WETH/USDC 오인 →
  // 주소를 버리고 풀 TVL 폴백 — "전 LST 가 똑같이 $202B" 복제 버그의 원인 차단. ──
  const builtinSyms = new Set(Object.keys(BUILTIN_ADDR.ethereum));
  const unverified = cands.filter(([s]) => addr.has(s) && !builtinSyms.has(s));
  const symByAddr = await llamaSymbols(unverified.map(([s]) => addr.get(s)!));
  for (const [s] of unverified) {
    const ls = symByAddr.get(addr.get(s)!);
    if (!ls || normSymKey(ls) !== normSymKey(s)) addr.delete(s);
  }
  const coins = cands.map(([s]) => addr.get(s)).filter((a): a is string => !!a).map((a) => `ethereum:${a}`);
  let mcaps = new Map<string, number>();
  if (coins.length) {
    try {
      const r = await fetch("https://coins.llama.fi/mcaps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ coins }), cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as Record<string, { mcap?: number }>;
        for (const [s] of cands) { const a = addr.get(s); const m = a ? j[`ethereum:${a}`]?.mcap : undefined; if (typeof m === "number" && m > 0) mcaps.set(s, m); }
      }
    } catch { /* 시총 실패 → 풀 TVL 폴백 */ }
  }
  return cands
    .map(([sym, tvl]) => ({ symbol: display.get(sym) ?? sym, tvlUsd: mcaps.get(sym) ?? tvl }))
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, limit);
}

interface PoolRec { symbol: string; tvl: number; vol: number; apy: number | null; tokens: string[]; project: string; chain: string }
interface MktRec { key: string; label: string; size: number; vol: number; lltv: number | null; util: number | null; vaults: { name: string; address?: string }[]; tokens: string[]; project: string; chain: string; oracle: string | null }

export async function buildFlowGraph(opts: BuildOpts = {}): Promise<FlowGraph> {
  const wantTokens = (opts.tokens?.length ? opts.tokens : DEFAULT_TOKENS).map((t) => t.trim()).filter(Boolean);
  const wantChains = new Set((opts.chains?.length ? opts.chains : DEFAULT_CHAINS).map((c) => c.toLowerCase()));
  const topPct = opts.topPct ?? 0.92;
  const maxProto = opts.maxProtocolsPerToken ?? 7;
  const maxMkt = opts.maxMarketsPerProtocol ?? 5;
  const notes: string[] = [];

  let pools: LlamaPool[] = [];
  try { pools = await fetchLlamaPools(); } catch (e) { notes.push(`defillama: ${(e as Error).message}`); }

  const wantSet = new Set(wantTokens.map((t) => t.toUpperCase()));
  const dispBy = new Map(wantTokens.map((t) => [t.toUpperCase(), t] as const));

  // ── 파생 가족 자동 확장 — BUILTIN 정답지 × wrappedUnderlying(영구 캐시)로 선택 토큰의
  //    기초/파생 심볼을 wantSet 에 합류시켜 **1급 토큰으로 집계**한다. 이걸 안 하면 자동 추가된
  //    파생(wstETH 등)에 정식 holds/market 엣지가 없어 모든 흐름이 '발견' 점선으로 격하된다. ──
  if (wantChains.has("ethereum")) {
    const entries = Object.entries(BUILTIN_ADDR.ethereum);
    const symByAddrB = new Map(entries.map(([s, a]) => [a, s] as const));
    const baseOf = new Map<string, string>(); // 파생 sym → 기초 sym (BUILTIN 내 검증 쌍만)
    // 동시성 8 제한 — 48토큰×3셀렉터 일제 사격이 publicnode 429 를 부르고, (수정 전엔)
    // 그 실패가 영구 음성 캐시로 굳어 가족 확장이 전멸했다. 캐시 덕에 콜드스타트만 비용.
    for (let i = 0; i < entries.length; i += 8) {
      await Promise.all(entries.slice(i, i + 8).map(async ([s, a]) => {
        const u = await wrappedUnderlying("ethereum", a);
        const b = u ? symByAddrB.get(u) : undefined;
        if (b) baseOf.set(s, b);
      }));
    }
    // 카나리아 — BUILTIN 에는 stETH↔wstETH 등 확실한 쌍이 늘 있으므로 0이면 RPC 장애다
    if (baseOf.size === 0) notes.push("파생 가족 프로브 실패(RPC) — 파생 토큰이 일부 누락될 수 있음(다음 갱신에서 자동 복구)");
    let changed = true;
    while (changed) { // 가족 폐포 — 기초를 고르면 파생이, 파생을 고르면 기초가 따라온다 (양방향)
      changed = false;
      for (const [d, b] of baseOf) {
        if (wantSet.has(d) && !wantSet.has(b)) { wantSet.add(b); changed = true; }
        if (wantSet.has(b) && !wantSet.has(d)) { wantSet.add(d); changed = true; }
      }
    }
    for (const s of wantSet) if (!dispBy.has(s) && BUILTIN_ADDR.ethereum[s]) {
      dispBy.set(s, (await erc20Symbol("ethereum", BUILTIN_ADDR.ethereum[s])) ?? s); // 표기는 온체인 심볼
    }
  }

  // canonical addr per (SYM, chain) — 후보를 모은 뒤 **온체인 symbol() 정합 검증**으로 확정.
  // 무검증 선착 채택은 LST 풀의 underlying(WETH·0x0)을 토큰 주소로 오인해 (a) 그 토큰의
  // 트랜잭션 피드가 남의 전송을 보여주고 (b) 제로주소 토큰은 피드가 영원히 비는 버그를 만든다
  // (LSETH/WBETH → 0x0 실측). 검증은 publicnode eth_call·프로세스 영구 캐시라 비용 수렴.
  const addrByTC = new Map<string, string>(); const canonByTC = new Map<string, Set<string>>();
  const candsByTC = new Map<string, string[]>();
  for (const p of [...pools].filter((p) => p.exposure === "single" && p.underlyingTokens?.length === 1 && p.underlyingTokens?.[0]).sort((a, b) => usd(b.tvlUsd) - usd(a.tvlUsd))) {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain) continue;
    for (const part of new Set(symbolParts(p.symbol))) {
      if (!wantSet.has(part)) continue;
      const k = `${part}|${chain}`, a = norm(p.underlyingTokens![0]!);
      if (!canonByTC.has(k)) canonByTC.set(k, new Set());
      canonByTC.get(k)!.add(a); // 풀 충돌가드용 canon 은 전 후보 유지 (기존 시맨틱)
      if (isRealAddr(a)) {
        const arr = candsByTC.get(k) ?? [];
        if (!arr.length) candsByTC.set(k, arr);
        if (arr.length < 6 && !arr.includes(a)) arr.push(a); // TVL 순 상위 6후보까지 검증 — LST 는 예치자산(WETH 등) 후보가 앞을 채워 진짜 주소가 뒤에 온다 (검증은 영구 캐시라 비용 수렴)
      }
    }
  }
  // verified builtin canonical addresses OVERRIDE DeFiLlama resolution for known tokens
  // (DeFiLlama can resolve stETH/weETH to an unpriced representation → no supply/euler).
  for (const tk of wantSet) for (const chain of wantChains) {
    const b = BUILTIN_ADDR[chain]?.[tk]; if (!b) continue;
    const k = `${tk}|${chain}`;
    addrByTC.set(k, b);
    if (!canonByTC.has(k)) canonByTC.set(k, new Set());
    canonByTC.get(k)!.add(b);
  }
  // BUILTIN 이 없는 키: 첫 "정합"(온체인 symbol == 후보 심볼) 후보 채택. 정합이 없으면 —
  // 반증 없는(RPC 부재/리드 실패) 첫 후보로 폴백, 반증만 있으면(전부 다른 토큰으로 판명)
  // 주소 미확정 = 그 토큰은 피드 없음 (거짓 피드보다 정직한 공백).
  await Promise.all([...candsByTC.entries()].map(async ([k, cands]) => {
    if (addrByTC.has(k)) return; // BUILTIN 정답지
    const [tk, chain] = k.split("|");
    let fallback: string | null = null;
    for (const cand of cands) {
      const sym = await erc20Symbol(chain, cand); // 프로세스 영구 캐시 — 같은 주소 재검증 0비용
      if (sym && normSymKey(sym) === normSymKey(tk)) { addrByTC.set(k, cand); return; }
      if (sym == null && fallback == null) fallback = cand;
    }
    if (fallback) addrByTC.set(k, fallback);
  }));
  // accumulate per protocol (chain|project): total, token contributions, pools — TVL 과 거래량을 함께.
  // 멘토 피드백: 사이즈(TVL)만 보면 "유동성은 작지만 거래량이 큰" DEX(Uniswap)가 계속 잘린다.
  const protoTotal = new Map<string, number>();
  const protoVolTotal = new Map<string, number>();
  const tokenInProto = new Map<string, number>();    // `${protoKey}|${TOKEN}` — TVL 기여
  const tokenVolInProto = new Map<string, number>(); // `${protoKey}|${TOKEN}` — 일 거래량 기여
  const poolsByProto = new Map<string, PoolRec[]>();
  const protoCategory = new Map<string, string | null>();

  for (const p of pools) {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain || !wantChains.has(chain) || !p.project) continue;
    const matched = [...new Set(symbolParts(p.symbol).filter((x) => wantSet.has(x)))];
    if (!matched.length) continue;
    const t = usd(p.tvlUsd); if (!t) continue;
    const v = usd(p.volumeUsd1d); // DEX 류만 값이 있음 — 없으면 0 (지어내지 않음)
    // collision guard per matched token
    const kept = matched.filter((part) => {
      const canon = canonByTC.get(`${part}|${chain}`);
      if (!canon?.size) return true;
      const ut = (p.underlyingTokens ?? []).map(norm);
      return !ut.length || ut.some((a) => canon.has(a));
    });
    if (!kept.length) continue;
    const protoKey = `${chain}|${p.project}`;
    inc(protoTotal, protoKey, t);
    if (v) inc(protoVolTotal, protoKey, v);
    protoCategory.set(protoKey, p.category ?? null);
    for (const part of kept) { inc(tokenInProto, `${protoKey}|${part}`, t); if (v) inc(tokenVolInProto, `${protoKey}|${part}`, v); }
    push(poolsByProto, protoKey, { symbol: p.symbol ?? "?", tvl: t, vol: v, apy: p.apy ?? null, tokens: kept.map((k) => dispBy.get(k)!), project: p.project, chain });
  }

  // Morpho precise markets
  const evmAddrs = [...new Set([...addrByTC.values()])].filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const addrToSym = new Map<string, string>();
  for (const [k, a] of addrByTC) addrToSym.set(a, dispBy.get(k.split("|")[0])!);
  const morphoByProto = new Map<string, MktRec[]>();
  if (evmAddrs.length) {
    const [asColl, asLoan] = await Promise.all([morphoQuery("collateralAssetAddress_in", evmAddrs), morphoQuery("loanAssetAddress_in", evmAddrs)]);
    const seen = new Set<string>();
    for (const m of [...asColl, ...asLoan]) {
      const chain = morphoChainKey(m.chain?.id, m.chain?.network); if (!chain || !wantChains.has(chain)) continue;
      const coll = addrToSym.get(norm(m.collateralAsset?.address ?? "")); const loan = addrToSym.get(norm(m.loanAsset?.address ?? ""));
      const involved = [coll, loan].filter(Boolean) as string[]; if (!involved.length) continue;
      const size = usd(m.state?.collateralAssetsUsd) || usd(m.state?.supplyAssetsUsd); if (size < 50_000) continue;
      const lltv = m.lltv ? Number(m.lltv) / 1e18 : null;
      // 모르포 마켓 정체성은 (loan, coll, ORACLE, lltv) — 오라클만 다른 두 실제 마켓이 합쳐지지 않게 키에 포함
      const key = `${m.collateralAsset?.symbol}/${m.loanAsset?.symbol}/${lltv}/${m.oracleAddress ?? ""}@${chain}`;
      if (seen.has(key)) continue; seen.add(key);
      const protoKey = `${chain}|morpho-blue`;
      inc(protoTotal, protoKey, size); protoCategory.set(protoKey, "Lending");
      for (const tk of new Set(involved)) inc(tokenInProto, `${protoKey}|${tk.toUpperCase()}`, size);
      push(morphoByProto, protoKey, {
        key, label: `${m.collateralAsset?.symbol ?? "?"}/${m.loanAsset?.symbol ?? "?"}`, size, vol: 0, lltv,
        util: m.state?.utilization ?? null, vaults: (m.supplyingVaults ?? []).map((v) => ({ name: v.name ?? "", address: v.address })).filter((v) => v.name).slice(0, 4),
        tokens: [...new Set(involved)], project: "morpho-blue", chain, oracle: m.oracleAddress ?? null,
      });
    }
  }

  // real vault sizes + curator names for the Morpho supplying vaults — ONE batched blue-api call
  const vaultAddrSet = new Set<string>();
  for (const list of morphoByProto.values()) for (const m of list) for (const v of m.vaults) if (v.address) vaultAddrSet.add(v.address.toLowerCase());
  const vaultMetaByAddr = await morphoVaultMeta([...vaultAddrSet]);

  // ── real on-chain chain supply (bridge sizing) + Euler curator vaults (per token) ──
  const eulerByProto = new Map<string, (EulerVault & { token: string })[]>();
  const chainSupplyByTC = new Map<string, number>(); // `${SYM}|${chain}` -> on-chain supply USD
  const perToken: { tk: string; addrByChain: Record<string, string> }[] = [];
  const allPairs: { chain: string; addr: string }[] = [];
  for (const tk of wantSet) {
    const addrByChain: Record<string, string> = {};
    for (const chain of wantChains) { const a = addrByTC.get(`${tk}|${chain}`); if (a) addrByChain[chain] = a; }
    if (!Object.keys(addrByChain).length) continue;
    perToken.push({ tk, addrByChain });
    for (const [c, a] of Object.entries(addrByChain)) allPairs.push({ chain: c, addr: a });
  }
  const prices = await fetchPrices(allPairs); // ONE batched coins.llama.fi call (avoids 429)
  await Promise.all(perToken.map(async ({ tk, addrByChain }) => {
    const [supplies, vaults] = await Promise.all([fetchChainSupplies(addrByChain, prices), fetchEulerVaults(addrByChain, prices)]);
    for (const [chain, u] of Object.entries(supplies)) chainSupplyByTC.set(`${tk}|${chain}`, u);
    for (const v of vaults) {
      const protoKey = `${v.chain}|euler`;
      inc(protoTotal, protoKey, v.allocationUsd); protoCategory.set(protoKey, "Yield (Euler)");
      inc(tokenInProto, `${protoKey}|${tk}`, v.allocationUsd);
      push(eulerByProto, protoKey, { ...v, token: dispBy.get(tk)! });
    }
  }));

  // token-chain totals + which protocols to keep — **카테고리 인지 선별** (멘토 피드백 반영):
  //  · 렌딩/스테이킹/일드 = TVL 기여 상위 (예치 스톡이 의미 있는 지표)
  //  · DEX = 일 거래량 기여 상위 (TVL 작아도 흐름의 본진 — "사이즈만 보다 Uniswap 놓침" 방지)
  //  · 카테고리별 쿼터를 먼저 보장한 뒤, 남는 슬롯은 정규화 점수 max(TVL 비중, 거래량 비중)로 채움
  //    — 서로 다른 단위(스톡 vs 플로우)를 "그 토큰 안에서의 비중"으로 환산해 비교한다.
  const tcTotal = new Map<string, number>();
  for (const [k, v] of tokenInProto) { const [chain, , token] = k.split("|"); inc(tcTotal, `${token}|${chain}`, v); }
  const tcVolTotal = new Map<string, number>();
  for (const [k, v] of tokenVolInProto) { const [chain, , token] = k.split("|"); inc(tcVolTotal, `${token}|${chain}`, v); }
  const catBySlug = await protocolCategories();
  const groupOfProto = (protoKey: string): ProtoCatGroup => {
    const project = protoKey.split("|")[1] ?? "";
    return catGroupOf(catBySlug.get(project.toLowerCase()) ?? protoCategory.get(protoKey));
  };
  const QUOTA: Record<ProtoCatGroup, number> = { lending: 4, dex: 4, staking: 3, yield: 3, other: 3 };
  const FILL_SCORE_MIN = 0.001;        // 어댑터 있는 프로토콜 충원 컷 — 0.1% 미만 꼬리 제외
  // 어댑터 없는 프로토콜은 10배 높은 컷(1%) — 흐름을 칠할 수단이 없어 노드가 회색으로만 남으므로,
  // 토큰 노출의 1% 미만인 니치(accountable·termmax·concrete 등)는 그래프를 회색으로 뒤덮지 않게
  // 제외한다(큰 어댑터-부재 프로토콜 balancer·pendle 은 1%↑면 그대로 표시). 2026-06-12 추가.
  const FILL_SCORE_MIN_NOADAPTER = 0.01;
  const scoreMinOf = (protoKey: string, chain: string) => hasFlowAdapter(protoKey.split("|")[1], chain) ? FILL_SCORE_MIN : FILL_SCORE_MIN_NOADAPTER;
  const keptProto = new Set<string>();
  const coreProto = new Set<string>(); // 쿼터 보장분 — 클라이언트 실효비중 컷에서도 항상 표시(meta.coreKeep)
  for (const tk of wantSet) {
    for (const chain of wantChains) {
      const mine: { protoKey: string; tvl: number; vol: number }[] = [];
      for (const [k, v] of tokenInProto) {
        const [c, , t] = k.split("|");
        if (c !== chain || t !== tk) continue;
        mine.push({ protoKey: k.split("|").slice(0, 2).join("|"), tvl: v, vol: tokenVolInProto.get(k) ?? 0 });
      }
      if (!mine.length) continue;
      const tvlTotal = tcTotal.get(`${tk}|${chain}`) || 1;
      const volTotal = tcVolTotal.get(`${tk}|${chain}`) || 1;
      const score = (m: { tvl: number; vol: number }) => Math.max(m.tvl / tvlTotal, m.vol / volTotal);
      const byCat = new Map<ProtoCatGroup, typeof mine>();
      for (const m of mine) { const g = groupOfProto(m.protoKey); const a = byCat.get(g); if (a) a.push(m); else byCat.set(g, [m]); }
      // 쿼터 후보에도 점수 하한 적용 — "staking 카테고리 3위"가 토큰 노출 0.001% 먼지여도
      // coreKeep 으로 영구 표시되는 것 방지. 쿼터 합(17)이 maxProto 를 넘을 수 있으므로
      // 점수순으로 maxProto 까지만 채택해 파라미터 계약을 지킨다.
      const quotaPicks: { protoKey: string; s: number }[] = [];
      for (const [g, arr] of byCat) {
        arr.sort((a, b) => (g === "dex" ? (b.vol - a.vol) || (b.tvl - a.tvl) : (b.tvl - a.tvl) || (b.vol - a.vol)));
        for (const m of arr.slice(0, QUOTA[g])) { const s = score(m); if (s >= scoreMinOf(m.protoKey, chain)) quotaPicks.push({ protoKey: m.protoKey, s }); }
      }
      quotaPicks.sort((a, b) => b.s - a.s);
      const pickedForToken = new Set<string>();
      for (const p of quotaPicks.slice(0, maxProto)) { keptProto.add(p.protoKey); coreProto.add(p.protoKey); pickedForToken.add(p.protoKey); }
      // 충원(쿼터 밖) — 점수 내림차순. 어댑터 유무로 컷이 다르므로 break 가 아니라 continue 로
      // 스캔(높은 점수의 어댑터-부재 뒤에 낮은 점수의 어댑터-보유가 와도 후자를 놓치지 않게).
      for (const m of [...mine].sort((a, b) => score(b) - score(a))) {
        if (pickedForToken.size >= maxProto) break;
        if (pickedForToken.has(m.protoKey)) continue;
        if (score(m) < scoreMinOf(m.protoKey, chain)) continue;
        keptProto.add(m.protoKey); pickedForToken.add(m.protoKey);
      }
    }
  }

  // ── assemble ──
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const tokenSummaries = new Map<string, FlowTokenSummary>();
  const chainTotal = new Map<string, number>();
  for (const [k, v] of tcTotal) chainTotal.set(k.split("|")[1], (chainTotal.get(k.split("|")[1]) ?? 0) + v);

  const ensureToken = (display: string, chain: string): string | null => {
    const tvl = tcTotal.get(`${display.toUpperCase()}|${chain}`) ?? 0;
    if (tvl <= 0) return null;
    const id = `token:${display}@${chain}`;
    if (!nodes.has(id)) {
      const addr = addrByTC.get(`${display.toUpperCase()}|${chain}`);
      nodes.set(id, { id, kind: "token", label: display, token: display, chain, tvlUsd: tvl, address: addr, risk: "safe", meta: { addr, chainSupplyUsd: chainSupplyByTC.get(`${display.toUpperCase()}|${chain}`) ?? null } });
      const s = tokenSummaries.get(display) ?? { symbol: display, tvlUsd: 0, chains: [], addressByChain: {} };
      s.tvlUsd += tvl; if (!s.chains.includes(chain)) s.chains.push(chain); if (addr) s.addressByChain[chain] = addr;
      tokenSummaries.set(display, s);
    }
    return id;
  };

  for (const protoKey of keptProto) {
    const [chain, project] = protoKey.split("|");
    const ptot = protoTotal.get(protoKey) ?? 0;
    const pvol = protoVolTotal.get(protoKey) ?? 0;
    const protoId = `proto:${chain}|${project}`;
    nodes.set(protoId, {
      id: protoId, kind: "protocol", label: project, token: "", chain, protocol: project, tvlUsd: ptot,
      volUsd: pvol || undefined,
      sharePct: (chainTotal.get(chain) ?? 0) > 0 ? ptot / (chainTotal.get(chain) ?? 1) : undefined,
      // flowSupported: 이 프로토콜의 실제 흐름을 측정·귀속할 어댑터가 있는가(체인 의존). false 면
      // 회색은 "조용해서"가 아니라 "측정 미지원" — UI 가 둘을 구분 표기한다.
      meta: { category: protoCategory.get(protoKey), catGroup: groupOfProto(protoKey), coreKeep: coreProto.has(protoKey), flowSupported: hasFlowAdapter(project, chain) }, risk: "safe",
    });
    // every active token that uses this protocol → holds edge (shared node, many edges)
    for (const tk of wantSet) {
      const contrib = tokenInProto.get(`${protoKey}|${tk}`) ?? 0; if (contrib <= 0) continue;
      const tokenId = ensureToken(dispBy.get(tk)!, chain); if (!tokenId) continue;
      const vcontrib = tokenVolInProto.get(`${protoKey}|${tk}`) ?? 0;
      edges.push({ id: `h:${tokenId}->${protoId}`, source: tokenId, target: protoId, kind: "holds", tvlUsd: contrib, volUsd: vcontrib || undefined, weight: 0, chain, dir: "both", label: "예치/익스포저" });
    }
    // markets: defillama pools + morpho markets — DEX 풀은 거래량으로도 선별(LP 펼치기: 사이즈만 보면
    // 거래량 본진인 Uniswap 풀이 또 잘린다). 선별 척도 = max(TVL, 일 거래량).
    const dfPools = poolsByProto.get(protoKey) ?? [];
    const moMkts = morphoByProto.get(protoKey) ?? [];
    const mkPool: MktRec[] = dfPools.map((p) => ({ key: p.symbol, label: p.symbol, size: p.tvl, vol: p.vol, lltv: null, util: null, vaults: [], tokens: p.tokens, project, chain, oracle: null }));
    const allMkts = [...moMkts, ...mkPool];
    for (const m of topByShare(allMkts, (x) => Math.max(x.size, x.vol), Math.max(ptot, pvol), topPct, maxMkt)) {
      const mktId = `mkt:${chain}|${project}|${m.key}`;
      if (!nodes.has(mktId)) {
        nodes.set(mktId, {
          id: mktId, kind: "market", label: m.label, token: m.tokens[0] ?? "", chain, protocol: project, tvlUsd: m.size,
          volUsd: m.vol || undefined,
          sharePct: ptot > 0 ? m.size / ptot : undefined, meta: { lltv: m.lltv, utilization: m.util, vaults: m.vaults.map((v) => v.name), apy: (dfPools.find((p) => p.symbol === m.key)?.apy) ?? null, flowSupported: hasFlowAdapter(project, chain) }, risk: "safe",
        });
        edges.push({ id: `m:${protoId}->${mktId}`, source: protoId, target: mktId, kind: "market", tvlUsd: m.size, volUsd: m.vol || undefined, weight: 0, chain, dir: "both", label: "마켓/풀" });
        // 오라클 의존 엣지(-----o-----): 마켓이 실제로 보는 가격 피드 (Morpho oracleAddress, 실데이터).
        // 같은 프로토콜이 여러 오라클을 보면 엣지가 그만큼 늘어난다.
        // 제로주소 = 오라클 없는 유휴 마켓 — 엣지를 만들면 날조이므로 제외.
        if (m.oracle && /^0x[0-9a-fA-F]{40}$/.test(m.oracle) && !/^0x0{40}$/.test(m.oracle)) {
          const oTokenId = ensureToken(m.tokens[0] ?? "", chain);
          if (oTokenId) edges.push({ id: `o:${mktId}`, source: mktId, target: oTokenId, kind: "oracle", tvlUsd: 0, weight: 0.15, chain, label: `오라클 ${m.oracle.slice(0, 6)}…${m.oracle.slice(-4)}` });
        }
      }
      // market ⇄ every in-graph token it involves (the web)
      for (const tdisp of new Set(m.tokens)) {
        const tokenId = ensureToken(tdisp, chain); if (!tokenId) continue;
        edges.push({ id: `i:${mktId}->${tokenId}`, source: mktId, target: tokenId, kind: "involves", tvlUsd: m.size, weight: 0, chain, dir: "both", label: `${tdisp} 구성` });
      }
      // vault nodes for morpho markets — WITH the MetaMorpho vault contract address (real deposit
      // target), REAL totalAssetsUsd, and the REAL curator names (vault = 큐레이터 운용 주체).
      // unknown → 0/null, never invented.
      for (const v of m.vaults.slice(0, 4)) { // 주요 볼트는 다 노드로 (2→4)
        const vId = `vault:${chain}|${v.name}`;
        if (!nodes.has(vId)) {
          const vm = v.address ? vaultMetaByAddr.get(v.address.toLowerCase()) : undefined;
          // 주소 있는 MetaMorpho 볼트는 nodeAddrs 로 넘겨져 카운터파티 귀속 가능 → flowSupported
          nodes.set(vId, { id: vId, kind: "vault", label: v.name, token: "", chain, protocol: project, tvlUsd: vm?.tvl ?? 0, address: v.address, risk: "safe", meta: { addr: v.address, curator: vm?.curator ?? null, flowSupported: !!v.address } });
        }
        // 엣지 수치는 "마켓 전체 규모"임을 라벨에 명시 — 볼트별 배분액은 이 쿼리로는 모른다 (과대귀속 방지)
        edges.push({ id: `v:${mktId}->${vId}`, source: mktId, target: vId, kind: "vault", tvlUsd: m.size, weight: 0, chain, dir: "both", label: "볼트 공급 (마켓 전체 규모)" });
      }
    }
    // Euler curator vaults (real Goldsky data) as vault nodes under the euler protocol
    for (const v of topByShare(eulerByProto.get(protoKey) ?? [], (x) => x.allocationUsd, ptot, topPct, maxMkt)) {
      const vId = `vault:${chain}|${v.name}`;
      if (!nodes.has(vId)) {
        // Euler Earn 볼트는 주소가 없고(노드 식별 불가) euler 이벤트는 렌딩 볼트 단위라 이 Earn
        // 볼트 개별엔 귀속 안 됨 → flowSupported:false (프로토콜 노드는 이벤트로 칠해짐).
        nodes.set(vId, { id: vId, kind: "vault", label: v.name, token: v.token, chain, protocol: project, tvlUsd: v.allocationUsd, meta: { curator: v.curator, source: "euler", flowSupported: false }, risk: "safe" });
        edges.push({ id: `m:${protoId}->${vId}`, source: protoId, target: vId, kind: "vault", tvlUsd: v.allocationUsd, weight: 0, chain, dir: "both", label: "Euler 볼트 공급" });
      }
      const tokenId = ensureToken(v.token, chain);
      if (tokenId) edges.push({ id: `i:${vId}->${tokenId}`, source: vId, target: tokenId, kind: "involves", tvlUsd: v.allocationUsd, weight: 0, chain, dir: "both", label: `${v.token} 구성` });
    }
  }

  // bridges (cross-chain same token) + siblings (cross-chain same protocol)
  const chainsByToken = new Map<string, string[]>();
  for (const n of nodes.values()) if (n.kind === "token") push(chainsByToken, n.token, n.chain);
  for (const [token, chains] of chainsByToken) {
    if (chains.length < 2) continue;
    const hub = chains.includes("ethereum") ? "ethereum" : chains[0];
    for (const c of chains) { if (c === hub) continue;
      const a = `token:${token}@${hub}`, b = `token:${token}@${c}`;
      const sup = chainSupplyByTC.get(`${token.toUpperCase()}|${c}`);
      const bridgedUsd = sup ?? Math.min(nodes.get(a)?.tvlUsd ?? 0, nodes.get(b)?.tvlUsd ?? 0);
      // 같은 심볼이 두 체인에 있다 ≠ 브릿지다 (베이스 WETH·네이티브 USDC 는 브릿지가 아님).
      // 기본 라벨은 "브릿지 미확인" — bridge_authorities 온체인 검증 행이 있을 때만 /api/flow 가
      // "브릿지 · <메커니즘>" 으로 승격한다. tvlUsd: sup 있으면 원격 체인 공급(실측),
      // 없으면 min(TVL) 추정 — 어느 쪽인지 라벨 괄호에 그대로 드러난다.
      edges.push({ id: `bridge:${token}:${hub}-${c}`, source: a, target: b, kind: "bridge", tvlUsd: bridgedUsd, weight: 0, chain: c, dir: "both", label: `${token} 체인간 연결 · 브릿지 미확인 (${sup != null ? `${c} 온체인 공급` : "TVL 기준 추정"})`, bridge: { fromChain: hub, toChain: c, mechanism: null, protocol: null } });
    }
  }
  const protoByProj = new Map<string, FlowNode[]>();
  for (const n of nodes.values()) if (n.kind === "protocol") push(protoByProj, n.protocol!, n);
  for (const [proj, list] of protoByProj) {
    const byChain = new Map<string, FlowNode>();
    for (const n of list) { const cur = byChain.get(n.chain); if (!cur || n.tvlUsd > cur.tvlUsd) byChain.set(n.chain, n); }
    const reps = [...byChain.values()]; if (reps.length < 2) continue;
    const hub = reps.find((r) => r.chain === "ethereum") ?? reps[0];
    // 동일-프로토콜 관계엔 "규모"가 없다 — min(tvl,tvl) 같은 합성 수치를 만들지 않는다 (tvlUsd 0 → 상세 패널에 규모 미표시)
    for (const r of reps) { if (r.id === hub.id) continue; edges.push({ id: `sib:${proj}:${hub.chain}-${r.chain}`, source: hub.id, target: r.id, kind: "sibling", tvlUsd: 0, weight: 0, chain: r.chain, dir: "both", label: `${proj} (동일 프로토콜)` }); }
  }

  // ── 파생 토큰(derive) — 머니레고의 토큰→토큰 연결. 전부 온체인/공식 API 검증, 추측 0. ──
  // (a) 랩/4626: wrappedUnderlying(asset()/stETH()/eETH() 역참조, 영구 캐시)가 가리키는 기초가
  //     그래프 토큰이면 기초↔파생 derive 엣지. 기초/파생이 그래프에 없으면 **자동 추가** —
  //     stETH 만 선택해도 wstETH 노드가 떠서 wstETH→aave 까지 흐름이 이어진다(실시간·평소 모두:
  //     파생 노드도 주소를 가진 token 노드라 피드 타깃·렌딩 이벤트 매칭에 자동 포함).
  const addDeriveTokenNode = (sym: string, chain: string, addr: string, via: string): string => {
    const id = `token:${sym}@${chain}`;
    if (!nodes.has(id)) {
      nodes.set(id, { id, kind: "token", label: sym, token: sym, chain, tvlUsd: 0, address: addr, risk: "safe", meta: { addr, derivedVia: via } });
      const s = tokenSummaries.get(sym) ?? { symbol: sym, tvlUsd: 0, chains: [], addressByChain: {} };
      if (!s.chains.includes(chain)) s.chains.push(chain);
      s.addressByChain[chain] = addr;
      tokenSummaries.set(sym, s);
    }
    return id;
  };
  const pushDerive = (baseId: string, derivedId: string, chain: string, tvl: number, label: string) => {
    edges.push({ id: `d:${baseId}->${derivedId}`, source: baseId, target: derivedId, kind: "derive", tvlUsd: tvl, weight: 0.5, chain, dir: "both", label });
  };
  {
    const tokenNodesNow = [...nodes.values()].filter((n) => n.kind === "token" && n.address && /^0x[0-9a-f]{40}$/.test(n.address));
    const addrToTokenId = new Map<string, string>();
    for (const n of tokenNodesNow) addrToTokenId.set(`${n.chain}:${n.address!.toLowerCase()}`, n.id);
    // (a-1) 그래프 토큰이 파생인 경우 → 기초에 연결 (기초가 없으면 자동 추가 — 심볼은 온체인 해석)
    await Promise.all(tokenNodesNow.map(async (n) => {
      const u = await wrappedUnderlying(n.chain, n.address!);
      if (!u) return;
      let baseId = addrToTokenId.get(`${n.chain}:${u}`);
      if (!baseId) {
        const baseSym = Object.entries(BUILTIN_ADDR[n.chain] ?? {}).find(([, a]) => a === u)?.[0] ?? (await erc20Symbol(n.chain, u));
        if (!baseSym) return; // 심볼 미해석 — 노드 날조 금지
        baseId = addDeriveTokenNode(baseSym, n.chain, u, "wrap-probe");
        addrToTokenId.set(`${n.chain}:${u}`, baseId);
      }
      pushDerive(baseId, n.id, n.chain, n.tvlUsd, `${n.label} 발행/상환 (랩·4626)`);
    }));
    // (a-2) BUILTIN 정답지(이더리움 48종)의 파생들이 그래프 토큰을 기초로 가지면 파생 자동 추가
    if (wantChains.has("ethereum")) {
      await Promise.all(Object.entries(BUILTIN_ADDR.ethereum).map(async ([dSym, dAddr]) => {
        if (addrToTokenId.has(`ethereum:${dAddr}`)) return;
        const u = await wrappedUnderlying("ethereum", dAddr);
        if (!u) return;
        const baseId = addrToTokenId.get(`ethereum:${u}`);
        if (!baseId) return;
        const dispSym = (await erc20Symbol("ethereum", dAddr)) ?? dSym; // 표기는 온체인 심볼
        const dId = addDeriveTokenNode(dispSym, "ethereum", dAddr, "wrap-probe");
        addrToTokenId.set(`ethereum:${dAddr}`, dId);
        pushDerive(baseId, dId, "ethereum", 0, `${dispSym} 발행/상환 (랩·4626)`);
      }));
    }
    // (b) Curve LP — 공식 API lpTokenAddress. 선택 토큰이 코인으로 든 ≥$1M 풀의 LP 를 토큰 노드로,
    //     매칭되는 curve 마켓 노드(코인 심볼 집합 = 마켓 라벨 파츠)에 derive 로 부착(없으면 프로토콜에).
    if (wantChains.has("ethereum") && keptProto.has("ethereum|curve-dex")) {
      try {
        const pools = await curveLpPools();
        const selAddrs = new Set([...addrByTC.entries()].filter(([k]) => k.endsWith("|ethereum")).map(([, a]) => a));
        const mktNodes = [...nodes.values()].filter((n) => n.kind === "market" && n.chain === "ethereum" && n.protocol === "curve-dex");
        for (const p of pools) {
          if (!(p.usdTotal >= 1_000_000) || !p.lpToken) continue;
          if (!p.coins.some((c) => selAddrs.has(c.address))) continue;
          const lpSym = p.lpSymbol || `${p.coins.map((c) => c.symbol).join("-")}-LP`;
          const lpId = `token:${lpSym}@ethereum`;
          if (nodes.has(lpId) || addrToTokenId.has(`ethereum:${p.lpToken}`)) continue;
          const want = p.coins.map((c) => c.symbol.toUpperCase()).sort().join("|");
          const mkt = mktNodes.find((m) => m.label.toUpperCase().split(/[-/\s+.]+/).filter(Boolean).sort().join("|") === want);
          const srcId = mkt?.id ?? "proto:ethereum|curve-dex";
          if (!nodes.has(srcId)) continue;
          nodes.set(lpId, { id: lpId, kind: "token", label: lpSym, token: lpSym, chain: "ethereum", tvlUsd: p.usdTotal, address: p.lpToken, risk: "safe", meta: { addr: p.lpToken, derivedVia: "curve-api", pool: p.name } });
          addrToTokenId.set(`ethereum:${p.lpToken}`, lpId);
          edges.push({ id: `d:${srcId}->${lpId}`, source: srcId, target: lpId, kind: "derive", tvlUsd: p.usdTotal, weight: 0.5, chain: "ethereum", dir: "both", label: "LP 발행/소각 (Curve)" });
          const s = tokenSummaries.get(lpSym) ?? { symbol: lpSym, tvlUsd: p.usdTotal, chains: ["ethereum"], addressByChain: { ethereum: p.lpToken } };
          tokenSummaries.set(lpSym, s);
        }
      } catch { /* Curve API 불가 → LP 생략 (날조 금지) */ }
    }
  }

  // dedup edges by id (DeFiLlama can yield two pools with the same symbol in one protocol)
  const edgeById = new Map<string, FlowEdge>();
  for (const e of edges) { const ex = edgeById.get(e.id); if (!ex) edgeById.set(e.id, e); else if (e.tvlUsd > ex.tvlUsd) edgeById.set(e.id, e); }
  // drop "involves" (token↔market direct) — a transaction never flows token→market directly; it goes
  // token→protocol→market sequentially. Markets/vaults connect only through their protocol.
  const dedup = [...edgeById.values()].filter((e) => e.kind !== "involves");
  const connected = new Set<string>();
  for (const e of dedup) { connected.add(e.source); connected.add(e.target); }
  // 파생/LP 토큰 표시 — derive 엣지의 타깃 토큰은 기초보다 작게 그린다 (radiusOf 가 참조)
  for (const e of dedup) {
    if (e.kind !== "derive") continue;
    const t = nodes.get(e.target);
    if (t?.kind === "token") t.derived = true;
  }

  // 두께/밀도 가중치 — TVL 과 거래량 중 큰 쪽 (DEX 엣지가 TVL 만으로 가늘어지지 않게)
  const flowUsd = (e: FlowEdge) => Math.max(e.tvlUsd, e.volUsd ?? 0);
  const maxTvl = Math.max(1, ...dedup.map(flowUsd));
  for (const e of dedup) { const u = flowUsd(e); e.weight = u > 0 ? Math.min(1, Math.log10(u + 1) / Math.log10(maxTvl + 1)) : 0.2; }

  const chainAgg = new Map<string, { tvl: number; tokens: Set<string> }>();
  for (const n of nodes.values()) if (n.kind === "token") { const c = chainAgg.get(n.chain) ?? { tvl: 0, tokens: new Set() }; c.tvl += n.tvlUsd; c.tokens.add(n.token); chainAgg.set(n.chain, c); }

  return {
    tokens: [...tokenSummaries.values()].sort((a, b) => b.tvlUsd - a.tvlUsd),
    chains: [...chainAgg.entries()].map(([chain, v]) => ({ chain, tvlUsd: v.tvl, tokens: v.tokens.size })).sort((a, b) => b.tvlUsd - a.tvlUsd),
    nodes: [...nodes.values()].filter((n) => n.kind === "token" || connected.has(n.id)), edges: dedup, generatedAt: new Date().toISOString(), notes,
  };
}
