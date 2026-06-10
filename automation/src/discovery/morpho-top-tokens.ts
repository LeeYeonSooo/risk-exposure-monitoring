import { GraphQLClient, gql } from "graphql-request";

import { selectByCoverage } from "./coverage";
import { isExcludedRwa } from "./rwa-filter";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

/**
 * NOTE: Morpho's MarketOrderBy enum does NOT expose `CollateralAssetsUsd`
 * (verified 2026-06 — only SupplyAssetsUsd / BorrowAssetsUsd / symbols).
 * So we fetch a broad set ordered by SupplyAssetsUsd and re-aggregate
 * `collateralAssetsUsd` locally per collateral token.
 *
 * Ranking criterion (사용자 결정): **Morpho 담보 순위 = Σ collateralAssetsUsd**.
 * 이 방식이 자동으로 idle/loan-only 마켓(collateralAssetsUsd=null)을 걸러냄
 * (예: BONDUSD 가 supplyAssetsUsd $9.2B 여도 담보는 null → 0으로 집계됨).
 */
const MARKETS_QUERY = gql`
  query Markets($chainId: Int!, $first: Int!) {
    markets(
      first: $first
      where: { chainId_in: [$chainId] }
      orderBy: SupplyAssetsUsd
      orderDirection: Desc
    ) {
      items {
        collateralAsset { address symbol decimals }
        state { collateralAssetsUsd supplyAssetsUsd }
      }
    }
  }
`;

interface MarketRow {
  collateralAsset: { address: string; symbol: string; decimals: number } | null;
  state: { collateralAssetsUsd: number | null; supplyAssetsUsd: number | null };
}

export interface DiscoveredToken {
  address: string;
  symbol: string;
  decimals: number;
  collateralUsd: number;   // Σ collateralAssetsUsd across markets (ranking metric)
  source: "morpho_collateral";
}

const FETCH_LIMIT = 1000;

/**
 * Discover tokens by Morpho Blue collateral ranking.
 * Returns tokens sorted by aggregated collateralAssetsUsd, RWA-filtered.
 */
export async function fetchMorphoTopTokens(
  topN = 100,
  minCollateralUsd = 1_000_000,
  coverageTarget = 0.95,
): Promise<DiscoveredToken[]> {
  const client = new GraphQLClient(MORPHO_API);
  const data = await client.request<{ markets: { items: MarketRow[] } }>(MARKETS_QUERY, {
    chainId: 1,
    first: FETCH_LIMIT,
  });

  const items = data.markets.items;
  if (items.length >= FETCH_LIMIT) {
    // 정렬이 SupplyAssetsUsd 기준이라 잘린 마켓들은 supply 가 가장 작은 것들 →
    // 담보 큰 토큰이 누락될 가능성은 낮지만, 명시적으로 경고 (silent truncation 금지).
    console.warn(
      `[discover:morpho] fetched ${items.length} markets (hit FETCH_LIMIT=${FETCH_LIMIT}); ` +
        `low-supply markets may be truncated. Increase FETCH_LIMIT or paginate if needed.`,
    );
  }

  // Aggregate REAL collateral USD per token (skip null/<=0 — 그게 핵심 버그 수정)
  const byToken = new Map<string, { symbol: string; decimals: number; collateralUsd: number }>();
  for (const m of items) {
    const c = m.collateralAsset;
    if (!c) continue;
    const collateralUsd = m.state.collateralAssetsUsd;
    if (collateralUsd == null || collateralUsd <= 0) continue; // ← loan-supply fallback 제거
    const addr = c.address.toLowerCase();
    const prev = byToken.get(addr);
    byToken.set(addr, {
      symbol: c.symbol,
      decimals: c.decimals,
      collateralUsd: (prev?.collateralUsd ?? 0) + collateralUsd,
    });
  }

  // RWA(부동산·금) 제외 후 누적 커버리지 선택 (담보 TVL 의 coverageTarget 까지)
  const candidates = [...byToken.entries()]
    .map(([address, v]) => ({
      address,
      symbol: v.symbol,
      decimals: v.decimals,
      collateralUsd: v.collateralUsd,
      source: "morpho_collateral" as const,
    }))
    .filter((t) => !isExcludedRwa(t.symbol, t.address));

  return selectByCoverage(candidates, {
    coverageTarget,
    minUsd: minCollateralUsd,
    topN,
    label: "discover:morpho",
  });
}
