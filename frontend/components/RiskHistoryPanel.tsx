"use client";

/**
 * 위험 히스토리 패널 — 우측 사이드에 "이 토큰의 알림(위험) 기록"만 보여주는 경량 패널.
 * (구 TokenDossier 의 Tier1~3·부실채권 표·오라클 분류·큐레이터 리스트는 제거 — 그래프로 대체)
 */

import { AlertTriangle } from "lucide-react";
import { useState } from "react";

interface AlertRow { created_at: string; severity: string; kind: string; message: string; source: string }

const sevColor = (s: string) => (s === "critical" ? "var(--color-danger)" : s === "warning" ? "#fbbf24" : "#60a5fa");

export function RiskHistoryPanel({
  alerts,
  counts,
  loading,
}: {
  alerts: AlertRow[];
  counts: Record<string, number>;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? alerts.slice(0, 50) : alerts.slice(0, 8);

  return (
    <div className="space-y-3">
      {/* 심각도 카운트 */}
      <div className="flex items-center gap-2">
        <SevPill n={counts.critical ?? 0} color="var(--color-danger)" label="critical" />
        <SevPill n={counts.warning ?? 0} color="#fbbf24" label="warning" />
        <SevPill n={counts.info ?? 0} color="#60a5fa" label="info" />
      </div>

      {/* 히스토리 */}
      {loading ? (
        <div className="text-[11px] text-[var(--color-text-muted)]">위험 히스토리 로딩…</div>
      ) : alerts.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border-subtle)] px-3 py-6 text-center text-[11px] text-[var(--color-text-muted)]">
          기록된 알림 없음
        </div>
      ) : (
        <div className="space-y-1.5">
          {shown.map((a, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
              <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: sevColor(a.severity) }} />
              <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                {new Date(a.created_at).toISOString().slice(5, 16).replace("T", " ")}
              </span>
              <span className="text-[var(--color-text-secondary)]">{a.message}</span>
            </div>
          ))}
          {alerts.length > 8 && (
            <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline">
              <AlertTriangle size={11} /> {open ? "접기" : `전체 ${alerts.length}건 보기`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SevPill({ n, color, label }: { n: number; color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: `${color}22`, color }}>
      <span className="font-semibold">{n}</span> {label}
    </span>
  );
}
