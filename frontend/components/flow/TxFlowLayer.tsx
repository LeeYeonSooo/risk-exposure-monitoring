"use client";

import { useMemo } from "react";
import { ViewportPortal } from "@xyflow/react";

import { bowedMidpoint } from "./FloatingFlowEdge";
import { buildRenderPlan, MAX_RENDER_HOPS } from "@/lib/flow-match";
import type { FlowEdge, FlowTx } from "@/lib/flow-types";

interface PNode { id: string; x: number; y: number; radius: number; kind: string; chain: string; label: string; protocol?: string; address?: string }

/** tx→hop 라우터 시그니처. 기본은 흐름맵의 buildRenderPlan(토큰→프로토콜→마켓→볼트). 브릿지 뷰는
 *  buildBridgeRenderPlan(체인↔브릿지 통로)을 주입해 같은 입자 렌더를 재사용한다. */
type PlanBuilder = (nodes: PNode[], edges: FlowEdge[], txs: FlowTx[], maxHops: number) => { tx: FlowTx; hops: [PNode, PNode][] }[];

/**
 * Transaction-flow overlay. Particles ride the REAL edges — nothing floats in the air.
 *
 *   • Only transactions that actually touched a graph node (protocol/market/vault, resolved from the
 *     real transfer chain) are shown. Each rides the EXACT edge lane (same geometry as the drawn edge),
 *     boundary→boundary, per hop, staggered — so it visibly travels token→protocol→market→vault.
 *   • Wallet/DEX transfers that touched no graph node are NOT faked onto edges (no ambient spray).
 *   • Direction picks the matching lane (deposit vs withdraw); colour = token; size ∝ real USD value.
 */

const LANE = 2.6;         // must match FloatingFlowEdge LANE
const HOP_STAGGER = 0.5;
// 알 크기 ∝ 실제 USD (log). 최소 3.2px — 가장 작은 트랜잭션도 fitView 줌(≈0.5×)에서 항상 보이게.
function radiusForValue(v: number) { return Math.max(3.2, Math.min(8, 3.2 + Math.max(0, Math.log10(v + 10) - 2) * 0.95)); }

export function TxFlowLayer({ nodes, edges, txs, colorByToken, buildPlan = buildRenderPlan, bowCenter, straight }: { nodes: PNode[]; edges: FlowEdge[]; txs: FlowTx[]; colorByToken: Map<string, string>; buildPlan?: PlanBuilder; bowCenter?: { x: number; y: number }; straight?: boolean }) {
  // 라우팅(plan: 어떤 tx가 어떤 hop을 타는가)은 노드 위치와 무관 — 노드 집합이 같으면 시뮬 tick마다
  // 재계산하지 않는다 (geometry 만 매 tick 갱신).
  const idsKey = useMemo(() => nodes.map((n) => n.id).join(","), [nodes]);
  const plan = useMemo(
    () => buildPlan(nodes, edges, txs, MAX_RENDER_HOPS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey, edges, txs, buildPlan],
  );
  const dots = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    const edgeByPair = new Map<string, FlowEdge>();
    for (const e of edges) { edgeByPair.set(`${e.source}|${e.target}`, e); edgeByPair.set(`${e.target}|${e.source}`, e); }
    // EXACT edge geometry — identical formula to FloatingFlowEdge per edge kind, so the particle
    // sits on the drawn line: flow edges (holds/market/vault) ride the ±LANE directional lane with
    // the short curve; relation edges ride the CENTER path — bridge/sibling with the long curve,
    // involves/oracle with the short curve (matches FloatingFlowEdge exactly).
    const lanePath = (e: FlowEdge, forward: boolean): string => {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (!s || !t) return "";
      const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const x1 = s.x + ux * (s.radius + 1), y1 = s.y + uy * (s.radius + 1);
      const x2 = t.x - ux * (t.radius + 2), y2 = t.y - uy * (t.radius + 2);
      const long = e.kind === "bridge" || e.kind === "sibling";
      const relation = long || e.kind === "involves" || e.kind === "oracle" || e.kind === "trace";
      const bowing = !!bowCenter;
      const curve = straight ? 0 : bowing ? Math.min(260, len * 0.3) : long ? Math.min(130, len * 0.18) : Math.min(26, len * 0.07);
      const { mx, my } = bowedMidpoint(x1, y1, x2, y2, ux, uy, curve, bowCenter?.x, bowCenter?.y);
      const sign = relation ? 0 : forward ? 1 : -1, ox = uy * LANE * sign, oy = -ux * LANE * sign;
      return `M ${x1 + ox} ${y1 + oy} Q ${mx + ox} ${my + oy} ${x2 + ox} ${y2 + oy}`;
    };

    // SHARED, CAP-APPLIED render plan — FlowTxPanel counts plan.length for "그래프 흐름 N건" and we render
    // exactly these hops, so the displayed count ALWAYS equals the animated particle set (no MAX_DOTS skew).
    const out: { d: string; kp: string; color: string; r: number; dur: number; begin: number; key: string }[] = [];
    let i = 0;
    for (const { tx, hops } of plan) {
      // 색 = 선택 토큰만 — 파생/LP 토큰 흐름은 회색 (22색 범례는 사람이 못 읽는다)
      const color = colorByToken.get(tx.token.toUpperCase()) ?? "#94a3b8";
      const r = radiusForValue(tx.valueUsd);
      const baseBegin = (i % 20) * 0.2;
      for (let k = 0; k < hops.length; k++) {
        const [a, b] = hops[k];
        const e = edgeByPair.get(`${a.id}|${b.id}`);
        if (!e) continue;
        const forward = a.id === e.source;       // travel direction vs the edge's stored orientation
        const d = lanePath(e, forward);
        if (!d) continue;
        const s = byId.get(e.source), t = byId.get(e.target);
        const len = s && t ? Math.hypot(t.x - s.x, t.y - s.y) : 200;
        out.push({ d, kp: forward ? "0;1" : "1;0", color, r, dur: 1.6 + Math.min(1.8, len / 360), begin: baseBegin + k * HOP_STAGGER, key: `${tx.hash}-${k}-${i}` });
      }
      i++;
    }
    return out;
  }, [plan, nodes, edges, colorByToken, bowCenter, straight]);

  return (
    <ViewportPortal>
      {/* zIndex 0 = 엣지 위, 노드 아래 — 알이 노드 원 위를 가로지르지 않고 밑으로 지나간다 */}
      <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", pointerEvents: "none", zIndex: 0 }}>
        {dots.map((d) => (
          <circle key={d.key} r={d.r} fill={d.color} opacity={0.95} stroke="#fff" strokeWidth={0.7}>
            <animateMotion dur={`${d.dur}s`} begin={`${d.begin}s`} repeatCount="indefinite" path={d.d} keyPoints={d.kp} keyTimes="0;1" calcMode="linear" />
          </circle>
        ))}
      </svg>
    </ViewportPortal>
  );
}
