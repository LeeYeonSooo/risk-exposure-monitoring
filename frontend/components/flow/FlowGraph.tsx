"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  type Edge, type Node, type NodeMouseHandler, useEdgesState, useNodesState, useReactFlow,
} from "@xyflow/react";
import { forceCollide, forceLink, forceSimulation, type ForceLink, type Simulation } from "d3-force";
import "@xyflow/react/dist/style.css";

import { BaselineFlowLayer } from "./BaselineFlowLayer";
import { FloatingFlowEdge } from "./FloatingFlowEdge";
import { FlowNodeShell, type FlowNodeData } from "./FlowNodes";
import { TxFlowLayer } from "./TxFlowLayer";
import { computeStaticLayout, radiusOf } from "@/lib/flow-layout";
import type { FlowActivity } from "@/lib/flow-match";
import type { FlowGraph as FlowGraphData, FlowMode, FlowNode, FlowTx, RiskLevel } from "@/lib/flow-types";

/**
 * 흐름맵 그래프 — 배치는 결정적 동심 링 레이아웃(평상시 물리 OFF, 위치 보존), 단 **드래그
 * 중에만** d3-force 가 살아나 이어진 노드들이 스프링으로 딸려온다(tiger-research 관계도
 * 스타일 — 사용자 확정 2026-06-12). **탄력 복귀 없음**(사용자 확정): 홈 앵커 없음, 안정
 * 거리 = 드래그 시작 시점의 현재 거리, 놓은 노드는 fx/fy 핀으로 그 자리에 영구 고정 —
 * "놓은 자리가 곧 자리". 정렬 초기화 버튼만이 핀을 풀고 동심원으로 되돌린다.
 * activity(트랜잭션이 하나라도 탄 노드·엣지 집합)가 주어지면 나머지는 아예 **숨긴다**(hidden) —
 * 실제 흐름이 있는 노드·엣지만 화면에 남고, 새 트랜잭션이 그 노드·엣지를 다시 활동으로 만들면
 * 위치(posRef)가 보존돼 **같은 자리**에 다시 나타난다 (실시간/평소 모드 공통). 선택한 노드·엣지는
 * 활동이 없어도 숨기지 않는다(상세 패널과 일관). activity 가 없으면(피드 로딩·실패·활동 0) 숨기지
 * 않고 구조 전체를 흐릿하게(dim) 보여준다 — 빈 화면이 "피드 죽음"을 "활동 없음"으로 위장하지 않게.
 */

const nodeTypes = { flow: FlowNodeShell };
const edgeTypes = { flow: FloatingFlowEdge };
const RISK_RANK: Record<RiskLevel, number> = { safe: 0, caution: 1, danger: 2 };
// evenly-spaced hues for the SELECTED count → always maximally separated, never collides (even 9+ tokens).
// alternate lightness for adjacent tokens so neighbours differ in brightness too.
function tokenColor(i: number, n: number): string {
  const hue = Math.round((i * 360) / Math.max(1, n));
  const light = i % 2 === 0 ? 52 : 42;
  return `hsl(${hue}, 72%, ${light}%)`;
}

const W = 1800, H = 1100;

// ── 드래그 물리 — 시뮬 노드/링크 (좌표는 노드 "중심" 기준) ──
// 복귀 금지(사용자 확정): 홈 앵커 없음, 링크 안정거리 = "드래그 시작 시점의 현재 거리"
// (원래 레이아웃 거리가 아님 — 그래야 끌고 간 무리가 통째로 따라오고, 놓아도 안 되감긴다),
// 끌어 놓은 노드는 fx/fy 핀 영구 고정. 즉 "놓은 자리가 곧 그 노드의 자리".
interface SimNode { id: string; x: number; y: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null; r: number }
interface SimLink { source: string | SimNode; target: string | SimNode; rest: number; k: number }
// 구조 결합이 단단할수록 세게 딸려온다 — 마켓/볼트는 부모와 한 몸, holds 는 토큰이 허브라 약간 약하게
const LINK_K: Record<string, number> = { market: 0.6, vault: 0.6, derive: 0.55, bridge: 0.45, holds: 0.35 };

function Inner({
  graph, mode, chainsOrder, selectedTokens, selectedId, onSelectNode, onSelectEdge, txs, activity,
}: {
  graph: FlowGraphData; mode: FlowMode; chainsOrder: string[]; selectedTokens: string[];
  selectedId: string | null; onSelectNode: (id: string) => void; onSelectEdge: (id: string) => void;
  txs: FlowTx[]; activity: FlowActivity | null;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  // 노드 중심 좌표 보존 — 30초 폴마다 핀 노드가 들고나도 기존(사용자가 옮긴) 위치는 절대 안 움직인다
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const chainsKeyRef = useRef("");
  const firstBuildRef = useRef(true);
  // 자동 컴팩트 배치 — 활동 노드만 모아 배치하고 화면을 맞춘다. 사용자가 직접 드래그/팬/줌하면
  // userMoved 가 켜져 자동 배치를 멈춘다(놓은 자리·본 화면 보존, 기존 설계 유지). 토큰/모드/체인이
  // 바뀌면(graphKey) 다시 풀린다. lastLayoutSig = 마지막으로 배치한 활동 노드 집합(같으면 재배치 안 함).
  const userMovedRef = useRef(false);
  const lastLayoutSigRef = useRef("");
  // 드래그 물리 — 평소엔 정지(alpha 0), 드래그하는 동안만 alphaTarget 으로 살아난다
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simByIdRef = useRef<Map<string, SimNode>>(new Map());
  const simLinksRef = useRef<SimLink[]>([]);
  const linkForceRef = useRef<ForceLink<SimNode, SimLink> | null>(null);
  const dragIdRef = useRef<string | null>(null);
  // build effect(deps=[graphKey])가 최신 선택/활동을 읽기 위한 ref — chainsOrder 단독 변경 시
  // selection effect 가 재실행되지 않아도 dim/selected 가 유실되지 않게 한다.
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const activityRef = useRef(activity);
  activityRef.current = activity;

  const graphKey = useMemo(
    () => graph.nodes.map((n) => n.id).join(",") + "|" + chainsOrder.join(","),
    [graph, chainsOrder],
  );
  // 활동 노드 집합의 서명 — 이게 바뀔 때만(새 노드 등장/소멸) 컴팩트 재배치한다. activity 없으면 빈 문자열.
  const activeSig = useMemo(() => (activity ? [...activity.nodeIds].sort().join(",") : ""), [activity]);

  // ── build nodes: 정적 레이아웃은 "새 노드"에만, 기존 노드는 posRef 위치 유지 ──
  useEffect(() => {
    const chainsKey = chainsOrder.join(",");
    if (chainsKeyRef.current !== chainsKey) { posRef.current.clear(); chainsKeyRef.current = chainsKey; } // 체인 구성이 바뀌면 밴드가 바뀌므로 재배치
    const layout = computeStaticLayout(graph, chainsOrder, W, H);
    // 함수형 업데이트 + 기존 노드 spread: ReactFlow v12 는 노드 객체가 통째로 교체되면 measured
    // 를 버려 한 프레임 노드 hidden·엣지 소실 블링크가 난다 — 기존 객체를 spread 해 measured 를
    // 보존하고, 신규 노드도 width/height 를 명시해 측정 전 프레임부터 치수가 있게 한다.
    setNodes((prev) => {
      const old = new Map(prev.map((p) => [p.id, p] as const));
      return graph.nodes.map((n) => {
        const r = radiusOf(n);
        const c = posRef.current.get(n.id) ?? layout.get(n.id) ?? { x: W / 2, y: H / 2 };
        posRef.current.set(n.id, c);
        const act = activityRef.current;
        const sel = n.id === selRef.current;
        return {
          ...(old.get(n.id) ?? {}),
          id: n.id, type: "flow",
          position: { x: c.x - r, y: c.y - r },
          width: r * 2, height: r * 2,
          // zIndex 1 > 입자 svg(zIndex 0) — 트랜잭션 알이 노드 원 위를 가로지르지 않고 아래로 지나간다
          zIndex: 1,
          // activity 있음 → 활동 없는 노드는 숨김(단 선택 노드는 노출). activity 없음 → 전부 흐릿하게(dim).
          data: { ...n, radius: r, dim: !act },
          hidden: act ? !act.nodeIds.has(n.id) && !sel : false,
          draggable: true, selected: sel,
        } as Node;
      });
    });
    // fitView 는 첫 빌드에만 — 핀 노드 변동 때마다 사용자의 팬/줌을 리셋하지 않는다
    const doFit = firstBuildRef.current;
    firstBuildRef.current = false;
    const fitT = doFit ? setTimeout(() => fitView({ padding: 0.05, duration: 600 }).catch(() => {}), 150) : null;
    return () => { if (fitT) clearTimeout(fitT); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey]);

  // ── 드래그 물리 시뮬 (재)구성 — 폴마다 엣지가 바뀌어도 시뮬은 정지 상태로 갈아끼우므로
  // 화면은 안 움직인다. 위치·핀(fx/fy)은 이전 시뮬에서 승계 — 사용자가 놓은 자리는 신성하다. ──
  useEffect(() => {
    const prevSim = simByIdRef.current;
    const byId = new Map<string, SimNode>();
    for (const n of graph.nodes) {
      const cur = posRef.current.get(n.id) ?? { x: W / 2, y: H / 2 };
      const old = prevSim.get(n.id);
      byId.set(n.id, { id: n.id, x: cur.x, y: cur.y, vx: 0, vy: 0, fx: old?.fx ?? null, fy: old?.fy ?? null, r: radiusOf(n) });
    }
    // 안정거리 = 현재 거리(드래그 시작마다 다시 잼) — 사용자가 만든 배치가 그대로 "정답 모양"이
    // 되므로 끌면 무리가 통째로 따라오고, 놓아도 원래 레이아웃으로 되감기지 않는다.
    const dist = (a: SimNode, b: SimNode) => Math.max(40, Math.hypot(a.x - b.x, a.y - b.y));
    const links: SimLink[] = [];
    const seen = new Set<string>();
    for (const e of graph.edges) {
      const a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b) continue;
      const pk = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
      if (seen.has(pk)) continue;
      seen.add(pk);
      links.push({ source: e.source, target: e.target, rest: dist(a, b), k: LINK_K[e.kind] ?? 0.2 });
    }
    simRef.current?.stop();
    const sim = forceSimulation<SimNode>([...byId.values()])
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance((l) => l.rest).strength((l) => l.k))
      .force("collide", forceCollide<SimNode>().radius((d) => d.r + 6).strength(0.7).iterations(2))
      .alpha(0).alphaDecay(0.09).velocityDecay(0.5).stop();
    sim.on("tick", () => {
      setNodes((nds) => nds.map((nd) => {
        if (nd.id === dragIdRef.current) return nd; // 끌리는 노드는 ReactFlow 가 진실원
        const s = byId.get(nd.id);
        if (!s) return nd;
        const r = (nd.data as FlowNodeData).radius ?? 12;
        posRef.current.set(nd.id, { x: s.x, y: s.y });
        const nx = s.x - r, ny = s.y - r;
        if (Math.abs(nx - nd.position.x) < 0.1 && Math.abs(ny - nd.position.y) < 0.1) return nd;
        return { ...nd, position: { x: nx, y: ny } };
      }));
    });
    // 드래그 도중 리빌드(30초 폴)면 잡고 있던 노드를 다시 고정하고 시뮬을 잇는다
    const did = dragIdRef.current;
    if (did) {
      const s = byId.get(did), c = posRef.current.get(did);
      if (s && c) { s.fx = c.x; s.fy = c.y; sim.alphaTarget(0.3).restart(); }
    }
    simRef.current = sim;
    simByIdRef.current = byId;
    simLinksRef.current = links;
    linkForceRef.current = sim.force("link") as ForceLink<SimNode, SimLink>;
    return () => { sim.stop(); };
  }, [graph, chainsOrder, setNodes]);

  // ── edges (re-derive on risk / activity change) ──
  useEffect(() => {
    const riskOf = new Map(graph.nodes.map((n) => [n.id, n.risk ?? "safe"] as const));
    setEdges(graph.edges.map((e) => {
      const sr = riskOf.get(e.source) ?? "safe", tr = riskOf.get(e.target) ?? "safe";
      const risk = RISK_RANK[sr] >= RISK_RANK[tr] ? sr : tr;
      return {
        id: e.id, source: e.source, target: e.target, type: "flow",
        data: {
          kind: e.kind, weight: e.weight, tvlUsd: e.tvlUsd, volUsd: e.volUsd, mode, dir: e.dir ?? "both", label: e.label,
          risk: risk === "safe" ? undefined : risk, oracle: e.oracle, trace: e.trace, baseline: e.baseline,
          // activity 없을 때만 흐릿하게 — 있을 땐 활동 엣지만 남으므로 항상 또렷
          dim: !activity,
        },
        // 활동 없는 엣지는 숨김(선택 엣지는 노출). 보이는 엣지는 양 끝 노드도 활동(computeActivity 불변식)이라 끊긴 선이 안 생긴다.
        hidden: activity ? !activity.edgeIds.has(e.id) && e.id !== selectedId : false,
        selected: e.id === selectedId, zIndex: 0,
      } as Edge;
    }));
  }, [graph, mode, selectedId, activity, setEdges]);

  // ── selection + show/hide on nodes (no reposition) — 새 트랜잭션이 들어오면 그 노드가 activity 에
  //    들어와 hidden=false 로 풀리고, 위치(posRef)는 보존돼 같은 자리에 다시 나타난다. activity 가
  //    없으면 숨기지 않고 전부 흐릿하게(dim) 둔다(빈 화면 방지). 선택 노드는 활동이 없어도 노출. ──
  useEffect(() => {
    setNodes((prev) => prev.map((n) => {
      const sel = n.id === selectedId;
      const hide = activity ? !activity.nodeIds.has(n.id) && !sel : false;
      const dim = !activity;
      if (n.selected === sel && !!n.hidden === hide && (n.data as FlowNodeData).dim === dim) return n;
      return { ...n, selected: sel, hidden: hide, data: { ...n.data, dim } };
    }));
  }, [selectedId, activity, setNodes]);

  // ── 컴팩트 자동 배치 — 활동 노드만으로 동심 레이아웃을 다시 계산해, 듬성한 빈 링/멀리 떨어진
  //    노드 없이 모이게 한다(연결 프로토콜은 토큰 근처로 — computeStaticLayout 의 각도 로직 재사용,
  //    활동 토큰 1개면 중심 허브). 숨김(비활동) 노드는 건드리지 않는다. ──
  const computeActiveLayout = useCallback(() => {
    if (!activity) return null;
    const sub = {
      ...graph,
      nodes: graph.nodes.filter((n) => activity.nodeIds.has(n.id)),
      // 구조 엣지(holds/market/vault/derive)까지 포함해야 동심 배치가 토큰↔프로토콜을 가깝게 둔다
      edges: graph.edges.filter((e) => activity.nodeIds.has(e.source) && activity.nodeIds.has(e.target)),
    };
    return computeStaticLayout(sub, chainsOrder, W, H);
  }, [activity, graph, chainsOrder]);

  const applyActiveLayout = useCallback((layout: Map<string, { x: number; y: number }>) => {
    setNodes((prev) => prev.map((n) => {
      const c = layout.get(n.id);
      if (!c) return n; // 숨김(비활동) 노드는 그대로
      const r = (n.data as FlowNodeData).radius ?? 12;
      posRef.current.set(n.id, c);
      const s = simByIdRef.current.get(n.id);
      if (s) { s.x = c.x; s.y = c.y; s.vx = 0; s.vy = 0; s.fx = null; s.fy = null; } // 자동 배치 = 핀 해제
      return { ...n, position: { x: c.x - r, y: c.y - r } };
    }));
    simRef.current?.alpha(0).stop();
  }, [setNodes]);

  // 토큰/모드/체인이 바뀌면(graphKey) 자동 배치를 다시 푼다 — 새 선택은 새로 최적 배치.
  useEffect(() => { userMovedRef.current = false; lastLayoutSigRef.current = ""; }, [graphKey]);

  // 활동 셋이 바뀌면(첫 등장 포함) 컴팩트 재배치 + 화면 맞춤 — 단 사용자가 직접 움직였으면 멈춤.
  useEffect(() => {
    if (!activeSig || userMovedRef.current || lastLayoutSigRef.current === activeSig) return;
    const layout = computeActiveLayout();
    if (!layout) return;
    lastLayoutSigRef.current = activeSig;
    applyActiveLayout(layout);
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 500, maxZoom: 1.4 }).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [activeSig, computeActiveLayout, applyActiveLayout, fitView]);

  // ── 드래그: ReactFlow 가 잡은 노드를 옮기고, 시뮬은 그 노드를 고정점(fx/fy)으로 받아
  // 이어진 노드들을 스프링으로 끌고 온다. **놓아도 핀을 풀지 않는다** — 놓은 자리가 그 노드의
  // 자리(탄력 복귀 없음, 사용자 확정). 딸려온 이웃들도 안정거리가 "드래그 직전 거리"라서
  // 따라온 자리 근처에 그대로 정착한다. ──
  const onDragStart: NodeMouseHandler = useCallback((_, node) => {
    userMovedRef.current = true; // 직접 옮기기 시작 = 자동 컴팩트 배치 중단(놓은 자리 보존)
    const r = (node.data as FlowNodeData).radius ?? 12;
    // 안정거리를 "지금 이 순간의 거리"로 다시 잰다 — 직전 드래그들이 만든 배치가 곧 중립 모양.
    // (이걸 안 하면 스프링이 옛 배치를 기억해 끌 때마다 옛 모양으로 되감으려 든다)
    for (const l of simLinksRef.current) {
      const a = l.source as SimNode, b = l.target as SimNode;
      if (typeof a === "object" && typeof b === "object") l.rest = Math.max(40, Math.hypot(a.x - b.x, a.y - b.y));
    }
    linkForceRef.current?.distance((l) => l.rest); // d3 내부 거리 캐시 갱신
    const s = simByIdRef.current.get(node.id);
    if (s) { s.fx = node.position.x + r; s.fy = node.position.y + r; }
    dragIdRef.current = node.id;
    simRef.current?.alphaTarget(0.3).restart();
  }, []);
  const onDrag: NodeMouseHandler = useCallback((_, node) => {
    const r = (node.data as FlowNodeData).radius ?? 12;
    const c = { x: node.position.x + r, y: node.position.y + r };
    posRef.current.set(node.id, c);
    const s = simByIdRef.current.get(node.id);
    if (s) { s.fx = c.x; s.fy = c.y; s.x = c.x; s.y = c.y; }
  }, []);
  const onDragStop: NodeMouseHandler = useCallback((_, node) => {
    const r = (node.data as FlowNodeData).radius ?? 12;
    const c = { x: node.position.x + r, y: node.position.y + r };
    posRef.current.set(node.id, c);
    const s = simByIdRef.current.get(node.id);
    if (s) { s.fx = c.x; s.fy = c.y; } // 핀 유지 — 시뮬이 식는 동안에도 이 노드는 1px 도 안 움직인다
    dragIdRef.current = null;
    simRef.current?.alphaTarget(0); // 이웃들만 자연 감쇠로 자리 잡고 멈춘다
  }, []);

  // 정렬 초기화 — 끌어놓은 위치를 버리고 결정적 레이아웃으로 재배치 + 자동 배치 재개.
  // 활동이 있으면 활동 노드만 컴팩트 배치, 없으면(흐릿 전체) 전체 레이아웃.
  const relayout = useCallback(() => {
    userMovedRef.current = false; // 자동 컴팩트 배치 재개
    const active = computeActiveLayout();
    if (active) {
      lastLayoutSigRef.current = activeSig;
      applyActiveLayout(active);
      setTimeout(() => fitView({ padding: 0.2, duration: 500, maxZoom: 1.4 }).catch(() => {}), 60);
      return;
    }
    posRef.current.clear();
    const layout = computeStaticLayout(graph, chainsOrder, W, H);
    setNodes((prev) => prev.map((n) => {
      const d = n.data as FlowNodeData;
      const c = layout.get(n.id) ?? { x: W / 2, y: H / 2 };
      posRef.current.set(n.id, c);
      return { ...n, position: { x: c.x - d.radius, y: c.y - d.radius } };
    }));
    simRef.current?.alpha(0).stop();
    for (const [id, s] of simByIdRef.current) {
      const c = posRef.current.get(id);
      if (c) { s.x = c.x; s.y = c.y; s.vx = 0; s.vy = 0; s.fx = null; s.fy = null; }
    }
    setTimeout(() => fitView({ padding: 0.05, duration: 500 }).catch(() => {}), 60);
  }, [activeSig, computeActiveLayout, applyActiveLayout, graph, chainsOrder, fitView, setNodes]);

  // 입자 기하 — 노드 위치는 ReactFlow 상태가 진실원 (드래그 중에도 입자가 따라온다)
  const positioned = useMemo(
    () => nodes.map((n) => {
      const d = n.data as FlowNodeData;
      return { ...(d as FlowNode), x: n.position.x + d.radius, y: n.position.y + d.radius, radius: d.radius };
    }),
    [nodes],
  );

  // 입자 색 = **상단에서 선택한 토큰만** (사람이 구별 가능한 수). 파생/LP 등 그 외 토큰의
  // 입자는 회색 폴백 — 흐름은 보이되 색 식별 부담을 주지 않는다.
  const colorByToken = useMemo(() => {
    const syms = [...new Set(selectedTokens.map((s) => s.toUpperCase()))].sort();
    return new Map(syms.map((s, i) => [s, tokenColor(i, syms.length)] as const));
  }, [selectedTokens]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, n) => onSelectNode(n.id)}
      onEdgeClick={(_, e) => onSelectEdge(e.id)}
      onPaneClick={() => onSelectNode("")}
      onMoveStart={(e) => { if (e) userMovedRef.current = true; }} // 사용자 팬/줌(프로그램 fitView 는 e=null) → 자동 배치 중단
      onNodeDragStart={onDragStart}
      onNodeDrag={onDrag}
      onNodeDragStop={onDragStop}
      minZoom={0.08}
      maxZoom={2.6}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      elementsSelectable
      colorMode="light"
    >
      <Background variant={BackgroundVariant.Dots} gap={30} size={1} color="#dde5f0" />
      <Controls showInteractive={false} />
      <MiniMap
        pannable zoomable
        nodeColor={(n) => {
          const d = n.data as { risk?: RiskLevel; kind?: string; dim?: boolean };
          if (d?.dim) return "#e2e8f0";
          if (d?.risk === "danger") return "#ef4444"; if (d?.risk === "caution") return "#f59e0b";
          return d?.kind === "token" ? "#6366f1" : d?.kind === "protocol" ? "#0ea5e9" : d?.kind === "vault" ? "#a855f7" : d?.kind === "bridge" ? "#0d9488" : "#94a3b8";
        }}
        maskColor="rgba(246,248,251,0.65)"
      />
      <Panel position="top-right" className="!m-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/75 px-2 py-1.5 text-[9px] shadow-sm backdrop-blur">
        <div className="flex flex-col gap-0.5">
          <Lg c="#0ea5e9" t="프로토콜" /><Lg c="#38bdf8" t="마켓" /><Lg c="#a855f7" t="볼트" /><Lg c="#0d9488" t="🌉 브릿지 (검증 메커니즘)" />
          <span className="my-0.5 h-px bg-[var(--color-border-subtle)]" />
          {mode === "baseline" ? (
            <>
              <span className="text-[8px] uppercase tracking-wide text-[var(--color-text-muted)]">평소 모드 · 입자 색 = 선택 토큰 · 밀도·크기 = $/h</span>
              {[...colorByToken].map(([sym, c]) => <Lg key={sym} c={c} t={sym} />)}
              <Lg c="#94a3b8" t="파생/LP 토큰 (회색)" />
              <span className="text-[var(--color-text-secondary)]">차선: 정방향 = 유입 · 역방향 = 유출 (실측 평균)</span>
              <span className="text-[var(--color-text-muted)]">반투명 입자 = DEX 일거래량 기반 (방향 미상)</span>
              <span className="text-[var(--color-text-secondary)]">엣지 클릭 = 평소 유입/유출 거래액·거래수</span>
            </>
          ) : (
            <>
              <span className="text-[8px] uppercase tracking-wide text-[var(--color-text-muted)]">트랜잭션 · 색 = 선택 토큰 · 알 크기=거래액</span>
              {[...colorByToken].map(([sym, c]) => <Lg key={sym} c={c} t={sym} />)}
              <Lg c="#94a3b8" t="파생/LP 토큰 (회색)" />
            </>
          )}
          <span className="my-0.5 h-px bg-[var(--color-border-subtle)]" />
          <span className="text-[var(--color-text-secondary)]">토큰→프로토콜 = 예치·스왑 유입</span>
          <span className="text-[var(--color-text-secondary)]">프로토콜→토큰 = 출금·스왑 유출</span>
          <span className="text-[var(--color-text-muted)]">실선 두 줄 = 양방향 흐름 차선 · 점선 = 관계만</span>
          <Lg c="#16a34a" t="파생/발행 (기초↔랩·LP 토큰)" />
          <span className="text-[var(--color-text-muted)]">─o─ = 오라클 의존 · <b style={{ color: "#dc2626" }}>빨강!</b> = 자기참조/NAV</span>
          <span style={{ color: "#c026d3" }}>┈◆┈→ <b>발견</b>(퓨샤·N마커) = 흐름이 찾은 새 연결</span>
          {activity
            ? <span className="text-[var(--color-text-muted)]">트랜잭션 없는 노드·엣지는 숨김 — 흐름이 생기면 같은 자리에 다시 표시</span>
            : <span className="text-[var(--color-text-muted)]">트랜잭션 없음 — 구조 전체를 흐릿하게 표시</span>}
          <span className="flex items-center gap-1 text-[var(--color-text-muted)]"><span className="size-2 rounded-full" style={{ border: "1.5px dashed #94a3b8" }} />점선 외곽 = 흐름 측정 미지원(어댑터 없음 — 회색≠조용함)</span>
          <span className="text-[var(--color-text-muted)]">노드를 끌면 이어진 노드가 딸려옵니다</span>
          <button onClick={relayout} className="mt-1 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
            ↺ 정렬 초기화 (드래그 위치 리셋)
          </button>
        </div>
      </Panel>
      {mode === "baseline"
        ? <BaselineFlowLayer nodes={positioned} edges={graph.edges} colorByToken={colorByToken} />
        : txs.length > 0 && <TxFlowLayer nodes={positioned} edges={graph.edges} txs={txs} colorByToken={colorByToken} />}
    </ReactFlow>
  );
}

export function FlowGraph(props: {
  graph: FlowGraphData; mode: FlowMode; chainsOrder: string[]; selectedTokens: string[];
  selectedId: string | null; onSelectNode: (id: string) => void; onSelectEdge: (id: string) => void;
  txs: FlowTx[]; activity: FlowActivity | null;
}) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

function Lg({ c, t }: { c: string; t: string }) {
  return <span className="flex items-center gap-1 text-[var(--color-text-secondary)]"><span className="size-2 rounded-full" style={{ background: c }} />{t}</span>;
}
