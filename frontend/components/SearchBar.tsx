"use client";

import { Search, Wallet, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GraphNode } from "@/lib/api";

export interface SearchBarProps {
  /** 전체 노드 풀 — 검색 후보 */
  nodes: GraphNode[];
  /** 검색 시 매치된 노드 ID set — 그래프 highlight 용 */
  focusIds: Set<string> | null;
  onFocusIdsChange: (ids: Set<string> | null) => void;
  /** Wallet import 트리거 — 부모가 백엔드 호출 후 결과 노드 ID 셋 반환 */
  onImportWallet: (address: string) => Promise<{ nodeIds: string[]; label?: string } | null>;
  /** 체인 필터 — 같은 바 안에 인라인으로 표시 (>1 체인일 때만). null = 전체 */
  chains?: string[];
  activeChain?: string | null;
  onSelectChain?: (chain: string | null) => void;
}

export function SearchBar({
  nodes,
  focusIds,
  onFocusIdsChange,
  onImportWallet,
  chains,
  activeChain,
  onSelectChain,
}: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [walletInput, setWalletInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedLabel, setImportedLabel] = useState<string | null>(null);
  const [open, setOpen] = useState(false); // suggestion dropdown
  const inputRef = useRef<HTMLInputElement>(null);
  // query 가 사용자가 타이핑한 건지(focus 동기화로 덮어쓰면 안 됨) 추적
  const querySourceRef = useRef<"user" | "focus">("focus");

  // 텍스트 검색 — 라벨/심볼 부분 일치
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes
      .filter((n) => {
        return (
          n.label.toLowerCase().includes(q) ||
          (n.metadata.symbol ?? "").toLowerCase().includes(q) ||
          n.id.toLowerCase().includes(q)
        );
      })
      .slice(0, 10);
  }, [nodes, query]);

  const applyQuery = (n: GraphNode) => {
    onFocusIdsChange(new Set([n.id]));
    setQuery(n.label);
    setOpen(false);
    inputRef.current?.blur();
  };

  const clearAll = () => {
    setQuery("");
    setWalletInput("");
    setImportError(null);
    setImportedLabel(null);
    onFocusIdsChange(null);
  };

  const handleImport = async () => {
    if (!walletInput.trim()) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await onImportWallet(walletInput.trim());
      if (!res || res.nodeIds.length === 0) {
        setImportError("이 주소의 노출이 매핑된 protocol에서 발견되지 않음.");
        onFocusIdsChange(null);
        setImportedLabel(null);
      } else {
        onFocusIdsChange(new Set(res.nodeIds));
        setImportedLabel(res.label ?? walletInput.trim().slice(0, 10) + "…");
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Import 실패");
    } finally {
      setImporting(false);
    }
  };

  // ESC 키로 입력창 닫기
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // focusIds ↔ 검색창 동기화 — 노드 클릭(외부 focus 설정)을 검색창에 반영.
  //   단일 노드 focus → 그 라벨 표시 / focus 해제 → (focus 가 채웠던 경우만) 비움.
  //   사용자가 타이핑 중(querySource='user')이면 덮어쓰지 않음.
  useEffect(() => {
    if (focusIds && focusIds.size === 1) {
      const id = [...focusIds][0];
      const label = nodes.find((n) => n.id === id)?.label;
      if (label && label !== query) {
        querySourceRef.current = "focus";
        setQuery(label);
      }
    } else if ((!focusIds || focusIds.size === 0) && querySourceRef.current === "focus") {
      if (query !== "") setQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIds, nodes]);

  const active = focusIds !== null && focusIds.size > 0;

  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/95 px-2 py-1.5 shadow-lg backdrop-blur">
      {/* Search input */}
      <div className="relative">
        <Search
          size={14}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            querySourceRef.current = "user";
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search token / protocol…"
          className="w-[230px] rounded-md bg-[var(--color-surface-raised)] py-1.5 pl-7 pr-2 text-[12px] outline-none placeholder:text-[var(--color-text-muted)] focus:ring-1 focus:ring-[var(--color-accent)]"
        />
        {open && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl">
            {suggestions.map((n) => (
              <button
                key={n.id}
                onClick={() => applyQuery(n)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-raised)]"
              >
                <span className="truncate text-[var(--color-text-primary)]">{n.label}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                  {n.type}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Wallet import */}
      <div className="flex items-center gap-1 border-l border-[var(--color-border-subtle)] pl-2">
        <Wallet size={14} className="text-[var(--color-text-muted)]" />
        <input
          value={walletInput}
          onChange={(e) => setWalletInput(e.target.value)}
          placeholder="0x… wallet"
          className="w-[180px] rounded-md bg-[var(--color-surface-raised)] px-2 py-1.5 text-[11px] font-mono outline-none placeholder:text-[var(--color-text-muted)] focus:ring-1 focus:ring-[var(--color-accent)]"
          onKeyDown={(e) => e.key === "Enter" && handleImport()}
        />
        <button
          onClick={handleImport}
          disabled={importing || !walletInput.trim()}
          className="rounded-md bg-[var(--color-accent)] px-2 py-1.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {importing ? "…" : "Import"}
        </button>
      </div>

      {/* 체인 필터 — 같은 바 안 인라인 */}
      {chains && chains.length > 1 && onSelectChain && (
        <div className="flex items-center gap-1 border-l border-[var(--color-border-subtle)] pl-2">
          <span className="pr-0.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            체인
          </span>
          {([null, ...chains] as (string | null)[]).map((ch) => {
            const on = (activeChain ?? null) === ch;
            const label = ch === null ? "All" : ch.charAt(0).toUpperCase() + ch.slice(1);
            return (
              <button
                key={ch ?? "all"}
                onClick={() => onSelectChain(ch)}
                className={
                  "rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors " +
                  (on
                    ? "bg-[var(--color-accent)] text-white"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]")
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Active indicator + clear */}
      {active && (
        <button
          onClick={clearAll}
          className="flex items-center gap-1 rounded-md bg-[var(--color-accent)]/10 px-2 py-1 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20"
        >
          <X size={12} />
          {importedLabel ?? `${focusIds.size} active`}
        </button>
      )}

      {importError && (
        <span className="text-[10px] text-[var(--color-danger)]">{importError}</span>
      )}
    </div>
  );
}
