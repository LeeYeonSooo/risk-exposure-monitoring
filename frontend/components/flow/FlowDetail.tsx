"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { formatUsd } from "@/lib/api";
import { ADDR_EXPLORER, PRow, TX_EXPLORER, TokenSpecRows, pct1, sevDots, shortAddr } from "@/components/panel/spec";
import type { FlowEdge, FlowGraph as FlowGraphData, FlowNode } from "@/lib/flow-types";

/**
 * 흐름맵 선택 패널 — 스펙 고정: 값은 한 줄 토큰(문장 금지), 없으면 행 숨김,
 * 주소는 ↗ 링크, 위험은 ⚠·빨강. 엔터티별 행 구성은 사용자 스펙 그대로.
 */
const EDGE_KIND_LABEL: Record<FlowEdge["kind"], string> = {
  holds: "예치 / 익스포저", market: "마켓 · 풀", involves: "구성 토큰", vault: "볼트 공급", bridge: "체인간 연결 (브릿지)", sibling: "동일 프로토콜 (타 체인)", oracle: "오라클 의존", trace: "이벤트 보강 흐름",
};
const kindKo = (k: FlowNode["kind"]) => (k === "token" ? "토큰" : k === "protocol" ? "프로토콜" : k === "market" ? "마켓/풀" : k === "vault" ? "볼트 (큐레이터 운용)" : k === "bridge" ? "브릿지" : "외부 컨트랙트");

// 프로토콜 알림 수 — /api/alerts 1회 캐시 후 protocol_node_id 정확 일치 집계
let _alertsCache: { at: number; rows: { severity: string; protocol_node_id: string | null }[] } | null = null;
function useProtocolAlertCounts(protoId: string | null): { crit: number; warnN: number } | null {
  const [v, setV] = useState<{ crit: number; warnN: number } | null>(null);
  useEffect(() => {
    if (!protoId) { setV(null); return; }
    let alive = true;
    const compute = (rows: { severity: string; protocol_node_id: string | null }[]) => {
      const slug = protoId.replace(/^proto:[^|]*\|/, "").replace(/-/g, "");
      const mine = rows.filter((r) => {
        const p = (r.protocol_node_id ?? "").replace(/^protocol:(dl:)?/, "").split("@")[0].replace(/[-_]/g, "");
        return p && p === slug;
      });
      if (alive) setV({ crit: mine.filter((r) => r.severity === "critical").length, warnN: mine.filter((r) => r.severity === "warning").length });
    };
    if (_alertsCache && Date.now() - _alertsCache.at < 60_000) { compute(_alertsCache.rows); return; }
    fetch("/api/alerts?limit=300", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      _alertsCache = { at: Date.now(), rows: (d.alerts ?? []) };
      compute(_alertsCache.rows);
    }).catch(() => {});
    return () => { alive = false; };
  }, [protoId]);
  return v;
}

export function FlowDetail({ sel, graph, onClose }: {
  sel: { type: "node" | "edge"; id: string };
  graph: FlowGraphData;
  onClose: () => void;
  onPick?: (id: string) => void;
}) {
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n] as const)), [graph]);
  const node = sel.type === "node" ? byId.get(sel.id) ?? null : null;
  const edge = sel.type === "edge" ? graph.edges.find((e) => e.id === sel.id) ?? null : null;
  const protoCounts = useProtocolAlertCounts(node?.kind === "protocol" ? node.id : null);
  const traceWindow = edge?.kind === "trace" && edge.trace
    ? edge.trace.windowSec != null ? `${Math.round(edge.trace.windowSec / 60)}분` : edge.trace.windowDays != null ? `${edge.trace.windowDays}일` : null
    : null;
  if (!node && !edge) return null;

  // ── 노드별 스펙 행 ──
  let body: React.ReactNode = null;
  if (node) {
    if (node.kind === "token") {
      // 주 체인 = 같은 심볼 토큰 노드들의 체인별 TVL 비중 (그래프 실데이터)
      const sibs = graph.nodes.filter((n) => n.kind === "token" && n.token.toUpperCase() === node.token.toUpperCase());
      const tot = sibs.reduce((s, n) => s + n.tvlUsd, 0) || 1;
      const chainPcts = sibs.map((n) => ({ chain: n.chain, pct: n.tvlUsd / tot })).sort((a, b) => b.pct - a.pct);
      body = <TokenSpecRows symbol={node.token} chainPcts={chainPcts.length > 1 ? chainPcts : null} />;
    } else if (node.kind === "protocol") {
      const mkts = graph.edges.filter((e) => e.kind === "market" && e.source === node.id).map((e) => byId.get(e.target)).filter((x): x is FlowNode => !!x);
      const lltvs = mkts.map((m) => Number(m.meta?.lltv)).filter((v) => Number.isFinite(v) && v > 0);
      const utils = mkts.map((m) => Number(m.meta?.utilization)).filter((v) => Number.isFinite(v));
      const maxLltv = lltvs.length ? Math.max(...lltvs) : null;
      const avgUtil = utils.length ? utils.reduce((s, v) => s + v, 0) / utils.length : null;
      body = (
        <>
          <PRow k="담보 · 마켓" v={mkts.length ? `${mkts.length}개 · ${formatUsd(node.tvlUsd)}` : node.tvlUsd > 0 ? formatUsd(node.tvlUsd) : null} />
          <PRow k="최고 LLTV" v={maxLltv != null ? pct1(maxLltv) : null} warn={maxLltv != null && maxLltv >= 0.945} />
          <PRow k="평균 이용률" v={avgUtil != null ? pct1(avgUtil) : null} warn={avgUtil != null && avgUtil >= 0.95} />
          <PRow k="알림" v={protoCounts ? sevDots(protoCounts.crit, protoCounts.warnN) : null} warn={(protoCounts?.crit ?? 0) > 0} />
        </>
      );
    } else if (node.kind === "market") {
      const oracleEdge = graph.edges.find((e) => e.kind === "oracle" && e.source === node.id);
      const vaults = graph.edges.filter((e) => e.kind === "vault" && e.source === node.id).map((e) => byId.get(e.target)).filter((x): x is FlowNode => !!x);
      const curators = [...new Set(vaults.map((v) => String(v.meta?.curator ?? v.label)))];
      const lltv = Number(node.meta?.lltv);
      const util = Number(node.meta?.utilization);
      body = (
        <>
          <PRow k="페어" v={node.label} />
          <PRow k="LLTV" v={Number.isFinite(lltv) && lltv > 0 ? pct1(lltv) : null} warn={lltv >= 0.945} />
          <PRow k="이용률" v={Number.isFinite(util) && util > 0 ? pct1(util) : null} warn={util >= 0.95} />
          <PRow k="규모" v={node.tvlUsd > 0 ? formatUsd(node.tvlUsd) : null} />
          <PRow k="오라클" v={oracleEdge ? (oracleEdge.label ?? "온체인 피드").replace(/^오라클\s*/, "") : null} badge={oracleEdge ? "verified" : undefined} />
          <PRow k="큐레이터" v={curators.length ? `${curators.slice(0, 2).join(" · ")}${curators.length > 2 ? ` +${curators.length - 2}` : ""}` : null} />
        </>
      );
    } else if (node.kind === "vault") {
      const shared = graph.edges.filter((e) => e.kind === "vault" && e.target === node.id).length;
      body = (
        <>
          <PRow k="AUM" v={node.tvlUsd > 0 ? formatUsd(node.tvlUsd) : null} />
          <PRow k="공유 마켓" v={shared > 0 ? `${shared}개` : null} />
          <PRow k="큐레이터" v={node.meta?.curator != null ? String(node.meta.curator) : null} />
        </>
      );
    } else if (node.kind === "bridge") {
      const mintLimit = node.meta?.mintLimit as number | null | undefined;
      const note = node.meta?.note != null ? String(node.meta.note) : null;
      const locked = note ? /잠금|잠김|lock/i.test(note) : false;
      body = (
        <>
          <PRow k="권한" v={String(node.meta?.authType ?? node.label)} />
          <PRow k="mint 한도" v={mintLimit != null ? `${Intl.NumberFormat("en", { notation: "compact" }).format(mintLimit)} ${node.token}` : null} />
          <PRow k="백킹" v={locked ? "잠금 확정" : note ? note.slice(0, 28) : null} badge={locked ? "verified" : undefined} />
          <PRow k="주소" v={node.address ? shortAddr(node.address) : null} href={node.address ? ADDR_EXPLORER[node.chain]?.(node.address) : null} badge="verified" />
        </>
      );
    }
  }

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

      <div className="mt-3 space-y-0.5">
        {node && (
          <>
            {body}
            {node.kind === "token" && node.address && (
              <PRow k="주소" v={shortAddr(node.address)} href={ADDR_EXPLORER[node.chain]?.(node.address)} badge="verified" />
            )}
          </>
        )}
        {edge && (
          <>
            {edge.kind === "oracle" ? (
              <>
                {edge.oracle?.danger && <PRow k="위험" v="⚠ 자기참조/NAV — 청산 지연" warn />}
                <PRow k="타입" v={edge.oracle?.type ?? null} warn={edge.oracle?.danger} />
                <PRow k="피드" v={edge.oracle?.provider ?? ((edge.label ?? "").replace(/^오라클\s*/, "") || "온체인 피드")} badge="verified" />
                <PRow k="검증" v={edge.oracle?.verified ? "온체인 introspection" : "마켓 실피드 (Morpho 온체인)"} badge="verified" />
                <PRow k="주소" v={edge.oracle?.address ? shortAddr(edge.oracle.address) : null} href={edge.oracle?.address ? ADDR_EXPLORER[edge.chain]?.(edge.oracle.address) : null} />
              </>
            ) : edge.kind === "trace" ? (
              <>
                <PRow k="자산" v={edge.trace?.assetSymbol ?? "?"} />
                <PRow k="흐름 금액" v={edge.trace?.amountUsd != null ? formatUsd(edge.trace.amountUsd) : null} />
                <PRow k="전송" v={edge.trace ? `${edge.trace.count}회${traceWindow ? ` / ${traceWindow}` : ""}` : null} />
                <PRow k="경유" v={edge.trace?.viaCollapsed ? "중간주소 접힘" : null} />
                <PRow k="샘플 tx" v={edge.trace?.sampleTx ? shortAddr(edge.trace.sampleTx) : null} href={edge.trace?.sampleTx ? TX_EXPLORER[edge.chain]?.(edge.trace.sampleTx) : null} />
              </>
            ) : (
              <>
                <PRow k="관계" v={EDGE_KIND_LABEL[edge.kind]} />
                <PRow k="규모" v={edge.tvlUsd > 0 ? formatUsd(edge.tvlUsd) : null} />
                {edge.bridge?.mechanism && <PRow k="메커니즘" v={edge.bridge.mechanism} badge="verified" />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
