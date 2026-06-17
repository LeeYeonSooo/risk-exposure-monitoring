"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, GripVertical, X } from "lucide-react";

import { alertFlowHref, alertChain } from "@/lib/alert-link";
import { kindLabel, prettyMessage, displayToken, isStaleEvent, isActiveChain } from "@/lib/alert-kinds";
import { SEV_COLOR, SEV_LABEL, SEV_ROW_BG, compareSeverityDesc } from "@/lib/severity";
import { dragStyle, useDragPosition } from "@/lib/use-drag";

/**
 * 우측 중단 미니 알림 패널 (토스트 대체).
 *  · 접힘: 종 버튼 — 새 알림(마지막으로 열어본 이후)이 있으면 빨간 점
 *  · 펼침: 반투명 패널, 심각도 우선 정렬(critical 먼저). 기본은 위험·경고만(정보는 토글)
 *    → info 폭주 시 critical 이 묻히지 않게. 행마다 '확인'(ack) 버튼.
 *  · 종 버튼·패널 모두 끌어서 이동 가능 (패널은 헤더를 잡고)
 *  ※ 백테스트는 메인 페이지 전용 — 흐름맵 등에서 쓰는 이 패널엔 두지 않는다(라이브 알림만).
 */

interface AlertItem { id: number | string; created_at: string; snapshot_ts?: string | null; severity: string; kind: string; token: string; message: string; protocol_node_id?: string | null; detail?: Record<string, unknown> | null }

// 이벤트 관측 시각(snapshot_ts 우선) — 홈 피드와 동일 기준으로 통일.
const eventTime = (a: AlertItem) => new Date(a.snapshot_ts ?? a.created_at).getTime();

function ago(ms: number): string {
  if (!isFinite(ms)) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export function AlertDock() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [open, setOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false); // 기본 위험·경고만
  // "마지막으로 열어본 시점"(이벤트 시각 최댓값) 이후 알림이 있으면 빨간 점.
  const baselineTs = useRef<number | null>(null);
  const drag = useDragPosition();

  const poll = useCallback(() => {
    // 심각도 우선 정렬로 받아 critical 이 limit 안에 들어오게. info 는 토글 시에만.
    const sev = showInfo ? "" : "&severity=critical,warning";
    return fetch(`/api/alerts?limit=100&sort=severity${sev}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        // 비활성 체인(eth/base/arb 외) 알림 숨김. 토큰레벨(chain null)은 유지.
        const rows: AlertItem[] = (d.alerts ?? []).filter((a: AlertItem) => {
          const ch = alertChain(a);
          return ch === null || isActiveChain(ch);
        });
        setAlerts(rows);
        if (baselineTs.current === null && rows.length) {
          baselineTs.current = Math.max(...rows.map(eventTime)); // 정렬 키와 무관하게 실제 최신 시각
        }
      })
      .catch(() => {});
  }, [showInfo]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) poll(); };
    tick();
    // 탭이 보일 때만 폴링(백그라운드 낭비 차단)
    const iv = setInterval(() => { if (document.visibilityState === "visible") tick(); }, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [poll]);

  // 펼쳐져 있는 동안엔 본 것으로 간주 — 기준점을 최신으로 유지
  useEffect(() => {
    if (open && alerts.length) baselineTs.current = Math.max(...alerts.map(eventTime));
  }, [open, alerts]);

  const hasNew = useMemo(() => {
    const base = baselineTs.current;
    if (base === null) return false;
    return alerts.some((a) => eventTime(a) > base);
  }, [alerts]);

  const ack = useCallback((id: number | string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id)); // 낙관적 제거
    fetch(`/api/alerts/${id}/ack`, { method: "POST" }).catch(() => poll());
  }, [poll]);

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
          onClick={() => setShowInfo((v) => !v)}
          className={"ml-auto rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors " + (showInfo ? "bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]")}
          title={showInfo ? "정보 알림 숨기기" : "정보 알림도 보기"}
        >
          정보 {showInfo ? "ON" : "OFF"}
        </button>
        <button
          onClick={() => { if (!drag.consumeMoved()) setOpen(false); }}
          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"
          title="접기"
        >
          <X size={13} />
        </button>
      </div>

      {alerts.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-[var(--color-text-muted)]">활성 알림 없음</div>
      ) : (
        // 행 높이 ≈ 56px — 한 번에 최대 4건(224px)까지만 보이고 나머지는 스크롤
        <div className="max-h-[224px] min-h-0 flex-1 overflow-y-auto">
          {[...alerts]
            .sort((a, b) =>
              (Number(isStaleEvent(a.kind, eventTime(a))) - Number(isStaleEvent(b.kind, eventTime(b))))
              || compareSeverityDesc(a.severity, b.severity) || eventTime(b) - eventTime(a))
            .map((a) => {
            const stale = isStaleEvent(a.kind, eventTime(a));
            const dot = stale ? "#94a3b8" : (SEV_COLOR[a.severity] ?? SEV_COLOR.info);
            const label = SEV_LABEL[a.severity] ?? "정보";
            return (
              <div
                key={String(a.id)}
                style={{ background: stale ? "transparent" : (SEV_ROW_BG[a.severity] ?? SEV_ROW_BG.info), opacity: stale ? 0.55 : 1 }}
                className="group block border-b border-white/10 px-2.5 py-1.5 last:border-b-0 hover:brightness-110"
              >
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: dot }} />
                  <span className="font-semibold text-[var(--color-text-primary)]">{displayToken(a.token)}</span>
                  <span className="font-medium" style={{ color: dot }}>{label}</span>
                  <span className="truncate text-[9px] text-[var(--color-text-muted)]">{kindLabel(a.kind)}</span>
                  <span className="ml-auto shrink-0 text-[9px] text-[var(--color-text-muted)]">{ago(eventTime(a))}</span>
                </div>
                <button
                  onClick={() => router.push(alertFlowHref(a))}
                  title="클릭: 이 알림의 토큰·체인만 선택된 흐름맵으로"
                  className="mt-0.5 block w-full text-left"
                >
                  <span className="line-clamp-2 text-[10px] leading-snug text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">{prettyMessage(a.message, a.kind)}</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); ack(a.id); }}
                  title="확인(해소) — 피드에서 제거"
                  className="mt-0.5 flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-white/10 hover:text-[var(--color-text-secondary)] group-hover:opacity-100"
                >
                  <Check size={10} /> 확인
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
