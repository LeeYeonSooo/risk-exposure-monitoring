"use client";

import { useMemo, useState } from "react";
import { BarChart3, ChevronDown, ChevronUp, GripVertical } from "lucide-react";

import { formatUsd } from "@/lib/api";
import type { BaselineState } from "./useFlowData";
import { dragStyle, useDragPosition } from "@/lib/use-drag";

/**
 * 평소 모드 패널 (좌하단): 평소 흐름이 큰 엣지 톱 목록(시간당 거래액·거래수) + 토큰별 관측
 * 커버리지를 정직하게 표기 — 페이지 캡으로 24h 를 못 본 토큰은 실제 관측 구간을 그대로 보여준다.
 */
const KIND_LABEL: Record<string, string> = { deposit: "예치", withdraw: "출금", swap: "스왑", wrap: "랩(발행)", unwrap: "언랩(상환)" };

export function FlowBaselinePanel({ baseline, loading }: { baseline: BaselineState; loading: boolean }) {
  const [open, setOpen] = useState(false); // 기본 접힘 — 그래프를 가리지 않게, 클릭으로 펼침
  const drag = useDragPosition({ withinParent: true });
  const top = useMemo(() => [...baseline.rows].sort((a, b) => b.usdPerHour - a.usdPerHour).slice(0, 16), [baseline.rows]);
  const notes = useMemo(() => {
    const out: string[] = [];
    for (const c of baseline.coverage) {
      if (c.truncated) out.push(`${c.token}: 최근 ${(c.observedSec / 3600).toFixed(1)}h 관측 (전송량이 많아 24h 전체를 못 봄 — 레이트는 관측구간 기준)`);
    }
    return out;
  }, [baseline.coverage]);

  return (
    <div data-drag-root style={dragStyle(drag.pos)} className="absolute bottom-3 left-3 z-10 w-[340px] rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/95 p-3 shadow-xl backdrop-blur">
      <button
        onPointerDown={drag.onPointerDown}
        onClick={() => { if (!drag.consumeMoved()) setOpen((o) => !o); }}
        className="flex w-full cursor-grab items-center gap-2 text-[11px] active:cursor-grabbing"
        title="클릭: 접기/펼치기 · 끌기: 이동"
      >
        <GripVertical size={12} className="text-[var(--color-text-muted)]" />
        <BarChart3 size={13} className="text-[var(--color-accent)]" /><span className="font-semibold text-[var(--color-text-primary)]">평소 흐름 (24h 집계)</span>
        <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">{loading ? "집계 중…" : baseline.at ? `갱신 ${Math.round((Date.now() - baseline.at) / 1000)}초 전` : ""}</span>
        {open ? <ChevronDown size={13} className="text-[var(--color-text-muted)]" /> : <ChevronUp size={13} className="text-[var(--color-text-muted)]" />}
      </button>
      {!open ? null : <>
      {baseline.error && <div className="mt-1 rounded bg-[rgba(239,68,68,0.1)] px-1.5 py-0.5 text-[10px] text-[#b91c1c]">집계 오류: {baseline.error}</div>}
      {top.length > 0 ? (
        <div className="mt-2 max-h-72 space-y-0.5 overflow-y-auto border-t border-[var(--color-border-subtle)] pt-1.5">
          {top.map((r, i) => (
            <div key={`${r.token}-${r.counterparty}-${r.direction}-${i}`} className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px]">
              <span className="w-4 shrink-0 text-right font-mono text-[9px] text-[var(--color-text-muted)]">{i + 1}</span>
              <span className="font-medium text-[var(--color-text-primary)]">{r.token}</span>
              <span className="text-[var(--color-text-muted)]">{r.direction === "in" ? "▸" : "◂"} {KIND_LABEL[r.kind] ?? r.kind} · {r.counterparty}</span>
              <span className="ml-auto font-mono text-[var(--color-text-secondary)]">{formatUsd(r.usdPerHour)}/h</span>
              <span className="w-12 shrink-0 text-right font-mono text-[9px] text-[var(--color-text-muted)]">{r.txPerHour >= 10 ? Math.round(r.txPerHour) : r.txPerHour.toFixed(1)} tx/h</span>
            </div>
          ))}
        </div>
      ) : <div className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">{loading ? "집계 중… (24h 전송 페이지를 읽는 중)" : "집계된 평소 흐름 없음"}</div>}
      {notes.length > 0 && (
        <div className="mt-1.5 space-y-0.5 border-t border-[var(--color-border-subtle)] pt-1.5">
          {notes.slice(0, 5).map((n, i) => <div key={i} className="text-[9px] leading-snug text-[var(--color-text-muted)]">· {n}</div>)}
        </div>
      )}
      <div className="mt-1.5 border-t border-[var(--color-border-subtle)] pt-1.5 text-[9px] leading-snug text-[var(--color-text-muted)]">
        집계원: 렌딩(aave·spark·compound·fluid·euler)·lido·sky·ethena·ether.fi·모르포 볼트 = 프로토콜 이벤트 로그 <b>24h 전수</b> · DEX = 일거래량(DeFiLlama) · 그 외 = 전송 스캔(관측구간 표기).
        <br />그래프: 입자 색 = 선택 토큰(파생/LP=회색) · 차선 위치로 방향 표시(정방향=유입·역방향=유출, 실측 평균) · 반투명 입자=거래량 기반(방향 미상). 색 있는 엣지·노드 = 평소 흐름 존재.
      </div>
      </>}
    </div>
  );
}
