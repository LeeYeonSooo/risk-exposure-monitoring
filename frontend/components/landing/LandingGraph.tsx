"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { LandingTxLayer } from "./LandingTxLayer";
import { SAFE_NODE_STATE, type NodeTickState, type RiskLevel } from "@/lib/api";
import type { LandingTopology } from "@/lib/landing-layout";

/**
 * 메인화면 이중 동심원 그래프 — 패널 없음(요구사항):
 *  · 토큰 노드 클릭 → 그 토큰의 관계맵 페이지(/token/[symbol])로 이동
 *  · 프로토콜 노드/엣지 클릭 → 아무 일도 없음
 *  · 입자 = 흐름 급변(flow_anomaly) 토큰만 (LandingTxLayer)
 * 노드 위험색 = 그 토큰/프로토콜의 최근 알림 최고 심각도 (실데이터).
 */
interface AlertLite { severity: string; token: string; protocol_node_id?: string | null }

export function LandingGraph({ topology, alerts, anomalySymbols }: {
  topology: LandingTopology;
  alerts: AlertLite[];
  anomalySymbols: Set<string>;
}) {
  const router = useRouter();

  const nodeStates = useMemo<Record<string, NodeTickState>>(() => {
    const rank: Record<string, number> = { info: 0, warning: 1, critical: 2 };
    const lvl: Record<string, RiskLevel> = {};
    const bump = (id: string, sev: string) => {
      const r = rank[sev] ?? 0;
      const cur = lvl[id] === "danger" ? 2 : lvl[id] === "caution" ? 1 : 0;
      const next = r >= 2 ? "danger" : r >= 1 ? "caution" : lvl[id] ?? "safe";
      if (r > cur || lvl[id] == null) lvl[id] = next as RiskLevel;
    };
    const symToId = new Map<string, string>();
    for (const [id, t] of topology.tokenInfo) symToId.set(t.symbol.toUpperCase(), id);
    for (const a of alerts) {
      const tid = symToId.get((a.token ?? "").toUpperCase());
      if (tid) bump(tid, a.severity);
      if (a.protocol_node_id) {
        // 정확 일치만 — 메인 그래프 노드 id 는 DB protocol_node_id 와 동일 체계
        const pid = a.protocol_node_id.split("@")[0];
        if (topology.nodes.some((n) => n.id === pid)) bump(pid, a.severity);
      }
    }
    const out: Record<string, NodeTickState> = {};
    for (const [id, l] of Object.entries(lvl)) out[id] = { ...SAFE_NODE_STATE, riskLevel: l };
    return out;
  }, [alerts, topology]);

  return (
    <GraphCanvas
      graphKey="landing"
      topology={{ nodes: topology.nodes, edges: topology.edges }}
      nodeStates={nodeStates}
      selectedNodeId={null}
      onSelectNode={(id) => {
        if (!id || !id.startsWith("token:")) return; // 프로토콜 노드 클릭 = 아무 일도 없음
        const sym = topology.tokenInfo.get(id)?.symbol ?? id.replace(/^token:/, "");
        router.push(`/token/${encodeURIComponent(sym)}`);
      }}
      staticLayout
      overlay={<LandingTxLayer edges={topology.edges} tokenInfo={topology.tokenInfo} anomalySymbols={anomalySymbols} />}
    />
  );
}
