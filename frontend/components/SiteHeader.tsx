"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const TOGGLE_NAV = [
  { href: "/", label: "검색" },
  { href: "/multi", label: "비교" },
];

const EXTRA_NAV: { href: string; label: string }[] = [];

interface Health { dbConnected: boolean; lastSnapshot?: string | null; tokenCount?: number }

export function SiteHeader({
  riskCounts,
}: {
  riskCounts?: { safe: number; caution: number; danger: number };
}) {
  const pathname = usePathname();
  // 데이터 신선도 — /api/health 1분마다. cron 꺼짐/DB 끊김/폴백 의심을 한눈에 해소.
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch("/api/health", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (live) setHealth(j); }).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-5">
      <div className="flex items-center gap-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight">Chain Spiral</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">v0.2</span>
        </Link>
        <nav className="flex items-center gap-3">
          {/* Toggle group: Live / Simulation */}
          <div className="flex items-center gap-0.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-0.5">
            {TOGGLE_NAV.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm font-medium transition-all",
                    active
                      ? "bg-[var(--color-accent)] text-white shadow-sm"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* Separator */}
          <span className="h-4 w-px bg-[var(--color-border-subtle)]" />

          {/* Regular nav: Backtest */}
          {EXTRA_NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "text-sm transition-colors",
                  active
                    ? "text-[var(--color-text-primary)] font-medium"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center gap-4 text-xs text-[var(--color-text-muted)]">
        <Freshness health={health} />
        {riskCounts && (
          <>
            <span className="hidden h-4 w-px bg-[var(--color-border-subtle)] sm:block" />
            <LegendDot color="var(--color-healthy)" label={`safe ${riskCounts.safe}`} />
            <LegendDot color="var(--color-caution)" label={`caution ${riskCounts.caution}`} />
            <LegendDot color="var(--color-danger)" label={`danger ${riskCounts.danger}`} />
          </>
        )}
      </div>
    </header>
  );
}

/** 데이터 신선도 배지 — 마지막 스냅샷 경과시간으로 라이브/stale 판정. */
function Freshness({ health }: { health: Health | null }) {
  if (!health) return null; // 로딩 중(서버 렌더 시 null → 하이드레이션 mismatch 없음)
  let color = "#94a3b8";
  let text = "스냅샷 없음";
  let title = "DB 에 스냅샷이 아직 없습니다 — 첫 snapshot 필요.";
  if (!health.dbConnected) {
    color = "#f87171"; text = "DB 연결 안 됨"; title = "DATABASE_URL 불일치 또는 DB 미기동.";
  } else if (health.lastSnapshot) {
    const min = Math.max(0, Math.round((Date.now() - new Date(health.lastSnapshot).getTime()) / 60000));
    const tok = health.tokenCount ?? 0;
    if (min < 90) { color = "#34d399"; text = `라이브 · ${min}분 전`; title = `${tok}개 토큰 · 마지막 스냅샷 ${min}분 전 (cron 동작 중)`; }
    else if (min < 1440) { color = "#fbbf24"; text = `${Math.round(min / 60)}시간 전`; title = `${tok}개 토큰 · cron 이 꺼져 있을 수 있음(데이터 ${Math.round(min / 60)}시간 경과)`; }
    else { color = "#fb923c"; text = `${Math.round(min / 1440)}일 전 · cron?`; title = `${tok}개 토큰 · 데이터 ${Math.round(min / 1440)}일 경과 — cron 미가동 가능성. ./start.sh 로 라이브 갱신.`; }
  }
  return (
    <span className="flex items-center gap-1.5 font-medium" title={title} style={{ color }}>
      <span className="inline-block size-2 rounded-full" style={{ backgroundColor: color }} />
      {text}
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block size-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
