/**
 * kuromi(the-god-kuromi) 재귀 홀더-언랩 그래프 → 우리 TopologyResponse 정규화.
 * "진짜 누가 들고 있나"를 depth(언랩 단계)별로 depth-컬럼 배치. 맵 안 오버레이로 표시.
 * 입력: kuromi sim.json (public/depth/<symbol>.json). Ethereum, (token,block) 재현, price-free.
 */
import type { GraphEdge, GraphNode, TopologyResponse } from "./api";

interface KuromiNode {
  id: string;
  type: string;
  label: string;
  data: { category?: string; kind?: string; depth: number; address?: string; approx?: boolean; symbol?: string | null };
}
interface KuromiEdge {
  id: string; source: string; target: string; label?: string; edge_type: string;
  amount?: number; depth?: number; via?: string;
  position?: { role?: string; detail?: { ltv?: number; liq_threshold?: number; underlying_symbol?: string }; confidence?: string; verifiable_onchain?: boolean };
}
export interface KuromiSim { nodes: KuromiNode[]; edges: KuromiEdge[]; metadata?: Record<string, unknown>; }

const COL_GAP = 460;
const ROW_GAP = 96;

/** depth(상세) 그래프가 준비된 토큰 (kuromi feeder 오프라인 크롤 샘플). */
export const DEPTH_AVAILABLE = new Set(["rseth", "steth", "wsteth"]);
export function hasDepth(symbol: string): boolean {
  return DEPTH_AVAILABLE.has(symbol.trim().toLowerCase());
}

export function normalizeDepthGraph(sim: KuromiSim): TopologyResponse {
  const depths = [...new Set(sim.nodes.map((n) => n.data.depth))].sort((a, b) => a - b);
  const colOf = new Map(depths.map((d, i) => [d, i]));

  const nodes: GraphNode[] = sim.nodes.map((n) => {
    const col = colOf.get(n.data.depth) ?? 0;
    const colNodes = sim.nodes.filter((m) => (colOf.get(m.data.depth) ?? 0) === col);
    const within = colNodes.findIndex((m) => m.id === n.id);
    return {
      id: n.id,
      type: (n.type === "token" ? "Token" : "DefiProtocol") as GraphNode["type"],
      label: n.label,
      metadata: {
        symbol: n.data.symbol ?? n.label,
        chain: "ethereum",
        category: n.data.category ?? null,
        approx: !!n.data.approx,
        description: `depth ${n.data.depth}`,
      } as GraphNode["metadata"],
      active: !n.data.approx,
      position: { x: col * COL_GAP, y: (within - (colNodes.length - 1) / 2) * ROW_GAP },
    };
  });

  const edges: GraphEdge[] = sim.edges.map((e) => {
    const det = e.position?.detail;
    const lt = det?.liq_threshold ?? null;
    return {
      id: e.id, source: e.source, target: e.target, type: e.edge_type, weight: e.amount ?? 0,
      attrs: {
        classification: { roles: [{ edge_type: e.edge_type, amount_token: e.amount ?? 0, amount_usd: 0 }], primary_role: e.edge_type, venue_type: "market", protocol_class: "lending" },
        edgeType: e.edge_type, venueType: "market", protocolClass: "lending",
        core: { amountToken: e.amount ?? 0, amountUsd: 0, pctOfSupply: null, pctOfProtocolTvl: null },
        oracle: { type: "NONE", provider: null, address: null, depegSensitive: false },
        lendingRisk: lt != null ? { ltv: det?.ltv ?? null, lt, liquidationBonus: null, supplyCap: null, borrowCap: null, reserveFactor: null, utilization: null, liquidityUsd: null, isFrozen: null, eModeCategory: null, irm: null } : null,
        dex: null, wrapper: null, topMarkets: null, topPools: null,
        meta: { snapshotBlock: null, snapshotTs: null, verifiableOnchain: e.position?.verifiable_onchain ?? null, confidence: (e.position?.confidence as "HIGH" | "MEDIUM" | "LOW" | null) ?? null, dataSource: `kuromi depth${e.via ? ` · via ${e.via}` : ""}${e.label ? ` · ${e.label}` : ""}` },
      } as unknown as GraphEdge["attrs"],
    };
  });

  return { nodes, edges };
}
