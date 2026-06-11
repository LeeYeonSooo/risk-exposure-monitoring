"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  type Edge, type Node, type NodeMouseHandler, useEdgesState, useNodesState, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";

import { FloatingFlowEdge } from "./FloatingFlowEdge";
import { FlowNodeShell } from "./FlowNodes";
import { TxFlowLayer } from "./TxFlowLayer";
import { LINK_DIST, LINK_STR, radiusOf, seedPositions } from "@/lib/flow-layout";
import type { FlowGraph as FlowGraphData, FlowMode, FlowTx, RiskLevel } from "@/lib/flow-types";

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

interface SimNode extends SimulationNodeDatum { id: string; r: number; bandX: number; kind: string }

const W = 1800, H = 1100;

function Inner({
  graph, mode, chainsOrder, selectedId, onSelectNode, onSelectEdge, txs,
}: {
  graph: FlowGraphData; mode: FlowMode; chainsOrder: string[];
  selectedId: string | null; onSelectNode: (id: string) => void; onSelectEdge: (id: string) => void; txs: FlowTx[];
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  const simNodesRef = useRef<Map<string, SimNode>>(new Map());
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const draggingRef = useRef<string | null>(null);
  const firstBuildRef = useRef(true);

  const graphKey = useMemo(
    () => graph.nodes.map((n) => n.id).join(",") + "|" + chainsOrder.join(","),
    [graph, chainsOrder],
  );

  // ── build + run the live simulation (rebuild only when node set / chains change) ──
  useEffect(() => {
    const multi = chainsOrder.length > 1;
    // spread the layout as the node count grows so many-token views don't collapse into a hairball
    const spread = Math.max(1, Math.sqrt(graph.nodes.length / 22));
    const bandX = (chain: string) => (multi ? ((Math.max(0, chainsOrder.indexOf(chain)) + 0.5) / chainsOrder.length) * W : W / 2);
    const seed = seedPositions(graph, chainsOrder, W, H);
    const rById = new Map(graph.nodes.map((n) => [n.id, radiusOf(n)] as const));

    const simNodes: SimNode[] = graph.nodes.map((n) => {
      const prev = posRef.current.get(n.id) ?? seed.get(n.id) ?? { x: W / 2, y: H / 2 };
      return { id: n.id, r: rById.get(n.id) ?? 12, bandX: bandX(n.chain), kind: n.kind, x: prev.x, y: prev.y };
    });
    const byId = new Map(simNodes.map((s) => [s.id, s] as const));
    simNodesRef.current = byId;

    const links: (SimulationLinkDatum<SimNode> & { ek: string })[] = [];
    for (const e of graph.edges) {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (!s || !t) continue;
      // 토큰→브릿지 노드 부착 엣지는 짧게 (체인간 bridge 엣지의 260px 와 구분)
      const ek = e.kind === "bridge" && e.target.startsWith("bridge:") ? "vault" : e.kind;
      links.push({ source: s, target: t, ek });
    }

    // initial RF nodes
    setNodes(graph.nodes.map((n) => {
      const s = byId.get(n.id)!;
      return {
        id: n.id, type: "flow",
        position: { x: (s.x ?? 0) - s.r, y: (s.y ?? 0) - s.r },
        // zIndex 1 > 입자 svg(zIndex 0) — 트랜잭션 알이 노드 원 위를 가로지르지 않고 아래로 지나간다
        zIndex: 1,
        data: { ...n, radius: s.r }, draggable: true, selected: n.id === selectedId,
      } as Node;
    }));

    const sim = forceSimulation(simNodes)
      .force("link", forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => (d as SimNode).id)
        .distance((l) => (LINK_DIST[(l as unknown as { ek: keyof typeof LINK_DIST }).ek] ?? 90) * spread)
        .strength((l) => LINK_STR[(l as unknown as { ek: keyof typeof LINK_STR }).ek] ?? 0.3))
      .force("charge", forceManyBody<SimNode>().strength((d) => (-(d.r * d.r) * 1.1 - 90) * spread).distanceMax(1100 * spread))
      .force("collide", forceCollide<SimNode>().radius((d) => d.r * spread * 0.5 + d.r + 12).strength(0.96))
      .force("x", forceX<SimNode>((d) => d.bandX).strength(multi ? 0.16 : 0.025))
      .force("y", forceY<SimNode>(H / 2).strength(0.03))
      // 첫 빌드만 강하게 풀고, 이후(30초 폴마다 실거래 핀 노드가 들고나는 재빌드)는 살짝만 —
      // 화면 전체가 주기적으로 출렁이지 않게. 기존 노드 위치는 posRef 로 보존됨.
      .alpha(firstBuildRef.current ? 0.9 : 0.25).alphaDecay(0.028);

    sim.on("tick", () => {
      for (const s of simNodes) posRef.current.set(s.id, { x: s.x ?? 0, y: s.y ?? 0 });
      setNodes((prev) => prev.map((n) => {
        const s = byId.get(n.id); if (!s) return n;
        return { ...n, position: { x: (s.x ?? 0) - s.r, y: (s.y ?? 0) - s.r } };
      }));
    });
    simRef.current = sim;
    // fitView 는 첫 빌드에만 — 핀 노드 변동 때마다 사용자의 팬/줌을 리셋하지 않는다
    const doFit = firstBuildRef.current;
    firstBuildRef.current = false;
    const fitT = doFit ? setTimeout(() => fitView({ padding: 0.16, duration: 600 }).catch(() => {}), 900) : null;
    return () => { if (fitT) clearTimeout(fitT); sim.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey]);

  // ── edges (re-derive on mode / risk change, not on tick) ──
  useEffect(() => {
    const riskOf = new Map(graph.nodes.map((n) => [n.id, n.risk ?? "safe"] as const));
    setEdges(graph.edges.map((e) => {
      const sr = riskOf.get(e.source) ?? "safe", tr = riskOf.get(e.target) ?? "safe";
      const risk = RISK_RANK[sr] >= RISK_RANK[tr] ? sr : tr;
      return {
        id: e.id, source: e.source, target: e.target, type: "flow",
        data: { kind: e.kind, weight: e.weight, tvlUsd: e.tvlUsd, mode, dir: e.dir ?? "both", label: e.label, risk: risk === "safe" ? undefined : risk, oracle: e.oracle, trace: e.trace },
        selected: e.id === selectedId, zIndex: 0,
      } as Edge;
    }));
  }, [graph, mode, selectedId, setEdges]);

  // ── selection highlight on nodes (no reposition) ──
  useEffect(() => {
    setNodes((prev) => prev.map((n) => (n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId })));
  }, [selectedId, setNodes]);

  // ── drag-to-pull: pin dragged node, reheat so neighbors follow ──
  const onNodeDragStart: NodeMouseHandler = useCallback((_, node) => {
    const s = simNodesRef.current.get(node.id); if (!s) return;
    draggingRef.current = node.id;
    s.fx = node.position.x + s.r; s.fy = node.position.y + s.r;
    simRef.current?.alphaTarget(0.3).restart();
  }, []);
  const onNodeDrag: NodeMouseHandler = useCallback((_, node) => {
    const s = simNodesRef.current.get(node.id); if (!s) return;
    s.fx = node.position.x + s.r; s.fy = node.position.y + s.r;
  }, []);
  const onNodeDragStop: NodeMouseHandler = useCallback((_, node) => {
    const s = simNodesRef.current.get(node.id); if (s) { s.fx = null; s.fy = null; }
    draggingRef.current = null;
    simRef.current?.alphaTarget(0);
  }, []);

  const positioned = useMemo(
    () => graph.nodes.map((n) => { const p = posRef.current.get(n.id) ?? { x: W / 2, y: H / 2 }; return { ...n, x: p.x, y: p.y, radius: radiusOf(n) }; }),
    // recompute when nodes move enough — tie to nodes state length + graphKey + a coarse tick via mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graphKey, nodes],
  );

  // per-token particle colour (selected/graph token symbols → palette) — distinguishes each token's flow
  const colorByToken = useMemo(() => {
    const syms = [...new Set(graph.nodes.filter((n) => n.kind === "token").map((n) => n.label.toUpperCase()))].sort();
    return new Map(syms.map((s, i) => [s, tokenColor(i, syms.length)] as const));
  }, [graph]);

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
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
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
          const r = (n.data as { risk?: RiskLevel })?.risk; const k = (n.data as { kind?: string })?.kind;
          if (r === "danger") return "#ef4444"; if (r === "caution") return "#f59e0b";
          return k === "token" ? "#6366f1" : k === "protocol" ? "#0ea5e9" : k === "vault" ? "#a855f7" : k === "bridge" ? "#0d9488" : "#94a3b8";
        }}
        maskColor="rgba(246,248,251,0.65)"
      />
      <Panel position="top-right" className="!m-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/75 px-2 py-1.5 text-[9px] shadow-sm backdrop-blur">
        <div className="flex flex-col gap-0.5">
          <Lg c="#0ea5e9" t="프로토콜" /><Lg c="#38bdf8" t="마켓" /><Lg c="#a855f7" t="볼트" /><Lg c="#0d9488" t="🌉 브릿지 (검증 메커니즘)" />
          <span className="my-0.5 h-px bg-[var(--color-border-subtle)]" />
          <span className="text-[8px] uppercase tracking-wide text-[var(--color-text-muted)]">트랜잭션 · 토큰별 색 · 알 크기=거래액</span>
          {[...colorByToken].map(([sym, c]) => <Lg key={sym} c={c} t={sym} />)}
          <span className="my-0.5 h-px bg-[var(--color-border-subtle)]" />
          <span className="text-[var(--color-text-secondary)]">토큰→프로토콜 = 예치·스왑 유입</span>
          <span className="text-[var(--color-text-secondary)]">프로토콜→토큰 = 출금·스왑 유출</span>
          <span className="text-[var(--color-text-muted)]">실선 두 줄 = 양방향 흐름 차선 · 점선 = 관계만</span>
          <span className="text-[var(--color-text-muted)]">─o─ = 오라클 의존 · <b style={{ color: "#dc2626" }}>빨강!</b> = 자기참조/NAV</span>
          <span style={{ color: "#c026d3" }}>┈◆┈→ <b>발견</b>(퓨샤·N마커) = 이벤트가 찾은 새 연결</span>
        </div>
      </Panel>
      {txs.length > 0 && <TxFlowLayer nodes={positioned} edges={graph.edges} txs={txs} colorByToken={colorByToken} />}
    </ReactFlow>
  );
}

export function FlowGraph(props: {
  graph: FlowGraphData; mode: FlowMode; chainsOrder: string[];
  selectedId: string | null; onSelectNode: (id: string) => void; onSelectEdge: (id: string) => void; txs: FlowTx[];
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
