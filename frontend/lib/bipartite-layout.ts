/**
 * 멀티체인 동심원(concentric) 이분그래프 레이아웃 — 체인마다 "섬" 1개.
 *
 * 각 체인을 독립된 동심원으로 그림 (안쪽 원 = 토큰, 바깥 원 = 프로토콜),
 * barycenter 교차 최소화로 둘레 순서 정렬 → 섬들을 옆으로 나란히 배치.
 * (브릿지 엣지가 생기면 섬과 섬을 잇게 됨 — 다음 단계.)
 * 결정적 정적 배치 → force 불필요, snap-back 없음.
 */

import type { GraphEdge, GraphNode, TopologyResponse } from "./api";

const TWO_PI = Math.PI * 2;
const TOKEN_ARC = 112;
const PROTO_ARC = 236;
const INNER_MIN_R = 320;
const RING_GAP = 380;
const BARYCENTER_ITERS = 12;
const ISLAND_GAP = 3800; // 섬(체인) 간 가로 간격
const CHAIN_ORDER = ["ethereum", "base", "arbitrum", "optimism", "polygon"];

function sizeUsd(n: GraphNode): number {
  return (n.metadata?.sizeUsd as number) ?? (n.metadata?.tokensHeldUsd as number) ?? 0;
}
function chainOf(n: GraphNode): string {
  return (n.metadata?.chain as string) ?? "ethereum";
}

function reorderByBarycenter(layer: string[], neighbors: Map<string, string[]>, otherIndex: Map<string, number>): string[] {
  const bary = new Map<string, number>();
  layer.forEach((id, i) => {
    const nbs = neighbors.get(id) ?? [];
    const idxs = nbs.map((n) => otherIndex.get(n)).filter((v): v is number => v != null);
    bary.set(id, idxs.length ? idxs.reduce((a, b) => a + b, 0) / idxs.length : i);
  });
  return [...layer].sort((a, b) => {
    const d = (bary.get(a) ?? 0) - (bary.get(b) ?? 0);
    return d !== 0 ? d : layer.indexOf(a) - layer.indexOf(b);
  });
}

/** 한 체인의 동심원 좌표 (원점 중심). */
function layoutChain(tokens: GraphNode[], protos: GraphNode[], edges: GraphEdge[]): Map<string, { x: number; y: number }> {
  const tokNbr = new Map<string, string[]>();
  const protoNbr = new Map<string, string[]>();
  for (const t of tokens) tokNbr.set(t.id, []);
  for (const p of protos) protoNbr.set(p.id, []);
  for (const e of edges) {
    if (tokNbr.has(e.source) && protoNbr.has(e.target)) {
      tokNbr.get(e.source)!.push(e.target);
      protoNbr.get(e.target)!.push(e.source);
    }
  }
  let tokOrder = [...tokens].sort((a, b) => sizeUsd(b) - sizeUsd(a)).map((n) => n.id);
  let protoOrder = [...protos].sort((a, b) => sizeUsd(b) - sizeUsd(a)).map((n) => n.id);
  for (let i = 0; i < BARYCENTER_ITERS; i++) {
    const tokIndex = new Map(tokOrder.map((id, k) => [id, k]));
    protoOrder = reorderByBarycenter(protoOrder, protoNbr, tokIndex);
    const protoIndex = new Map(protoOrder.map((id, k) => [id, k]));
    tokOrder = reorderByBarycenter(tokOrder, tokNbr, protoIndex);
  }
  const rInner = Math.max(INNER_MIN_R, (tokOrder.length * TOKEN_ARC) / TWO_PI);
  const rOuter = Math.max(rInner + RING_GAP, (protoOrder.length * PROTO_ARC) / TWO_PI);
  const pos = new Map<string, { x: number; y: number }>();
  tokOrder.forEach((id, i) => {
    const a = (TWO_PI * i) / Math.max(1, tokOrder.length) - Math.PI / 2;
    pos.set(id, { x: Math.cos(a) * rInner, y: Math.sin(a) * rInner });
  });
  protoOrder.forEach((id, i) => {
    const a = (TWO_PI * i) / Math.max(1, protoOrder.length) - Math.PI / 2;
    pos.set(id, { x: Math.cos(a) * rOuter, y: Math.sin(a) * rOuter });
  });
  return pos;
}

export function applyBipartiteLayout(topo: TopologyResponse): TopologyResponse {
  // 체인별 그룹
  const byChain = new Map<string, { tokens: GraphNode[]; protos: GraphNode[] }>();
  const nodeChain = new Map<string, string>();
  for (const n of topo.nodes) {
    if (n.type === "IslandHandle") continue; // 핸들은 링 배치에서 제외 (중앙에 따로 배치)
    const ch = chainOf(n);
    nodeChain.set(n.id, ch);
    let g = byChain.get(ch);
    if (!g) { g = { tokens: [], protos: [] }; byChain.set(ch, g); }
    (n.type === "Token" ? g.tokens : g.protos).push(n);
  }
  const rank = (c: string) => {
    const i = CHAIN_ORDER.indexOf(c);
    return i === -1 ? 999 : i;
  };
  const chains = [...byChain.keys()].sort((a, b) => rank(a) - rank(b));

  const pos = new Map<string, { x: number; y: number }>();
  const handles: GraphNode[] = [];
  chains.forEach((ch, i) => {
    const { tokens, protos } = byChain.get(ch)!;
    const chainEdges = topo.edges.filter((e) => nodeChain.get(e.source) === ch && nodeChain.get(e.target) === ch);
    const local = layoutChain(tokens, protos, chainEdges);
    const offsetX = i * ISLAND_GAP;
    local.forEach((p, id) => pos.set(id, { x: p.x + offsetX, y: p.y }));
    // 섬 중앙 이동 핸들 (이 노드를 끌면 원 전체가 따라옴 — GraphCanvas 에서 처리)
    // RF 는 노드를 top-left 기준 배치(nodeOrigin 기본값) → 80px 핸들을 정중앙에
    // 두려면 절반(40px)만큼 빼서 배치. (RiskNode 의 size-20 = 80px 와 일치)
    const HANDLE_HALF = 40;
    const handleId = `island:${ch}`;
    pos.set(handleId, { x: offsetX - HANDLE_HALF, y: -HANDLE_HALF });
    handles.push({
      id: handleId,
      type: "IslandHandle" as GraphNode["type"],
      label: ch,
      metadata: { chain: ch } as GraphNode["metadata"],
      active: true,
    });
  });

  const nodes: GraphNode[] = [...topo.nodes, ...handles].map((n) => ({
    ...n,
    position: pos.get(n.id) ?? n.position ?? { x: 0, y: 0 },
  }));
  return { nodes, edges: topo.edges };
}
