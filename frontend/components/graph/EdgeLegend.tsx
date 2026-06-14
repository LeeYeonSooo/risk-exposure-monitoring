"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { EDGE_TYPE_COLORS, EDGE_TYPE_LABELS } from "@/lib/edge-colors";

/**
 * 엣지 타입 범례 + 필터 — 그래프 좌하단. 접기/펴기.
 * 항목을 클릭하면 그 타입만 보기(다중 선택). 비어있으면 전체 표시.
 * 현재 그래프에 존재하는 타입만 노출.
 */
export function EdgeLegend({
  presentTypes,
  activeTypes,
  onToggleType,
  onClear,
}: {
  presentTypes?: Set<string>;
  /** 비어있으면 전체. 채워지면 그 타입만 보기. */
  activeTypes?: Set<string>;
  onToggleType?: (type: string) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(true);

  const entries = Object.entries(EDGE_TYPE_COLORS).filter(
    ([t]) => !presentTypes || presentTypes.size === 0 || presentTypes.has(t),
  );
  if (entries.length === 0) return null;

  const filtering = !!activeTypes && activeTypes.size > 0;
  const interactive = !!onToggleType;

  return (
    <div className="pointer-events-auto absolute bottom-4 left-4 z-30 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/90 px-3 py-2 text-[11px] shadow-lg backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center justify-between gap-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <span className="font-medium uppercase tracking-wider">
            엣지 타입{interactive ? " · 필터" : ""}
          </span>
          {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        {filtering && onClear && (
          <button
            onClick={onClear}
            className="flex items-center gap-0.5 rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25"
            title="필터 해제"
          >
            <X size={10} /> {activeTypes!.size}
          </button>
        )}
      </div>
      {open && (
        <>
          <ul className="mt-1.5 space-y-0.5">
            {entries.map(([type, color]) => {
              const on = !filtering || activeTypes!.has(type);
              const row = (
                <>
                  <span
                    className="h-0.5 w-4 shrink-0 rounded-full"
                    style={{ backgroundColor: color, opacity: on ? 1 : 0.3 }}
                  />
                  <span
                    className={
                      on
                        ? "text-[var(--color-text-secondary)]"
                        : "text-[var(--color-text-muted)] opacity-50"
                    }
                  >
                    {EDGE_TYPE_LABELS[type] ?? type}
                  </span>
                </>
              );
              return interactive ? (
                <li key={type}>
                  <button
                    onClick={() => onToggleType!(type)}
                    className={
                      "flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--color-surface-raised)] " +
                      (filtering && on ? "bg-[var(--color-surface-raised)]" : "")
                    }
                    title="이 타입만 보기 (다중 선택)"
                  >
                    {row}
                  </button>
                </li>
              ) : (
                <li key={type} className="flex items-center gap-2 px-1 py-0.5">
                  {row}
                </li>
              );
            })}
          </ul>
          {/* 데이터 출처 3단계 — 실선=온체인 검증 / 점선=DeFiLlama 추정 / 점점선=검증불가(DD 불가) */}
          <div className="mt-2 space-y-1 border-t border-[var(--color-border-subtle)] pt-1.5">
            <div className="flex items-center gap-2">
              <span className="h-0.5 w-4 shrink-0 rounded-full" style={{ backgroundColor: "#cbd5e1" }} />
              <span className="text-[var(--color-text-secondary)]">온체인 검증</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="w-4 shrink-0"
                style={{ borderTop: "2px dashed #cbd5e1", opacity: 0.5 }}
              />
              <span className="text-[var(--color-text-secondary)]">DeFiLlama 추정 (미검증)</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="w-4 shrink-0"
                style={{ borderTop: "2px dotted #cbd5e1", opacity: 0.4 }}
              />
              <span className="text-[var(--color-text-secondary)]">검증불가 <span className="text-[var(--color-text-muted)]">(정체불명 · DD 불가)</span></span>
            </div>
          </div>
          {/* 화살표 방향 = 예치(자금이 들어가는) 방향. 출금/상환은 같은 화살표를 거꾸로 읽는다 — 가역(역엣지 없음). 감사관 [고정3]. */}
          <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-1.5 leading-snug text-[var(--color-text-muted)]">
            화살표 = 예치 방향(자금이 들어가는 쪽). 출금·상환은 같은 화살표를 <span className="text-[var(--color-text-secondary)]">거꾸로</span> 따라 나간다.
          </div>
        </>
      )}
    </div>
  );
}
