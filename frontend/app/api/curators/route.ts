import { NextResponse } from "next/server";

/**
 * /api/curators — Morpho MetaMorpho 볼트를 큐레이터별로 묶어 반환 (멀티체인).
 * 큐레이터 대시보드용: 큐레이터 → 볼트 → 마켓 할당(담보·LT·유동성·가동률·withdraw queue).
 * blue-api 직접 프록시 (서버사이드, 키 불필요). 라이브.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const MORPHO_API = "https://blue-api.morpho.org/graphql";
const CHAINS: { id: number; name: string }[] = [
  { id: 1, name: "ethereum" },
  { id: 8453, name: "base" },
  { id: 42161, name: "arbitrum" },
];
const MIN_AUM_USD = 5_000_000;

const QUERY = `query Vaults($c: Int!, $min: Float!) {
  vaults(first: 100, where: { chainId_in: [$c], totalAssetsUsd_gte: $min }, orderBy: TotalAssetsUsd, orderDirection: Desc) {
    items {
      address name asset { symbol }
      state {
        totalAssetsUsd netApy
        curators { name verified }
        allocation {
          supplyAssetsUsd supplyCapUsd withdrawQueueIndex
          market { collateralAsset { symbol } loanAsset { symbol } lltv state { utilization } }
        }
      }
    }
  }
}`;

interface RawAlloc {
  supplyAssetsUsd: number | null;
  supplyCapUsd: number | null;
  withdrawQueueIndex: number | null;
  market: {
    collateralAsset: { symbol: string } | null;
    loanAsset: { symbol: string } | null;
    lltv: string | null;
    state: { utilization: number | null } | null;
  } | null;
}

export interface CuratorAllocation {
  collateral: string;
  loan: string;
  lltv: number | null;
  supplyUsd: number;
  utilization: number | null;
  inWithdrawQueue: boolean;
}
export interface CuratorVault {
  address: string;
  name: string;
  chain: string;
  asset: string;
  aumUsd: number;
  netApy: number | null;
  allocations: CuratorAllocation[];
}
export interface CuratorGroup {
  name: string;
  /** 출처: morpho(온체인 정밀) | defillama(비-Morpho 집계, 미검증) — 정직성 신호 */
  source: "morpho" | "defillama";
  /** 베뉴/프로토콜 — Morpho · Euler · Silo · Fluid (크로스-프로토콜 신뢰 신호) */
  protocol: string;
  aumUsd: number;
  vaultCount: number;
  chains: string[];
  vaults: CuratorVault[];
  /** 위험 신호 카운트: 가동률 ≥95% 마켓 수 */
  hotMarkets: number;
  /** 자기북 집중도 — 이 큐레이터 배분의 마켓별 HHI(1=한 마켓 몰빵). 신뢰 신호. */
  ownBookHHI: number;
  /** 배분 마켓 수 */
  marketCount: number;
}

// ── 비-Morpho 큐레이터형 베뉴 (DeFiLlama yields) ──────────────────────────────
const VENUE_PROJECTS: Record<string, string> = { "euler-v2": "Euler", "silo-v2": "Silo", "fluid-lending": "Fluid" };

/** poolMeta 에서 큐레이터/매니저 이름 추출 — "K3 Capital Earn WETH" → "K3 Capital". 없으면 프로토콜명. */
function venueName(project: string, poolMeta: string | null): string {
  const proj = VENUE_PROJECTS[project] ?? project;
  if (poolMeta && !/^EVK\b/i.test(poolMeta)) {
    const m = poolMeta.match(/^(.*?)\s+(Earn|Managed|Prime|Vault)\b/i);
    if (m && m[1].trim().length >= 2) return `${m[1].trim()} · ${proj}`;
  }
  return proj;
}

interface LlamaPool { project: string; chain: string; symbol: string; tvlUsd: number; poolMeta: string | null; pool?: string; }

/** 비-Morpho 큐레이터형 베뉴 — DeFiLlama yields(Euler/Silo/Fluid). best-effort, 실패 시 []. source=defillama(미검증). */
async function fetchDefiLlamaVenues(): Promise<CuratorGroup[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let pools: LlamaPool[] = [];
  try {
    const res = await fetch("https://yields.llama.fi/pools", { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: LlamaPool[] };
    pools = (json.data ?? []).filter((p) => VENUE_PROJECTS[p.project] && p.tvlUsd > 1_000_000);
  } finally {
    clearTimeout(timer);
  }
  const byVenue = new Map<string, CuratorGroup & { _mk: Map<string, number> }>();
  for (const p of pools.sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 250)) {
    const name = venueName(p.project, p.poolMeta);
    let g = byVenue.get(name);
    if (!g) {
      g = { name, source: "defillama", protocol: VENUE_PROJECTS[p.project] ?? p.project, aumUsd: 0, vaultCount: 0, chains: [], vaults: [], hotMarkets: 0, ownBookHHI: 0, marketCount: 0, _mk: new Map() };
      byVenue.set(name, g);
    }
    g.aumUsd += p.tvlUsd;
    g.vaultCount += 1;
    const chain = p.chain.toLowerCase();
    if (!g.chains.includes(chain)) g.chains.push(chain);
    g._mk.set(p.symbol, (g._mk.get(p.symbol) ?? 0) + p.tvlUsd);
    // 위험 탭이 읽는 allocations 구조 — collateral=symbol, supplyUsd=tvl, utilization=null(미검증).
    g.vaults.push({ address: p.pool ?? name, name: p.poolMeta ?? p.symbol, chain, asset: p.symbol, aumUsd: p.tvlUsd, netApy: null,
      allocations: [{ collateral: p.symbol, loan: "—", lltv: null, supplyUsd: p.tvlUsd, utilization: null, inWithdrawQueue: false }] } as CuratorVault);
  }
  const out: CuratorGroup[] = [];
  for (const g of byVenue.values()) {
    const tot = [...g._mk.values()].reduce((s, x) => s + x, 0) || 1;
    g.ownBookHHI = [...g._mk.values()].reduce((s, x) => s + (x / tot) ** 2, 0);
    g.marketCount = g._mk.size;
    g.vaults.sort((a, b) => b.aumUsd - a.aumUsd);
    const { _mk, ...clean } = g; void _mk;
    out.push(clean);
  }
  return out.sort((a, b) => b.aumUsd - a.aumUsd).slice(0, 12);
}

async function fetchChain(chainId: number, chainName: string): Promise<CuratorVault[]> {
  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { c: chainId, min: MIN_AUM_USD } }),
    cache: "no-store",
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: { vaults?: { items?: Array<{ address: string; name: string; asset: { symbol: string } | null; state: { totalAssetsUsd: number | null; netApy: number | null; curators: { name: string }[] | null; allocation: RawAlloc[] | null } | null }> } };
  };
  const items = json.data?.vaults?.items ?? [];
  return items.map((v) => {
    const allocations: CuratorAllocation[] = (v.state?.allocation ?? [])
      .filter((a) => (a.supplyAssetsUsd ?? 0) > 0 && a.market)
      .map((a) => ({
        collateral: a.market!.collateralAsset?.symbol ?? "—",
        loan: a.market!.loanAsset?.symbol ?? v.asset?.symbol ?? "—",
        lltv: a.market!.lltv ? Number(a.market!.lltv) / 1e18 : null,
        supplyUsd: a.supplyAssetsUsd ?? 0,
        utilization: a.market!.state?.utilization ?? null,
        inWithdrawQueue: (a.withdrawQueueIndex ?? -1) >= 0,
      }))
      .sort((x, y) => y.supplyUsd - x.supplyUsd);
    return {
      address: v.address,
      name: v.name,
      chain: chainName,
      asset: v.asset?.symbol ?? "—",
      aumUsd: v.state?.totalAssetsUsd ?? 0,
      netApy: v.state?.netApy ?? null,
      curatorName: v.state?.curators?.[0]?.name ?? "Unknown",
      allocations,
    } as CuratorVault & { curatorName: string };
  });
}

export async function GET() {
  try {
    const perChain = await Promise.all(CHAINS.map((c) => fetchChain(c.id, c.name).catch(() => [])));
    const vaults = perChain.flat() as Array<CuratorVault & { curatorName: string }>;

    const byCurator = new Map<string, CuratorGroup>();
    for (const v of vaults) {
      const key = v.curatorName;
      let g = byCurator.get(key);
      if (!g) {
        g = { name: key, source: "morpho", protocol: "Morpho", aumUsd: 0, vaultCount: 0, chains: [], vaults: [], hotMarkets: 0, ownBookHHI: 0, marketCount: 0 };
        byCurator.set(key, g);
      }
      g.aumUsd += v.aumUsd;
      g.vaultCount += 1;
      if (!g.chains.includes(v.chain)) g.chains.push(v.chain);
      g.hotMarkets += v.allocations.filter((a) => (a.utilization ?? 0) >= 0.95).length;
      const { ...vaultClean } = v;
      g.vaults.push(vaultClean);
    }
    const morpho = [...byCurator.values()];
    for (const g of morpho) {
      // 자기북 집중도(HHI) — 모든 볼트의 마켓별 배분을 합산. 1=한 마켓 몰빵(위험), 분산일수록 ↓.
      const byMarket = new Map<string, number>();
      for (const vlt of g.vaults) for (const a of vlt.allocations) byMarket.set(`${a.collateral}/${a.loan}`, (byMarket.get(`${a.collateral}/${a.loan}`) ?? 0) + a.supplyUsd);
      const tot = [...byMarket.values()].reduce((s, x) => s + x, 0) || 1;
      g.ownBookHHI = [...byMarket.values()].reduce((s, x) => s + (x / tot) ** 2, 0);
      g.marketCount = byMarket.size;
      g.vaults.sort((a, b) => b.aumUsd - a.aumUsd);
    }

    // 비-Morpho 큐레이터형 베뉴(Euler/Silo/Fluid) — DeFiLlama. 실패해도 Morpho만 반환(graceful).
    const external = await fetchDefiLlamaVenues().catch(() => [] as CuratorGroup[]);

    const curators = [...morpho, ...external].sort((a, b) => b.aumUsd - a.aumUsd);
    return NextResponse.json({ curators, totalVaults: vaults.length, externalVenues: external.length });
  } catch (e) {
    return NextResponse.json({ curators: [], totalVaults: 0, error: (e as Error).message }, { status: 200 });
  }
}
