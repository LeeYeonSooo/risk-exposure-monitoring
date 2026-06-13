"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AlertDock } from "@/components/AlertDock";
import { SiteHeader } from "@/components/SiteHeader";
import { FlowBaselinePanel } from "@/components/flow/FlowBaselinePanel";
import { FlowControls } from "@/components/flow/FlowControls";
import { FlowDetail } from "@/components/flow/FlowDetail";
import { FlowGraph } from "@/components/flow/FlowGraph";
import { FlowTxPanel } from "@/components/flow/FlowTxPanel";
import { useFlowData, type FlowViewMode } from "@/components/flow/useFlowData";
import { chainOptions } from "@/lib/chains-ui";
import {
  augmentGraphWithBaselineTraceEdges, augmentGraphWithEventTraceEdges, buildBaselineOverlay,
  computeActivity, filterGraphByDetail, type FlowActivity,
} from "@/lib/flow-match";
import { LIVE_WINDOW_SEC } from "@/lib/flow-types";

const WIN_MIN = Math.round(LIVE_WINDOW_SEC / 60); // 윈도우 분 — 한 곳(flow-types)만 바꾸면 UI 자동 반영

/**
 * /flow — the 흐름맵 page (its own page, reached from the header). Two modes:
 *  · 실시간 — 최근 30분(1분 지연)의 실전송이 입자로 엣지를 탄다 (크기 ∝ 금액)
 *  · 평소   — 최근 24h 집계로 "어느 엣지로 얼마나 흐르는 게 평소인가"를 두께·수치로
 * 두 모드 모두, 트랜잭션이 하나라도 탄 노드·엣지만 색을 유지하고 나머지는 회색으로 가라앉는다.
 * ?token=SYMBOL preselects a token (e.g. linked from a token page).
 */
export default function FlowPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-[var(--color-bg)] text-sm text-[var(--color-text-muted)]">로딩…</div>}>
      <FlowPageInner />
    </Suspense>
  );
}

function FlowPageInner() {
  const sp = useSearchParams();
  const initialTokens = (sp.get("tokens") || sp.get("token") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const initKey = initialTokens.join(",");
  // ?chains= (알림 딥링크 등) — 아는 체인만 통과, 없으면 ethereum
  const initialChains = (sp.get("chains") || "").split(",").map((s) => s.trim().toLowerCase())
    .filter((c) => chainOptions().some((o) => o.key === c));
  const chInitKey = initialChains.join(",");
  const [chains, setChains] = useState<string[]>(initialChains.length ? initialChains : ["ethereum"]);
  const [tokens, setTokens] = useState<string[]>(initialTokens.length ? initialTokens : ["stETH", "WETH", "USDC", "USDT", "WBTC"]);
  const [mode, setMode] = useState<FlowViewMode>("live");
  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  // URL 토큰이 (늦게라도) 도착하면 적용 + 자동 추천 영구 차단 — 프로덕션에서 useSearchParams 가
  // 첫 렌더에 비어 autoPicked=false 로 고정되고, 수십 초 뒤 universe 도착 시 자동 추천이
  // URL 선택을 덮어쓰던 레이스의 수정.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initKey) { setTokens(initKey.split(",")); setAutoPicked(true); } }, [initKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (chInitKey) setChains(chInitKey.split(",")); }, [chInitKey]);

  const chainOpts = useMemo(() => chainOptions(), []);
  const orderedChains = useMemo(() => [...chains].sort((a, b) => (a === "ethereum" ? -1 : b === "ethereum" ? 1 : a.localeCompare(b))), [chains]);
  const flow = useFlowData({ tokens, chains, active: true, mode });
  // node composition is fully DATA-DRIVEN, no user dial: a node shows only when its EFFECTIVE
  // share of the token's total exposure (parent eff × share within parent) is ≥1% — so a 2% market
  // inside a 1.2% protocol (= 0.02% overall) stays hidden. tx-active nodes are always pinned, and
  // category-quota protocols (DEX by volume 등 — meta.coreKeep) are always shown.
  const MIN_SHARE = 0.005; // 주요 마켓·풀·볼트는 다 노드로 (요구사항 — 노드 많아도 좋다)
  const { graph, activity } = useMemo((): { graph: typeof flow.graph; activity: FlowActivity | null } => {
    if (!flow.graph) return { graph: flow.graph, activity: null };
    if (mode === "live") {
      const g = filterGraphByDetail(augmentGraphWithEventTraceEdges(flow.graph, flow.txs), MIN_SHARE, flow.txs);
      // 피드가 실패/비었으면 딤을 끈다 — 전부 회색인 지도는 "피드 죽음"을 "활동 없음"으로 위장한다
      const act = flow.txs.length && !flow.txError ? computeActivity(g.nodes, g.edges, flow.txs) : null;
      return { graph: g, activity: act };
    }
    const rows = flow.baseline.rows;
    const g1 = augmentGraphWithBaselineTraceEdges(flow.graph, rows, flow.baseline.coverage);
    const g2 = filterGraphByDetail(g1, MIN_SHARE, rows);
    // 집계 실패/빈 결과면 딤을 끈다 — 전부 회색인 지도는 "집계 실패"를 "평소 흐름 없음"으로 위장한다
    if (!rows.length || flow.baseline.error) return { graph: g2, activity: null };
    const { edgeStats, activity: act } = buildBaselineOverlay(g2, rows, flow.baseline.coverage);
    return {
      graph: { ...g2, edges: g2.edges.map((e) => (edgeStats.has(e.id) ? { ...e, baseline: edgeStats.get(e.id)! } : e)) },
      activity: act,
    };
  }, [flow.graph, flow.txs, flow.txError, flow.baseline, mode]);

  // initial view = the REAL top-5 tokens by TVL (always incl. stETH), single chain — unless the user picked ?tokens
  const [autoPicked, setAutoPicked] = useState(initialTokens.length > 0);
  useEffect(() => {
    if (autoPicked || !flow.universe.length) return;
    const ranked = [...flow.universe].sort((a, b) => b.tvlUsd - a.tvlUsd);
    const picks: string[] = [];
    const steth = ranked.find((t) => t.symbol.toLowerCase() === "steth");
    if (steth) picks.push(steth.symbol);
    for (const t of ranked) { if (picks.length >= 5) break; if (!picks.some((s) => s.toLowerCase() === t.symbol.toLowerCase())) picks.push(t.symbol); }
    if (picks.length) setTokens(picks);
    setAutoPicked(true);
  }, [autoPicked, flow.universe]);

  const toggleChain = (k: string) => setChains((p) => (p.includes(k) ? (p.length > 1 ? p.filter((c) => c !== k) : p) : [...p, k]));
  const addToken = (t: string) => setTokens((p) => (p.some((x) => x.toUpperCase() === t.toUpperCase()) ? p : [...p, t]));
  const removeToken = (t: string) => setTokens((p) => (p.length > 1 ? p.filter((x) => x !== t) : p));

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]">
      <AlertDock />
      <SiteHeader />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 lg:px-5">
        <span className="text-sm font-bold text-[var(--color-text-primary)]">흐름맵 <span className="text-[11px] font-normal text-[var(--color-text-muted)]">
          {mode === "live" ? `· 실시간 트랜잭션 (최근 1000건 · 최대 ${WIN_MIN}분 · 1분 지연)` : "· 평소 흐름 (최근 24h 집계 — 어느 엣지가 평소에 얼마나 흐르나)"}
        </span></span>
        {/* 모드 토글 — 실시간(입자) ↔ 평소(집계 두께) */}
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-0.5">
          {([["live", "실시간 30분"], ["baseline", "평소 24h"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => { if (k !== mode) { setMode(k); setSel(null); } }} // 모드별 그래프 구성이 달라 선택 대상이 사라질 수 있음 — 빈 사이드바 방지
              className={"rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors " + (mode === k ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]")}>
              {label}
            </button>
          ))}
        </div>
        <FlowControls chains={chains} toggleChain={toggleChain} chainOptions={chainOpts}
          tokens={tokens} addToken={addToken} removeToken={removeToken} universe={flow.universe} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative h-[560px] min-h-[560px] flex-none lg:h-auto lg:min-h-0 lg:flex-1">
          {graph && graph.nodes.length > 0 ? (
            <FlowGraph graph={graph} mode={mode === "baseline" ? "baseline" : "transaction"} chainsOrder={orderedChains}
              selectedTokens={tokens}
              selectedId={sel?.id ?? null}
              onSelectNode={(id) => setSel(id ? { type: "node", id } : null)}
              onSelectEdge={(id) => setSel({ type: "edge", id })}
              txs={flow.txs} activity={activity} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
              {flow.loading ? "실시간 흐름 그래프 구성 중… (DeFiLlama·Morpho 라이브)" : `${tokens.join(", ")} 흐름 데이터 없음`}
            </div>
          )}
          {graph && graph.nodes.length > 0 && (mode === "live"
            ? <FlowTxPanel txs={flow.txs} txLoading={flow.txLoading} txAt={flow.txAt} txError={flow.txError} txPartial={flow.txPartial} graph={graph} />
            : <FlowBaselinePanel baseline={flow.baseline} loading={flow.baselineLoading} />)}
        </div>

        {sel && graph && (
          <aside className="w-full shrink-0 overflow-y-auto border-t border-[var(--color-border-subtle)] bg-[var(--color-surface)] lg:w-[360px] lg:border-l lg:border-t-0">
            <FlowDetail sel={sel} graph={graph} onClose={() => setSel(null)} onPick={(id) => setSel({ type: "node", id })} />
          </aside>
        )}
      </div>
    </div>
  );
}
