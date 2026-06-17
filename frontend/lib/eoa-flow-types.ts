export type EoaFlowTransfer = {
  direction: "in" | "out" | "internal";
  token: string;
  symbol: string;
  amount?: number;
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
  events?: unknown[];
  metadata?: EoaFlowMetadata;
  pseudoDebank?: unknown;
  morphoBorrowerAnalysis?: unknown;
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
