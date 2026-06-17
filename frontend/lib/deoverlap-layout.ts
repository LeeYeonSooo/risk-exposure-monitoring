/**
 * 동심원 겹침 제거 — 동심원/오버레이가 만든 좌표는 거의 그대로 두되, **겹치는 노드만** 살짝 밀어
 * 분리한다(원래 자리 앵커 + 노드 크기 충돌). 토큰(중심)은 고정. 링 구조·가지 정렬은 유지.
 *
 * 왜 force 전체 재배치(organic)가 아니라 이 방식인가: 사용자는 동심원 구조를 원함. 그래서 위치를
 * 강하게 원래 자리로 당기고(anchor) 충돌만 풀어 "동심원 그대로 + 안 겹침"을 만든다.
 */
import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";

import type { GraphNode, TopologyResponse } from "./api";

interface DN extends SimulationNodeDatum { id: string; ox: number; oy: number; dia: number; ring: boolean }

// 동심원 링을 정의하는 "구조 노드"(토큰 중심 + 링1 프로토콜)는 거의 안 움직이게 강하게 앵커한다.
//   이걸 흐르게 두면 큰 프로토콜(연결성 부스트로 큼)이 충돌로 링을 흩트려 나선/지터처럼 보인다.
//   마켓·볼트·파생(leaf)만 약하게 앵커해 겹침을 푼다 → "깨끗한 동심원 + 안 겹침".
const isRingProto = (id: string) => /^c:[^:]+:protocol:/.test(id) && !/:m\d+$/.test(id);

// 노드 렌더 지름 근사(RiskNode 와 동일 규칙) — 충돌 반경용. share 기반 diameterPx × 연결성 boost.
function estDiameter(n: GraphNode): number {
  const boost = (n.metadata.connImportance as number | undefined) ?? 1;
  const base =
    n.type === "Token"
      ? 86
      : (n.metadata.diameterPx as number | undefined) ??
        (n.type === "Bridge" ? 60 : n.type === "DerivativeToken" ? 40 : 54);
  return base * boost;
}

export function deOverlapConcentric(topology: TopologyResponse): TopologyResponse {
  const nodes = topology.nodes;
  if (nodes.length < 3) return topology;
  const token = nodes.find((n) => /^c:[^:]+:token$/.test(n.id)) ?? nodes.find((n) => n.type === "Token");

  const dia = new Map<string, number>();
  const sim: DN[] = [];
  for (const n of nodes) {
    if (!n.position) continue;
    const d = estDiameter(n);
    dia.set(n.id, d);
    const isRing = isRingProto(n.id);
    // ★중심좌표 산출★ — 링1 프로토콜은 concentric position 이 "링 위의 점"(노드를 중심정렬할 자리)이다.
    //   그래서 그대로 중심으로 쓴다 → 부스트로 박스가 커져도 그 점에 정확히 센터링(아래 출력에서 -d/2).
    //   (concentric 이 프로토콜만 position 에 -diameterPx/2 를 안 해 박스가 링점 기준 우하향으로 밀렸던 것 보정 —
    //    큰 지배 프로토콜일수록 더 밀려 원이 찌그러져 보였다.) 그 외 노드는 position 이 top-left 라 +d/2.
    const cx = isRing ? n.position.x : n.position.x + d / 2;
    const cy = isRing ? n.position.y : n.position.y + d / 2;
    // 토큰(중심)과 링1 프로토콜은 완전 고정(fx/fy) → 동심원 링이 충돌力에 안 흔들림. 마켓·볼트·파생만 움직여 겹침 해소.
    const pin = n === token || isRing;
    sim.push({ id: n.id, x: cx, y: cy, ox: cx, oy: cy, dia: d, ring: isRing, ...(pin ? { fx: cx, fy: cy } : {}) } as DN);
  }
  if (sim.length < 3) return topology;

  const s = forceSimulation(sim)
    // leaf(마켓/볼트/파생)만 원래 자리로 약하게 당김 — 링(고정)을 기준으로 겹침만 풀림. 링 노드는 fx/fy 라 안 움직임.
    .force("ax", forceX<DN>((d) => d.ox).strength(0.4))
    .force("ay", forceY<DN>((d) => d.oy).strength(0.4))
    // 노드 크기만큼 충돌 반경 → 겹치면 밀어냄 (라벨 여유 포함)
    .force("collide", forceCollide<DN>((d) => d.dia / 2 + 16).strength(0.95).iterations(3))
    .alphaDecay(0.035)
    .stop();
  for (let i = 0; i < 160; i++) s.tick();

  const posById = new Map(sim.map((d) => [d.id, { x: d.x ?? d.ox, y: d.y ?? d.oy }] as const));
  const newNodes = nodes.map((n) => {
    const p = posById.get(n.id);
    if (!p) return n;
    const d = dia.get(n.id)!;
    return { ...n, position: { x: p.x - d / 2, y: p.y - d / 2 } }; // 중심 → 좌상단
  });
  return { ...topology, nodes: newNodes };
}
