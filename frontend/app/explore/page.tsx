"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { SiteHeader } from "@/components/SiteHeader";
import { DepGraphCanvas } from "@/components/graph/DepGraphCanvas";
import { TokenDossier } from "@/components/graph/TokenDossier";
import { SAFE_NODE_STATE, formatUsd, type GraphEdge, type GraphNode, type NodeTickState } from "@/lib/api";

interface ManifestTok { symbol: string; file: string; block: number; nodes: number; edges: number }
interface SimGraph {
  nodes: { id: string; type: string; label: string; data?: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; label?: string; edge_type?: string }[];
}
interface Relation { edge: GraphEdge; otherId: string; otherLabel: string; direction: "out" | "in" }

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function ExplorePage() {
  const [manifest, setManifest] = useState<ManifestTok[]>([]);
  const [sym, setSym] = useState<string>("");
  const [graph, setGraph] = useState<SimGraph | null>(null);
  // 우리 DB 의 rich 엣지 전체 (도시에/마켓상세용)
  const [dbEdges, setDbEdges] = useState<GraphEdge[]>([]);
  const [dbNodes, setDbNodes] = useState<Map<string, GraphNode>>(new Map());
  const [picked, setPicked] = useState<{ label: string } | null>(null);

  useEffect(() => {
    fetch("/depgraph/manifest.json").then((r) => r.json()).then((m) => {
      const toks: ManifestTok[] = m.tokens ?? [];
      setManifest(toks);
      setSym((s) => s || toks[0]?.symbol || "");
    }).catch(() => {});
    // 우리 DB rich 그래프 (한 번)
    fetch("/api/graph", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const nodes = new Map<string, GraphNode>();
      for (const n of d.nodes ?? []) nodes.set(n.id, { id: n.id, type: n.type, label: n.label, metadata: { ...(n.metadata ?? {}), chain: n.chain }, active: true } as GraphNode);
      const edges: GraphEdge[] = (d.edges ?? []).map((e: { source: string; target: string; edge_type: string; weight: number; attrs: unknown }) => ({
        id: `${e.source}__${e.target}`, source: e.source, target: e.target, type: e.edge_type, weight: e.weight, attrs: e.attrs as GraphEdge["attrs"],
      }));
      setDbNodes(nodes); setDbEdges(edges);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!sym) return;
    setPicked(null);
    const t = manifest.find((x) => x.symbol === sym);
    if (t) fetch(`/depgraph/${t.file}`).then((r) => r.json()).then(setGraph).catch(() => setGraph(null));
  }, [sym, manifest]);

  // 선택 토큰의 DB rich relations (도시에 입력)
  const tokenNodeId = useMemo(() => {
    // manifest 심볼 → DB node_id (대소문자 무시 매칭)
    for (const id of dbNodes.keys()) if (id.toLowerCase() === `token:${sym}`.toLowerCase()) return id;
    return `token:${sym}`;
  }, [dbNodes, sym]);

  const relations: Relation[] = useMemo(() => {
    return dbEdges
      .filter((e) => e.source === tokenNodeId || e.target === tokenNodeId)
      .map((e) => {
        const out = e.source === tokenNodeId;
        const otherId = out ? e.target : e.source;
        return { edge: e, otherId, otherLabel: dbNodes.get(otherId)?.label ?? otherId, direction: out ? ("out" as const) : ("in" as const) };
      })
      .sort((a, b) => (b.edge.attrs?.core?.amountUsd ?? 0) - (a.edge.attrs?.core?.amountUsd ?? 0));
  }, [dbEdges, dbNodes, tokenNodeId]);

  const tokenNode: GraphNode = useMemo(
    () => dbNodes.get(tokenNodeId) ?? ({ id: tokenNodeId, type: "Token", label: sym, metadata: { symbol: sym, chain: "ethereum" }, active: true } as GraphNode),
    [dbNodes, tokenNodeId, sym],
  );
  const state: NodeTickState = SAFE_NODE_STATE;

  // 클릭한 dep-node 라벨 → DB relation 매칭 (마켓 상세)
  const pickedRelation = useMemo(() => {
    if (!picked) return null;
    const key = picked.label.toLowerCase().split(/[\s(]/)[0]; // "Aave V3 (core)" → "aave"
    if (!key || key.length < 2) return null;
    return relations.find((r) => r.otherLabel.toLowerCase().includes(key)) ?? null;
  }, [picked, relations]);

  const cur = manifest.find((x) => x.symbol === sym);

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]">
      <SiteHeader />
      <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-5 py-2.5">
        <span className="text-sm font-semibold text-[var(--color-text-primary)]">큐레이터 실사 — 토큰 의존성</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">좌: 의존성 구조(Tier 2·3) · 우: 상세 도시에(Tier 1→2→3)</span>
        <div className="ml-auto flex items-center gap-1">
          {manifest.map((t) => (
            <button key={t.symbol} onClick={() => setSym(t.symbol)}
              className={"rounded-md px-3 py-1 text-[12px] font-medium transition-colors " + (t.symbol === sym ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]")}>
              {t.symbol}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 좌: 의존성 그래프 (Tier 2·3 구조) */}
        <div className="relative min-h-0 flex-1">
          {graph ? (
            <DepGraphCanvas nodes={graph.nodes} edges={graph.edges} onSelect={(_, n) => n && n.type !== "token" && setPicked({ label: n.label })} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">{sym ? `${sym} 로딩…` : "토큰 선택"}</div>
          )}
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/90 px-3 py-2 text-[10px] text-[var(--color-text-muted)] backdrop-blur">
            <div className="mb-1 font-semibold uppercase tracking-wider">의존성 구조 · 노드 클릭 → 우측 마켓 상세</div>
            엣지 라벨 = 역할·수량 · 점선 = 미검증 · 좌→우 = 의존 깊이 · {cur ? `#${cur.block} · ${cur.nodes}n/${cur.edges}e` : ""} · dep-engine
          </div>
        </div>

        {/* 우: 상세 패널 — 노드 클릭 시 마켓 상세, 아니면 토큰 도시에 */}
        <aside className="w-[400px] shrink-0 overflow-y-auto border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
          {picked ? (
            <MarketDetail label={picked.label} relation={pickedRelation} onClose={() => setPicked(null)} />
          ) : (
            <div className="px-5 py-4">
              <div className="mb-3">
                <div className="text-lg font-semibold text-[var(--color-text-primary)]">{sym}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">Token · 실사 도시에 (우리 DB 실데이터)</div>
              </div>
              {sym && <TokenDossier node={tokenNode} relations={relations} state={state} />}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// 노드(프로토콜) 클릭 → 그 (토큰,프로토콜) 엣지의 rich 마켓 상세
function MarketDetail({ label, relation, onClose }: { label: string; relation: Relation | null; onClose: () => void }) {
  const a = relation?.edge.attrs;
  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">마켓 상세</div>
          <div className="text-lg font-semibold text-[var(--color-text-primary)]">{label}</div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"><X size={16} /></button>
      </div>
      {!relation || !a ? (
        <p className="text-[12px] text-[var(--color-text-muted)]">이 프로토콜의 온체인 상세는 우리 DB 스냅샷에 없음(미추적 또는 dep-engine 전용 노드). 좌측 그래프의 엣지 라벨로 역할·수량 확인 가능.</p>
      ) : (
        <div className="space-y-3 text-[12px]">
          <Row k="노출 (USD)" v={a.core?.amountUsd != null ? formatUsd(a.core.amountUsd) : "—"} />
          <Row k="공급 비중" v={a.core?.pctOfSupply != null ? pct(a.core.pctOfSupply) : "—"} />
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">역할</div>
            <div className="flex flex-wrap gap-1">
              {(a.classification?.roles ?? []).map((r, i) => (
                <span key={i} className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">{r.edge_type} · {formatUsd(r.amount_usd)}</span>
              ))}
            </div>
          </div>
          <Row k="오라클" v={a.oracle?.provider ? `${a.oracle.type ?? ""} · ${a.oracle.provider}` : (a.oracle?.type ?? "—")} />
          <Row k="LT (청산임계)" v={a.lendingRisk?.lt != null ? pct(a.lendingRisk.lt) : "—"} />
          <Row k="가동률" v={a.lendingRisk?.utilization != null ? pct(a.lendingRisk.utilization) : "—"} />
          <Row k="가용 유동성" v={a.lendingRisk?.liquidityUsd != null ? formatUsd(a.lendingRisk.liquidityUsd) : "—"} />
          {(a.topMarkets?.length ?? 0) > 0 && (
            <div>
              <div className="mb-1 mt-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">마켓 (LLTV · 규모)</div>
              <div className="space-y-1">
                {a.topMarkets!.slice(0, 8).map((m, i) => (
                  <div key={i} className="flex items-center justify-between rounded bg-[var(--color-surface-raised)] px-2 py-1">
                    <span className="text-[var(--color-text-primary)]">{m.collateralAsset ?? "?"}/{m.loanAsset ?? "?"}</span>
                    <span className="font-mono text-[var(--color-text-secondary)]">{m.lltv != null ? pct(m.lltv) : "—"} · {formatUsd(m.marketSizeUsd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--color-text-muted)]">{k}</span>
      <span className="font-mono text-[var(--color-text-secondary)]">{v}</span>
    </div>
  );
}
