"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TOGGLE_NAV = [
  { href: "/", label: "검색" },
  { href: "/flow", label: "흐름맵" },
  // EOA 흐름 — 기능 제거(사용자 2026-06-17). 페이지/컴포넌트/조회 API(eoa-flows) 삭제, 관계맵·흐름맵·모니터링만 남김.
  //   (내부 enrich용 /api/eoa-flow + wallet-portfolio 는 관계맵 Morpho 패널이 쓰므로 유지.)
];

const EXTRA_NAV: { href: string; label: string }[] = [];

export function SiteHeader({
  riskCounts,
}: {
  riskCounts?: { safe: number; caution: number; danger: number };
}) {
  const pathname = usePathname();

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

      {riskCounts && (
        <div className="flex items-center gap-4 text-xs text-[var(--color-text-muted)]">
          <LegendDot color="var(--color-healthy)" label={`safe ${riskCounts.safe}`} />
          <LegendDot color="var(--color-caution)" label={`caution ${riskCounts.caution}`} />
          <LegendDot color="var(--color-danger)" label={`danger ${riskCounts.danger}`} />
        </div>
      )}
    </header>
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
