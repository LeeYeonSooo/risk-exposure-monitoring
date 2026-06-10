"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AlertDock } from "@/components/AlertDock";
import { SiteHeader } from "@/components/SiteHeader";
import { FlowControls } from "@/components/flow/FlowControls";
import { FlowDetail } from "@/components/flow/FlowDetail";
import { FlowGraph } from "@/components/flow/FlowGraph";
import { FlowTxPanel } from "@/components/flow/FlowTxPanel";
import { useFlowData } from "@/components/flow/useFlowData";
import { chainOptions } from "@/lib/chains-ui";
import { filterGraphByDetail } from "@/lib/flow-match";

/**
 * /flow — the 흐름맵 page (its own page, reached from the header). Transaction flow only:
 * real transfers ride the edges as equal particles (size ∝ value, count ∝ frequency).
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
  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initKey) setTokens(initKey.split(",")); }, [initKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (chInitKey) setChains(chInitKey.split(",")); }, [chInitKey]);

  const chainOpts = useMemo(() => chainOptions(), []);
  const orderedChains = useMemo(() => [...chains].sort((a, b) => (a === "ethereum" ? -1 : b === "ethereum" ? 1 : a.localeCompare(b))), [chains]);
  const flow = useFlowData({ tokens, chains, active: true });
  // node composition is fully DATA-DRIVEN, no user dial: a node shows only when its EFFECTIVE
  // share of the token's total exposure (parent eff × share within parent) is ≥1% — so a 2% market
  // inside a 1.2% protocol (= 0.02% overall) stays hidden. tx-active nodes are always pinned.
  const MIN_SHARE = 0.01;
  const graph = useMemo(() => (flow.graph ? filterGraphByDetail(flow.graph, MIN_SHARE, flow.txs) : flow.graph), [flow.graph, flow.txs]);

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
        <span className="text-sm font-bold text-[var(--color-text-primary)]">흐름맵 <span className="text-[11px] font-normal text-[var(--color-text-muted)]">· 실시간 트랜잭션 (5분 윈도우 · 1분 지연)</span></span>
        {(() => {
          // 비-EVM 피드는 체인마다 수집 방식·커버리지가 다르다 — 숨기지 않고 그대로 공지
          const NOTE: Record<string, string> = {
            solana: "솔라나: 민트 참조 트랜잭션 기반 — 지갑 전송(transferChecked)·스왑·민트·소각은 잡히지만 일부 레거시 전송·직접 풀 스왑은 보이지 않습니다.",
            tron: "트론: TronGrid 토큰 Transfer 이벤트 전체 + 검증된 장소만 라벨 — 미등재 컨트랙트는 전송으로 표시됩니다.",
            aptos: "앱토스: 공식 인덱서 활동 기반 — 장소는 엔트리 함수 모듈로 식별, 미등재 모듈은 전송으로 표시됩니다.",
            starknet: "스타크넷: 토큰 Transfer 이벤트 + 검증된 장소만 라벨 — 시각은 블록 단위이며 미등재 컨트랙트는 전송으로 표시됩니다.",
            sui: "Sui: 등재된 장소 패키지를 거친 이동만 보입니다(코인 전송은 표준 이벤트가 없음) — P2P 전송은 구조적으로 안 보입니다.",
          };
          const active = chains.filter((c) => NOTE[c]);
          if (!active.length) return null;
          return (
            <span className="rounded bg-[rgba(153,69,255,0.12)] px-1.5 py-0.5 text-[10px] text-[#7c3aed]"
              title={active.map((c) => NOTE[c]).join("\n")}>
              비-EVM 피드({active.join("·")}): 커버리지 제한 — 자세히는 마우스오버
            </span>
          );
        })()}
        <FlowControls chains={chains} toggleChain={toggleChain} chainOptions={chainOpts}
          tokens={tokens} addToken={addToken} removeToken={removeToken} universe={flow.universe} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative h-[560px] min-h-[560px] flex-none lg:h-auto lg:min-h-0 lg:flex-1">
          {graph && graph.nodes.length > 0 ? (
            <FlowGraph graph={graph} mode="transaction" chainsOrder={orderedChains}
              selectedId={sel?.id ?? null}
              onSelectNode={(id) => setSel(id ? { type: "node", id } : null)}
              onSelectEdge={(id) => setSel({ type: "edge", id })}
              txs={flow.txs} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
              {flow.loading ? "실시간 흐름 그래프 구성 중… (DeFiLlama·Morpho 라이브)" : `${tokens.join(", ")} 흐름 데이터 없음`}
            </div>
          )}
          {graph && graph.nodes.length > 0 && <FlowTxPanel txs={flow.txs} txLoading={flow.txLoading} txAt={flow.txAt} txError={flow.txError} graph={graph} />}
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
