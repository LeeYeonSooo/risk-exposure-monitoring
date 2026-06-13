"use client";

import { useMemo } from "react";
import { ViewportPortal } from "@xyflow/react";

import type { FlowEdge } from "@/lib/flow-types";

interface PNode { id: string; x: number; y: number; radius: number; kind: string; chain: string; label: string; protocol?: string }

/**
 * 평소 모드 입자 레이어 — 개별 트랜잭션이 아니라 **평소 레이트의 시각화**.
 * 라이브 모드와 같은 문법: **색 = 토큰**, 차선 = 방향(위 차선 정방향 = 유입, 아래 차선 역방향 = 유출),
 * 밀도·크기 ∝ 평소 시간당 흐름($/h). 거래량 기반(DEX 일거래량 — 방향 미상)은 같은 토큰 색의
 * **반투명** 입자가 양 차선을 돈다 (실측 평균과 구분 — 지어내지 않음).
 * 기하는 FloatingFlowEdge/TxFlowLayer 와 동일 공식 — 입자가 그려진 선 위에 정확히 앉는다.
 */

const LANE = 2.6;            // must match FloatingFlowEdge LANE
const MAX_EDGES = 150;       // 입자를 띄우는 엣지 상한 (usd/h 상위)
const MAX_LANES_PER_EDGE = 4; // 엣지당 차선 스펙 상한 (토큰 多 엣지 과밀 방지 — 레이트 큰 순)
const FALLBACK = "#94a3b8";  // 선택 토큰 외(파생/LP)는 회색 — 라이브와 동일

function dotCount(usdPerHour: number): number {
  // $10k/h→1, $1M/h→2, $100M/h→4 (log 스케일 — 평소 양의 상대 비교가 목적)
  return Math.max(1, Math.min(4, Math.floor(Math.log10(usdPerHour + 1) / 2)));
}
function dotR(usdPerHour: number): number {
  return Math.max(2.2, Math.min(6, 1.2 + Math.log10(usdPerHour + 10) * 0.55));
}

export function BaselineFlowLayer({ nodes, edges, colorByToken }: { nodes: PNode[]; edges: FlowEdge[]; colorByToken: Map<string, string> }) {
  const dots = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    const lanePath = (e: FlowEdge, forward: boolean): string => {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (!s || !t) return "";
      const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const x1 = s.x + ux * (s.radius + 1), y1 = s.y + uy * (s.radius + 1);
      const x2 = t.x - ux * (t.radius + 2), y2 = t.y - uy * (t.radius + 2);
      const long = e.kind === "bridge" || e.kind === "sibling";
      const relation = long || e.kind === "involves" || e.kind === "oracle" || e.kind === "trace";
      const curve = long ? Math.min(130, len * 0.18) : Math.min(26, len * 0.07);
      const mx = (x1 + x2) / 2 - uy * curve, my = (y1 + y2) / 2 + ux * curve;
      const sign = relation ? 0 : forward ? 1 : -1, ox = uy * LANE * sign, oy = -ux * LANE * sign;
      return `M ${x1 + ox} ${y1 + oy} Q ${mx + ox} ${my + oy} ${x2 + ox} ${y2 + oy}`;
    };

    const flowEdges = edges
      .filter((e) => e.baseline && (e.kind === "holds" || e.kind === "market" || e.kind === "vault" || e.kind === "trace" || e.kind === "derive"))
      .sort((a, b) => (b.baseline!.usdPerHour) - (a.baseline!.usdPerHour))
      .slice(0, MAX_EDGES);

    const out: { d: string; kp: string; color: string; op: number; r: number; dur: number; begin: number; key: string }[] = [];
    let i = 0;
    for (const e of flowEdges) {
      const b = e.baseline!;
      // 토큰별 차선 스펙 — 색 = 토큰 (라이브와 동일 팔레트), 차선 = 방향, 반투명 = 거래량 기반(방향 미상)
      const lanes: { rate: number; forward: boolean; color: string; op: number; tag: string }[] = [];
      for (const [sym, v] of Object.entries(b.byToken ?? {})) {
        const color = colorByToken.get(sym) ?? FALLBACK;
        if (v.inUsdPerHour > 0) lanes.push({ rate: v.inUsdPerHour, forward: true, color, op: 0.9, tag: `${sym}-in` });
        if (v.outUsdPerHour > 0) lanes.push({ rate: v.outUsdPerHour, forward: false, color, op: 0.9, tag: `${sym}-out` });
        if (v.volPerHour > 0) {
          lanes.push({ rate: v.volPerHour / 2, forward: true, color, op: 0.45, tag: `${sym}-vf` }, { rate: v.volPerHour / 2, forward: false, color, op: 0.45, tag: `${sym}-vr` });
        }
      }
      if (!lanes.length) { lanes.push({ rate: b.usdPerHour / 2, forward: true, color: FALLBACK, op: 0.5, tag: "f" }, { rate: b.usdPerHour / 2, forward: false, color: FALLBACK, op: 0.5, tag: "r" }); }
      lanes.sort((a, c) => c.rate - a.rate);
      for (const lane of lanes.slice(0, MAX_LANES_PER_EDGE)) {
        const n = dotCount(lane.rate);
        const r = dotR(lane.rate);
        const dur = Math.max(2.6, 6.5 - Math.log10(lane.rate + 10) * 0.35); // 흐름이 클수록 약간 빠르게
        for (let k = 0; k < n; k++) {
          const d = lanePath(e, lane.forward);
          if (!d) continue;
          out.push({ d, kp: lane.forward ? "0;1" : "1;0", color: lane.color, op: lane.op, r, dur, begin: -((k / n) * dur) - (i % 7) * 0.35, key: `${e.id}-${lane.tag}-${k}` });
        }
      }
      i++;
    }
    return out;
  }, [nodes, edges, colorByToken]);

  return (
    <ViewportPortal>
      {/* zIndex 0 = 엣지 위, 노드 아래 (TxFlowLayer 와 동일 레이어링) */}
      <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", pointerEvents: "none", zIndex: 0 }}>
        {dots.map((d) => (
          <circle key={d.key} r={d.r} fill={d.color} opacity={d.op} stroke="#fff" strokeWidth={0.6}>
            <animateMotion dur={`${d.dur}s`} begin={`${d.begin}s`} repeatCount="indefinite" path={d.d} keyPoints={d.kp} keyTimes="0;1" calcMode="linear" />
          </circle>
        ))}
      </svg>
    </ViewportPortal>
  );
}
