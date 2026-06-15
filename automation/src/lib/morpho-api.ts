import { GraphQLClient, gql } from "graphql-request";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

let _client: GraphQLClient | null = null;
function client(): GraphQLClient {
  if (_client) return _client;
  _client = new GraphQLClient(MORPHO_API, {
    headers: { "Content-Type": "application/json" },
  });
  return _client;
}

// ─────────────────────────────────────────────────────────────
// Types matching Morpho GraphQL schema
// ─────────────────────────────────────────────────────────────

export interface MorphoMarket {
  uniqueKey: string;            // = GraphQL marketId (코드 전반에서 uniqueKey 로 노출)
  lltv: string;
  oracleAddress: string | null;
  irmAddress: string | null;
  loanAsset: { address: string; symbol: string; decimals: number };
  collateralAsset: { address: string; symbol: string; decimals: number } | null;
  state: {
    supplyAssetsUsd: number | null;
    borrowAssetsUsd: number | null;
    collateralAssetsUsd: number | null;   // WBTC 등 담보의 USD 가치 (담보 집계용)
    collateralAssets: string | null;
    utilization: number | null;
  };
}

export interface MorphoVaultAllocation {
  market: { uniqueKey: string; collateralAsset?: { address: string } | null };
  supplyAssetsUsd: number | null;
  supplyCapUsd: number | null;
}

export interface MorphoVault {
  address: string;
  name: string;
  asset: { address: string; symbol: string };
  state: {
    totalAssetsUsd: number | null;
    apy: number | null;
    curator: string | null;
    allocation: MorphoVaultAllocation[];
  };
}

// ─────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────

const MARKETS_BY_COLLATERAL = gql`
  query MarketsByCollateral($chainId: Int!, $collateral: String!) {
    markets(
      first: 200
      where: { chainId_in: [$chainId], collateralAssetAddress_in: [$collateral] }
      orderBy: SupplyAssetsUsd
      orderDirection: Desc
    ) {
      items {
        uniqueKey: marketId
        lltv
        oracleAddress
        irmAddress
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
        state { supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd collateralAssets utilization }
      }
    }
  }
`;

const MARKETS_BY_LOAN = gql`
  query MarketsByLoan($chainId: Int!, $loan: String!) {
    markets(
      first: 200
      where: { chainId_in: [$chainId], loanAssetAddress_in: [$loan] }
      orderBy: SupplyAssetsUsd
      orderDirection: Desc
    ) {
      items {
        uniqueKey: marketId
        lltv
        oracleAddress
        irmAddress
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
        state { supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd collateralAssets utilization }
      }
    }
  }
`;

const VAULTS_BY_COLLATERAL_EXPOSURE = gql`
  query VaultsByCollateralExposure($chainId: Int!) {
    vaults(
      first: 200
      where: { chainId_in: [$chainId], listed: true, totalAssetsUsd_gte: 1000000 }
      orderBy: TotalAssetsUsd
      orderDirection: Desc
    ) {
      items {
        address
        name
        asset { address symbol }
        state {
          totalAssetsUsd
          apy
          curator
          allocation {
            market { uniqueKey: marketId collateralAsset { address } }
            supplyAssetsUsd
            supplyCapUsd
          }
        }
      }
    }
  }
`;

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/** Markets where this token is collateral (WBTC posted as collateral). chainId 로 멀티체인(기본 메인넷). */
export async function fetchMarketsByCollateral(token: string, chainId = 1): Promise<MorphoMarket[]> {
  const data = await client().request<{ markets: { items: MorphoMarket[] } }>(
    MARKETS_BY_COLLATERAL,
    { chainId, collateral: token.toLowerCase() },
  );
  return data.markets.items;
}

/** Markets where this token is the loan asset (borrowable WBTC). */
export async function fetchMarketsByLoan(token: string): Promise<MorphoMarket[]> {
  const data = await client().request<{ markets: { items: MorphoMarket[] } }>(
    MARKETS_BY_LOAN,
    { chainId: 1, loan: token.toLowerCase() },
  );
  return data.markets.items;
}

/**
 * MetaMorpho vaults that have allocations into markets where `token` is collateral.
 * Returns vaults with their allocation array — filter client-side by market collateral.
 */
export async function fetchVaultsByCollateralExposure(token: string): Promise<MorphoVault[]> {
  const data = await client().request<{ vaults: { items: MorphoVault[] } }>(
    VAULTS_BY_COLLATERAL_EXPOSURE,
    { chainId: 1 },
  );
  const lower = token.toLowerCase();
  // Keep only vaults that allocate to at least one market with this collateral
  return data.vaults.items.filter((v) =>
    v.state.allocation?.some(
      (a) => a.market.collateralAsset?.address?.toLowerCase() === lower,
    ),
  );
}

// ─────────────────────────────────────────────────────────────
// Market positions — 차입자 집중도/self-deal (reflexivity)
// ─────────────────────────────────────────────────────────────
export interface MarketPosition {
  user: { address: string };
  /** (담보$×LLTV)/차입$ — 1 에 가까울수록 청산 임박. 순공급자(차입 0)는 null/무한. */
  healthFactor: number | null;
  /** 담보 가격이 청산까지 변동해야 하는 비율(Morpho 제공). 이국적/무가격 담보에선 비현실값이 나올 수 있어 healthFactor 우선. */
  priceVariationToLiquidationPrice: number | null;
  state: { borrowAssetsUsd: number | null; supplyAssetsUsd: number | null; collateralUsd: number | null };
}

const MARKET_POSITIONS = gql`
  query MarketPositions($chainId: Int!, $market: String!) {
    marketPositions(
      first: 50
      where: { chainId_in: [$chainId], marketUniqueKey_in: [$market] }
      orderBy: BorrowShares
      orderDirection: Desc
    ) {
      items {
        user { address }
        healthFactor
        priceVariationToLiquidationPrice
        state { borrowAssetsUsd supplyAssetsUsd collateralUsd }
      }
    }
  }
`;

/** 한 마켓의 포지션(차입자) — borrowShares 내림차순. 집중도/self-deal 산출용. 실패 시 []. */
export async function fetchMarketPositions(marketKey: string, chainId = 1): Promise<MarketPosition[]> {
  const data = await client().request<{ marketPositions: { items: MarketPosition[] } }>(
    MARKET_POSITIONS,
    { chainId, market: marketKey },
  );
  return data.marketPositions?.items ?? [];
}
