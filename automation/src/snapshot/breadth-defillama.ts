import { env } from "@/config/chains";
import {
  fetchLlamaPools,
  fetchProtocolCategories,
  poolContainsToken,
} from "@/lib/defillama";
import type { EdgeTypeName, ProtocolClass, VenueType } from "@/types/edge-schema";

/**
 * Breadth tier — 기준(criterion) 기반 프로토콜 수집.
 *
 * 하드코딩(Euler/Silo/Dolomite) 대신:
 *   "DeFiLlama 상 이 토큰을 담은 풀이 있고, 프로토콜 카테고리가 관심 대상이며,
 *    합산 TVL ≥ 임계" → 자동 포함.
 *
 * precise adapter(Aave/Morpho 등)가 이미 커버하는 프로토콜은 dedup 으로 제외.
 * 나머지(Silo/Euler/Dolomite/Convex/…)는 coarse edge 로 추가 (confidence=MEDIUM).
 */

// DeFiLlama slug → 우리 canonical node_id (precise adapter 와 dedup).
// 여기 매핑된 건 precise tier 가 정확히 처리하므로 breadth 에서 skip 됨.
const SLUG_TO_CANONICAL: Record<string, string> = {
  "aave-v3": "protocol:aave_v3",
  "aave-v2": "protocol:aave_v2",
  "morpho-blue": "protocol:morpho_blue",
  "compound-v3": "protocol:compound_v3",
  sparklend: "protocol:spark",
  "fluid-lending": "protocol:fluid",
  "fluid-dex": "protocol:fluid",
  "uniswap-v3": "protocol:uniswap_v3",
  "uniswap-v2": "protocol:uniswap_v2",
  "curve-dex": "protocol:curve",
};

export interface BreadthExposure {
  nodeId: string;        // protocol:<canonical> 또는 protocol:dl:<slug>
  label: string;
  project: string;       // DeFiLlama slug
  category: string;
  tvlUsd: number;        // 합산 (해당 프로토콜의 토큰 보유 풀들)
  poolCount: number;
  edgeType: EdgeTypeName;
  venueType: VenueType;
  protocolClass: ProtocolClass;
  multiAssetApprox: boolean; // 다중자산 풀 포함 → amountToken 은 상한 추정
}

function classForCategory(category: string): {
  edgeType: EdgeTypeName;
  venueType: VenueType;
  protocolClass: ProtocolClass;
} {
  switch (category) {
    case "Lending":
      return { edgeType: "collateral", venueType: "market", protocolClass: "lending" };
    case "CDP":
    case "CDP Manager":
      return { edgeType: "cdp_collateral", venueType: "cdp", protocolClass: "cdp" };
    case "Dexs":
    case "Derivatives":
      return { edgeType: "lp_pair", venueType: "pool", protocolClass: "dex" };
    case "Yield":
    case "Yield Aggregator":
    case "Farm":
    case "Basis Trading":
    default:
      return { edgeType: "deposit_supply", venueType: "vault", protocolClass: "wrapper" };
  }
}

function nodeIdFor(slug: string): string {
  return SLUG_TO_CANONICAL[slug] ?? `protocol:dl:${slug}`;
}

/** precise adapter 가 커버하는 canonical node_id 집합(이미 처리된 것 dedup). */
export function isCanonicalCovered(slug: string): boolean {
  return slug in SLUG_TO_CANONICAL;
}

/**
 * 토큰 심볼 기준으로 breadth exposure 수집.
 * @param tokenSymbol  e.g. "WBTC"
 * @param coveredNodeIds  precise tier 가 이미 만든 protocol node_id 들 (dedup)
 */
export async function fetchBreadthExposure(
  tokenSymbol: string,
  coveredNodeIds: Set<string>,
): Promise<BreadthExposure[]> {
  const [pools, cats] = await Promise.all([
    fetchLlamaPools(),
    fetchProtocolCategories(),
  ]);

  const allowedCats = new Set(env.BREADTH_CATEGORIES);
  const minTvl = env.BREADTH_MIN_TVL_USD;

  // project(slug) 별로 토큰 보유 풀 합산
  interface Acc {
    project: string;
    category: string;
    tvlUsd: number;
    poolCount: number;
    multiAssetApprox: boolean;
  }
  const byProject = new Map<string, Acc>();

  for (const p of pools) {
    if (!poolContainsToken(p.symbol, tokenSymbol)) continue;
    const category = cats.get(p.project) ?? "Unknown";
    if (!allowedCats.has(category)) continue;
    const tvl = p.tvlUsd ?? 0;
    if (tvl <= 0) continue;

    const isMulti =
      (p.exposure && p.exposure !== "single") ||
      (p.symbol || "").split(/[-/\s+]+/).filter(Boolean).length > 1;

    const cur = byProject.get(p.project) ?? {
      project: p.project,
      category,
      tvlUsd: 0,
      poolCount: 0,
      multiAssetApprox: false,
    };
    cur.tvlUsd += tvl;
    cur.poolCount += 1;
    cur.multiAssetApprox = cur.multiAssetApprox || Boolean(isMulti);
    byProject.set(p.project, cur);
  }

  const out: BreadthExposure[] = [];
  for (const acc of byProject.values()) {
    if (acc.tvlUsd < minTvl) continue;          // 기준: TVL 임계
    const nodeId = nodeIdFor(acc.project);
    if (coveredNodeIds.has(nodeId)) continue;   // precise tier 가 이미 커버 → skip
    if (isCanonicalCovered(acc.project)) continue; // canonical 인데 precise 가 0 반환한 경우도 중복 방지
    const cls = classForCategory(acc.category);
    out.push({
      nodeId,
      label: acc.project,
      project: acc.project,
      category: acc.category,
      tvlUsd: acc.tvlUsd,
      poolCount: acc.poolCount,
      multiAssetApprox: acc.multiAssetApprox,
      ...cls,
    });
  }

  return out.sort((a, b) => b.tvlUsd - a.tvlUsd);
}
