export type EoaFlowTransfer = {
  direction: "in" | "out" | "internal";
  token: string;
  symbol: string;
  from?: string;
  to?: string;
  amount?: number;
  amount_source?: "upstream" | "receipt_logs" | "missing";
  count: number;
};

export type EoaFlowDetail = {
  event_id?: string;
  address?: string;
  tx_hash?: string;
  datetime_utc?: string;
  block_number?: number;
  category?: string;
  protocol?: string;
  action?: string;
  transfers?: EoaFlowTransfer[];
};

export type EoaFlowNode = {
  id: string;
  type: "eoa" | "event" | "protocol" | "asset" | string;
  label: string;
  data: {
    kind: "eoa" | "safe" | "event" | "protocol" | "asset" | string;
    category?: string;
    protocol?: string;
    action?: string;
    address?: string;
    lane?: number;
    step?: number;
    tx_hash?: string;
    block_number?: number;
    datetime_utc?: string;
    target?: string;
    target_label?: string;
    symbol?: string;
    event_count?: number;
    dfs_depth?: number;
    discovered_by?: string;
    first_seen_utc?: string;
    last_seen_utc?: string;
    category_counts?: Record<string, number>;
    transfers?: EoaFlowTransfer[];
  };
};

export type EoaFlowEdge = {
  id: string;
  source: string;
  target: string;
  edge_type: string;
  category?: string;
  label?: string;
  amount?: number;
  symbol?: string;
  tx_hash?: string;
  event_count?: number;
  details?: EoaFlowDetail[];
};

export type EoaWalletClusterAddress = {
  address: string;
  nodeId?: string | null;
  label?: string | null;
  kind: "eoa" | "safe" | "contract" | "unknown";
  clusterId?: string | null;
  classificationReason?: string;
  discoveredBy?: string | null;
};

export type EoaWalletClusterEdge = {
  id: string;
  source: string;
  target: string;
  relation: "transfer" | "deployer";
  direction: "directed" | "mutual";
  strength: "weak" | "strong";
  reasons: string[];
  txCount: number;
  symbols: string[];
  firstSeenUtc: string | null;
  lastSeenUtc: string | null;
  sampleTx: string | null;
  details?: EoaFlowDetail[];
};

export type EoaWalletCluster = {
  id: string;
  addresses: string[];
  size: number;
  edgeCount: number;
  transferTxCount: number;
  strongReasons: string[];
  hasSeed: boolean;
};

export type EoaClusterPortfolioSummary = {
  clusterId: string;
  label: string;
  addressCount: number;
  sampledAddressCount: number;
  totalUsd: number | null;
  walletTokenUsd: number | null;
  protocolNetUsd: number | null;
  topWalletTokens: Array<{
    tokenAddress?: string | null;
    symbol: string;
    amount: number | null;
    valueUsd: number | null;
    addressCount: number;
  }>;
  topProtocols: Array<{
    protocolId: string;
    protocolName: string;
    netUsd: number | null;
    assetUsd: number | null;
    debtUsd: number | null;
    addressCount: number;
    positionCount: number;
  }>;
  externalOutflows?: {
    totals: {
      knownInfraUsd7d: number;
      knownInfraUsd30d: number;
      knownInfraUsdAll: number;
      knownCexBridgeUsd7d: number;
      knownCexBridgeUsd30d: number;
      knownCexBridgeUsdAll: number;
      cexUsd30d: number;
      bridgeUsd30d: number;
      routerUsd30d: number;
      solverUsd30d: number;
      protocolUsd30d: number;
      walletUsd7d: number;
      walletUsd30d: number;
      walletUsdAll: number;
      eoaUsd30d: number;
      contractUsd30d: number;
      largeUnclassifiedUsd30d: number;
    };
    topCounterparties: Array<{
      category: string;
      label: string;
      counterparty: string;
      tokenAddress?: string | null;
      symbol: string;
      amount: number | null;
      valueUsd: number | null;
      txCount: number;
      addressCount: number;
      firstSeenUtc: string | null;
      lastSeenUtc: string | null;
      sampleTx: string | null;
    }>;
  };
  dataGaps: string[];
};

export type EoaAddressPortfolioSummary = {
  address: string;
  totalUsd: number | null;
  walletTokenUsd: number | null;
  protocolNetUsd: number | null;
  topWalletTokens: Array<{
    tokenAddress?: string | null;
    symbol: string;
    amount: number | null;
    valueUsd: number | null;
  }>;
  topProtocols: Array<{
    protocolId: string;
    protocolName: string;
    netUsd: number | null;
    assetUsd: number | null;
    debtUsd: number | null;
    positionCount: number;
  }>;
  externalOutflows?: EoaClusterPortfolioSummary["externalOutflows"];
  dataGaps: string[];
};

export type EoaWalletClusterPayload = {
  addresses: EoaWalletClusterAddress[];
  edges: EoaWalletClusterEdge[];
  clusters: EoaWalletCluster[];
  clusterPortfolios?: EoaClusterPortfolioSummary[];
  addressPortfolios?: EoaAddressPortfolioSummary[];
  dataGaps?: string[];
  sources?: Array<{ source: string; ok: boolean; detail?: unknown; error?: string }>;
};

export type EoaFlowMetadata = {
  source?: string;
  view?: string;
  format_version?: number;
  address_count?: number;
  event_count?: number;
  category_counts?: Record<string, number>;
  max_events_per_address?: number;
  chain?: string;
  chain_id?: number;
  from_block?: number;
  to_block?: number;
  receipt_transfers?: string;
  important_only?: boolean;
  generated_at_utc?: string;
  discovery?: unknown;
  enrichment?: unknown;
  dfs?: {
    seed_addresses?: string[];
    depth?: number;
    directions?: string;
    discovered_addresses?: number;
    discovery_edges?: number;
  };
  error?: string;
};

export type EoaFlowPayload = {
  nodes: EoaFlowNode[];
  edges: EoaFlowEdge[];
  events?: EoaFlowDetail[];
  metadata?: EoaFlowMetadata;
  pseudoDebank?: unknown;
  morphoBorrowerAnalysis?: unknown;
  walletClusters?: EoaWalletClusterPayload;
};

export type EoaFlowItem = {
  name: string;
  label: string;
  nodes: number;
  edges: number;
  events: number;
  addresses: number;
  from_block?: number;
  to_block?: number;
};
