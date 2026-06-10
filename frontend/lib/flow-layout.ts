/**
 * flow-layout — sizing + force constants + initial seeding for the LIVE d3-force
 * simulation (run in FlowGraph). Tokens are big hubs, protocols medium, markets and
 * vaults small. With multiple chains each chain seeds into its own horizontal band.
 */
import type { FlowEdge, FlowGraph, FlowNode } from "./flow-types";

const BASE_R: Record<FlowNode["kind"], number> = { token: 27, protocol: 18, market: 11, vault: 9, external: 10, bridge: 12 };

export function radiusOf(n: FlowNode): number {
  const base = BASE_R[n.kind] ?? 12;
  const t = n.tvlUsd > 0 ? Math.log10(n.tvlUsd + 1) : 0; // ~0..11
  return base + Math.min(base * 1.15, t * 1.7);
}

// bridge 는 토큰↔[브릿지 노드]↔토큰의 절반 엣지라 260→150 (총 거리 유지). trace = 발견된 새 의존성(느슨).
export const LINK_DIST: Record<FlowEdge["kind"], number> = {
  holds: 115, market: 60, involves: 150, vault: 44, bridge: 150, sibling: 230, oracle: 140, trace: 190,
};
export const LINK_STR: Record<FlowEdge["kind"], number> = {
  holds: 0.5, market: 0.72, involves: 0.16, vault: 0.62, bridge: 0.12, sibling: 0.07, oracle: 0.03, trace: 0.04,
};

/** deterministic initial positions: chain bands; tokens on a ring; others jittered near band. */
export function seedPositions(graph: FlowGraph, chainsOrder: string[], width: number, height: number): Map<string, { x: number; y: number }> {
  const chains = chainsOrder.length ? chainsOrder : [...new Set(graph.nodes.map((n) => n.chain))];
  const multi = chains.length > 1;
  const bandX = (chain: string) => (multi ? ((Math.max(0, chains.indexOf(chain)) + 0.5) / chains.length) * width : width / 2);

  const tokensByChain = new Map<string, FlowNode[]>();
  for (const n of graph.nodes) if (n.kind === "token") (tokensByChain.get(n.chain) ?? tokensByChain.set(n.chain, []).get(n.chain)!).push(n);

  const out = new Map<string, { x: number; y: number }>();
  for (const n of graph.nodes) {
    const bx = bandX(n.chain);
    if (n.kind === "token") {
      const list = tokensByChain.get(n.chain) ?? [];
      const idx = list.indexOf(n);
      const ang = (idx / Math.max(1, list.length)) * Math.PI * 2;
      const ring = multi ? Math.min(width / chains.length, height) * 0.26 : Math.min(width, height) * 0.28;
      out.set(n.id, { x: bx + Math.cos(ang) * ring, y: height / 2 + Math.sin(ang) * ring });
    } else {
      let h = 0; for (let i = 0; i < n.id.length; i++) h = (h * 31 + n.id.charCodeAt(i)) >>> 0;
      out.set(n.id, { x: bx + ((h % 700) - 350), y: height / 2 + (((h >> 9) % 700) - 350) });
    }
  }
  return out;
}
