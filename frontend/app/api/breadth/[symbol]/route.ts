import { NextResponse } from "next/server";

/**
 * GET /api/breadth/[symbol]  — 토큰 하나의 "전 체인 익스포저" 라이브 수집 (으아아악).
 *
 * DeFiLlama yields(/pools, 무료)에서 해당 토큰을 담은 모든 풀을 전 체인에서 긁어
 * (체인 × 프로토콜)별로 묶고, 각 프로토콜의 개별 마켓/풀(pools[]) 까지 그대로 돌려준다.
 * → 큐레이터가 Aave·Compound·DEX 등 모든 프로토콜의 세부 마켓/풀(담보·LP·APY·IL)을
 *   체인 막론하고 한 화면에서 본다. DB 정밀(Morpho 마켓/큐레이터)과 합쳐짐.
 * 온체인 미검증이라 그래프에선 점선(unverified)으로 정직 표시.
 *
 * 30분 캐시(revalidate) — 10MB 풀 목록 풀 다운로드를 토큰마다 매번 하지 않게.
 */

export const revalidate = 1800;

// DeFiLlama 체인명 → 우리 체인 키.
// 2026-06-12 스코프 축소: 이더리움·베이스·아비트럼 3체인 완성 우선 — 머니레고 관계맵 개편 동안
// 다른 체인은 의도적으로 제외. 다른 EVM 체인은 3체인 완성 후 여기에 다시 추가 (비EVM 은 제외).
const CHAIN_MAP: Record<string, string> = {
  Ethereum: "ethereum", Arbitrum: "arbitrum", Base: "base",
};

// 검증된 정식주소 오버라이드 — DeFiLlama 풀 메타로 주소를 못 얻는 핵심 배포분만
// (해당 체인 RPC totalSupply 직독으로 검증된 주소만 등재). 3체인 스코프에선 현재 비어 있음.
const ADDR_OVERRIDES: Record<string, Record<string, string>> = {};

const CHAIN_TVL_MIN = 250_000;   // 체인 단위 dust 컷 (낮춤 — 더 많은 체인)
const PROTO_TVL_MIN = 20_000;    // 프로토콜 단위 dust 컷 (낮춤)
const MAX_CHAINS = 12;           // 상위 체인 (늘림)
const POOLS_PER_PROTO = 12;      // 프로토콜당 마켓/풀 상한 (늘림 — 단일체인 뷰에서 깊게)

interface Pool {
  chain?: string; project?: string; symbol?: string; tvlUsd?: number;
  apy?: number | null; apyBase?: number | null; apyReward?: number | null;
  exposure?: string | null; ilRisk?: string | null; poolMeta?: string | null;
  stablecoin?: boolean; underlyingTokens?: string[] | null; category?: string | null;
}
export interface BreadthPool {
  symbol: string; tvlUsd: number; apy: number | null; apyBase: number | null; apyReward: number | null;
  exposure: string | null; ilRisk: string | null; poolMeta: string | null; stablecoin: boolean;
}
export interface BreadthItem { chain: string; project: string; tvlUsd: number; category: string | null; pools: BreadthPool[] }
export interface MorphoMkt { loan: string; collateral: string; lltv: number | null; supplyUsd: number; utilization: number | null; ouroboros: boolean; vaults: string[]; role: "collateral" | "supply" }
export interface EulerVault { name: string; curator: string | null; allocationUsd: number }

// chainId → 우리 체인 키 (Morpho chain.id 가 가장 확실 — network 는 "OP Mainnet" 같은 표시명이라 매칭 깨짐)
// 2026-06-12 스코프 축소: 3체인 외 Morpho 마켓은 버림 (다른 체인 키를 지어내지 않음 → null = 제외)
const CHAINID_KEY: Record<number, string> = {
  1: "ethereum", 8453: "base", 42161: "arbitrum",
};
const NAME_KEY: Record<string, string> = { "Arbitrum One": "arbitrum" };
const morphoChainKey = (id?: number, net?: string) =>
  (id != null && CHAINID_KEY[id]) || (net && NAME_KEY[net]) || null;
// (sameFamily 제거 — ouroboros 신호 전면 제외)

type MItem = { lltv?: string; loanAsset?: { symbol?: string }; collateralAsset?: { symbol?: string }; state?: { supplyAssetsUsd?: number; collateralAssetsUsd?: number; utilization?: number }; chain?: { id?: number; network?: string }; supplyingVaults?: { name?: string }[] };
async function morphoQuery(filter: string, addrs: string[], revalidateS: number): Promise<MItem[]> {
  const query = `{ markets(first: 300, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { ${filter}: ${JSON.stringify(addrs)} }) { items { lltv loanAsset { symbol } collateralAsset { symbol } state { supplyAssetsUsd collateralAssetsUsd utilization } chain { id network } supplyingVaults { name } } } }`;
  try {
    const r = await fetch("https://blue-api.morpho.org/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), next: { revalidate: revalidateS } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.data?.markets?.items ?? []) as MItem[];
  } catch { return []; }
}

// 토큰이 담보 OR 공급(loan)인 Morpho 마켓을 전 체인에서. 토큰 종류에 따라 익스포저 측이 다름:
//  담보형(wstETH 등) → collateralAssetsUsd(잠긴 토큰), 공급형(USDe·USDC 등) → supplyAssetsUsd(공급된 토큰).
async function fetchMorphoMarkets(addrs: string[], revalidateS: number): Promise<Record<string, MorphoMkt[]>> {
  if (!addrs.length) return {};
  const out: Record<string, MorphoMkt[]> = {};
  const [asColl, asLoan] = await Promise.all([
    morphoQuery("collateralAssetAddress_in", addrs, revalidateS),
    morphoQuery("loanAssetAddress_in", addrs, revalidateS),
  ]);
  const push = (m: MItem, role: "collateral" | "supply") => {
    const chain = morphoChainKey(m.chain?.id, m.chain?.network);
    const loan = m.loanAsset?.symbol ?? "?", coll = m.collateralAsset?.symbol ?? "?";
    const size = role === "collateral" ? (m.state?.collateralAssetsUsd ?? 0) : (m.state?.supplyAssetsUsd ?? 0);
    if (!chain || size <= 0) return;
    (out[chain] ??= []).push({
      loan, collateral: coll, lltv: m.lltv ? Number(m.lltv) / 1e18 : null,
      supplyUsd: size, utilization: m.state?.utilization ?? null, ouroboros: false, role,
      vaults: (m.supplyingVaults ?? []).map((v) => v.name ?? "").filter(Boolean).slice(0, 5),
    });
  };
  for (const m of asColl) push(m, "collateral");
  for (const m of asLoan) push(m, "supply");
  for (const k of Object.keys(out)) { // 같은 마켓 양쪽 매칭 dedupe + 규모순
    const seen = new Set<string>();
    out[k] = out[k].filter((m) => { const key = `${m.collateral}/${m.loan}/${m.lltv}`; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => b.supplyUsd - a.supplyUsd);
  }
  return out;
}

// ── Euler Earn 큐레이터 볼트 (비-Morpho 큐레이터) — 공용 Goldsky 서브그래프 (무키, 멀티체인) ──
// 슬러그 전수 프로브(2026-06-10): 실볼트 sonic·avalanche·bsc·unichain·swell·linea·plasma(+기존 3),
// 빈 응답(미래 대비 포함) berachain·bob·gnosis·optimism·ink·hyperevm·worldchain. avax·polygon 슬러그는 404.
const eulerSub = (slug: string) => `https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-${slug}/latest/gn`;
const EULER_ENDPOINTS: Record<string, string> = {
  ethereum: eulerSub("mainnet"), base: eulerSub("base"), arbitrum: eulerSub("arbitrum"),
};

// DeFiLlama coins API — 토큰 가격+소수점 (Euler totalAssets 토큰단위 → USD 환산용)
async function fetchTokenPrices(addrByChain: Record<string, string>, revalidateS: number): Promise<Record<string, { price: number; decimals: number }>> {
  const keys = Object.entries(addrByChain).filter(([, a]) => /^0x[0-9a-fA-F]{40}$/.test(a)).map(([c, a]) => `${c}:${a}`);
  if (!keys.length) return {};
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}`, { next: { revalidate: revalidateS } });
    if (!r.ok) return {};
    const j = (await r.json()) as { coins?: Record<string, { price?: number; decimals?: number }> };
    const out: Record<string, { price: number; decimals: number }> = {};
    for (const [k, v] of Object.entries(j.coins ?? {})) {
      if (v.price != null && v.decimals != null) out[k.split(":")[0]] = { price: v.price, decimals: v.decimals };
    }
    return out;
  } catch { return {}; }
}

async function fetchEulerVaults(addrByChain: Record<string, string>, prices: Record<string, { price: number; decimals: number }>, revalidateS: number): Promise<Record<string, EulerVault[]>> {
  const out: Record<string, EulerVault[]> = {};
  const chains = Object.keys(addrByChain).filter((c) => EULER_ENDPOINTS[c] && /^0x[0-9a-fA-F]{40}$/.test(addrByChain[c]) && prices[c]);
  await Promise.all(chains.map(async (chain) => {
    const addr = addrByChain[chain].toLowerCase();
    const query = `{ eulerEarnVaults(first: 50, where: { asset: "${addr}" }) { name curator totalAssets } }`;
    try {
      const r = await fetch(EULER_ENDPOINTS[chain], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), next: { revalidate: revalidateS } });
      if (!r.ok) return;
      const j = (await r.json()) as { data?: { eulerEarnVaults?: { name?: string; curator?: string; totalAssets?: string }[] } };
      const { price, decimals } = prices[chain];
      const vaults: EulerVault[] = (j.data?.eulerEarnVaults ?? [])
        .map((v) => ({
          name: v.name || "Euler Earn vault",
          curator: v.curator && !/^0x0+$/.test(v.curator) ? v.curator : null,
          allocationUsd: (Number(v.totalAssets ?? 0) / Math.pow(10, decimals)) * price,
        }))
        .filter((v) => v.allocationUsd >= 50_000)
        .sort((a, b) => b.allocationUsd - a.allocationUsd);
      if (vaults.length) out[chain] = vaults;
    } catch { /* skip chain */ }
  }));
  return out;
}

// ── 체인별 온체인 총공급(eth_call totalSupply) — Alchemy 우선(신뢰도/레이트), publicnode 폴백 ──
// 토큰의 *모든* 체인 supply 를 직접 읽어야 크로스체인 무담보/무한민팅을 잡는다(DeFiLlama 추정 아님, 면담 #1 신호).
// 2026-06-12 스코프 축소: 이더리움·베이스·아비트럼 3체인 (비EVM supply 리더 제거).
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const ALCHEMY_SLUG: Record<string, string> = {
  ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet",
};
// publicnode 폴백(무료, 키 불요) — Alchemy 일시 실패 시.
const PUBLIC_RPC: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com", base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
};
/** 체인 RPC 후보 — Alchemy(키 있으면) 우선, publicnode 폴백. 순서대로 시도. */
function rpcUrlsFor(chain: string): string[] {
  const urls: string[] = [];
  if (ALCHEMY_KEY && ALCHEMY_SLUG[chain]) urls.push(`https://${ALCHEMY_SLUG[chain]}.g.alchemy.com/v2/${ALCHEMY_KEY}`);
  if (PUBLIC_RPC[chain]) urls.push(PUBLIC_RPC[chain]);
  return urls;
}
async function callTotalSupply(url: string, token: string, revalidateS: number): Promise<string | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: "0x18160ddd" }, "latest"] }), next: { revalidate: revalidateS } });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string };
    return j.result && j.result !== "0x" ? j.result : null;
  } catch { return null; }
}
/** ERC20 decimals() 온체인 직독 — llama 가격(=decimals 메타)이 없는 체인용. */
async function callDecimals(url: string, token: string, revalidateS: number): Promise<number | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: "0x313ce567" }, "latest"] }), next: { revalidate: revalidateS } });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string };
    if (!j.result || j.result === "0x") return null;
    const d = Number(BigInt(j.result));
    return Number.isFinite(d) && d >= 0 && d <= 36 ? d : null;
  } catch { return null; }
}
export interface ChainSupply { supply: number; supplyUsd: number }
async function fetchChainSupplies(addrByChain: Record<string, string>, prices: Record<string, { price: number; decimals: number }>, revalidateS: number): Promise<Record<string, ChainSupply>> {
  const out: Record<string, ChainSupply> = {};
  // 토큰 가격은 체인 불문 ≈동일 → 미가격 체인은 레퍼런스 가격·소수점으로 USD 환산(supply 자체는 정확).
  const priced = Object.values(prices).filter((p) => p.price > 0);
  const refPrice = prices.ethereum?.price ?? (priced.length ? [...priced].map((p) => p.price).sort((a, b) => a - b)[Math.floor(priced.length / 2)] : 0);
  const refDecimals = prices.ethereum?.decimals ?? (priced[0]?.decimals ?? 18);
  const usd = (chain: string, supply: number) => supply * (prices[chain]?.price ?? refPrice);

  await Promise.all(Object.keys(addrByChain).map(async (chain) => {
    const addr = addrByChain[chain];
    // EVM (eth_call totalSupply) — Alchemy→publicnode 폴백.
    // decimals: llama 메타 → 온체인 decimals() → 레퍼런스 순. ⚠️ 같은 심볼도 체인별 decimals 가 다름
    // (ETH USDT=6, BSC USDT=18) — 레퍼런스만 믿으면 supply 가 1e12 배 튄다.
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || rpcUrlsFor(chain).length === 0) return;
    for (const url of rpcUrlsFor(chain)) {
      const hex = await callTotalSupply(url, addr, revalidateS);
      if (!hex) continue;
      const decimals = prices[chain]?.decimals ?? (await callDecimals(url, addr, revalidateS)) ?? refDecimals;
      const supply = Number(BigInt(hex)) / Math.pow(10, decimals);
      if (supply > 0) { out[chain] = { supply, supplyUsd: usd(chain, supply) }; return; }
    }
  }));
  return out;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const want = decodeURIComponent(symbol).toUpperCase();

  let pools: Pool[] = [];
  try {
    const res = await fetch("https://yields.llama.fi/pools", { next: { revalidate } });
    if (!res.ok) throw new Error(`llama ${res.status}`);
    const json = (await res.json()) as { data?: Pool[] };
    pools = json.data ?? [];
  } catch (e) {
    return NextResponse.json({ symbol: want, items: [], chains: [], tokenAddrByChain: {}, error: String(e) }, { status: 200 });
  }

  // 토큰을 "온전한 토큰"으로 포함하는 풀만 (WSTETH-WETH → [WSTETH,WETH] 매칭; 오탐 방지)
  const symMatches = pools.filter((p) => {
    const parts = (p.symbol ?? "").toUpperCase().split(/[-/\s+.]+/).filter(Boolean);
    return parts.includes(want);
  });

  // 정식 토큰 주소(체인별) — 단일자산(=실제 그 토큰) 풀 중 TVL 최대 기준(낮은 TVL 동명이토큰 콜리전 방지).
  const norm = (a: string) => (/^0x/i.test(a) ? a.toLowerCase() : a); // EVM 만 소문자, 비-EVM(Solana base58)은 그대로
  const canonByChain = new Map<string, Set<string>>();
  const tokenAddrByChain: Record<string, string> = {};
  const singles = symMatches
    .filter((p) => p.exposure === "single" && Array.isArray(p.underlyingTokens) && p.underlyingTokens.length === 1 && p.underlyingTokens[0])
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  for (const p of singles) {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain) continue;
    const addr = p.underlyingTokens![0]!;
    if (!canonByChain.has(chain)) canonByChain.set(chain, new Set());
    canonByChain.get(chain)!.add(norm(addr));
    if (!tokenAddrByChain[chain]) tokenAddrByChain[chain] = addr; // TVL 내림차순 정렬 → 첫 주소 = 최대 풀의 주소
  }
  // 2차: exposure 표기는 없지만 underlyingTokens 가 정확히 1개인 풀 — 비-EVM(Sui/Tron 등)은 풀 메타가
  // 부실해 1차(single 표기)에서 주소를 못 얻는 체인이 많다. 이미 resolve 된 체인은 건드리지 않음.
  const oneUnderlying = symMatches
    .filter((p) => Array.isArray(p.underlyingTokens) && p.underlyingTokens.length === 1 && p.underlyingTokens[0])
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  for (const p of oneUnderlying) {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain || tokenAddrByChain[chain]) continue;
    const addr = p.underlyingTokens![0]!;
    if (!canonByChain.has(chain)) canonByChain.set(chain, new Set());
    canonByChain.get(chain)!.add(norm(addr));
    tokenAddrByChain[chain] = addr;
  }
  // 3차: 검증된 오버라이드 — 풀 메타로 끝내 못 얻은 핵심 배포분만 채움 (USDT@tron 등).
  for (const [chain, addr] of Object.entries(ADDR_OVERRIDES[want] ?? {})) {
    if (tokenAddrByChain[chain]) continue;
    tokenAddrByChain[chain] = addr;
    if (!canonByChain.has(chain)) canonByChain.set(chain, new Set());
    canonByChain.get(chain)!.add(norm(addr));
  }

  // 주소 검증 — 같은 심볼 다른 토큰(콜리전) 제거. 그 체인의 정식주소를 아는 경우에만 검증
  // (모르면 심볼매치 유지 — 과필터로 정상 익스포저 누락 방지).
  const matches = symMatches.filter((p) => {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain) return false;
    const canon = canonByChain.get(chain);
    if (!canon || !canon.size) return true; // 정식주소 모름 → 유지
    const ut = (p.underlyingTokens ?? []).map(norm);
    return ut.length === 0 ? true : ut.some((a) => canon.has(a));
  });

  // (체인 × 프로토콜) 그룹 → 개별 풀 보존
  const byProto = new Map<string, { chain: string; project: string; category: string | null; raw: Pool[] }>();
  for (const p of matches) {
    const chain = CHAIN_MAP[p.chain ?? ""];
    if (!chain || !p.project) continue;
    const key = `${chain}|${p.project}`;
    const cur = byProto.get(key) ?? { chain, project: p.project, category: p.category ?? null, raw: [] };
    cur.raw.push(p);
    byProto.set(key, cur);
  }

  let items: BreadthItem[] = [...byProto.values()].map((g) => {
    const tvlUsd = g.raw.reduce((s, p) => s + (p.tvlUsd ?? 0), 0);
    const pools = g.raw
      .filter((p) => (p.tvlUsd ?? 0) > 0)
      .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
      .slice(0, POOLS_PER_PROTO)
      .map((p) => ({
        symbol: p.symbol ?? "?", tvlUsd: p.tvlUsd ?? 0,
        apy: p.apy ?? null, apyBase: p.apyBase ?? null, apyReward: p.apyReward ?? null,
        exposure: p.exposure ?? null, ilRisk: p.ilRisk ?? null, poolMeta: p.poolMeta ?? null, stablecoin: !!p.stablecoin,
      }));
    return { chain: g.chain, project: g.project, category: g.category, tvlUsd, pools };
  }).filter((x) => x.tvlUsd >= PROTO_TVL_MIN);

  // 체인별 TVL → dust 체인 제거 + 상위 MAX_CHAINS 만
  const chainTvl = new Map<string, number>();
  for (const it of items) chainTvl.set(it.chain, (chainTvl.get(it.chain) ?? 0) + it.tvlUsd);
  const keepChains = new Set(
    [...chainTvl.entries()].filter(([, v]) => v >= CHAIN_TVL_MIN).sort((a, b) => b[1] - a[1]).slice(0, MAX_CHAINS).map(([c]) => c),
  );
  items = items.filter((it) => keepChains.has(it.chain)).sort((a, b) => b.tvlUsd - a.tvlUsd);

  const chains = [...keepChains].map((c) => ({ chain: c, tvlUsd: chainTvl.get(c) ?? 0, protocols: items.filter((i) => i.chain === c).length }));

  // 전 체인 Morpho 마켓 (실제 LLTV·큐레이터) — DeFiLlama 집계 풀보다 정밀.
  // EVM 주소만 (Solana 등 비-EVM 주소는 Morpho Address 스칼라가 거부 → 쿼리 전체 실패하므로 제외).
  const evmAddrs = [...new Set(Object.values(tokenAddrByChain))].filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const [morphoMarkets, prices] = await Promise.all([
    fetchMorphoMarkets(evmAddrs, revalidate),
    fetchTokenPrices(tokenAddrByChain, revalidate),
  ]);
  // Euler Earn 큐레이터 볼트(비-Morpho) + 체인별 온체인 총공급(L2 브릿지 양 근사) — 둘 다 가격 필요, 병렬.
  const [eulerVaults, supplyByChain] = await Promise.all([
    fetchEulerVaults(tokenAddrByChain, prices, revalidate),
    fetchChainSupplies(tokenAddrByChain, prices, revalidate),
  ]);

  return NextResponse.json({ symbol: want, items, chains, tokenAddrByChain, morphoMarkets, eulerVaults, supplyByChain, totalPools: matches.length });
}
