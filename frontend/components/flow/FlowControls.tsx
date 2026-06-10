"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

import { formatUsd } from "@/lib/api";

/**
 * 흐름맵 control bar (transaction-only): 체인 · 토큰. Presentational (state lives in the page).
 */
export function FlowControls({
  chains, toggleChain, chainOptions, tokens, addToken, removeToken, universe,
}: {
  chains: string[];
  toggleChain: (key: string) => void;
  chainOptions: { key: string; label: string }[];
  tokens: string[];
  addToken: (t: string) => void;
  removeToken: (t: string) => void;
  universe: { symbol: string; tvlUsd: number; pct: number }[];
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [q, setQ] = useState("");
  const addable = useMemo(
    () => universe.filter((s) => !tokens.some((t) => t.toUpperCase() === s.symbol.toUpperCase()) && (!q || s.symbol.toLowerCase().includes(q.toLowerCase()))),
    [universe, tokens, q],
  );

  return (
    <>
      {/* chains */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">체인</span>
        <div className="flex flex-wrap items-center gap-1">
          {chainOptions.map((c) => {
            const on = chains.includes(c.key);
            return (
              <button key={c.key} onClick={() => toggleChain(c.key)}
                className={"rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors " + (on ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent-dim)]" : "border-[var(--color-border-subtle)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]")}>
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* tokens */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">토큰</span>
        <div className="flex flex-wrap items-center gap-1">
          {tokens.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded-md bg-[var(--color-surface-raised)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-primary)]">
              {t}<button onClick={() => removeToken(t)} className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><X size={11} /></button>
            </span>
          ))}
          <div className="relative">
            <button onClick={() => setAddOpen((o) => !o)} className="flex items-center gap-0.5 rounded-md border border-dashed border-[var(--color-border-strong)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
              <Plus size={11} /> 토큰
            </button>
            {addOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-1.5 shadow-xl">
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`실시간 토큰 검색 (TVL순 · ${universe.length}개)`}
                  className="mb-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-2 py-1 text-[12px] outline-none focus:border-[var(--color-accent)]" />
                <div className="max-h-72 overflow-y-auto">
                  {universe.length === 0 ? <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">로딩…</div> :
                    addable.length === 0 ? <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">결과 없음</div> :
                    addable.map((s) => (
                      <button key={s.symbol} onClick={() => { addToken(s.symbol); setQ(""); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-[var(--color-surface-raised)]">
                        <span className="flex-1 truncate font-medium text-[var(--color-text-primary)]">{s.symbol}</span>
                        <span className="font-mono text-[10px] text-[var(--color-text-secondary)]">{formatUsd(s.tvlUsd)}</span>
                        <span className="w-9 text-right font-mono text-[9px] text-[var(--color-text-muted)]">{(s.pct * 100).toFixed(1)}%</span>
                      </button>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
