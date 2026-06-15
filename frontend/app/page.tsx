"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight, Bell, Waves, X } from "lucide-react";

import { alertFlowHref } from "@/lib/alert-link";
import { kindLabel, catOf, CAT_LABEL, prettyMessage, displayToken, isStaleEvent, isActiveChain, type AlertCategory } from "@/lib/alert-kinds";
import { SEV_COLOR, SEV_LABEL, compareSeverityDesc, severityAtLeast } from "@/lib/severity";
import { formatUsd } from "@/lib/api";

/**
 * 메인화면 — 헤더(로고·검색바·흐름맵 버튼) + 실시간 상황판(이벤트 기반 동심원: 안=토큰,
 * 밖=프로토콜, 이상 흐름만 발화 — docs/flow-situation-board.md) + 우측 실시간 모니터링 알림.
 * 검색바 클릭 → 반투명 오버레이로 시총 순위 토큰 리스트(클릭 = 그 토큰의 관계맵 페이지).
 */

interface Alert {
  id: string; created_at: string; snapshot_ts: string | null; severity: "critical" | "warning" | "info" | string;
  kind: string; token: string; protocol_node_id: string | null; message: string;
  detail?: { chain?: string } | null;
}
interface TokenExposure { usd: number; dbUsd: number; breadthUsd: number; mcapUsd: number | null; source: string; snapshotTs: string | null }
// 심각도 색·라벨·kind 라벨·카테고리는 공유 lib(lib/severity·lib/alert-kinds)에서 — 표면 간 불일치 제거.

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
  const [catSel, setCatSel] = useState<AlertCategory | "전체">("전체");
  const [expandedId, setExpandedId] = useState<string | null>(null); // 클릭한 알림 = 메시지 펼침

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
      // 심각도 우선 정렬 + counts 동반(헤더 카운트용). 탭이 보일 때만 폴링(백그라운드 낭비 차단).
      fetch("/api/alerts?limit=300&sort=severity&withCounts=1", { cache: "no-store" }).then((r) => r.json()).then((d) => {
        setAlerts((d.alerts ?? []) as Alert[]);
        setCounts((d.counts ?? {}) as Record<string, number>);
      }).catch(() => {});
    };
    loadAlerts();
    const iv = setInterval(() => { if (document.visibilityState === "visible") loadAlerts(); }, 15_000);
    return () => clearInterval(iv);
  }, []);

  const chainChips = useMemo(() => {
    const c = new Map<string, number>();
    // 활성 체인(eth/base/arb)만 칩으로. 토큰레벨(체인 null)·비활성 체인은 칩 안 만듦.
    for (const a of alerts) { const ch = chainOf(a); if (isActiveChain(ch)) c.set(ch!, (c.get(ch!) ?? 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [alerts]);

  // 필터(누적 심각도 + 체인 + 카테고리) 적용 후, (kind·token·protocol) 단위로 묶어 최신 1건 + 'xN' 배지.
  //   같은 마켓 반복 알림이 피드를 도배해 critical 이 묻히던 문제 대응.
  const shownAlerts = useMemo(() => {
    const filtered = alerts.filter((a) => {
      const ch0 = chainOf(a);
      // 비활성 체인(eth/base/arb 외) 알림은 숨김(2026-06: 3체인만 지원). 토큰레벨(null)은 전 체인 기준이라 표시.
      if (ch0 !== null && !isActiveChain(ch0)) return false;
      if (sevSel !== "전체" && !severityAtLeast(a.severity, sevSel)) return false; // '경고' 선택 시 위험 포함
      if (catSel !== "전체" && catOf(a.kind) !== catSel) return false;
      if (chainSel !== "전체") {
        // 특정 체인 선택 시 그 체인 알림 + 체인없는(토큰레벨, 전 체인 기준) 알림을 함께 표시.
        if (ch0 !== null && ch0 !== chainSel) return false;
      }
      return true;
    });
    const groups = new Map<string, { rep: Alert; count: number; maxSev: string; latestMs: number }>();
    for (const a of filtered) {
      const key = `${a.kind}|${a.token}|${a.protocol_node_id ?? ""}`;
      const ms = new Date(alertEventTime(a)).getTime();
      const g = groups.get(key);
      if (!g) groups.set(key, { rep: a, count: 1, maxSev: a.severity, latestMs: ms });
      else {
        g.count++;
        // 대표(rep)=가장 최신 발생(현재 상태·시각 반영). 표시 심각도는 그룹 최대(worst). 재발화하는 ongoing
        //   조건(예: 8일째 디페그)이 오래된 critical 을 rep 으로 잡아 stale 오인되던 것 방지 — 최신 발생으로 판정.
        if (ms > g.latestMs) { g.rep = a; g.latestMs = ms; }
        if (compareSeverityDesc(a.severity, g.maxSev) < 0) g.maxSev = a.severity;
      }
    }
    // 정렬: ① 신선한 알림 먼저(이벤트형이 24h+ 미발생 = 사건종료로 뒤로) ② 심각도(그룹 최대) ③ 최신.
    const stale = (g: { rep: Alert; latestMs: number }) => isStaleEvent(g.rep.kind, g.latestMs);
    return [...groups.values()].sort((x, y) =>
      (Number(stale(x)) - Number(stale(y)))
      || compareSeverityDesc(x.maxSev, y.maxSev)
      || (y.latestMs - x.latestMs));
  }, [alerts, sevSel, chainSel, catSel]);

  const go = (sym: string) => router.push(`/token/${encodeURIComponent(sym)}`);

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]">
      {/* AlertDock(우측 플로팅 알림)은 메인에선 숨김 — 인라인 '실시간 모니터링' 피드가 대체. token·flow 페이지에선 표시. */}

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

      <div className="flex min-h-0 flex-1 justify-center">
        {/* 메인은 실시간 모니터링 알림 단독 — 그래프(FlowMapBoard)·상황판 레일 숨김(2026-06 사용자 요청).
            중앙 정렬 단일 패널. 그래프/상황판은 token·flow 페이지에서 계속 제공. */}
        <aside className="flex w-full max-w-3xl flex-col bg-[var(--color-surface)]">
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
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-5 pb-1.5 pt-2">
            <span className="mr-1 w-9 shrink-0 text-[10px] uppercase text-[var(--color-text-muted)]">심각도</span>
            {/* 누적('이상') 필터 — '경고↑' 선택 시 위험 포함 */}
            {[["전체", "전체"], ["critical", "위험"], ["warning", "경고↑"]].map(([s, lbl]) => {
              const on = sevSel === s;
              return (
                <button key={s} onClick={() => setSevSel(s)}
                  className={"rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors " + (on ? "bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]")}
                  style={on && s !== "전체" ? { color: SEV_COLOR[s] } : undefined}>
                  {lbl}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-5 pb-2 pt-1.5">
            <span className="mr-1 w-9 shrink-0 text-[10px] uppercase text-[var(--color-text-muted)]">분류</span>
            {(["전체", "minting", "depeg", "contract", "liquidity"] as const).map((c) => {
              const on = catSel === c;
              return (
                <button key={c} onClick={() => setCatSel(c)}
                  className={"rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors " + (on ? "bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]")}>
                  {c === "전체" ? "전체" : CAT_LABEL[c]}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {shownAlerts.length === 0 ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]">
                {alerts.length === 0 ? "알림 로딩 중… (DB 연결 시 표시)" : "필터에 해당하는 알림이 없어요."}
              </div>
            ) : shownAlerts.map(({ rep: a, count, maxSev, latestMs }) => {
              const col = SEV_COLOR[maxSev] ?? "#94a3b8";  // 그룹 최대 심각도(worst)로 표시
              const ch = chainOf(a);
              const eventTs = alertEventTime(a);            // rep=최신 발생이라 가장 최근 시각
              const expanded = expandedId === a.id;
              const stale = isStaleEvent(a.kind, latestMs); // 그룹 최신 발생 기준 — ongoing 조건 오인 방지
              return (
                <div key={a.id}
                  onClick={() => setExpandedId(expanded ? null : a.id)}
                  title={expanded ? "클릭: 접기" : "클릭: 메시지 펼치기"}
                  style={stale ? { opacity: 0.5 } : undefined}
                  className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-raised)]">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: stale ? "#94a3b8" : col, boxShadow: stale ? "none" : `0 0 6px ${col}99` }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-text-primary)]">{displayToken(a.token)}</span>
                      {ch && <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--color-text-muted)]">{ch}</span>}
                      <span className="text-[11px] font-medium" style={{ color: stale ? "var(--color-text-muted)" : col }}>{kindLabel(a.kind)}</span>
                      {count > 1 && <span className="rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-text-muted)]" title={`동일 알림 ${count}건`}>×{count}</span>}
                      {stale && <span className="rounded bg-[var(--color-bg)] px-1 py-0.5 text-[9px] text-[var(--color-text-muted)]" title="이벤트형 알림이 24시간+ 갱신 안 됨 — 사건 종료 추정">지난</span>}
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]" title={`이벤트 관측: ${absTime(eventTs)}`}>{relTime(eventTs)}</span>
                    </div>
                    <div className={"mt-0.5 text-[12px] leading-snug text-[var(--color-text-secondary)] " + (expanded ? "whitespace-pre-wrap break-words" : "truncate")}>{prettyMessage(a.message, a.kind)}</div>
                    {expanded && (
                      <button
                        onClick={(e) => { e.stopPropagation(); router.push(alertFlowHref(a)); }}
                        className="mt-1.5 inline-flex items-center gap-1 rounded bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)] hover:brightness-110">
                        흐름맵으로 <ArrowRight size={11} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-[var(--color-border-subtle)] px-5 py-1.5 text-[10px] text-[var(--color-text-muted)]">
            시간은 이벤트 관측 시각 · 동일 알림은 묶음(×N) · '지난'=이벤트형 24h+ 미갱신(사건종료 추정) · 클릭 = 펼치기
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
