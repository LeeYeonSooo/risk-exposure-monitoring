"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, GripVertical, Zap } from "lucide-react";

import { formatUsd } from "@/lib/api";
import { buildRenderPlan } from "@/lib/flow-match";
import type { FlowGraph, FlowTx } from "@/lib/flow-types";
import { dragStyle, useDragPosition } from "@/lib/use-drag";

/**
 * Transaction feed panel (bottom-left of the map): recent real transfers, each linking to
 * the block explorer. No normal/suspicious split — every transfer is shown equally.
 */
const EXPLORER: Record<string, string> = {
  ethereum: "https://etherscan.io", arbitrum: "https://arbiscan.io", base: "https://basescan.org",
  optimism: "https://optimistic.etherscan.io", polygon: "https://polygonscan.com", avalanche: "https://snowtrace.io",
  bsc: "https://bscscan.com", gnosis: "https://gnosisscan.io", linea: "https://lineascan.build", scroll: "https://scrollscan.com",
  solana: "https://solscan.io", tron: "https://tronscan.org/#", sui: "https://suivision.xyz",
  aptos: "https://explorer.aptoslabs.com", starknet: "https://starkscan.co",
};
const KIND_LABEL: Record<FlowTx["kind"], string> = { deposit: "예치", withdraw: "출금", swap: "스왑", mint: "민트", burn: "소각", wrap: "랩", unwrap: "언랩", transfer: "전송" };

export function FlowTxPanel({ txs, txLoading, txAt, txError, graph }: { txs: FlowTx[]; txLoading: boolean; txAt: number | null; txError?: string | null; graph?: FlowGraph | null }) {
  const [open, setOpen] = useState(true);
  const drag = useDragPosition({ withinParent: true }); // 그래프 영역 안에서 끌어서 이동
  // float the transactions that ACTUALLY render on the graph (counterparty resolves to a node) to the top
  const { recent, onGraph, shown, mb } = useMemo(() => {
    // SAME plan TxFlowLayer renders (same nodes/edges/txs/cap) → `shown` EXACTLY equals the animated count.
    const plan = buildRenderPlan(graph?.nodes ?? [], graph?.edges ?? [], txs);
    // keyed by OBJECT identity, not hash — one hash can yield two FlowTx legs (token A + token B)
    // and only the routed leg should be marked as on-graph.
    const rendered = new Set<FlowTx>(plan.map((p) => p.tx));
    const isOn = (t: FlowTx) => rendered.has(t);
    const on: FlowTx[] = [], off: FlowTx[] = [];
    for (const t of txs) (isOn(t) ? on : off).push(t);
    const mintburn = txs.filter((t) => t.kind === "mint" || t.kind === "burn").length;
    return { recent: [...on, ...off].slice(0, 300), onGraph: isOn, shown: plan.length, mb: mintburn };
  }, [txs, graph]);
  return (
    <div data-drag-root style={dragStyle(drag.pos)} className="absolute bottom-3 left-3 z-10 w-80 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/95 p-3 shadow-xl backdrop-blur">
      <button
        onPointerDown={drag.onPointerDown}
        onClick={() => { if (!drag.consumeMoved()) setOpen((o) => !o); }}
        className="flex w-full cursor-grab items-center gap-2 text-[11px] active:cursor-grabbing"
        title="클릭: 접기/펼치기 · 끌기: 이동"
      >
        <GripVertical size={12} className="text-[var(--color-text-muted)]" />
        <Zap size={13} className="text-[var(--color-accent)]" /><span className="font-semibold text-[var(--color-text-primary)]">트랜잭션 흐름</span>
        <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">{txLoading ? "수집 중…" : txAt ? `갱신 ${Math.round((Date.now() - txAt) / 1000)}초 전` : ""}</span>
        {open ? <ChevronDown size={13} className="text-[var(--color-text-muted)]" /> : <ChevronUp size={13} className="text-[var(--color-text-muted)]" />}
      </button>
      {!open ? null : <>
      {txError && <div className="mt-1 rounded bg-[rgba(239,68,68,0.1)] px-1.5 py-0.5 text-[10px] text-[#b91c1c]">피드 오류: {txError} — 아래 목록은 불완전할 수 있음</div>}
      <div className="mt-1.5 flex items-center gap-2 text-[11px]">
        <span className="flex items-center gap-1 font-medium text-[var(--color-text-primary)]"><span className="size-2 rounded-full bg-[#6366f1]" />그래프 흐름 {shown}건</span>
        {mb > 0 && <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">발행소각 {mb}건</span>}
      </div>
      {recent.length > 0 ? (
        <div className="mt-2 max-h-72 space-y-0.5 overflow-y-auto border-t border-[var(--color-border-subtle)] pt-1.5">
          {recent.map((t, i) => (
            <a key={`${t.hash}-${i}`} href={`${EXPLORER[t.chain] ?? EXPLORER.ethereum}${t.chain === "tron" ? "/transaction/" : t.chain === "aptos" ? "/txn/" : t.chain === "sui" ? "/txblock/" : "/tx/"}${t.hash}`} target="_blank" rel="noreferrer"
              className={"flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px] hover:bg-[var(--color-surface-raised)] " + (onGraph(t) ? "" : "opacity-60")} title={onGraph(t) ? `그래프 흐름: ${t.counterparty}` : "그래프 미표시 전송"}>
              <span className={"size-1.5 shrink-0 rounded-full " + (onGraph(t) ? "bg-[#6366f1]" : "bg-[var(--color-border-strong)]")} />
              <span className="font-medium text-[var(--color-text-primary)]">{t.token}</span>
              <span className="text-[var(--color-text-muted)]">{t.kind === "transfer" ? "↔" : t.direction === "in" ? "▸" : "◂"} {KIND_LABEL[t.kind]}{t.counterparty ? ` · ${t.counterparty}` : ""}</span>
              <span className="ml-auto font-mono text-[var(--color-text-secondary)]">{formatUsd(t.valueUsd)}</span>
              <span className="font-mono text-[9px] text-[var(--color-text-muted)]">{new Date(t.ts * 1000).toLocaleTimeString("ko-KR", { hour12: false })}</span>
              <ExternalLink size={9} className="text-[var(--color-text-muted)]" />
            </a>
          ))}
        </div>
      ) : <div className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">{txLoading ? "수집 중…" : "최근 윈도우에 전송 없음"}</div>}
      </>}
    </div>
  );
}
