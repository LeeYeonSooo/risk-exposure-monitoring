/**
 * 트리 레이아웃 — 토큰(root)을 최상단에 두고 위에서 아래로 내려오는 계층 배치.
 *   토큰 → 프로토콜 → 파생토큰 → 수용처 마켓 → 큐레이터 볼트
 *
 * 동심원(concentric-layout)의 대안. overlayLego·PageRank(connImportance)까지 끝난
 * 노드/엣지를 받아 position 만 재계산한다(노드·엣지 디자인·메타 불변). GraphCanvas staticLayout 으로 고정 렌더.
 *
 * ★핵심: 깊이 = "노드 종류 레벨"로 강제한다(BFS 깊이가 아니라).★
 *   토큰0 · 프로토콜1 · 파생2 · 수용처마켓3 · 큐레이터볼트4.
 *   부모 = 들어오는 엣지 source 중 "한 레벨 위" 노드(파생의 부모 = 발행 프로토콜, 마켓의 부모 = 그 파생, 볼트의 부모 = 마켓).
 *   → 파생이 토큰 직속(레벨1)에 쏟아지지 않고 "발행 프로토콜 아래"로 내려간다(사용자: "프로토콜 아래에 그 다음 자식").
 *   가로 위치는 부모 아래 자식 중앙(tidy tree). 교차 의존(파생→다른 프로토콜 마켓)은 비트리 엣지로 직선 연결.
 */
import type { GraphNode, TopologyResponse } from "./api";

const LEVEL_GAP = 260;    // 레벨(종류) 수직 간격
const SIBLING_GAP = 30;   // 형제 노드 가로 여유
const CHAIN_GAP = 340;    // 체인 트리 사이 가로 간격
const ORPHAN_GAP = 64;    // 트리에 안 걸린 노드 가로 간격
const ISLAND_DY = 120;    // 체인 라벨(IslandHandle)을 root 위로 올리는 거리

function chainOf(n: GraphNode): string {
  const c = n.metadata?.chain as string | undefined;
  if (c) return c;
  const m = /^c:([^:]+):/.exec(n.id);
  return m ? m[1] : "ethereum";
}

// 노드 종류 → 깊이 레벨. 토큰0 · 프로토콜1 · 파생2 · 마켓3 · 큐레이터볼트4.
function levelOf(n: GraphNode): number {
  if (n.type === "Token" || /^c:[^:]+:token$/.test(n.id)) return 0;
  if (n.metadata?._vault) return 4;
  if (n.metadata?._market) return 3;
  if (n.type === "DerivativeToken") return 2;
  return 1; // 프로토콜(브릿지 합성 노드 포함)
}

// RiskNode 실제 지름 근사 — 간격 계산용.
function nodeDia(n: GraphNode): number {
  const cb = (n.metadata?.connImportance as number | undefined) ?? 1;
  let base: number;
  if (n.metadata?._market || n.metadata?._vault) base = 54;
  else if (n.type === "DerivativeToken") base = 40;
  else if (n.type === "Token") base = (n.metadata?.diameterPx as number | undefined) ?? 64;
  else if (n.type === "Bridge") base = 60;
  else base = (n.metadata?.diameterPx as number | undefined) ?? 96;
  return base * cb;
}

export function applyTreeLayout(topology: TopologyResponse, hiddenChains: Set<string>): TopologyResponse {
  const nodes = topology.nodes.filter((n) => !hiddenChains.has(chainOf(n)));
  if (!nodes.length) return topology;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const idSet = new Set(byId.keys());

  // 들어오는 엣지 (target → [sources])
  const inEdges = new Map<string, string[]>();
  for (const e of topology.edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue;
    (inEdges.get(e.target) ?? inEdges.set(e.target, []).get(e.target)!).push(e.source);
  }

  // 부모 = in-edge source 중 레벨이 더 낮은(상위) 것 중 가장 가까운(레벨 큰) 노드. 없으면 같은 체인 토큰.
  //   파생(2)의 in-edge: 토큰(0, issues)·프로토콜(1, issues) → 가장 가까운 상위 = 프로토콜(1). 파생이 프로토콜 아래로.
  //   마켓(3): 파생(2, collateral_at)·프로토콜(1) → 파생(2). 볼트(4): 마켓(3). 프로토콜(1): 토큰(0).
  const parentOf = (id: string): string | null => {
    const n = byId.get(id)!; const lv = levelOf(n);
    if (lv === 0) return null;
    const srcs = (inEdges.get(id) ?? []).filter((s) => byId.has(s) && levelOf(byId.get(s)!) < lv);
    if (srcs.length) { srcs.sort((a, b) => levelOf(byId.get(b)!) - levelOf(byId.get(a)!)); return srcs[0]; }
    const root = `c:${chainOf(n)}:token`;
    return byId.has(root) && root !== id ? root : null;
  };

  const children = new Map<string, string[]>();
  for (const n of nodes) {
    const p = parentOf(n.id);
    if (p) (children.get(p) ?? children.set(p, []).get(p)!).push(n.id);
  }

  const pos = new Map<string, { x: number; y: number }>();
  let cursorX = 0, maxY = 0;
  // 후위순회 — 자식 먼저 x 누적, 부모는 자식 중앙. y = 종류 레벨(+줄 엇갈림).
  //   자식이 많으면 여러 줄로 접어(yShift) 가로 폭을 줄이고, leaf 가로 간격도 압축(compress).
  const place = (id: string, yShift = 0, compress = 1): number => {
    const existing = pos.get(id);
    if (existing && existing.x !== 0) return existing.x;
    const n = byId.get(id)!;
    const y = levelOf(n) * LEVEL_GAP + yShift;
    if (y > maxY) maxY = y;
    pos.set(id, { x: 0, y }); // 사이클 가드
    const kids = (children.get(id) ?? []).filter((k) => k !== id && (!pos.get(k) || pos.get(k)!.x === 0));
    let x: number;
    if (!kids.length) {
      const half = (nodeDia(n) / 2 + SIBLING_GAP / 2) * compress;
      x = cursorX + half; cursorX = x + half;
    } else {
      const rows = kids.length > 14 ? 3 : kids.length > 6 ? 2 : 1;
      const zig = rows > 1 ? 110 : 0;       // 줄 간 수직 오프셋
      const comp = rows > 1 ? 1.5 / rows : 1; // 여러 줄이면 가로 간격 압축
      const xs = kids.map((k, i) => place(k, (i % rows) * zig, comp));
      x = (Math.min(...xs) + Math.max(...xs)) / 2;
    }
    pos.set(id, { x, y });
    return x;
  };

  for (const chain of [...new Set(nodes.map(chainOf))]) {
    const root = `c:${chain}:token`;
    if (byId.has(root)) {
      place(root);
      const island = nodes.find((n) => n.type === "IslandHandle" && chainOf(n) === chain && !pos.has(n.id));
      if (island) pos.set(island.id, { x: pos.get(root)!.x, y: -ISLAND_DY });
      cursorX += CHAIN_GAP;
    }
  }

  // 트리에 안 걸린 노드(고립·사이클) — 맨 아래 줄
  let ox = 0; const oy = maxY + LEVEL_GAP;
  for (const n of nodes) {
    if (pos.has(n.id)) continue;
    const half = nodeDia(n) / 2 + ORPHAN_GAP / 2;
    ox += half; pos.set(n.id, { x: ox, y: oy }); ox += half;
  }

  // position = 중심 - 지름/2 (좌상단; concentric·lego 동일 관례)
  const laidOut = topology.nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) return n;
    const d = nodeDia(n);
    return { ...n, position: { x: p.x - d / 2, y: p.y - d / 2 } };
  });
  return { ...topology, nodes: laidOut };
}
