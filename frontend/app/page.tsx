"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight, Bell, Waves, X } from "lucide-react";

import { AlertDock } from "@/components/AlertDock";
import { alertFlowHref } from "@/lib/alert-link";
import { formatUsd } from "@/lib/api";

/**
 * 메인화면 — 헤더(로고·검색바·흐름맵 버튼) + 중앙 토큰 순위(시가총액, 클릭 = 관계맵)
 * + 우측 실시간 모니터링 알림. (2026-06-12) 실시간 상황판은 내부 피드백으로 메인에서 제거 —
 * 실시간 시각화는 토큰 페이지의 "실시간 상황판" 탭과 /flow 흐름맵이 담당.
 * 검색바 클릭 → 반투명 오버레이로 시총 순위 토큰 리스트(클릭 = 그 토큰의 관계맵 페이지).
 */

interface Alert {
  id: string; created_at: string; snapshot_ts: string | null; severity: "critical" | "warning" | "info" | string;
  kind: string; token: string; protocol_node_id: string | null; message: string;
  detail?: { chain?: string } | null;
}
interface TokenExposure { usd: number; dbUsd: number; breadthUsd: number; mcapUsd: number | null; source: string; snapshotTs: string | null }
const SEV_COLOR: Record<string, string> = { critical: "#f87171", warning: "#fbbf24", info: "#60a5fa" };
const SEV_LABEL: Record<string, string> = { critical: "위험", warning: "경고", info: "정보" };
const KIND_LABEL: Record<string, string> = {
  supply_spike: "공급 급증", liquidity_drop_lending: "대출 유동성 급감", liquidity_drop_dex: "DEX 유동성 급감",
  bad_debt_threshold: "부실채권 임계", reserve_frozen: "리저브 동결", collateral_adoption: "신규 담보 채택",
  utilization_jump: "이용률 급등", high_utilization: "고이용률", unverified_large_exposure: "미검증 대형 익스포저",
  high_lltv_market: "고 LLTV 마켓", oracle_changed: "오라클 변경",
  irm_changed: "IRM 변경", depeg: "디페그", new_market: "신규 마켓", chain_supply_spike: "체인 공급 급증",
  wallet_value_drop: "지갑 밸류 급감", flow_anomaly: "흐름 급변",
};

// 알림의 체인 추정: protocol_node_id 의 @chain → 그 체인 / detail.chain / @없고 프로토콜 있으면 이더리움 / 둘 다 없으면 토큰레벨
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
const alertEventTime = (a: Alert) => a.snapshot_ts ?? a.created_at;
function absTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function MainLanding() {
  const router = useRouter();
  const [tokens, setTokens] = useState<string[]>([]);
  const [exposure, setExposure] = useState<Record<string, number>>({});
  const [mcap, setMcap] = useState<Record<string, number>>({}); // 시가총액(순위 기준), 없으면 익스포저 폴백
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [chainSel, setChainSel] = useState<string>("전체");
  const [sevSel, setSevSel] = useState<string>("전체");

  useEffect(() => {
    fetch("/api/tokens").then((r) => r.json()).then((d) => {
      setTokens([...new Set((d.tokens ?? []).map((t: string) => t.split("@")[0]))].sort() as string[]);
    }).catch(() => {});
    fetch("/api/token-exposures", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const exp: Record<string, number> = {};
      const mc: Record<string, number> = {};
      for (const [sym, item] of Object.entries((d.exposures ?? {}) as Record<string, TokenExposure>)) {
        exp[sym] = item.usd ?? 0;
        if (item.mcapUsd != null) mc[sym] = item.mcapUsd;
      }
      setExposure(exp);
      setMcap(mc);
    }).catch(() => {});
    const loadAlerts = () => {
      fetch("/api/alerts?limit=300", { cache: "no-store" }).then((r) => r.json()).then((d) => {
        setAlerts((d.alerts ?? []) as Alert[]);
        setCounts((d.counts ?? {}) as Record<string, number>);
      }).catch(() => {});
    };
    loadAlerts();
    const iv = setInterval(loadAlerts, 15_000);
    return () => clearInterval(iv);
  }, []);

  const chainChips = useMemo(() => {
    const c = new Map<string, number>();
    for (const a of alerts) { const ch = chainOf(a) ?? "토큰레벨"; c.set(ch, (c.get(ch) ?? 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [alerts]);

  const shownAlerts = useMemo(() => {
    return alerts.filter((a) => {
      if (sevSel !== "전체" && a.severity !== sevSel) return false;
      if (chainSel !== "전체") {
        const ch = chainOf(a);
        if (chainSel === "토큰레벨") { if (ch !== null) return false; }
        else if (ch !== chainSel && ch !== null) return false;
      }
      return true;
    });
  }, [alerts, sevSel, chainSel]);

  const go = (sym: string) => router.push(`/token/${encodeURIComponent(sym)}`);

  // 중앙 = 시총 순위 (검색 오버레이와 같은 기준 — 시총 없으면 익스포저 폴백)
  const rankedTokens = useMemo(() => {
    const rv = (t: string) => mcap[t] ?? exposure[t] ?? 0;
    return [...tokens].sort((a, b) => rv(b) - rv(a)).slice(0, 80);
  }, [tokens, mcap, exposure]);

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]">
      <AlertDock />

      {/* ── 헤더: 로고 · 검색바 · 흐름맵 버튼 (스케치 구조) ── */}
      <header className="flex shrink-0 items-center gap-4 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-5 py-2.5">
        <button onClick={() => router.push("/")} className="shrink-0 text-lg font-bold tracking-tight text-[var(--color-text-primary)]">
          Chain Spiral <span className="align-middle text-[10px] font-normal text-[var(--color-text-muted)]">v0.2</span>
        </button>
        <button
          onClick={() => setSearchOpen(true)}
          className="relative mx-auto flex w-full max-w-xl items-center gap-2.5 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-4 py-2 text-left text-[13px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)]"
        >
          <Search size={15} />
          토큰 검색 — wstETH, USDe, WBTC …
        </button>
        <button
          onClick={() => router.push("/flow")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Waves size={15} /> 흐름맵
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── 중앙: 토큰 순위 (시가총액 — 클릭 = 그 토큰의 관계맵) ── */}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-4 py-6">
            <div className="flex items-center justify-between px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              <span>토큰 순위 · 시가총액</span>
              <span className="normal-case">{tokens.length}개 추적 · 클릭 = 관계맵</span>
            </div>
            <div className="mt-1.5 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
              {rankedTokens.length === 0 ? (
                <div className="px-5 py-4 text-sm text-[var(--color-text-muted)]">로딩…</div>
              ) : rankedTokens.map((t, i) => (
                <button key={t} onClick={() => go(t)}
                  className="group flex w-full items-center gap-2.5 px-5 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-raised)]">
                  <span className="w-6 shrink-0 text-right font-mono text-[11px] text-[var(--color-text-muted)]">{i + 1}</span>
                  <span className="flex-1 truncate text-[14px] font-medium text-[var(--color-text-primary)]">{t}</span>
                  {mcap[t] ? <span className="font-mono text-[12px] text-[var(--color-text-secondary)]" title="시가총액">{formatUsd(mcap[t])}</span> : exposure[t] ? <span className="font-mono text-[12px] text-[var(--color-text-muted)]" title="익스포저 (시총 미상)">{formatUsd(exposure[t])}</span> : null}
                  <ArrowRight size={14} className="shrink-0 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── 우: 실시간 모니터링 알림 ── */}
        <aside className="flex w-[420px] shrink-0 flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
          <div className="flex flex-wrap items-center gap-2.5 px-5 pb-2 pt-4">
            <Bell size={16} className="text-[var(--color-accent)]" />
            <span className="text-[15px] font-bold text-[var(--color-text-primary)]">실시간 모니터링 알림</span>
            <div className="ml-auto flex items-center gap-1.5">
              {(["critical", "warning", "info"] as const).map((s) => (
                <span key={s} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium" style={{ borderColor: `${SEV_COLOR[s]}66`, color: SEV_COLOR[s], backgroundColor: `${SEV_COLOR[s]}14` }}>
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: SEV_COLOR[s] }} />{SEV_LABEL[s]} {counts[s] ?? 0}
                </span>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto px-5 pb-2.5 pt-1">
            <div className="flex w-max min-w-full items-center gap-1.5 whitespace-nowrap">
              <span className="mr-1 shrink-0 text-[10px] uppercase text-[var(--color-text-muted)]">체인</span>
              {["전체", ...chainChips.map(([c]) => c)].map((c) => {
                const on = chainSel === c;
                const n = c === "전체" ? alerts.length : (chainChips.find(([x]) => x === c)?.[1] ?? 0);
                return (
                  <button key={c} onClick={() => setChainSel(c)}
                    className={"flex min-h-[26px] shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10px] leading-none capitalize transition-colors " + (on ? "bg-[var(--color-accent)]/15 text-[var(--color-text-primary)] ring-1 ring-[var(--color-accent)]/50" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]")}>
                    {c} <span className="font-mono text-[9px] opacity-70">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-5 pb-2 pt-2">
            <span className="mr-1 text-[10px] uppercase text-[var(--color-text-muted)]">심각도</span>
            {["전체", "critical", "warning", "info"].map((s) => {
              const on = sevSel === s;
              const lbl = s === "전체" ? "전체" : SEV_LABEL[s];
              return (
                <button key={s} onClick={() => setSevSel(s)}
                  className={"rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors " + (on ? "bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]")}
                  style={on && s !== "전체" ? { color: SEV_COLOR[s] } : undefined}>
                  {lbl}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {shownAlerts.length === 0 ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]">
                {alerts.length === 0 ? "알림 로딩 중… (DB 연결 시 표시)" : "필터에 해당하는 알림이 없어요."}
              </div>
            ) : shownAlerts.map((a) => {
              const col = SEV_COLOR[a.severity] ?? "#94a3b8";
              const ch = chainOf(a);
              const eventTs = alertEventTime(a);
              return (
                <button key={a.id} onClick={() => router.push(alertFlowHref(a))}
                  title="클릭: 이 알림의 토큰·체인만 선택된 흐름맵으로"
                  className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-raised)]">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: col, boxShadow: `0 0 6px ${col}99` }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-text-primary)]">{a.token}</span>
                      {ch && <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--color-text-muted)]">{ch}</span>}
                      <span className="text-[11px] font-medium" style={{ color: col }}>{KIND_LABEL[a.kind] ?? a.kind}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]" title={`이벤트 관측: ${absTime(eventTs)}`}>{relTime(eventTs)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[12px] leading-snug text-[var(--color-text-secondary)]">{a.message}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--color-border-subtle)] px-5 py-1.5 text-[10px] text-[var(--color-text-muted)]">
            토큰레벨 알림은 전 체인 기준 · 시간은 이벤트 관측 시각 · 알림 클릭 = 흐름맵 이동
          </div>
        </aside>
      </div>

      {searchOpen && (
        <SearchOverlay tokens={tokens} exposure={exposure} mcap={mcap} onPick={(sym) => { setSearchOpen(false); go(sym); }} onClose={() => setSearchOpen(false)} />
      )}
    </div>
  );
}

/** 검색 오버레이 — 메인을 덮는 반투명 배경 + 상단 검색바 + TVL 순위 토큰 리스트(클릭 = 관계맵) */
function SearchOverlay({ tokens, exposure, mcap, onPick, onClose }: {
  tokens: string[]; exposure: Record<string, number>; mcap: Record<string, number>;
  onPick: (sym: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);

  // 순위 = 시가총액(큐레이터가 기대하는 "큰 토큰" 순서). 시총 없으면 익스포저로 폴백.
  const rankVal = (t: string) => mcap[t] ?? exposure[t] ?? 0;
  const ranked = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = (s ? tokens.filter((t) => t.toLowerCase().includes(s)) : tokens).slice();
    list.sort((a, b) => rankVal(b) - rankVal(a));
    return list.slice(0, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tokens, exposure, mcap]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[120]">
      {/* 반투명 배경 — 메인화면이 비쳐 보임 */}
      <div className="absolute inset-0 bg-[var(--color-bg)]/75 backdrop-blur-sm" onClick={onClose} />
      <div className="relative mx-auto flex h-full w-full max-w-2xl flex-col px-4 pt-4">
        <div className="relative">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            autoFocus value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, ranked.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter" && ranked[hi]) onPick(ranked[hi]);
            }}
            placeholder="토큰 검색 — wstETH, USDe, WBTC …"
            className="w-full rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] py-3.5 pl-11 pr-12 text-[15px] text-[var(--color-text-primary)] shadow-xl outline-none focus:border-[var(--color-accent)]"
          />
          <button onClick={onClose} className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"><X size={16} /></button>
        </div>

        <div className="mt-3 flex items-center justify-between px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          <span>{q.trim() ? "검색 결과" : "토큰 순위 · 시가총액"}</span>
          <span className="normal-case">{tokens.length}개 추적 · 클릭 = 관계맵</span>
        </div>
        <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/95 shadow-xl backdrop-blur" style={{ maxHeight: "62vh" }}>
          {ranked.length === 0 ? (
            <div className="px-5 py-4 text-sm text-[var(--color-text-muted)]">{tokens.length ? "매치 없음" : "로딩…"}</div>
          ) : ranked.map((t, i) => (
            <button key={t} onClick={() => onPick(t)}
              className={"group flex w-full items-center gap-2.5 px-5 py-2.5 text-left transition-colors " + (i === hi ? "bg-[var(--color-surface-raised)]" : "hover:bg-[var(--color-surface-raised)]")}>
              <span className="w-6 shrink-0 text-right font-mono text-[11px] text-[var(--color-text-muted)]">{i + 1}</span>
              <span className="flex-1 truncate text-[14px] font-medium text-[var(--color-text-primary)]">{t}</span>
              {mcap[t] ? <span className="font-mono text-[12px] text-[var(--color-text-secondary)]" title="시가총액">{formatUsd(mcap[t])}</span> : exposure[t] ? <span className="font-mono text-[12px] text-[var(--color-text-muted)]" title="익스포저 (시총 미상)">{formatUsd(exposure[t])}</span> : null}
              <ArrowRight size={14} className="shrink-0 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
