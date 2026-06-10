"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { X } from "lucide-react";

import { SiteHeader } from "@/components/SiteHeader";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { SAFE_NODE_STATE, type GraphEdge, type GraphNode, type NodeTickState } from "@/lib/api";
import { applyMultiTokenLayout } from "@/lib/multi-token-layout";

function MultiInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const selected = useMemo(() => (sp.get("tokens") || "").split(",").map((s) => s.trim()).filter(Boolean), [sp]);
  const [allTokens, setAllTokens] = useState<string[]>([]);
  const [dbNodes, setDbNodes] = useState<Map<string, GraphNode>>(new Map());
  const [dbEdges, setDbEdges] = useState<GraphEdge[]>([]);
  const [hiddenChains, setHiddenChains] = useState<Set<string>>(new Set());
  const [add, setAdd] = useState("");
  const [selNode, setSelNode] = useState<string | null>(null);
  const [addrBySym, setAddrBySym] = useState<Record<string, Record<string, string>>>({});
  const [supplyBySym, setSupplyBySym] = useState<Record<string, Record<string, { supply: number; supplyUsd: number }>>>({});
  const [breadthLoading, setBreadthLoading] = useState(false);
  const [showMarkets, setShowMarkets] = useState(true); // 마켓·큐레이터 링(밀도). 브릿지 허브는 항상 중앙.

  useEffect(() => {
    fetch("/api/tokens").then((r) => r.json()).then((d) => setAllTokens([...new Set(((d.tokens ?? []) as string[]).map((t) => t.split("@")[0]))].sort())).catch(() => {});
    fetch("/api/graph", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const nodes = new Map<string, GraphNode>();
      for (const n of d.nodes ?? []) nodes.set(n.id, { id: n.id, type: n.type, label: n.label, metadata: { ...(n.metadata ?? {}), chain: n.chain }, active: true } as GraphNode);
      setDbNodes(nodes);
      setDbEdges((d.edges ?? []).map((e: { source: string; target: string; edge_type: string; weight: number; attrs: unknown }) => ({ id: `${e.source}__${e.target}`, source: e.source, target: e.target, type: e.edge_type, weight: e.weight, attrs: e.attrs as GraphEdge["attrs"] })));
    }).catch(() => {});
  }, []);

  // 선택 토큰마다 breadth 로 체인별 주소 수집 → 토큰 노드 실제 로고. (이미 받은 건 재요청 안 함)
  useEffect(() => {
    const need = selected.filter((s) => !addrBySym[s]);
    if (need.length === 0) return;
    setBreadthLoading(true);
    Promise.all(need.map((sym) =>
      fetch(`/api/breadth/${encodeURIComponent(sym)}`).then((r) => r.json())
        .then((d) => [sym, (d.tokenAddrByChain ?? {}) as Record<string, string>, (d.supplyByChain ?? {}) as Record<string, { supply: number; supplyUsd: number }>] as const)
        .catch(() => [sym, {} as Record<string, string>, {} as Record<string, { supply: number; supplyUsd: number }>] as const),
    )).then((triples) => {
      setAddrBySym((prev) => { const next = { ...prev }; for (const [sym, addr] of triples) next[sym] = addr; return next; });
      setSupplyBySym((prev) => { const next = { ...prev }; for (const [sym, , supply] of triples) next[sym] = supply; return next; });
    }).finally(() => setBreadthLoading(false));
  }, [selected, addrBySym]);

  const tokSels = useMemo(() => selected.map((sym) => {
    const want = sym.toLowerCase();
    const ids = [...dbNodes.keys()].filter((id) => id.startsWith("token:") && id.replace("token:", "").split("@")[0].toLowerCase() === want);
    return { sym, tokenIds: ids.length ? ids : [`token:${sym}`] };
  }), [selected, dbNodes]);

  const { topology, sharedCount } = useMemo(() => applyMultiTokenLayout({ tokens: tokSels, dbNodes, dbEdges, hiddenChains, addrBySym, supplyBySym, includeMarkets: showMarkets }), [tokSels, dbNodes, dbEdges, hiddenChains, addrBySym, supplyBySym, showMarkets]);
  const chains = useMemo(() => { const s = new Set<string>(); for (const n of topology.nodes) if (n.id.startsWith("island:")) s.add(n.metadata.chain as string); return [...s]; }, [topology]);
  const nodeStates = useMemo(() => { const m: Record<string, NodeTickState> = {}; for (const n of topology.nodes) m[n.id] = SAFE_NODE_STATE; return m; }, [topology]);

  const setTokens = (arr: string[]) => router.replace(`/multi?tokens=${encodeURIComponent([...new Set(arr)].join(","))}`);
  const addTok = (t: string) => { if (t && !selected.includes(t)) setTokens([...selected, t]); setAdd(""); };

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]">
      <SiteHeader />
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-2.5">
        <span className="text-lg font-bold text-[var(--color-text-primary)]">멀티 토큰 비교</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">여러 토큰 + 토큰 간 익스포저(공유 프로토콜)</span>
        <div className="ml-1 flex flex-wrap items-center gap-1.5">
          {selected.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[12px] font-medium text-[var(--color-text-primary)]">
              {t} <button onClick={() => setTokens(selected.filter((x) => x !== t))} className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><X size={12} /></button>
            </span>
          ))}
          <input list="alltok" value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTok(add.trim()); }}
            placeholder="+ 토큰 추가" className="w-32 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" />
          <datalist id="alltok">{allTokens.map((t) => <option key={t} value={t} />)}</datalist>
        </div>
        {chains.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase text-[var(--color-text-muted)]">체인</span>
            <button onClick={() => { setHiddenChains(new Set()); setSelNode(null); }} className="rounded px-1.5 py-0.5 text-[10px] text-[var(--color-accent)] hover:underline">전체</button>
            {chains.map((ch) => {
              const on = !hiddenChains.has(ch);
              return (
                <button key={ch} onClick={() => { setHiddenChains((p) => { const n = new Set(p); if (n.has(ch)) n.delete(ch); else n.add(ch); return n; }); setSelNode(null); }}
                  className={"flex items-center gap-1 rounded px-2 py-0.5 text-[11px] capitalize transition-colors " + (on ? "text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)]" : "text-[var(--color-text-muted)] opacity-55 hover:opacity-90")}>
                  <span className={"inline-block size-2.5 rounded-[3px] border " + (on ? "border-[var(--color-accent)] bg-[var(--color-accent)]" : "border-[var(--color-border-subtle)]")} />{ch}
                </button>
              );
            })}
          </div>
        )}
        <button
          onClick={() => { setShowMarkets((v) => !v); setSelNode(null); }}
          className={"ml-auto flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors " + (showMarkets ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-text-primary)]" : "border-[var(--color-border-subtle)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]")}
          title="끄면 마켓·큐레이터 링을 숨겨 토큰→프로토콜 개요만 (밀도 조절). 브릿지 허브는 항상 중앙."
        >
          <span className={"inline-block size-2 rounded-full " + (showMarkets ? "bg-[var(--color-accent)]" : "bg-[var(--color-border-subtle)]")} />
          마켓·큐레이터 {showMarkets ? "ON" : "OFF"}
        </button>
        <a href="/" className="text-[11px] text-[var(--color-accent)] hover:underline">← 검색</a>
      </div>
      <div className="relative min-h-0 flex-1">
        {selected.length === 0 ? (
          <Empty msg="비교할 토큰을 2개 이상 추가하세요 — 예: wstETH, USDe, WBTC. (큐레이터가 함께 쓰는 토큰들의 상관 익스포저를 한눈에)" />
        ) : topology.nodes.length > 1 ? (
          <GraphCanvas graphKey={`multi-${selected.join(",")}-${[...hiddenChains].sort().join(",")}-${showMarkets ? "mk" : "ov"}-${topology.nodes.length}`} topology={topology} nodeStates={nodeStates} selectedNodeId={selNode} onSelectNode={setSelNode} staticLayout />
        ) : (
          <Empty msg="선택한 토큰의 온체인 엣지가 DB 에 없어요." />
        )}
        {selected.length >= 2 && topology.nodes.length > 1 && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 space-y-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/85 px-3 py-2 text-[10px] leading-relaxed text-[var(--color-text-secondary)] backdrop-blur">
            <div className="font-semibold text-[var(--color-text-primary)]">중앙 = 브릿지 허브 · 바깥 = 체인별 동심원</div>
            <div>한 체인 원: 안쪽부터 토큰 → 프로토콜 → 마켓/풀 → 큐레이터</div>
            <div>공유 프로토콜 {sharedCount}개(토큰들 사이) = 토큰 간 상관 익스포저</div>
            <div className="pt-1"><span style={{ color: "#fbbf24" }}>앰버</span> 잠김(소스) · <span style={{ color: "#34d399" }}>초록</span> 민팅(도착) · <span style={{ color: "#fdba74" }}>주황 마켓</span> ↔ 토큰간</div>
          </div>
        )}
        {breadthLoading && (
          <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/90 px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] backdrop-blur">
            <span className="size-3 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            토큰 주소·로고 수집 중…
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]">{msg}</div>;
}

export default function MultiTokenPage() {
  return <Suspense fallback={null}><MultiInner /></Suspense>;
}
