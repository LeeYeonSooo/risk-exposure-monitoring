"use client";

import { useMemo, useEffect } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

/**
 * 단일 토큰 의존성 그래프 — dep-engine(재귀 크롤러) 산출물을 depth/tier 컬럼으로 렌더.
 * 좌→우: [토큰] → [직접 노출 프로토콜(depth0)] → [한 단계 깊은 의존(depth1+)].
 * 엣지에 관계 설명(역할·수량) 라벨을 얹어, 큐레이터가 한 화면에서 읽어내려가게 한다.
 * (ChainSpiral dep-engine 의 OverviewCanvas depth-column 방식을 우리 디자인으로 이식.)
 */

type RawNode = { id: string; type: string; label: string; data?: Record<string, unknown> };
type RawEdge = { id: string; source: string; target: string; label?: string; edge_type?: string };

const FLOW = new Set(["morpho", "compound_v3", "restake", "transformed", "lending", "vault", "cdp"]);

const EDGE_COLOR: Record<string, string> = {
  collateral: "#60a5fa", lending: "#38bdf8", morpho: "#60a5fa", vault: "#c084fc",
  wrapper: "#a3a3a3", restake: "#f472b6", transformed: "#fb923c", cdp: "#facc15",
  dex: "#34d399", oracle: "#fbbf24", issued_by: "#f472b6", eigenlayer: "#f472b6",
  kelp: "#fb923c", maker: "#facc15", holds: "#475569", compound_v3: "#34d399",
};

const KIND_BG: Record<string, string> = {
  token: "var(--color-accent)",
  "ledger:aave_v3": "#0369a1", "ledger:morpho": "#1d4ed8", "ledger:eigenlayer": "#be185d",
  "ledger:kelp": "#c2410c", "ledger:maker": "#a16207", "ledger:compound_v3": "#15803d",
  aToken: "#0369a1", erc4626_vault: "#7c3aed", erc20_receipt: "#475569",
  EOA: "#334155", safe: "#3f3f46", opaque: "#52525b", contract: "#334155",
};

function fmtUsd(v: unknown): string {
  const n = typeof v === "number" ? v : NaN;
  if (!isFinite(n)) return "";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function nodeLabel(n: RawNode): string {
  if (n.type === "token") return n.label;
  const usd = fmtUsd(n.data?.tokens_held_usd);
  return usd ? `${n.label}  ·  ${usd}` : n.label;
}

const COL = 340;
const GAP = 92;

export function DepGraphCanvas({
  nodes,
  edges,
  onSelect,
}: {
  nodes: RawNode[];
  edges: RawEdge[];
  onSelect?: (id: string, node: RawNode | null) => void;
}) {
  const { layoutNodes, layoutEdges, columns } = useMemo(() => {
    const depthOf = (n: RawNode): number =>
      n.type === "token" ? -1 : typeof n.data?.depth === "number" ? (n.data!.depth as number) : 0;
    const byDepth = new Map<number, RawNode[]>();
    for (const n of nodes) {
      const d = depthOf(n);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(n);
    }
    const maxCol = Math.max(...[...byDepth.values()].map((a) => a.length), 1);
    const colH = maxCol * GAP;
    const depths = [...byDepth.keys()].sort((a, b) => a - b);

    const rfNodes: Node[] = [];
    depths.forEach((d) => {
      const arr = byDepth
        .get(d)!
        .slice()
        .sort((a, b) => (Number(b.data?.tokens_held_usd ?? 0) - Number(a.data?.tokens_held_usd ?? 0)));
      const x = 40 + (d + 1) * COL;
      arr.forEach((n, i) => {
        const approx = Boolean(n.data?.approx);
        const kind = String(n.data?.category ?? n.type);
        const isToken = n.type === "token";
        rfNodes.push({
          id: n.id,
          position: { x, y: i * GAP + (colH - arr.length * GAP) / 2 },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: { label: nodeLabel(n), raw: n },
          style: {
            background: KIND_BG[kind] ?? "var(--color-surface-raised)",
            color: "#e5e7eb",
            border: approx
              ? "1px dashed var(--color-caution)"
              : isToken
                ? "2px solid #fff"
                : "1px solid rgba(255,255,255,0.18)",
            borderRadius: 12,
            padding: isToken ? "12px 16px" : "9px 13px",
            fontSize: isToken ? 14 : 12,
            fontWeight: isToken ? 700 : 500,
            width: 260,
            textAlign: "left",
            boxShadow: isToken ? "0 0 0 4px rgba(124,109,255,0.25)" : "none",
          },
        });
      });
    });

    const layoutEdges: Edge[] = edges.map((e) => {
      const color = EDGE_COLOR[e.edge_type ?? ""] ?? "#475569";
      const flow = FLOW.has(e.edge_type ?? "");
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: flow,
        style: { stroke: color, strokeWidth: flow ? 2.2 : 1.5 },
        labelStyle: { fontSize: 10, fill: "#cbd5e1", fontWeight: 500 },
        labelBgStyle: { fill: "#0b0f17", fillOpacity: 0.82 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 4,
      };
    });

    // 컬럼 헤더 (tier 의미 부여)
    const colLabels: Record<number, string> = {
      [-1]: "토큰",
      0: "직접 노출 — 프로토콜·역할",
      1: "한 단계 깊은 의존",
      2: "2-hop",
      3: "3-hop",
    };
    const columns = depths.map((d) => ({ x: 40 + (d + 1) * COL, label: colLabels[d] ?? `depth ${d}` }));

    return { layoutNodes: rfNodes, layoutEdges, columns };
  }, [nodes, edges]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(layoutNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(layoutEdges);
  useEffect(() => setRfNodes(layoutNodes), [layoutNodes, setRfNodes]);
  useEffect(() => setRfEdges(layoutEdges), [layoutEdges, setRfEdges]);

  return (
    <div className="relative h-full w-full bg-[var(--color-bg)]">
      {/* 컬럼 헤더 — depth=tier 의미 */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 flex">
        {columns.map((c) => (
          <div
            key={c.x}
            className="absolute text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
            style={{ left: c.x, top: 8 }}
          >
            {c.label}
          </div>
        ))}
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => onSelect?.(n.id, (n.data as { raw?: RawNode })?.raw ?? null)}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
      >
        <Background variant={BackgroundVariant.Dots} color="#1e293b" gap={26} />
        <Controls />
        <MiniMap pannable zoomable maskColor="rgba(0,0,0,0.6)" />
      </ReactFlow>
    </div>
  );
}
