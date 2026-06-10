/**
 * Flow-graph schema — relationship + flow graph.
 *
 * Within ONE chain a protocol is a SINGLE shared node; every token that uses it
 * links to it (so two tokens sharing Aave = one Aave node, two edges). Markets and
 * vaults are real nodes too, and a market links back to EVERY in-graph token it
 * involves — that is what weaves the web (token ⇄ market ⇄ token). Different chains
 * are separate; their tokens/protocols are joined by bridge / sibling edges.
 */

export type FlowNodeKind = "token" | "protocol" | "market" | "vault" | "external" | "bridge";
export type RiskLevel = "safe" | "caution" | "danger";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  /** owning/primary token symbol (grouping hint); shared nodes use "" */
  token: string;
  chain: string;
  protocol?: string;
  tvlUsd: number;
  /** share of the parent total (0..1) */
  sharePct?: number;
  /** token contract address on this chain (token nodes) */
  address?: string;
  meta?: Record<string, unknown>;
  risk?: RiskLevel;
}

// trace = Dune 트랜잭션 추적(14일 집계)으로 발견된 흐름 — 기존 정적 엣지에 없던 "새 의존성"만 추가.
export type FlowEdgeKind = "holds" | "market" | "involves" | "vault" | "bridge" | "sibling" | "oracle" | "trace";

/** 마켓 오라클 인텔 — 우리 DB 의 온체인 introspection(edges.attrs.topMarkets[].oracle) 결과. */
export interface OracleIntel {
  type?: string | null;        // MARKET | EXCHANGE_RATE | NAV | ORACLE_FREE …
  provider?: string | null;    // Chainlink · Morpho per-market …
  description?: string | null;
  verified?: boolean;
  address?: string | null;
  /** NAV/하드코딩(자기참조) — 디페그가 가격에 안 잡혀 청산 지연 위험 */
  danger?: boolean;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  kind: FlowEdgeKind;
  tvlUsd: number;
  /** normalized 0..1 — particle density / stroke weight */
  weight: number;
  chain: string;
  /** ambient flow direction along the edge */
  dir?: "forward" | "both";
  label?: string;
  bridge?: { mechanism?: string | null; protocol?: string | null; fromChain: string; toChain: string };
  /** kind=oracle 엣지의 introspection 인텔 (있을 때만 — 우리 DB) */
  oracle?: OracleIntel;
  /** kind=trace 엣지의 집계 수치 (Dune erc20 Transfer, 14일) */
  trace?: { assetSymbol: string | null; amountUsd: number | null; count: number; windowDays: number; sampleTx?: string | null; viaCollapsed?: boolean };
}

export interface FlowTokenSummary {
  symbol: string;
  tvlUsd: number;
  chains: string[];
  addressByChain: Record<string, string>;
}

export interface FlowGraph {
  tokens: FlowTokenSummary[];
  chains: { chain: string; tvlUsd: number; tokens: number }[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  generatedAt: string;
  notes?: string[];
}

export type FlowMode = "token-flow" | "transaction";

/** A near-real-time (≈1 min delayed) real transfer surfaced in the 흐름맵. All tx are equal — no classification. */
export interface FlowTx {
  hash: string;
  chain: string;
  token: string;
  from: string;
  to: string;
  valueUsd: number;
  ts: number; // unix seconds (event time, ~1min delayed)
  /** flow direction in the graph: into a protocol (deposit/mint/wrap) or out (withdraw/burn/unwrap) */
  direction: "in" | "out";
  kind: "deposit" | "withdraw" | "swap" | "mint" | "burn" | "wrap" | "unwrap" | "transfer";
  counterparty?: string | null; // label of the non-token side (known protocol, or generically-resolved contract)
  counterpartyAddr?: string | null; // the contract address of that counterparty (for generic/dynamic nodes)
  /** known pool pair (e.g. "WBTC-WETH") when the counterparty is a derived DEX pool — lets the
   *  renderer land the particle on the EXACT market node instead of stopping at the protocol. */
  marketHint?: string | null;
  reasons: string[];
}
