/**
 * flow-core — builds the live FlowGraph (real data) for N tokens × M chains.
 *
 * Sources (keyless, live): DeFiLlama /pools (cached, ~15MB) · Morpho blue-api markets
 * · public-RPC totalSupply (bridge sizing). Within a chain a protocol is ONE shared
 * node (multiple tokens edge into it); markets/vaults are real nodes; a market edges
 * back to every in-graph token it involves → the token⇄market⇄token web.
 */

import type { FlowEdge, FlowGraph, FlowNode, FlowTokenSummary } from "./flow-types";

export const CHAIN_MAP: Record<string, string> = {
  Ethereum: "ethereum", Arbitrum: "arbitrum", Base: "base", "OP Mainnet": "optimism", Optimism: "optimism",
  Polygon: "polygon", Avalanche: "avalanche", BSC: "bsc", Gnosis: "gnosis", Linea: "linea", Scroll: "scroll",
  "ZKsync Era": "zksync", Mantle: "mantle", Blast: "blast", Sonic: "sonic", Unichain: "unichain",
  Berachain: "berachain", Mode: "mode", Fraxtal: "fraxtal", Ink: "ink", "World Chain": "wc", Metis: "metis",
  // 비-EVM — 그래프(토큰·프로토콜·마켓)는 DeFiLlama 풀로 동일 구성 + 라이브 입자는 체인별 transfer 어댑터(solana/tron/aptos/starknet/sui-transfers).
  Solana: "solana", Tron: "tron", Sui: "sui", Aptos: "aptos", Starknet: "starknet",
};
const CHAINID_KEY: Record<number, string> = {
  1: "ethereum", 10: "optimism", 56: "bsc", 100: "gnosis", 130: "unichain", 137: "polygon", 146: "sonic",
  252: "fraxtal", 480: "wc", 1135: "lisk", 1868: "soneium", 5000: "mantle", 8453: "base", 34443: "mode",
  42161: "arbitrum", 43114: "avalanche", 57073: "ink", 59144: "linea", 60808: "bob", 80094: "berachain",
  534352: "scroll", 747474: "katana", 999: "hyperliquid",
};
const morphoChainKey = (id?: number, net?: string) =>
  (id != null && CHAINID_KEY[id]) || (net || "").toLowerCase().split(" ")[0] || null;

export const DEFAULT_TOKENS = ["stETH", "wstETH", "weETH", "WBTC", "USDe"];
export const DEFAULT_CHAINS = ["ethereum"];

// fallback canonical addresses (ethereum) for tokens whose address doesn't resolve via
// DeFiLlama single-exposure pools (e.g. stETH — Lido's pool lists WETH as underlying).
const BUILTIN_ADDR: Record<string, Record<string, string>> = {
  ethereum: {
    STETH: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", WSTETH: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    WEETH: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", WBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    USDE: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", SUSDE: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
    USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    DAI: "0x6b175474e89094c44da98b954eedeac495271d0f", WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    RETH: "0xae78736cd615f374d3085123a210448e74fc6393", CBBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
  },
};
const REVALIDATE = 600;

interface LlamaPool {
  chain?: string; project?: string; symbol?: string; tvlUsd?: number;
  apy?: number | null; exposure?: string | null; underlyingTokens?: string[] | null; category?: string | null;
}

const symbolParts = (s: string | null | undefined) => (s ?? "").toUpperCase().split(/[-/\s+.]+/).filter(Boolean);
const norm = (a: string) => (/^0x/i.test(a) ? a.toLowerCase() : a);
const usd = (n: number | null | undefined) => (typeof n === "number" && isFinite(n) && n > 0 ? n : 0);
function inc(m: Map<string, number>, k: string, n: number) { m.set(k, (m.get(k) ?? 0) + n); }
function push<T>(m: Map<string, T[]>, k: string, v: T) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }

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
// ── 솔라나 민트 확정 — Jupiter 공식 토큰 레지스트리 (lite-api.jup.ag, 키리스) ──
// DeFiLlama 풀의 underlyingTokens 는 "예치 자산"이라 파생 토큰(JitoSOL 풀 → SOL)의 민트가
// 틀리게 잡힌다. 표시·트랜잭션용 민트는 레지스트리의 검증 토큰에서 심볼 정확 일치 + 최대
// 시가총액으로 확정한다 (틀린 민트로 다른 토큰의 거래를 보여주는 것 방지).
const _jupMintCache = new Map<string, { at: number; mint: string | null }>();
async function jupiterMint(symbol: string): Promise<string | null> {
  const key = symbol.toUpperCase();
  const hit = _jupMintCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.mint;
  let mint: string | null = null;
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (r.ok) {
      const items = (await r.json()) as { id?: string; symbol?: string; mcap?: number; isVerified?: boolean }[];
      const exact = (items ?? []).filter((t) => (t.symbol ?? "").toUpperCase() === key && t.id && t.isVerified !== false);
      exact.sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
      mint = exact[0]?.id ?? null;
    }
  } catch { /* 레지스트리 불가 → 민트 미확정(해당 토큰 솔라나 피드 없음 — 거짓 매핑보다 낫다) */ }
  _jupMintCache.set(key, { at: Date.now(), mint });
  return mint;
}

async function morphoGql(query: string): Promise<{ data: unknown; errored: boolean }> {
  try {
    const r = await fetch("https://blue-api.morpho.org/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), cache: "no-store" });
    if (!r.ok) return { data: null, errored: true };
    const j = (await r.json()) as { data?: unknown; errors?: unknown[] };
    return { data: j?.data ?? null, errored: !!j?.errors?.length };
  } catch { return { data: null, errored: true }; }
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
  arbitrum: "https://arbitrum-one-rpc.publicnode.com", optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com", gnosis: "https://gnosis-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com", avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
  linea: "https://linea-rpc.publicnode.com", scroll: "https://scroll-rpc.publicnode.com",
  mantle: "https://mantle-rpc.publicnode.com", sonic: "https://sonic-rpc.publicnode.com",
  unichain: "https://unichain-rpc.publicnode.com", berachain: "https://berachain-rpc.publicnode.com",
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

/** Top tokens by aggregated single-exposure pool TVL (live, for the search picker). */
export async function topTokensByTvl(limit = 150): Promise<{ symbol: string; tvlUsd: number }[]> {
  let pools: LlamaPool[] = [];
  try { pools = await fetchLlamaPools(); } catch { return []; }
  const bySym = new Map<string, number>();
  const display = new Map<string, string>();
  for (const p of pools) {
    if (p.exposure !== "single") continue;
    const parts = symbolParts(p.symbol);
    if (parts.length !== 1) continue;
    const sym = parts[0];
    if (sym.length < 2 || sym.length > 12 || /^\d+$/.test(sym)) continue;
    inc(bySym, sym, usd(p.tvlUsd));
    if (!display.has(sym)) display.set(sym, (p.symbol ?? sym).split(/[-/\s+.]/)[0]);
  }
  return [...bySym.entries()]
    .map(([sym, tvlUsd]) => ({ symbol: display.get(sym) ?? sym, tvlUsd }))
    .filter((x) => x.tvlUsd > 1_000_000)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, limit);
}

interface PoolRec { symbol: string; tvl: number; apy: number | null; tokens: string[]; project: string; chain: string }
interface MktRec { key: string; label: string; size: number; lltv: number | null; util: number | null; vaults: { name: string; address?: string }[]; tokens: string[]; project: string; chain: string; oracle: string | null }

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

  // canonical addr per (SYM, chain)
  const addrByTC = new Map<string, string>(); const canonByTC = new Map<string, Set<string>>();
  for (const p of [...pools].filter((p) => p.exposure === "single" && p.underlyingTokens?.length === 1 && p.underlyingTokens?.[0]).sort((a, b) => usd(b.tvlUsd) - usd(a.tvlUsd))) {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain) continue;
    for (const part of new Set(symbolParts(p.symbol))) {
      if (!wantSet.has(part)) continue;
      const k = `${part}|${chain}`, a = norm(p.underlyingTokens![0]!);
      if (!canonByTC.has(k)) canonByTC.set(k, new Set());
      canonByTC.get(k)!.add(a);
      if (!addrByTC.has(k)) addrByTC.set(k, a);
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
  // 솔라나: Jupiter 레지스트리 민트가 풀-유래 주소를 덮어쓴다 (canon 에는 추가만 — 그래프 집계 불변)
  if (wantChains.has("solana")) {
    await Promise.all([...wantSet].map(async (tk) => {
      const mint = await jupiterMint(dispBy.get(tk)!);
      if (!mint) return;
      const k = `${tk}|solana`;
      addrByTC.set(k, mint);
      if (!canonByTC.has(k)) canonByTC.set(k, new Set());
      canonByTC.get(k)!.add(mint);
    }));
  }

  // accumulate per protocol (chain|project): total, token contributions, pools
  const protoTotal = new Map<string, number>();
  const tokenInProto = new Map<string, number>(); // `${protoKey}|${TOKEN}`
  const poolsByProto = new Map<string, PoolRec[]>();
  const protoCategory = new Map<string, string | null>();

  for (const p of pools) {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain || !wantChains.has(chain) || !p.project) continue;
    const matched = [...new Set(symbolParts(p.symbol).filter((x) => wantSet.has(x)))];
    if (!matched.length) continue;
    const t = usd(p.tvlUsd); if (!t) continue;
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
    protoCategory.set(protoKey, p.category ?? null);
    for (const part of kept) inc(tokenInProto, `${protoKey}|${part}`, t);
    push(poolsByProto, protoKey, { symbol: p.symbol ?? "?", tvl: t, apy: p.apy ?? null, tokens: kept.map((k) => dispBy.get(k)!), project: p.project, chain });
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
        key, label: `${m.collateralAsset?.symbol ?? "?"}/${m.loanAsset?.symbol ?? "?"}`, size, lltv,
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

  // token-chain totals + which protocols to keep (top share per token, unioned)
  const tcTotal = new Map<string, number>();
  for (const [k, v] of tokenInProto) { const [chain, , token] = k.split("|"); inc(tcTotal, `${token}|${chain}`, v); }
  const keptProto = new Set<string>();
  for (const tk of wantSet) {
    for (const chain of wantChains) {
      const mine = [...tokenInProto.entries()].filter(([k]) => { const [c, , t] = k.split("|"); return c === chain && t === tk; })
        .map(([k, v]) => ({ protoKey: k.split("|").slice(0, 2).join("|"), v }));
      const total = tcTotal.get(`${tk}|${chain}`) ?? 0;
      for (const p of topByShare(mine, (x) => x.v, total, topPct, maxProto)) keptProto.add(p.protoKey);
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
    const protoId = `proto:${chain}|${project}`;
    nodes.set(protoId, {
      id: protoId, kind: "protocol", label: project, token: "", chain, protocol: project, tvlUsd: ptot,
      sharePct: (chainTotal.get(chain) ?? 0) > 0 ? ptot / (chainTotal.get(chain) ?? 1) : undefined,
      meta: { category: protoCategory.get(protoKey) }, risk: "safe",
    });
    // every active token that uses this protocol → holds edge (shared node, many edges)
    for (const tk of wantSet) {
      const contrib = tokenInProto.get(`${protoKey}|${tk}`) ?? 0; if (contrib <= 0) continue;
      const tokenId = ensureToken(dispBy.get(tk)!, chain); if (!tokenId) continue;
      edges.push({ id: `h:${tokenId}->${protoId}`, source: tokenId, target: protoId, kind: "holds", tvlUsd: contrib, weight: 0, chain, dir: "both", label: "예치/익스포저" });
    }
    // markets: defillama pools + morpho markets, top-share
    const dfPools = poolsByProto.get(protoKey) ?? [];
    const moMkts = morphoByProto.get(protoKey) ?? [];
    const mkPool: MktRec[] = dfPools.map((p) => ({ key: p.symbol, label: p.symbol, size: p.tvl, lltv: null, util: null, vaults: [], tokens: p.tokens, project, chain, oracle: null }));
    const allMkts = [...moMkts, ...mkPool];
    for (const m of topByShare(allMkts, (x) => x.size, ptot, topPct, maxMkt)) {
      const mktId = `mkt:${chain}|${project}|${m.key}`;
      if (!nodes.has(mktId)) {
        nodes.set(mktId, {
          id: mktId, kind: "market", label: m.label, token: m.tokens[0] ?? "", chain, protocol: project, tvlUsd: m.size,
          sharePct: ptot > 0 ? m.size / ptot : undefined, meta: { lltv: m.lltv, utilization: m.util, vaults: m.vaults.map((v) => v.name), apy: (dfPools.find((p) => p.symbol === m.key)?.apy) ?? null }, risk: "safe",
        });
        edges.push({ id: `m:${protoId}->${mktId}`, source: protoId, target: mktId, kind: "market", tvlUsd: m.size, weight: 0, chain, dir: "both", label: "마켓/풀" });
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
      for (const v of m.vaults.slice(0, 2)) {
        const vId = `vault:${chain}|${v.name}`;
        if (!nodes.has(vId)) {
          const vm = v.address ? vaultMetaByAddr.get(v.address.toLowerCase()) : undefined;
          nodes.set(vId, { id: vId, kind: "vault", label: v.name, token: "", chain, protocol: project, tvlUsd: vm?.tvl ?? 0, address: v.address, risk: "safe", meta: { addr: v.address, curator: vm?.curator ?? null } });
        }
        // 엣지 수치는 "마켓 전체 규모"임을 라벨에 명시 — 볼트별 배분액은 이 쿼리로는 모른다 (과대귀속 방지)
        edges.push({ id: `v:${mktId}->${vId}`, source: mktId, target: vId, kind: "vault", tvlUsd: m.size, weight: 0, chain, dir: "both", label: "볼트 공급 (마켓 전체 규모)" });
      }
    }
    // Euler curator vaults (real Goldsky data) as vault nodes under the euler protocol
    for (const v of topByShare(eulerByProto.get(protoKey) ?? [], (x) => x.allocationUsd, ptot, topPct, maxMkt)) {
      const vId = `vault:${chain}|${v.name}`;
      if (!nodes.has(vId)) {
        nodes.set(vId, { id: vId, kind: "vault", label: v.name, token: v.token, chain, protocol: project, tvlUsd: v.allocationUsd, meta: { curator: v.curator, source: "euler" }, risk: "safe" });
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

  // dedup edges by id (DeFiLlama can yield two pools with the same symbol in one protocol)
  const edgeById = new Map<string, FlowEdge>();
  for (const e of edges) { const ex = edgeById.get(e.id); if (!ex) edgeById.set(e.id, e); else if (e.tvlUsd > ex.tvlUsd) edgeById.set(e.id, e); }
  // drop "involves" (token↔market direct) — a transaction never flows token→market directly; it goes
  // token→protocol→market sequentially. Markets/vaults connect only through their protocol.
  const dedup = [...edgeById.values()].filter((e) => e.kind !== "involves");
  const connected = new Set<string>();
  for (const e of dedup) { connected.add(e.source); connected.add(e.target); }

  const maxTvl = Math.max(1, ...dedup.map((e) => e.tvlUsd));
  for (const e of dedup) e.weight = e.tvlUsd > 0 ? Math.min(1, Math.log10(e.tvlUsd + 1) / Math.log10(maxTvl + 1)) : 0.2;

  const chainAgg = new Map<string, { tvl: number; tokens: Set<string> }>();
  for (const n of nodes.values()) if (n.kind === "token") { const c = chainAgg.get(n.chain) ?? { tvl: 0, tokens: new Set() }; c.tvl += n.tvlUsd; c.tokens.add(n.token); chainAgg.set(n.chain, c); }

  return {
    tokens: [...tokenSummaries.values()].sort((a, b) => b.tvlUsd - a.tvlUsd),
    chains: [...chainAgg.entries()].map(([chain, v]) => ({ chain, tvlUsd: v.tvl, tokens: v.tokens.size })).sort((a, b) => b.tvlUsd - a.tvlUsd),
    nodes: [...nodes.values()].filter((n) => n.kind === "token" || connected.has(n.id)), edges: dedup, generatedAt: new Date().toISOString(), notes,
  };
}
