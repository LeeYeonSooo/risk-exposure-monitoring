/**
 * Unified edge attributes — mirrored from frontend/lib/edge-schema.ts.
 * Keep these two in sync (consider extracting to a shared package later).
 *
 * Invariant (bipartite): every edge connects exactly one token node and one
 * protocol node. Cross-protocol relationships go inside MarketEntry.fundingVaults.
 *
 * Multi-role: a single (token, protocol) edge may carry multiple roles
 * via classification.roles[]. e.g. on Aave V3, WBTC is both `collateral`
 * and `loan_asset`.
 */

export type EdgeTypeName =
  | "collateral"
  | "collateral_isolated"
  | "cdp_collateral"
  | "loan_asset"
  | "deposit_supply"
  | "lp_pair"
  | "mint_backing";

export type VenueType =
  | "market"
  | "isolated_market"
  | "vault"
  | "pool"
  | "cdp";

export type ProtocolClass = "lending" | "dex" | "wrapper" | "cdp";

export interface EdgeRole {
  edge_type: EdgeTypeName;
  amount_token: number;
  amount_usd: number;
  pct_of_supply?: number | null;
  pct_of_protocol_tvl?: number | null;
}

export interface Classification {
  roles: EdgeRole[];
  primary_role: EdgeTypeName;
  venue_type: VenueType;
  protocol_class: ProtocolClass;
}

export interface CoreWeight {
  amountToken: number;
  amountUsd: number;
  pctOfSupply: number | null;
  pctOfProtocolTvl: number | null;
}

export type OracleType = "MARKET" | "EXCHANGE_RATE" | "NAV" | "ORACLE_FREE" | "NONE";

export interface OracleInfo {
  type: OracleType;
  provider: string | null;
  address: string | null;
  depegSensitive: boolean;
  /** 온체인 introspection 으로 읽은 실제 피드 설명(예: "wBTC/BTC/USD"). 못 읽으면 null. */
  description?: string | null;
  /** true = type/provider/description 를 온체인 컨트랙트에서 검증해 채움. false = 심볼 휴리스틱 fallback. */
  verified?: boolean;
}

/** Interest Rate Model — diff target for irm_changed alert. */
export interface IrmInfo {
  address: string | null;
  family: string | null;
  baseRate: number | null;
  kink: number | null;
}

export interface LendingRisk {
  ltv: number | null;
  lt: number | null;
  liquidationBonus: number | null;
  supplyCap: number | null;
  borrowCap: number | null;
  reserveFactor: number | null;
  utilization: number | null;
  liquidityUsd: number | null;
  isFrozen: boolean | null;
  eModeCategory: string | null;
  irm: IrmInfo | null;
}

export interface DexMetrics {
  poolCount: number | null;
  liquidityUsd: number | null;
  depthAt1pctUsd: number | null;
  depthAt5pctUsd: number | null;
  topPairs: string[] | null;
}

export interface WrapperInfo {
  issuedToken: string;
  backingShare: number | null;
  coBackingTokens: string[] | null;
  redemption: string | null;
  manager: string | null;
}

export interface FundingVault {
  vaultName: string;
  vaultAddress: string;
  curator: string;
  depositAsset: string;
  allocationUsd: number;
}

/**
 * 개별 포지션 청산위험 — 마켓의 최대 차입자(들) 중 청산임계에 가장 근접한 단일 포지션.
 * near_liquidation 을 **집계 LTV** 가 아니라 **포지션 단위**로 평가하기 위함. 집계는 양방향으로 틀린다:
 *  · FN — 큰 안전 포지션(고래)이 Σ담보를 키워 집계 LTV 를 끌어내려 옆의 청산임박 포지션을 가림.
 *  · FP — 집계만 높고 실제 청산 위험 포지션은 거의 없음.
 * 따라서 "청산임계 근접 + 충분히 큰" 개별 포지션이 있을 때만 발화한다. (Morpho 한정 — 포지션 API 가 있는 유일한 소스.)
 */
export interface RiskiestPosition {
  /** 차입자 주소 */
  user: string;
  /** 이 포지션 차입 USD (규모 게이트용) */
  borrowUsd: number;
  /** 이 포지션 담보 USD */
  collateralUsd: number;
  /** Morpho healthFactor = (담보$×LLTV)/차입$ — 1 에 가까울수록 청산 임박, <1 이면 청산 가능 */
  healthFactor: number;
  /** 담보 가격이 이만큼 더 빠지면 이 포지션이 청산 (= max(0, 1 − 1/HF)) */
  dropToLiquidation: number;
}

export interface MarketEntry {
  loanAsset?: string;
  collateralAsset?: string;
  lltv: number;
  marketSizeUsd: number;
  oracleAddress?: string;
  /** 마켓별 오라클 introspection 결과(종류/제공자/검증). Morpho 처럼 마켓마다 오라클이 다를 때 per-market 로 보존. */
  oracle?: OracleInfo;
  irmAddress?: string;
  ouroborosRisk?: boolean;
  utilization?: number;
  /** 부실채권 임계용 — 이 마켓의 담보 예치 USD / 차입 USD. aggLTV = borrowUsd/collateralUsd. */
  collateralUsd?: number | null;
  borrowUsd?: number | null;
  /** 개별 포지션 청산위험 대표 — 이 마켓 최대 차입자 중 청산임계 최근접(near_liquidation 포지션 단위 평가용, Morpho). */
  riskiestPosition?: RiskiestPosition | null;
  vaultFunded: boolean;
  fundingVaults: FundingVault[] | null;
  vaultFundedShareOfSupply: number | null;
}

export interface PoolEntry {
  pair: string;
  amount: number;
  fee: number | null;
  pairedToken?: string;
  depthAt1pctUsd?: number;
}

export interface EdgeMeta {
  snapshotBlock: number | null;
  snapshotTs: string | null;
  verifiableOnchain: boolean | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  dataSource: string | null;
}

export interface EdgeAttrs {
  /** New canonical block — multi-role per (token, protocol). */
  classification: Classification;

  /** Legacy mirror — synced with classification.primary_role / venue_type / protocol_class */
  edgeType: EdgeTypeName;
  venueType: VenueType;
  protocolClass: ProtocolClass;

  /** Totals across all roles. */
  core: CoreWeight;
  oracle: OracleInfo;
  lendingRisk: LendingRisk | null;
  dex: DexMetrics | null;
  wrapper: WrapperInfo | null;
  topMarkets: MarketEntry[] | null;
  topPools: PoolEntry[] | null;
  meta: EdgeMeta;
}

export const NO_ORACLE: OracleInfo = {
  type: "NONE",
  provider: null,
  address: null,
  depegSensitive: false,
};

export const DEFAULT_META: EdgeMeta = {
  snapshotBlock: null,
  snapshotTs: null,
  verifiableOnchain: true,
  confidence: "HIGH",
  dataSource: "automation-snapshot",
};

/** Build a single-role classification (most adapters). */
export function makeClassification(
  role: EdgeRole,
  venueType: VenueType,
  protocolClass: ProtocolClass,
): Classification {
  return {
    roles: [role],
    primary_role: role.edge_type,
    venue_type: venueType,
    protocol_class: protocolClass,
  };
}

/** Build a multi-role classification, picking primary by largest amount_usd. */
export function makeMultiClassification(
  roles: EdgeRole[],
  venueType: VenueType,
  protocolClass: ProtocolClass,
): Classification {
  if (roles.length === 0) throw new Error("makeMultiClassification: empty roles[]");
  const primary = [...roles].sort((a, b) => b.amount_usd - a.amount_usd)[0].edge_type;
  return { roles, primary_role: primary, venue_type: venueType, protocol_class: protocolClass };
}

/**
 * Sum role amounts → CoreWeight (headline = "예치/잠긴 노출").
 *
 * loan_asset(차입)은 **합산에서 제외** — Aave 등에서 차입액은 이미 예치(aToken supply)
 * 안에 포함된 부분집합이라 더하면 이중계상됨. 차입은 별도 role 로 보존되어 표시되지만
 * headline core(그래프 weight·TVL)는 공급/담보/예치 측만 집계 → DeFiLlama TVL 과 정합.
 * (단일 마켓이 아닌 Morpho collateral_isolated 등도 예치측이라 포함)
 */
export function sumRolesToCore(roles: EdgeRole[]): CoreWeight {
  let amountToken = 0;
  let amountUsd = 0;
  let pctSum = 0;
  let allPctNull = true;
  const supplySide = roles.filter((r) => r.edge_type !== "loan_asset");
  // 공급측 role 이 하나도 없으면(순수 loan_asset only) loan 값으로라도 표시
  const counted = supplySide.length > 0 ? supplySide : roles;
  for (const r of counted) {
    amountToken += r.amount_token;
    amountUsd += r.amount_usd;
    if (r.pct_of_supply != null) {
      pctSum += r.pct_of_supply;
      allPctNull = false;
    }
  }
  return {
    amountToken,
    amountUsd,
    pctOfSupply: allPctNull ? null : pctSum,
    pctOfProtocolTvl: null,
  };
}

// ─────────────────────────────────────────────────────────────
// Snapshot record (what gets written to DB)
// ─────────────────────────────────────────────────────────────

export interface TokenNodeSnapshot {
  nodeId: string;
  type: "Token";
  label: string;
  address: string;
  metadata: {
    symbol: string;
    decimals: number;
    totalSupply: number;
    holders: number | null;
    marketCapUsd: number | null;
    paused: boolean;
    bridges: Record<string, Array<{ bridge: string; lockedAmount: number; destChains: string[]; mechanism?: string | null }>>;
    /** Top-N holder list (for whale-unwind alert). */
    topHolders?: Array<{ address: string; rawBalance: string; amount: number }>;
    /** D04b — 토큰의 정식 Chainlink USD 피드 latestRoundData (FeedRegistry, 메인넷). 미등록이면 null. */
    oracleFeed?: { updatedAt: number; answer: number; roundStale: boolean } | null;
  };
}

export interface ProtocolNodeSnapshot {
  nodeId: string;
  type: "DefiProtocol";
  label: string;
  address: string;
  metadata: {
    family: string;
    architecture: string;
    coreContract: string | null;
    tokensHeld: number;
    tokensHeldUsd: number;
    governance: string | null;
  };
}

export interface EdgeSnapshot {
  edgeId: string;
  source: string;                  // node_id (token side)
  target: string;                  // node_id (protocol side)
  type: string;                    // matches attrs.classification.primary_role / attrs.edgeType (legacy)
  weight: number;
  attrs: EdgeAttrs;
}

export interface TokenSnapshotResult {
  token: TokenNodeSnapshot;
  protocols: ProtocolNodeSnapshot[];
  edges: EdgeSnapshot[];
  unknownAddresses: Array<{ address: string; balance: bigint; hint: string | null }>;
  snapshotTs: string;
  blockNumber: number | null;
}
