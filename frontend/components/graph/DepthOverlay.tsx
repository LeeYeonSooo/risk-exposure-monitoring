"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";

import type { TopologyResponse } from "@/lib/api";
import { hasDepth, normalizeDepthGraph, type KuromiSim } from "@/lib/depth-graph";
import { GraphCanvas } from "./GraphCanvas";
import { GraphErrorBoundary } from "./GraphErrorBoundary";

/**
 * kuromi 재귀 언랩(depth) 그래프를 맵 위 오버레이로 펼침 (별도 페이지 X).
 * 노드 클릭 → SidePanel "상세 ▸" → 이 오버레이. "진짜 누가 들고 있나"를 depth 컬럼으로.
 */
export function DepthOverlay({ token, onClose }: { token: string | null; onClose: () => void }) {
  const [topo, setTopo] = useState<TopologyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setStatus("loading");
    setTopo(null);
    setSelected(null);
    const t = token.toLowerCase();
    if (!hasDepth(t)) { setStatus("missing"); return; }
    fetch(`/depth/${t}.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("nf"))))
      .then((sim: KuromiSim) => { setTopo(normalizeDepthGraph(sim)); setStatus("ready"); })
      .catch(() => setStatus("missing"));
  }, [token]);

  if (!token) return null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[var(--color-background)]/96 backdrop-blur-sm">
      <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-5 py-2.5">
        <h2 className="text-[14px] font-semibold">
          상세 의존성 — {token.toUpperCase()} <span className="text-[var(--color-text-muted)]">· 재귀 홀더 언랩 (depth)</span>
        </h2>
        <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">Ethereum · (token,block) 재현 · price-free</span>
        <button onClick={onClose} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]" title="닫기">
          <X size={16} />
        </button>
      </div>
      <div className="relative flex-1">
        {status === "loading" && (
          <div className="flex h-full items-center justify-center gap-2 text-[var(--color-text-muted)]">
            <Loader2 size={16} className="animate-spin" /> 상세 그래프 로딩 중…
          </div>
        )}
        {status === "missing" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--color-text-muted)]">
            <div className="text-sm">이 토큰의 상세(depth) 그래프는 아직 준비되지 않았어요.</div>
            <div className="max-w-md text-[12px]">kuromi 재귀 언랩은 오프라인 크롤 — 현재 rsETH · stETH · wstETH 지원. (feeder 라이브 wiring 후 확장)</div>
          </div>
        )}
        {status === "ready" && topo && (
          <GraphErrorBoundary>
            <GraphCanvas graphKey={`depth-${token}`} topology={topo} nodeStates={{}} selectedNodeId={selected} onSelectNode={setSelected} />
          </GraphErrorBoundary>
        )}
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/90 px-3 py-2 text-[11px] text-[var(--color-text-secondary)] backdrop-blur">
          왼쪽 = 토큰, 오른쪽으로 갈수록 깊은 홀더(언랩 단계). 점선/흐림 = opaque(미해독). 수치는 온체인 재현.
        </div>
      </div>
    </div>
  );
}
