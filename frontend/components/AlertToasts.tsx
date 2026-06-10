"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, X } from "lucide-react";

/**
 * 알림 독 — 사라지는 토스트 대신 "쌓이는" 우측 패널.
 *   · 우상단 벨 버튼(미확인 수 배지, critical 도착 시 펄스) → 클릭하면 패널 토글.
 *   · 패널: 최근 알림 누적 목록(심각도 점·토큰·메시지·시각), 심각도 필터 칩, 스크롤.
 *   · 데이터는 /api/alerts 폴링(5초) — DB가 원본이므로 새로고침해도 이력이 유지된다.
 * (export 이름은 AlertToasts 유지 — 사용처 무변경.)
 */

interface AlertItem { id: string; created_at: string; severity: string; kind?: string; token: string; message: string }

const SEV: Record<string, { dot: string; label: string }> = {
  critical: { dot: "#ef4444", label: "위험" },
  warning: { dot: "#f59e0b", label: "주의" },
  info: { dot: "#10b981", label: "정보" },
};
const SEV_KEYS = ["critical", "warning", "info"] as const;

function timeKo(ts: string): string {
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "방금";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function AlertToasts() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Set<string>>(new Set(SEV_KEYS));
  const [unseen, setUnseen] = useState(0);
  const [pulse, setPulse] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    let alive = true;
    const poll = () => {
      fetch("/api/alerts?limit=80", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          const rows: AlertItem[] = d.alerts ?? [];
          if (!rows.length) return;
          setAlerts(rows);
          // 미확인 카운트 — 첫 로드는 "이미 본 것"으로 간주(이력), 이후 새 id 만 센다.
          const fresh = rows.filter((a) => !seen.current.has(a.id));
          for (const a of rows) seen.current.add(a.id);
          if (firstLoad.current) { firstLoad.current = false; return; }
          if (fresh.length && !openRef.current) {
            setUnseen((u) => u + fresh.length);
            if (fresh.some((a) => a.severity === "critical")) { setPulse(true); setTimeout(() => setPulse(false), 2600); }
          }
        })
        .catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const visible = useMemo(() => alerts.filter((a) => filter.has(a.severity)), [alerts, filter]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, warning: 0, info: 0 };
    for (const a of alerts) c[a.severity] = (c[a.severity] ?? 0) + 1;
    return c;
  }, [alerts]);

  const toggleSev = (s: string) => setFilter((p) => { const n = new Set(p); if (n.has(s)) { if (n.size > 1) n.delete(s); } else n.add(s); return n; });

  return (
    <>
      {/* 벨 버튼 — 미확인 배지 */}
      <button
        onClick={() => { setOpen((o) => !o); setUnseen(0); }}
        title="알림 패널"
        className="fixed right-4 top-[60px] z-[100] flex items-center justify-center rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-md transition-transform hover:scale-105"
        style={{ width: 38, height: 38, animation: pulse ? "alertpulse 0.65s ease-in-out 4" : undefined }}
      >
        <Bell size={16} className="text-[var(--color-text-secondary)]" />
        {unseen > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[#ef4444] px-1 text-[9px] font-bold text-white">
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>
      <style>{`@keyframes alertpulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); } 50% { box-shadow: 0 0 0 9px rgba(239,68,68,0); } }`}</style>

      {/* 쌓이는 패널 */}
      {open && (
        <div className="fixed right-4 top-[104px] z-[100] flex max-h-[68vh] w-[330px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl">
          <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
            <Bell size={13} className="text-[var(--color-accent)]" />
            <span className="text-[12px] font-bold text-[var(--color-text-primary)]">알림 이력</span>
            <span className="text-[10px] text-[var(--color-text-muted)]">최근 {alerts.length}건</span>
            <button onClick={() => setOpen(false)} className="ml-auto rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"><X size={13} /></button>
          </div>
          <div className="flex items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
            {SEV_KEYS.map((s) => {
              const on = filter.has(s);
              return (
                <button key={s} onClick={() => toggleSev(s)}
                  className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors"
                  style={{ borderColor: on ? `${SEV[s].dot}66` : "var(--color-border-subtle)", color: on ? SEV[s].dot : "var(--color-text-muted)", background: on ? `${SEV[s].dot}12` : "transparent" }}>
                  <span className="size-1.5 rounded-full" style={{ background: SEV[s].dot, opacity: on ? 1 : 0.35 }} />
                  {SEV[s].label} {counts[s] ?? 0}
                </button>
              );
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-[var(--color-text-muted)]">표시할 알림 없음</div>}
            {visible.map((a) => {
              const s = SEV[a.severity] ?? SEV.info;
              return (
                <div key={a.id} className="border-b border-[var(--color-border-subtle)] px-3 py-2 last:border-b-0 hover:bg-[var(--color-surface-raised)]/50">
                  <div className="flex items-center gap-1.5 text-[10.5px]">
                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: s.dot }} />
                    <span className="font-bold text-[var(--color-text-primary)]">{a.token}</span>
                    <span className="font-semibold" style={{ color: s.dot }}>{s.label}</span>
                    {a.kind && <span className="truncate text-[var(--color-text-muted)]">{a.kind}</span>}
                    <span className="ml-auto shrink-0 text-[9.5px] text-[var(--color-text-muted)]">{timeKo(a.created_at)}</span>
                  </div>
                  <div className="mt-0.5 line-clamp-3 text-[10.5px] leading-snug text-[var(--color-text-secondary)]">{a.message}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
