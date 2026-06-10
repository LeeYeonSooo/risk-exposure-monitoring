/**
 * Unified edge attributes — same section structure across ALL edge types.
 *
 * Invariant (bipartite): every edge connects exactly one token node and one
 * protocol node. NO protocol→protocol, NO token→token edges. Cross-protocol
 * relationships (e.g. MetaMorpho vault → Morpho Blue market) live inside
 * MarketEntry.fundingVaults as nested attributes.
 *
 * Multi-role: a single token↔protocol edge may carry multiple roles
 * (e.g. WBTC on Aave V3 is BOTH `collateral` AND `loan_asset`). Roles live
 * inside `classification.roles[]`. `primary_role` is the dominant one used
 * for visual styling (color, label).
 *
 * Sections (rendered in this order in SidePanel):
 *   1. Endpoints
 *   2. Classification — roles[] / primary_role / venue_type / protocol_class
 *   3. Core weight   — amount_token / amount_usd / pct_of_supply / pct_of_protocol_tvl (totals across roles)
 *   4. Oracle        — type / provider / address / depegSensitive
 *   5. Lending risk  — LTV / LT / liq bonus / supply cap / utilization / e-mode / IRM
 *   6. DEX metrics   — pool count / liquidity / depth
 *   7. Wrapper       — issued token / backing share / co-backing
 *   8. Sub-items     — topMarkets (with vault funding nested), topPools
 *   9. Meta          — snapshot / confidence / source
 */

// ─────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────

export type EdgeTypeName =
  | "collateral"             // mono-pool lending (Aave V3, Spark, Compound V3, ...)
  | "collateral_isolated"    // Morpho Blue-style isolated markets aggregate
  | "cdp_collateral"         // CDP-style collateral (Maker, f(x))
  | "loan_asset"             // token can be borrowed (loan-side of a market)
  | "deposit_supply"         // token deposited into a vault/pool to supply liquidity
  | "lp_pair"                // DEX swap pool
  | "mint_backing";          // wrapper token (eBTC, fxBTC) backing

export type VenueType =
  | "market"                 // single mono-pool market
  | "isolated_market"        // bundle of isolated markets
  | "vault"                  // ERC-4626 vault
  | "pool"                   // DEX pool
  | "cdp";                   // CDP / leveraged stable

export type ProtocolClass = "lending" | "dex" | "wrapper" | "cdp";

/**
 * One role of a token within a protocol. A single (token, protocol) edge can
 * have multiple roles. e.g. on Aave V3, WBTC has role=collateral (supplied)
 * AND role=loan_asset (borrowed). Amounts are role-specific.
 */
export interface EdgeRole {
  edge_type: EdgeTypeName;
  amount_token: number;
  amount_usd: number;
  pct_of_supply?: number | null;
  pct_of_protocol_tvl?: number | null;
}

/**
 * Classification block — collects all roles + chooses one as primary for UI.
 */
export interface Classification {
  roles: EdgeRole[];
  primary_role: EdgeTypeName;
  venue_type: VenueType;
  protocol_class: ProtocolClass;
}

// ─────────────────────────────────────────────────────────────
// Core sections
// ─────────────────────────────────────────────────────────────

export interface CoreWeight {
  amountToken: number;
  amountUsd: number;
  pctOfSupply: number | null;
  pctOfProtocolTvl: number | null;
}

export type OracleType =
  | "MARKET"
  | "EXCHANGE_RATE"
  | "NAV"
  | "ORACLE_FREE"
  | "NONE";

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

// ─────────────────────────────────────────────────────────────
// Class-specific (nullable)
// ─────────────────────────────────────────────────────────────

/**
 * Interest Rate Model — tracked separately because IRM changes are one of
 * the 7 monitored dynamic risk factors (diff engine alert kind=irm_changed).
 */
export interface IrmInfo {
  address: string | null;       // canonical IRM contract address
  family: string | null;        // "Adaptive" | "Static" | "DoubleSlope" | etc.
  baseRate: number | null;      // optional snapshot of current rate (display only)
  kink: number | null;          // utilization point where slope changes
}

export interface LendingRisk {
  ltv: number | null;
  lt: number | null;
  liquidationBonus: number | null;
  supplyCap: number | null;
  borrowCap: number | null;
  reserveFactor: number | null;
  utilization: number | null;
  liquidityUsd: number | null;  // available-to-borrow USD (for utilization/liquidity drop alerts)
  isFrozen: boolean | null;
  eModeCategory: string | null;
  irm: IrmInfo | null;          // interest-rate model (diff target)
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

// ─────────────────────────────────────────────────────────────
// Sub-item lists
// ─────────────────────────────────────────────────────────────

/**
 * Nested vault info inside a MarketEntry — represents which MetaMorpho-style
 * vaults route liquidity into this specific market. Replaces the old
 * protocol→protocol "vault_allocation" edge (bipartite invariant).
 */
export interface FundingVault {
  vaultName: string;
  vaultAddress: string;
  curator: string;
  depositAsset: string;
  allocationUsd: number;
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
  /** 부실채권 임계용 — 담보 예치 USD / 차입 USD. aggLTV = borrowUsd/collateralUsd. */
  collateralUsd?: number | null;
  borrowUsd?: number | null;

  // Vault funding (nested) — replaces protocol→protocol vault_allocation edge
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

// ─────────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────────

export interface EdgeMeta {
  snapshotBlock: number | null;
  snapshotTs: string | null;
  verifiableOnchain: boolean | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  dataSource: string | null;
}

// ─────────────────────────────────────────────────────────────
// Unified attrs
// ─────────────────────────────────────────────────────────────

export interface EdgeAttrs {
  /** New canonical block — multi-role per (token, protocol) edge. */
  classification: Classification;

  /**
   * Legacy mirror fields — kept synced with `classification.primary_role` etc.
   * for backward-compat with components that haven't been migrated yet.
   * New code SHOULD read `classification.*` and ignore these.
   */
  edgeType: EdgeTypeName;
  venueType: VenueType;
  protocolClass: ProtocolClass;

  /** Totals across all roles (sum of role amounts). */
  core: CoreWeight;
  oracle: OracleInfo;
  lendingRisk: LendingRisk | null;
  dex: DexMetrics | null;
  wrapper: WrapperInfo | null;
  topMarkets: MarketEntry[] | null;
  topPools: PoolEntry[] | null;
  meta: EdgeMeta;
}

/**
 * Helper — build an EdgeAttrs from a single role (most common case).
 * Sets both the legacy fields and classification.roles=[that one role].
 */
export function singleRoleAttrs(
  role: EdgeRole,
  venueType: VenueType,
  protocolClass: ProtocolClass,
  rest: Omit<EdgeAttrs, "edgeType" | "venueType" | "protocolClass" | "core" | "classification">,
): EdgeAttrs {
  return {
    classification: {
      roles: [role],
      primary_role: role.edge_type,
      venue_type: venueType,
      protocol_class: protocolClass,
    },
    edgeType: role.edge_type,
    venueType,
    protocolClass,
    core: {
      amountToken: role.amount_token,
      amountUsd: role.amount_usd,
      pctOfSupply: role.pct_of_supply ?? null,
      pctOfProtocolTvl: role.pct_of_protocol_tvl ?? null,
    },
    ...rest,
  };
}

/**
 * Helper — choose the dominant role by amount_usd (used for primary_role).
 */
export function pickPrimaryRole(roles: EdgeRole[]): EdgeTypeName {
  if (roles.length === 0) throw new Error("pickPrimaryRole: empty roles[]");
  return [...roles].sort((a, b) => b.amount_usd - a.amount_usd)[0].edge_type;
}

/**
 * Helper — sum CoreWeight from a multi-role classification.
 */
export function sumRoles(roles: EdgeRole[]): CoreWeight {
  const sum = roles.reduce(
    (acc, r) => ({
      amountToken: acc.amountToken + r.amount_token,
      amountUsd: acc.amountUsd + r.amount_usd,
      pctOfSupply: (acc.pctOfSupply ?? 0) + (r.pct_of_supply ?? 0),
      pctOfProtocolTvl: null as number | null,
    }),
    { amountToken: 0, amountUsd: 0, pctOfSupply: 0 as number | null, pctOfProtocolTvl: null as number | null },
  );
  if (roles.every((r) => r.pct_of_supply == null)) sum.pctOfSupply = null;
  return sum;
}

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

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
  dataSource: "manual-snapshot",
};
