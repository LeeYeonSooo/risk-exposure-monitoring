/**
 * Graph types + helpers for the Live page.
 *
 * Previously this file bridged to a Python simulator backend; that path is gone.
 * Now it only exposes the type surface that the graph components
 * (RiskNode / FloatingEdge / GraphCanvas / SidePanel) need, plus a few helpers.
 *
 * Graph data is live-only: the page fetches it from /api/graph (Postgres
 * snapshot). There is no static seed — empty DB renders a "no live data" state.
 */

// ─────────────────────────────────────────────────────────────
// Node / edge data shapes
// ─────────────────────────────────────────────────────────────

export type NodeType = "Token" | "TokenProtocol" | "DefiProtocol" | "Oracle" | "Bridge" | "IslandHandle";
export type RiskLevel = "safe" | "caution" | "danger";

export interface NodeMetadata {
  /** On-chain address for exact transaction-flow matching when available. */
  address?: string | null;
  /** Protocol core contract address, when distinct from the node address. */
  coreContract?: string | null;
  /** Protocol family key from the automation registry, e.g. aave_v3 or morpho_blue. */
  family?: string | null;
  description?: string | null;
  chain?: string | null;
  symbol?: string | null;
  category?: string | null;
  quality?: string | null;
  pegTargetTokenId?: string | null;
  /** pool-owning protocol for a lending-market node (e.g. "Morpho Blue", "Aave V3", "Spark") */
  venue?: string | null;
  /** standardized node role */
  role?: string | null;
  /** provenance label */
  data_source?: string | null;
  /** true = approximation, not exact */
  approx?: boolean | null;
  /** issuer of the collateral token (e.g. "Pendle" for a PT-collateral Morpho market) */
  collateral_protocol?: string | null;
  /**
   * Bridge metadata embedded on the Token node, keyed by *source chain*.
   * Phase 1: only the "ethereum" key is rendered. Future chains stay in metadata.
   *
   * Example:
   *   bridges: {
   *     ethereum: [{bridge: "Arbitrum", lockedAmount: 7024, destChains: ["arbitrum"]}, ...]
   *   }
   */
  bridges?: Record<string, TokenBridgeEntry[]> | null;
  /** Edge/node hover payload — supplementary detail rendered in tooltip / side panel */
  hoverPayload?: Record<string, unknown> | null;
  /** Raw token holdings for a protocol node */
  tokensHeld?: number | null;
  /** Raw USD value of tokens held */
  tokensHeldUsd?: number | null;
  /** 노드 크기/정렬용 USD 규모 = 인접 엣지 amountUsd 합 (프론트 계산). log2 스케일에 사용. */
  sizeUsd?: number | null;
  /** 동심원 합성 노드 — 프로토콜 로고 resolve 용 DeFiLlama slug */
  brandSlug?: string | null;
  /** 동심원 합성 마켓 노드 payload (클릭 시 상세) */
  _market?: Record<string, unknown> | null;
  /** 동심원 합성 볼트 노드 payload (클릭 시 상세) */
  _vault?: Record<string, unknown> | null;
  /** 체인 노드(매크로/트리) 마킹 — 체인 로고 원으로 렌더 */
  _chainNode?: boolean;
  /** breadth(DeFiLlama 라이브) 노드 출처 마킹 */
  dataSource?: string | null;
  /** 토큰 노드 컨트랙트 주소 (체인별) — 토큰 로고(DeFiLlama token-icon CDN)용 */
  tokenAddr?: string | null;
  /** 명시적 렌더 지름(px) — 동심원 중심 토큰을 링 반경에 비례해 키워 가독성↑ */
  diameterPx?: number | null;
  /** 현재 그래프에서 이 노드가 차지하는 토큰 익스포저 분포 비중(0..1). */
  distributionPct?: number | null;
  /** 분포 비중의 기준 설명(예: 전체 익스포저, 체인 내부, 프로토콜 내부). */
  distributionScope?: string | null;
  /** 브릿지 노드 종류 — named(레지스트리 명시) | canonical(추정) | oft(동일주소 메시). hover 툴팁용. */
  bridgeKind?: string | null;
  /** 브릿지 메커니즘 — lock_mint | burn_mint | liquidity (엣지 색·태그·리스크). */
  bridgeMechanism?: string | null;
  /** 브릿지 프로토콜 풀네임 (LayerZero, Chainlink CCIP, Wormhole, Canonical …) */
  bridgeProtocol?: string | null;
  /** 짧은 태그 (LZ, CCIP, canonical …) */
  bridgeTag?: string | null;
  /** 알려진 취약/사고 이력 브릿지 */
  bridgeWeak?: boolean | null;
  /** (가능 시) 이 브릿지의 mint 한도/캡 — xERC20 등에서만. 없으면 null. */
  bridgeMintLimit?: number | null;
  /** 온체인으로 mint 권한 검증됨(CCIP/OFT/xERC20/MINTER) — "추정" 아님. */
  bridgeVerified?: boolean | null;
}

export interface TokenBridgeEntry {
  bridge: string;
  lockedAmount: number;
  destChains: string[];
  mechanism?: "lock_unlock" | "burn_mint" | "messaging";
}

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  metadata: NodeMetadata;
  position?: { x: number; y: number } | null;
  active: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** e.g. "collateral" | "lp_pair" | "vault_allocation" | "mint_backing" */
  type: string;
  weight: number;
  /** cross-protocol bridge tier (legacy field, kept for backwards compat) */
  tier?: string;
  bridge?: boolean;
  sharedWhales?: number;
  /** @deprecated — use `attrs` instead. kept for transitional rendering only. */
  hoverPayload?: Record<string, unknown> | null;
  /**
   * Unified edge attributes (see lib/edge-schema.ts).
   * UI 가 우선적으로 이걸 읽고, 섹션 헤더는 모든 edge에서 동일.
   */
  attrs?: import("./edge-schema").EdgeAttrs;
}

export interface TopologyResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface NodeTickState {
  riskLevel: RiskLevel;
  falseNegative: boolean;
  liquidated: boolean;
  pegRatio: number | null;
  tvl: number | null;
  note: string | null;
}

// ─────────────────────────────────────────────────────────────
// Default node tick state — all nodes start safe on the live page
// ─────────────────────────────────────────────────────────────

export const SAFE_NODE_STATE: NodeTickState = {
  riskLevel: "safe",
  falseNegative: false,
  liquidated: false,
  pegRatio: null,
  tvl: null,
  note: null,
};

// ─────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}
