"use client";

import { useMemo } from "react";
import { X } from "lucide-react";

import { formatUsd } from "@/lib/api";
import { curatorLabel } from "./FlowNodes";
import type { FlowEdge, FlowGraph as FlowGraphData, FlowNode } from "@/lib/flow-types";

/** Selection detail for the 흐름맵 — rendered as a proper right-side panel (not a floating card). */
const EDGE_KIND_LABEL: Record<FlowEdge["kind"], string> = {
  holds: "예치 / 익스포저", market: "마켓 · 풀", involves: "구성 토큰", vault: "볼트 공급", bridge: "체인간 연결 (브릿지)", sibling: "동일 프로토콜 (타 체인)", oracle: "오라클 의존", trace: "추적 흐름 (Dune 14일)",
};
const kindKo = (k: FlowNode["kind"]) => (k === "token" ? "토큰" : k === "protocol" ? "프로토콜" : k === "market" ? "마켓/풀" : k === "vault" ? "볼트 (큐레이터 운용)" : k === "bridge" ? "브릿지" : "외부 컨트랙트");

function connectionsOf(n: FlowNode, graph: FlowGraphData, byId: Map<string, FlowNode>) {
  const out: { id: string; label: string; usd: number }[] = [];
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind === "oracle") continue; // 오라클 의존선(tvl 0)은 연결 목록의 $0 노이즈가 됨 — 제외
    const other = e.source === n.id ? e.target : e.target === n.id ? e.source : null;
    if (!other || seen.has(other)) continue;
    const o = byId.get(other); if (!o) continue;
    seen.add(other); out.push({ id: other, label: o.label, usd: e.tvlUsd });
  }
  return out.sort((a, b) => b.usd - a.usd).slice(0, 14);
}

export function FlowDetail({ sel, graph, onClose, onPick }: {
  sel: { type: "node" | "edge"; id: string };
  graph: FlowGraphData;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n] as const)), [graph]);
  const node = sel.type === "node" ? byId.get(sel.id) ?? null : null;
  const edge = sel.type === "edge" ? graph.edges.find((e) => e.id === sel.id) ?? null : null;
  const conns = useMemo(() => (node ? connectionsOf(node, graph, byId) : []), [node, graph, byId]);
  // 프로토콜이 보는 오라클 수 = 그 프로토콜 마켓들의 오라클 엣지 distinct 수 (실데이터 집계)
  const oracleCount = useMemo(() => {
    if (!node || node.kind !== "protocol") return 0;
    const feeds = new Set<string>();
    for (const e of graph.edges) {
      if (e.kind !== "oracle") continue;
      const src = byId.get(e.source);
      if (src?.protocol === node.protocol && src?.chain === node.chain) feeds.add(e.label ?? e.id);
    }
    return feeds.size;
  }, [node, graph, byId]);
  if (!node && !edge) return null;

  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between">
        {node ? (
          <div>
            <div className="text-[15px] font-bold text-[var(--color-text-primary)]">{node.label}</div>
            <div className="text-[11px] capitalize text-[var(--color-text-muted)]">{kindKo(node.kind)} · {node.chain}{node.protocol && node.kind !== "protocol" ? ` · ${node.protocol}` : ""}</div>
          </div>
        ) : edge ? (
          <div>
            <div className="text-[13px] font-bold text-[var(--color-text-primary)]">{byId.get(edge.source)?.label ?? edge.source} <span className="text-[var(--color-text-muted)]">↔</span> {byId.get(edge.target)?.label ?? edge.target}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">{EDGE_KIND_LABEL[edge.kind]} · {edge.chain}</div>
          </div>
        ) : null}
        <button onClick={onClose} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"><X size={15} /></button>
      </div>

      <div className="mt-3 space-y-1.5 text-[12px]">
        {node && <>
          {node.tvlUsd > 0 && <Row k="TVL" v={formatUsd(node.tvlUsd)} />}
          {node.sharePct != null && <Row k="비중" v={`${(node.sharePct * 100).toFixed(1)}%`} />}
          {node.risk && node.risk !== "safe" && <Row k="리스크" v={node.risk === "danger" ? "위험 (알림)" : "주의"} danger={node.risk === "danger"} />}
          {node.meta?.category != null && <Row k="분류" v={String(node.meta.category)} />}
          {oracleCount > 0 && <Row k="오라클" v={`표시 마켓 기준 ${oracleCount}개 피드`} />}
          {node.meta?.chainSupplyUsd != null && <Row k="온체인 공급" v={formatUsd(Number(node.meta.chainSupplyUsd))} />}
          {node.kind === "bridge" && <>
            <Row k="메커니즘" v={node.meta?.mechanism ? String(node.meta.mechanism) : "미확인 (온체인 권한 미검증)"} danger={!node.meta?.mechanism} />
            {node.meta?.fromChain != null && <Row k="구간" v={`${String(node.meta.fromChain)} ↔ ${String(node.meta.toChain)}`} />}
            {node.meta?.note != null && <div className="pt-1 text-[10.5px] leading-snug text-[var(--color-text-muted)]">{String(node.meta.note)}</div>}
            <div className="pt-1 text-[10px] leading-snug text-[var(--color-text-muted)]">검증된 mint 권한(bridge_authorities 온체인 직독) 기준. 번&민트는 메시지층 침해 시 무담보 민팅 위험 — 라이브 트랜잭션이 이 노드를 경유하며 락/민팅 활동이 보입니다.</div>
          </>}
          {node.meta?.curator != null && <Row k="큐레이터" v={curatorLabel(node.meta.curator)} />}
          {node.meta?.lltv != null && <Row k="LLTV" v={`${(Number(node.meta.lltv) * 100).toFixed(1)}%`} />}
          {node.meta?.apy != null && <Row k="APY" v={`${Number(node.meta.apy).toFixed(2)}%`} />}
          {node.meta?.utilization != null && <Row k="이용률" v={`${(Number(node.meta.utilization) * 100).toFixed(1)}%`} />}
          {node.address && <Row k="주소" v={`${node.address.slice(0, 6)}…${node.address.slice(-4)}`} />}
          {conns.length > 0 && (
            <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-2">
              <div className="mb-1 text-[10px] uppercase text-[var(--color-text-muted)]">연결 ({conns.length})</div>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {conns.map((m) => (
                  <button key={m.id} onClick={() => onPick(m.id)} className="flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11px] hover:bg-[var(--color-surface-raised)]">
                    <span className="truncate text-[var(--color-text-primary)]">{m.label}</span>
                    <span className="ml-2 shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{formatUsd(m.usd)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>}
        {edge && <>
          <Row k="관계" v={EDGE_KIND_LABEL[edge.kind]} />
          {edge.tvlUsd > 0 && <Row k="규모" v={formatUsd(edge.tvlUsd)} />}
          {edge.bridge && <Row k="브릿지" v={`${edge.bridge.fromChain} → ${edge.bridge.toChain}${edge.bridge.mechanism ? ` · ${edge.bridge.mechanism}` : ""}`} />}
          {edge.oracle && <>
            {edge.oracle.danger && <Row k="위험" v="⚠ 자기참조/NAV — 청산 지연 위험" danger />}
            {edge.oracle.type && <Row k="오라클 타입" v={edge.oracle.type} danger={edge.oracle.danger} />}
            {edge.oracle.provider && <Row k="제공자" v={edge.oracle.provider} />}
            {edge.oracle.description && <Row k="피드" v={edge.oracle.description} />}
            <Row k="검증" v={edge.oracle.verified ? "온체인 introspection ✓" : "분류 추정"} />
            {edge.oracle.address && <Row k="주소" v={`${edge.oracle.address.slice(0, 8)}…${edge.oracle.address.slice(-6)}`} />}
            {edge.oracle.danger && <div className="pt-1 text-[10px] leading-snug text-[var(--color-danger)]">시장 디페그가 이 가격 피드에 안 잡혀 청산이 지연될 수 있음 — 무담보 발행/사기 루핑의 전형적 통로.</div>}
          </>}
          {edge.trace && <>
            <Row k="자산" v={edge.trace.assetSymbol ?? "?"} />
            {edge.trace.amountUsd != null && <Row k="흐름 금액" v={formatUsd(edge.trace.amountUsd)} />}
            <Row k="전송 횟수" v={`${edge.trace.count}회 / ${edge.trace.windowDays}일`} />
            {edge.trace.viaCollapsed && <Row k="경유" v="미지 중간주소 접힘 (병목 min 금액)" />}
            {edge.trace.sampleTx && <Row k="샘플 tx" v={`${edge.trace.sampleTx.slice(0, 12)}…`} />}
            <div className="pt-1 text-[10px] leading-snug text-[var(--color-text-muted)]">Dune erc20 Transfer 추적이 발견한, 정적 그래프에 없던 자금 경로. EOA/라우터 등 중간 주소는 그래프에 그리지 않고 끝점만 잇습니다.</div>
          </>}
          {edge.label && <div className="pt-1 text-[11px] text-[var(--color-text-muted)]">{edge.label}</div>}
        </>}
      </div>
    </div>
  );
}

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-[var(--color-text-muted)]">{k}</span><span className={"font-mono " + (danger ? "text-[var(--color-danger)]" : "text-[var(--color-text-primary)]")}>{v}</span></div>;
}
