"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, GripVertical, X } from "lucide-react";

import { alertFlowHref } from "@/lib/alert-link";
import { dragStyle, useDragPosition } from "@/lib/use-drag";

/**
 * 우측 중단 미니 알림 패널 (토스트 대체).
 *  · 접힘: 종 버튼 — 새 알림(마지막으로 열어본 이후)이 있으면 빨간 점
 *  · 펼침: 반투명 패널, 심각도별 칸 색(위험=빨강/주의=노랑/정보=초록),
 *    한 번에 최대 4건 높이 + 나머지는 스크롤 (DB /api/alerts 그대로, 가공 없음)
 *  · 종 버튼·패널 모두 끌어서 이동 가능 (패널은 헤더를 잡고)
 */

interface AlertItem { id: number | string; created_at: string; snapshot_ts?: string | null; severity: string; kind: string; token: string; message: string; protocol_node_id?: string | null; detail?: Record<string, unknown> | null }

const SEV: Record<string, { dot: string; label: string; row: string }> = {
  critical: { dot: "#ef4444", label: "위험", row: "rgba(239,68,68,0.20)" },
  warning: { dot: "#f59e0b", label: "주의", row: "rgba(251,191,36,0.22)" },
  info: { dot: "#10b981", label: "정보", row: "rgba(16,185,129,0.18)" },
};

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export function AlertDock() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [open, setOpen] = useState(false);
  // "마지막으로 열어본 시점" 이후 알림이 있으면 빨간 점. 첫 로딩은 기준점만 잡는다.
  const baselineTs = useRef<number | null>(null);
  const drag = useDragPosition();

  useEffect(() => {
    let alive = true;
    const poll = () => {
      fetch("/api/alerts?limit=100", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          const rows: AlertItem[] = d.alerts ?? [];
          setAlerts(rows);
          if (baselineTs.current === null && rows.length) baselineTs.current = new Date(rows[0].created_at).getTime();
        })
        .catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 10_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // 펼쳐져 있는 동안엔 본 것으로 간주 — 기준점을 최신으로 유지
  useEffect(() => {
    if (open && alerts.length) baselineTs.current = new Date(alerts[0].created_at).getTime();
  }, [open, alerts]);

  const hasNew = useMemo(() => {
    const base = baselineTs.current;
    if (base === null) return false;
    return alerts.some((a) => new Date(a.created_at).getTime() > base);
  }, [alerts]);

  if (!open) {
    return (
      <button
        data-drag-root
        onPointerDown={drag.onPointerDown}
        onClick={() => { if (!drag.consumeMoved()) setOpen(true); }}
        title={`알림 ${alerts.length}건${hasNew ? " · 새 알림 있음" : ""} (끌어서 이동)`}
        style={dragStyle(drag.pos)}
        className="fixed right-3 top-1/2 z-[90] -translate-y-1/2 cursor-grab rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/80 p-2.5 shadow-lg backdrop-blur-md hover:bg-[var(--color-surface-raised)] active:cursor-grabbing"
      >
        <Bell size={16} className="text-[var(--color-text-secondary)]" />
        {hasNew && (
          <span className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-[#ef4444] ring-2 ring-[var(--color-surface)]" />
        )}
      </button>
    );
  }

  return (
    <div
      data-drag-root
      style={dragStyle(drag.pos)}
      className="fixed right-3 top-1/2 z-[90] flex w-72 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/60 shadow-xl backdrop-blur-md"
    >
      <div
        onPointerDown={drag.onPointerDown}
        className="flex cursor-grab items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2.5 py-2 active:cursor-grabbing"
        title="끌어서 이동"
      >
        <GripVertical size={12} className="text-[var(--color-text-muted)]" />
        <Bell size={13} className="text-[var(--color-accent)]" />
        <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">알림</span>
        <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{alerts.length}건</span>
        <button
          onClick={() => { if (!drag.consumeMoved()) setOpen(false); }}
          className="ml-auto rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"
          title="접기"
        >
          <X size={13} />
        </button>
      </div>

      {alerts.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-[var(--color-text-muted)]">알림 없음</div>
      ) : (
        // 행 높이 ≈ 56px — 한 번에 최대 4건(224px)까지만 보이고 나머지는 스크롤
        <div className="max-h-[224px] min-h-0 flex-1 overflow-y-auto">
          {alerts.map((a) => {
            const s = SEV[a.severity] ?? SEV.info;
            return (
              <a
                key={String(a.id)}
                href={alertFlowHref(a)}
                title="클릭: 이 알림의 토큰·체인만 선택된 흐름맵으로"
                style={{ background: s.row }}
                className="block border-b border-white/40 px-2.5 py-1.5 last:border-b-0 hover:brightness-95"
              >
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: s.dot }} />
                  <span className="font-semibold text-[var(--color-text-primary)]">{a.token}</span>
                  <span className="font-medium" style={{ color: s.dot }}>{s.label}</span>
                  <span className="ml-auto shrink-0 text-[9px] text-[var(--color-text-muted)]">{ago(a.created_at)}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-[var(--color-text-secondary)]">{a.message}</div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
