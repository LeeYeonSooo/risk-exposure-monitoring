"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight, Bell } from "lucide-react";

import { SiteHeader } from "@/components/SiteHeader";
import { formatUsd } from "@/lib/api";

interface Alert {
  id: string; created_at: string; snapshot_ts: string | null; severity: "critical" | "warning" | "info" | string;
  kind: string; token: string; protocol_node_id: string | null; message: string;
  detail?: { chain?: string } | null;
}

interface TokenExposure {
  usd: number;
  dbUsd: number;
  breadthUsd: number;
  source: "defillama-live" | "db-snapshot" | "none" | string;
  snapshotTs: string | null;
}

interface Wallet {
  wallet: string; label: string | null; kind: string | null; active: boolean;
  totalUsd: number | null; protocolCount: number | null; source: string | null; dropPct: number | null;
}

const SEV_COLOR: Record<string, string> = { critical: "#f87171", warning: "#fbbf24", info: "#60a5fa" };
const SEV_LABEL: Record<string, string> = { critical: "위험", warning: "경고", info: "정보" };
const KIND_LABEL: Record<string, string> = {
  supply_spike: "공급 급증", liquidity_drop_lending: "대출 유동성 급감", liquidity_drop_dex: "DEX 유동성 급감",
  bad_debt_threshold: "부실채권 임계", reserve_frozen: "리저브 동결", collateral_adoption: "신규 담보 채택",
  utilization_jump: "이용률 급등", high_utilization: "고이용률", unverified_large_exposure: "미검증 대형 익스포저",
  high_lltv_market: "고 LLTV 마켓", oracle_changed: "오라클 변경",
  irm_changed: "IRM 변경", depeg: "디페그", new_market: "신규 마켓", chain_supply_spike: "체인 공급 급증",
  wallet_value_drop: "지갑 밸류 급감",
};

// 알림의 체인 추정: protocol_node_id 의 @chain → 그 체인 / detail.chain(체인 공급 알림) / @없고 프로토콜 있으면 이더리움 / 프로토콜·체인 둘 다 없으면 토큰레벨(전 체인)
function chainOf(a: Alert): string | null {
  const p = a.protocol_node_id ?? "";
  if (p.includes("@")) return p.split("@")[1];
  if (a.detail?.chain) return a.detail.chain;
  if (p) return "ethereum";
  return null;
}
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
function alertEventTime(a: Alert): string {
  return a.snapshot_ts ?? a.created_at;
}
function absTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function SearchLanding() {
  const router = useRouter();
  const [tokens, setTokens] = useState<string[]>([]);
  const [exposure, setExposure] = useState<Record<string, number>>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [watch, setWatch] = useState<Set<string>>(new Set()); // 선택(관심) 토큰 — 모니터링 스코프
  const [chainSel, setChainSel] = useState<string>("전체");
  const [sevSel, setSevSel] = useState<string>("전체");

  useEffect(() => {
    fetch("/api/tokens").then((r) => r.json()).then((d) => {
      setTokens([...new Set((d.tokens ?? []).map((t: string) => t.split("@")[0]))].sort() as string[]);
    }).catch(() => {});
    fetch("/api/token-exposures", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const exp: Record<string, number> = {};
      for (const [sym, item] of Object.entries((d.exposures ?? {}) as Record<string, TokenExposure>)) {
        exp[sym] = item.usd ?? 0;
      }
      setExposure(exp);
    }).catch(() => {});
    fetch("/api/alerts?limit=300", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      setAlerts((d.alerts ?? []) as Alert[]);
      setCounts((d.counts ?? {}) as Record<string, number>);
    }).catch(() => {});
    fetch("/api/wallets", { cache: "no-store" }).then((r) => r.json()).then((d) => setWallets((d.wallets ?? []) as Wallet[])).catch(() => {});
  }, []);

  const ranked = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = (s ? tokens.filter((t) => t.toLowerCase().includes(s)) : tokens).slice();
    list.sort((a, b) => (exposure[b] ?? 0) - (exposure[a] ?? 0));
    return list.slice(0, 80);
  }, [q, tokens, exposure]);

  // 알림에 등장하는 체인들(추정) — 칩 구성
  const chainChips = useMemo(() => {
    const c = new Map<string, number>();
    for (const a of alerts) { const ch = chainOf(a) ?? "토큰레벨"; c.set(ch, (c.get(ch) ?? 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [alerts]);

  const watchLower = useMemo(() => new Set([...watch].map((s) => s.toLowerCase())), [watch]);

  // 모니터링 패널 알림 필터: 선택 토큰(있으면) → 그 토큰만 / 체인 / 심각도
  const shownAlerts = useMemo(() => {
    return alerts.filter((a) => {
      if (watchLower.size && !watchLower.has((a.token ?? "").toLowerCase())) return false;
      if (sevSel !== "전체" && a.severity !== sevSel) return false;
      if (chainSel !== "전체") {
        const ch = chainOf(a);
        if (chainSel === "토큰레벨") { if (ch !== null) return false; }
        else if (ch !== chainSel && ch !== null) return false; // 토큰레벨(전 체인)은 항상 통과
      }
      return true;
    });
  }, [alerts, watchLower, sevSel, chainSel]);

  const go = (sym: string) => router.push(`/token/${encodeURIComponent(sym)}`);
  const toggleWatch = (sym: string) => setWatch((p) => { const n = new Set(p); if (n.has(sym)) n.delete(sym); else n.add(sym); return n; });

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)] lg:h-screen">
      <SiteHeader />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ── 좌: 검색 + 토큰 순위 (체크=관심) ── */}
        <aside className="flex w-full shrink-0 flex-col border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] lg:w-[400px] lg:border-b-0 lg:border-r">
          <div className="px-5 pb-3 pt-6">
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Chain Spiral</h1>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
              토큰 하나의 <span className="text-[var(--color-text-primary)]">모든 온체인 익스포저</span>와 실시간 위험 모니터링.
            </p>
            <div className="relative mt-4">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                autoFocus value={q}
                onChange={(e) => { setQ(e.target.value); setHi(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, ranked.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
                  else if (e.key === "Enter" && ranked[hi]) go(ranked[hi]);
                }}
                placeholder="토큰 검색 — wstETH, USDe, WBTC …"
                className="w-full rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] py-3 pl-10 pr-4 text-[14px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>
          </div>
          <div className="flex items-center justify-between px-5 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            <span>{q.trim() ? "검색 결과" : "토큰 순위 · TVL 커버리지"}</span>
            <span className="normal-case">{tokens.length}개 추적</span>
          </div>
          <div className="min-h-0 max-h-[58vh] flex-1 overflow-y-auto lg:max-h-none">
            {ranked.length === 0 ? (
              <div className="px-5 py-3 text-sm text-[var(--color-text-muted)]">{tokens.length ? "매치 없음" : "로딩…"}</div>
            ) : ranked.map((t, i) => {
              const on = watch.has(t);
              return (
                <div key={t} className={"group flex items-center gap-2.5 px-5 py-2 transition-colors " + (i === hi ? "bg-[var(--color-surface-raised)]" : "hover:bg-[var(--color-surface-raised)]")}>
                  <button onClick={() => toggleWatch(t)} title="모니터링에 추가/제거"
                    className={"flex size-4 shrink-0 items-center justify-center rounded border transition-colors " + (on ? "border-[var(--color-accent)] bg-[var(--color-accent)]" : "border-[var(--color-border-subtle)] hover:border-[var(--color-accent)]")}>
                    {on && <span className="size-1.5 rounded-[1px] bg-white" />}
                  </button>
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-[var(--color-text-muted)]">{i + 1}</span>
                  <button onClick={() => go(t)} className="flex flex-1 items-center gap-2 text-left">
                    <span className="flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">{t}</span>
                    {exposure[t] ? <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{formatUsd(exposure[t])}</span> : null}
                    <ArrowRight size={13} className="shrink-0 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100" />
                  </button>
                </div>
              );
            })}
          </div>
          {watch.size > 0 && (
            <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] px-5 py-2.5">
              <span className="text-[11px] text-[var(--color-text-secondary)]">선택 {watch.size}개</span>
              <button onClick={() => router.push(`/multi?tokens=${encodeURIComponent([...watch].join(","))}`)}
                className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90">비교 뷰로 →</button>
              <button onClick={() => setWatch(new Set())} className="ml-auto text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">해제</button>
            </div>
          )}
        </aside>

        {/* ── 우: 모니터링 (실시간 알림) ── */}
        <main className="flex min-h-[48vh] min-w-0 flex-1 flex-col bg-[var(--color-bg)] lg:min-h-0">
          <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-5 lg:px-6 lg:pt-6">
            <Bell size={17} className="text-[var(--color-accent)]" />
            <span className="text-lg font-bold text-[var(--color-text-primary)]">모니터링 · 실시간 알림</span>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {watch.size ? `선택 ${watch.size}개 토큰` : "전체 토큰"} · diff 엔진 적재
            </span>
            <div className="flex items-center gap-1.5 lg:ml-auto">
              {(["critical", "warning", "info"] as const).map((s) => (
                <span key={s} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium" style={{ borderColor: `${SEV_COLOR[s]}66`, color: SEV_COLOR[s], backgroundColor: `${SEV_COLOR[s]}14` }}>
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: SEV_COLOR[s] }} />{SEV_LABEL[s]} {counts[s] ?? 0}
                </span>
              ))}
            </div>
          </div>

          {/* 체인 필터 칩 */}
          <div className="flex flex-wrap items-center gap-1.5 px-5 pb-2 lg:px-6">
            <span className="mr-1 text-[10px] uppercase text-[var(--color-text-muted)]">체인</span>
            {["전체", ...chainChips.map(([c]) => c)].map((c) => {
              const on = chainSel === c;
              const n = c === "전체" ? alerts.length : (chainChips.find(([x]) => x === c)?.[1] ?? 0);
              return (
                <button key={c} onClick={() => setChainSel(c)}
                  className={"flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors " + (on ? "bg-[var(--color-accent)]/15 text-[var(--color-text-primary)] ring-1 ring-[var(--color-accent)]/50" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]")}>
                  {c} <span className="font-mono text-[9px] opacity-70">{n}</span>
                </button>
              );
            })}
          </div>
          {/* 심각도 탭 */}
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-5 pb-2.5 lg:px-6">
            <span className="mr-1 text-[10px] uppercase text-[var(--color-text-muted)]">심각도</span>
            {["전체", "critical", "warning", "info"].map((s) => {
              const on = sevSel === s;
              const lbl = s === "전체" ? "전체" : SEV_LABEL[s];
              return (
                <button key={s} onClick={() => setSevSel(s)}
                  className={"rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors " + (on ? "bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]")}
                  style={on && s !== "전체" ? { color: SEV_COLOR[s] } : undefined}>
                  {lbl}
                </button>
              );
            })}
          </div>

          {/* 추적 지갑 (DeBank/온체인) — 큐레이터·고래 자금 추적. 급감 시 위 알림으로도 뜸. */}
          {wallets.length > 0 && (
            <div className="border-b border-[var(--color-border-subtle)] px-5 py-2 lg:px-6">
              <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase text-[var(--color-text-muted)]">
                <span>추적 지갑 · 자금 이탈 감시</span>
                <span className="font-mono normal-case">{wallets.length}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {wallets.slice(0, 18).map((w) => {
                  const drop = w.dropPct != null && w.dropPct >= 0.05;
                  const col = w.dropPct != null && w.dropPct >= 0.5 ? "#f87171" : w.dropPct != null && w.dropPct >= 0.3 ? "#fbbf24" : "#94a3b8";
                  return (
                    <span key={w.wallet} title={`${w.wallet}${w.source ? ` · ${w.source}` : ""}${w.active ? "" : " · 비활성"}`}
                      className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[11px]">
                      <span className={"size-1.5 rounded-full " + (w.active ? "" : "opacity-40")} style={{ backgroundColor: col }} />
                      <span className="font-medium text-[var(--color-text-primary)]">{w.label || `${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)}`}</span>
                      <span className="font-mono text-[var(--color-text-secondary)]">{w.totalUsd != null ? formatUsd(w.totalUsd) : "—"}</span>
                      {drop && <span className="font-mono" style={{ color: col }}>▼{Math.round((w.dropPct ?? 0) * 100)}%</span>}
                    </span>
                  );
                })}
                {wallets.length > 18 && <span className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">외 {wallets.length - 18}개</span>}
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {shownAlerts.length === 0 ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]">
                {alerts.length === 0 ? "알림 로딩 중… (DB 연결 시 표시)" : watch.size ? "선택한 토큰에 해당하는 알림이 없어요." : "필터에 해당하는 알림이 없어요."}
              </div>
            ) : shownAlerts.map((a) => {
              const col = SEV_COLOR[a.severity] ?? "#94a3b8";
              const ch = chainOf(a);
              const eventTs = alertEventTime(a);
              return (
                <button key={a.id} onClick={() => go(a.token)}
                  className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-raised)]">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: col, boxShadow: `0 0 6px ${col}99` }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-text-primary)]">{a.token}</span>
                      {ch && <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--color-text-muted)]">{ch}</span>}
                      <span className="text-[11px] font-medium" style={{ color: col }}>{KIND_LABEL[a.kind] ?? a.kind}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]" title={`이벤트 관측: ${absTime(eventTs)}`}>{relTime(eventTs)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[12px] leading-snug text-[var(--color-text-secondary)]">{a.message}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--color-border-subtle)] px-5 py-2 text-[10px] text-[var(--color-text-muted)] lg:px-6">
            토큰레벨 알림은 전 체인 기준입니다. 시간은 이벤트 관측 시각 기준입니다.
          </div>
        </main>
      </div>
    </div>
  );
}
