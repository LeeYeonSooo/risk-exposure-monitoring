"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEX_PROTOS, FLOW_CHAINS, type FlowAction, type FlowEdgeOut, type FlowMapData, type FlowSummary, type LeverOut } from "@/lib/flowmap";

/**
 * 실시간 상황판 (docs/flow-situation-board.md §3)
 *
 * 동심원 2겹: 안쪽 링=토큰, 바깥 링=프로토콜. 고정 배치(공간 기억).
 * 평시엔 구조 엣지(흐림)만. systemic(다수 주체 비정상)=이상치 발화(라이브 입자 엣지),
 * whale(단일 주체 대형)=정보(호박색), normal=구조. 분류는 서버(검증된 게이트)가 함.
 * 같은 tx 의 담보예치+차입(레버 페어)은 토큰→프로토콜→토큰 한 붓 보라 경로.
 */

const ACTION_COLOR: Record<FlowAction, string> = { supply: "#2563eb", repay: "#0d9488", withdraw: "#dc2626", borrow: "#ea580c", sell: "#db2777", buy: "#65a30d" };
const ACTION_LABEL: Record<FlowAction, string> = { supply: "예치", repay: "상환", withdraw: "인출", borrow: "차입", sell: "매도", buy: "매수" };
const LEVER_COLOR = "#9333ea";
const UNWIND_COLOR = "#0891b2";
const WHALE_COLOR = "#d97706"; // 단일 주체 대형(정보)
const BASE_EDGE = "#cbd5e1";
const agoFmt = (sec: number) => sec < 90 ? `${sec}초` : sec < 5400 ? `${Math.round(sec / 60)}분` : `${(sec / 3600).toFixed(1)}시간`;

const W = 980, H = 640, CX = 490, CY = 320, R_TOK = 184, R_PROTO = 272;
const TOK_STAGGER = 13;  // 토큰 링 홀짝 반지름 스태거 — 59노드 간격 확보
const BASE_OP = 0.12;    // 평시 구조 엣지 기본 불투명도(더 흐리게 — 발화만 도드라지게)
const WHALE_BOARD_MAX = 5; // 보드에 색칠하는 whale 상한(레일엔 전부)
const FLOW_LANE = 3.1;   // 흐름맵 상세 그래프와 맞춘 병렬 차선 간격
const fmt = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
const pos = (deg: number, r: number) => ({ x: CX + r * Math.cos((deg * Math.PI) / 180), y: CY + r * Math.sin((deg * Math.PI) / 180) });
const tokenIcon = (addr: string, chainId: number) => `https://token-icons.llamao.fi/icons/tokens/${chainId}/${addr.toLowerCase()}?h=48&w=48`;
const protoIcon = (slug: string) => `https://icons.llamao.fi/icons/protocols/${slug}?w=48&h=48`;

const edgeKey = (e: FlowEdgeOut) => `${e.token}|${e.proto}|${e.action}`;
const FLOW_CHAIN_LABEL = (key: string) => FLOW_CHAINS.find((c) => c.key === key)?.label ?? key;
interface FlowPath { center: string; lanes: [string, string] }

function FlowParticles({ path, color, count = 2, opacity = 0.9, delay = 0, duration = 3.6, radius = 2.1 }: {
  path: string;
  color: string;
  count?: number;
  opacity?: number;
  delay?: number;
  duration?: number;
  radius?: number;
}) {
  return (
    <g className="pointer-events-none">
      {Array.from({ length: count }).map((_, i) => (
        <circle key={i} r={radius} fill={color} opacity={opacity} stroke="var(--color-surface)" strokeWidth={0.8}>
          <animateMotion
            path={path}
            dur={`${duration}s`}
            begin={`${delay - (duration / count) * i}s`}
            repeatCount="indefinite"
            calcMode="linear"
          />
        </circle>
      ))}
    </g>
  );
}

/**
 * railPortal — 주어지면 우측 레일(이상 흐름·대형 단일·레버)을 그 DOM 노드로 포털 렌더.
 * 메인 화면이 레일을 알림 패널에 합칠 때 사용(겹침 방지 + 한 패널) — 호버 연동·핀은 그대로 동작.
 * 미지정(undefined)이면 기존처럼 보드 옆에 내장(토큰 페이지).
 */
export function FlowMapBoard({ sym = "", railPortal }: { sym?: string; railPortal?: HTMLElement | null }) {
  const [chain, setChain] = useState("ethereum"); // 체인 칩 — 보드는 체인당 하나(고정 배치·공간 기억)
  const [summary, setSummary] = useState<FlowSummary | null>(null); // 전 체인 이상치 집계(칩 뱃지)
  const [data, setData] = useState<FlowMapData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<string | null>(null);   // edgeKey | `lever:i` | `tok:SYM` | `proto:NAME`
  const [pinned, setPinned] = useState<string | null>(null); // 클릭 고정 — 다시 클릭/배경 클릭 전까지 격리 유지
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<Map<string, FlowMapData>>(new Map()); // 체인별 마지막 응답 — 되돌아올 때 즉시 표시(SWR)
  const togglePin = useCallback((k: string) => setPinned((p) => (p === k ? null : k)), []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setErr(null);
      const r = await fetch(`/api/flowmap?chain=${encodeURIComponent(chain)}`, { cache: "no-store", signal });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `http ${r.status}`);
      if (signal?.aborted) return;            // 전환 후 도착한 stale 응답 — 현재 체인 덮어쓰기 금지
      cacheRef.current.set(chain, j);
      setData(j);
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // 체인 전환으로 취소됨 — 정상
      setErr(String(e).slice(0, 160));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [chain]);

  useEffect(() => {
    setPinned(null); setHover(null);
    const cached = cacheRef.current.get(chain);
    if (cached) { setData(cached); setLoading(false); } // 본 적 있는 체인 — 즉시 표시 후 백그라운드 갱신(깜빡임 없음)
    else { setData(null); setLoading(true); }           // 처음 보는 체인만 로딩 화면
    const ac = new AbortController();
    load(ac.signal);
    const id = setInterval(() => { if (!document.hidden) load(ac.signal); }, 60_000);
    return () => { ac.abort(); clearInterval(id); };     // 전환 시 진행 중 fetch 취소 → race 차단
  }, [load]);

  // 전 체인 요약 — 칩 뱃지(systemic 빨강/whale 호박) + 미수집 체인 백그라운드 수집 트리거
  useEffect(() => {
    const pull = () => fetch("/api/flowmap?summary=1", { cache: "no-store" }).then((r) => r.json()).then(setSummary).catch(() => {});
    pull();
    const id = setInterval(() => { if (!document.hidden) pull(); }, 60_000);
    return () => clearInterval(id);
  }, []);

  // systemic 엣지 키 집합 (서버 분류) — 발화(입자 엣지) 대상
  const fired = useMemo(() => new Set((data?.edges ?? []).filter((e) => e.kind === "systemic").map(edgeKey)), [data]);
  // 보드에 색칠하는 whale 상한 — 나머지 whale 은 구조선처럼 흐리게 (레일 목록엔 전부)
  const whaleLit = useMemo(() => new Set((data?.edges ?? []).filter((e) => e.kind === "whale").sort((a, b) => b.recentUsd - a.recentUsd).slice(0, WHALE_BOARD_MAX).map(edgeKey)), [data]);

  // 격리 — 클릭 고정(pinned)이 우선, 없으면 호버. 연결된 것만 남기고 나머지 흐림.
  // 구조(normal) 엣지는 격리에 포함하지 않음 — 회색 선은 격리해도 안 띄움(요청).
  const focusKey = pinned ?? hover;
  const hl = useMemo(() => {
    if (!data || !focusKey) return null;
    const toks = new Set<string>(), protos = new Set<string>(), edges = new Set<string>(), levers = new Set<string>();
    const litEdge = (e: FlowEdgeOut) => e.kind === "systemic" || whaleLit.has(edgeKey(e));
    const lev = (l: LeverOut, id: string) => { levers.add(id); protos.add(l.proto); toks.add(l.collat); toks.add(l.debt); };
    if (focusKey.startsWith("tok:")) {
      const s = focusKey.slice(4); toks.add(s);
      data.edges.forEach((e) => { if (e.token === s && litEdge(e)) { edges.add(edgeKey(e)); protos.add(e.proto); } });
      data.levers.forEach((l, i) => { if (l.collat === s || l.debt === s) lev(l, `lever:${i}`); });
      data.unwinds.forEach((l, i) => { if (l.collat === s || l.debt === s) lev({ ...l, collat: l.debt, debt: l.collat }, `lever:u${i}`); });
    } else if (focusKey.startsWith("proto:")) {
      const s = focusKey.slice(6); protos.add(s);
      data.edges.forEach((e) => { if (e.proto === s && litEdge(e)) { edges.add(edgeKey(e)); toks.add(e.token); } });
      data.levers.forEach((l, i) => { if (l.proto === s) lev(l, `lever:${i}`); });
      data.unwinds.forEach((l, i) => { if (l.proto === s) lev({ ...l, collat: l.debt, debt: l.collat }, `lever:u${i}`); });
    } else if (focusKey.startsWith("lever:")) {
      const m = focusKey.slice(6); const isU = m.startsWith("u");
      const idx = Number(isU ? m.slice(1) : m);
      const l = isU ? data.unwinds[idx] : data.levers[idx];
      if (l) lev(isU ? { ...l, collat: l.debt, debt: l.collat } : l, focusKey);
    } else { // edgeKey (contains "|")
      const e = data.edges.find((x) => edgeKey(x) === focusKey);
      if (e) { edges.add(focusKey); toks.add(e.token); protos.add(e.proto); }
    }
    return { toks, protos, edges, levers };
  }, [data, focusKey, whaleLit]);

  // ── 배치 ──
  const layout = useMemo(() => {
    if (!data) return null;
    // 레지스트리 전체(≈59) 렌더 — idle 은 작은 점, 활동분은 크게+라벨. 64 초과분만 잘림.
    const toks = data.tokens.slice(0, 64);
    const tokPos = new Map<string, { x: number; y: number; deg: number }>();
    toks.forEach((t, i) => {
      const deg = -90 + (360 * i) / toks.length;
      tokPos.set(t.sym, { ...pos(deg, R_TOK + (i % 2 ? TOK_STAGGER : -TOK_STAGGER)), deg }); // 홀짝 스태거로 간격 확보
    });
    const protoPos = new Map<string, { x: number; y: number; deg: number }>();
    data.protocols.forEach((p, i) => {
      const deg = -90 + (360 * i) / data.protocols.length + 180 / data.protocols.length;
      protoPos.set(p.name, { ...pos(deg, R_PROTO), deg });
    });
    return { toks, tokPos, protoPos };
  }, [data]);

  // 엣지 곡선: in = 토큰→프로토콜, out = 프로토콜→토큰. 방향별로 수직 오프셋을 줘 한 쌍 분리.
  const edgePaths = useCallback((e: FlowEdgeOut): FlowPath | null => {
    if (!layout) return null;
    const t = layout.tokPos.get(e.token), p = layout.protoPos.get(e.proto);
    if (!t || !p) return null;
    const from = e.dir === "in" ? t : p, to = e.dir === "in" ? p : t;
    const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const a = { x: from.x + ux * 20, y: from.y + uy * 20 };
    const b = { x: to.x - ux * 26, y: to.y - uy * 26 };
    const side = e.dir === "in" ? 1 : -1;
    const c = { x: (a.x + b.x) / 2 - uy * 22 * side, y: (a.y + b.y) / 2 + ux * 22 * side };
    const lane = (n: number) => {
      const ox = uy * FLOW_LANE * n, oy = -ux * FLOW_LANE * n;
      return `M ${(a.x + ox).toFixed(1)} ${(a.y + oy).toFixed(1)} Q ${(c.x + ox).toFixed(1)} ${(c.y + oy).toFixed(1)} ${(b.x + ox).toFixed(1)} ${(b.y + oy).toFixed(1)}`;
    };
    return { center: lane(0), lanes: [lane(1), lane(-1)] };
  }, [layout]);

  // 레버/언와인드: 토큰 → 프로토콜 → 토큰 경로(입자 애니메이션용으로 세그먼트 분리)
  const leverSegments = useCallback((l: LeverOut): FlowPath[] | null => {
    if (!layout) return null;
    const t1 = layout.tokPos.get(l.collat), p = layout.protoPos.get(l.proto), t2 = layout.tokPos.get(l.debt);
    if (!t1 || !p || !t2) return null;
    const seg = (f: { x: number; y: number }, g: { x: number; y: number }, side: number) => {
      const dx = g.x - f.x, dy = g.y - f.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const a = { x: f.x + ux * 22, y: f.y + uy * 22 }, b = { x: g.x - ux * 28, y: g.y - uy * 28 };
      const c = { x: (a.x + b.x) / 2 - uy * 34 * side, y: (a.y + b.y) / 2 + ux * 34 * side };
      const lane = (n: number) => {
        const ox = uy * FLOW_LANE * n, oy = -ux * FLOW_LANE * n;
        return `M ${(a.x + ox).toFixed(1)} ${(a.y + oy).toFixed(1)} Q ${(c.x + ox).toFixed(1)} ${(c.y + oy).toFixed(1)} ${(b.x + ox).toFixed(1)} ${(b.y + oy).toFixed(1)}`;
      };
      return { center: lane(0), lanes: [lane(1), lane(-1)] as [string, string] };
    };
    const s1 = seg(t1, p, 1), s2 = seg(p, t2, 1);
    return [s1, s2];
  }, [layout]);

  const onTip = useCallback((ev: React.MouseEvent, lines: string[]) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    setTip({ x: Math.min(ev.clientX - box.left + 14, box.width - 230), y: ev.clientY - box.top + 12, lines });
  }, []);

  const anomalies = useMemo(() => (data?.edges ?? []).filter((e) => e.kind === "systemic").sort((a, b) => b.recentUsd - a.recentUsd), [data]);
  const whales = useMemo(() => (data?.edges ?? []).filter((e) => e.kind === "whale").sort((a, b) => b.recentUsd - a.recentUsd), [data]);
  const focusSym = useMemo(() => data?.tokens.find((t) => t.sym.toLowerCase() === sym.toLowerCase())?.sym ?? null, [data, sym]);

  // 체인 칩 — 로딩/에러 중에도 항상 렌더(다른 체인으로 전환 가능해야 함)
  const chipBar = (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5">
      {FLOW_CHAINS.map((c) => {
        const s = summary?.chains.find((x) => x.key === c.key);
        const active = chain === c.key;
        return (
          <button key={c.key} onClick={() => setChain(c.key)}
            title={s?.topAnomaly ? `${s.topAnomaly.token} ${s.topAnomaly.proto} ${fmt(s.topAnomaly.usd)} (z ${s.topAnomaly.z.toFixed(1)})` : s?.status === "collecting" ? "수집 중" : c.label}
            className={"flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors " +
              (active ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white" : "border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]")}>
            {c.label}
            {s && s.systemic > 0 && <span className={"rounded-full px-1 font-mono text-[9px] font-bold " + (active ? "bg-white/25" : "bg-[#dc2626] text-white")}>{s.systemic}</span>}
            {s && s.systemic === 0 && s.whale > 0 && <span className={"size-1.5 rounded-full " + (active ? "bg-white/70" : "bg-[#d97706]")} title={`대형 단일 ${s.whale}건`} />}
            {s && s.status === "collecting" && <span className={"size-1.5 animate-pulse rounded-full " + (active ? "bg-white/70" : "bg-[var(--color-text-muted)]")} />}
          </button>
        );
      })}
    </div>
  );
  if ((loading && !data) || (err && !data) || !data || !layout) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {chipBar}
        {err && !data ? (
          <Center><span className="text-sm text-[var(--color-danger)]">상황판 로드 실패</span><span className="mt-1 max-w-[420px] text-[11px] text-[var(--color-text-muted)]">{err}</span><button onClick={() => { setLoading(true); load(); }} className="mt-3 rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-[12px] hover:bg-[var(--color-surface-raised)]">다시 시도</button></Center>
        ) : (
          <Center><span className="size-8 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" /><span className="mt-3 text-sm text-[var(--color-text-secondary)]">{FLOW_CHAIN_LABEL(chain)} 온체인 흐름 수집 중… (Aave 계열 + 상위 DEX, 6시간 윈도우)</span></Center>
        )}
      </div>
    );
  }

  const ago = Math.max(0, Math.round(Date.now() / 1000 - data.meta.fetchedAt));
  // 평가창의 실제 끝 시각이 지금으로부터 얼마나 전인가 (블록 기준 — "15분" 거짓 라벨 방지)
  const winLag = Math.max(0, Math.round(Date.now() / 1000 - data.meta.recentEndSec));

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* ── 보드 (칩 바 + SVG) ── */}
      <div className="flex min-h-[420px] flex-1 flex-col">
        {chipBar}
      <div ref={boxRef} className="relative min-h-[380px] flex-1">
        {data.meta.historical != null && (
          <div className="absolute left-3 top-3 z-10 rounded-md border border-[#6366f166] bg-[#6366f11a] px-2.5 py-1 text-[11px] font-semibold text-[#4338ca]">
            과거 리플레이 — 블록 {data.meta.historical.toLocaleString()} 기준 실데이터
          </div>
        )}
        {data.meta.historical == null && anomalies.length === 0 && (
          <div className="absolute left-3 top-3 z-10 rounded-md border border-[#10b98155] bg-[#10b9811a] px-2.5 py-1 text-[11px] font-semibold text-[#047857]">
            정상 — 다수 주체 이상 흐름 없음{whales.length ? ` · 단일 대형 ${whales.length}건` : ""}
          </div>
        )}
        <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet"
          onClick={(e) => { if ((e.target as Element).tagName === "svg") setPinned(null); }}>
          {/* 링 가이드 */}
          <circle cx={CX} cy={CY} r={R_TOK} fill="none" stroke="var(--color-border-subtle)" strokeDasharray="2 6" opacity={0.6} />
          <circle cx={CX} cy={CY} r={R_PROTO} fill="none" stroke="var(--color-border-subtle)" strokeDasharray="2 6" opacity={0.6} />

          {/* ── 구조/흐름 엣지 ── */}
          {data.edges.map((e) => {
            const paths = edgePaths(e);
            if (!paths) return null;
            const k = edgeKey(e);
            const sysm = e.kind === "systemic";
            const whale = e.kind === "whale" && whaleLit.has(k); // 상위 N개 whale 만 색칠(과밀 방지)
            const lit = sysm || whale;
            const color = sysm ? ACTION_COLOR[e.action] : whale ? WHALE_COLOR : BASE_EDGE;
            const on = hl ? hl.edges.has(k) : null; // null=평시, true/false=격리중
            // 격리 중엔 구조선(회색)은 절대 안 띄움 — 발화 엣지만 남김
            const opacity = on === null ? (sysm ? 0.95 : whale ? 0.7 : BASE_OP) : on ? 0.97 : 0.03;
            const width = sysm ? Math.min(8.5, 2.4 + Math.sqrt(e.recentUsd) / 1100) : whale ? Math.min(4, 1.4 + Math.sqrt(e.recentUsd) / 1600) : Math.min(2, 0.6 + e.share * 4);
            const laneWidth = sysm ? Math.min(3.2, 1.35 + Math.sqrt(e.recentUsd) / 2300) : whale ? Math.min(2.2, 1.05 + Math.sqrt(e.recentUsd) / 2600) : width;
            const tip = [
              `${e.token} ${e.dir === "in" ? "→" : "←"} ${e.proto} · ${ACTION_LABEL[e.action]}`,
              `최근 ${fmt(e.recentUsd)} · 주체 ${e.actors}명 · ${e.txCount}tx${e.poolUsd > 0 ? ` · 풀의 ${(e.pctPool * 100).toFixed(1)}%` : ""}`,
              sysm ? `다수 주체 이상 흐름 (z ${e.z.toFixed(1)})` : e.kind === "whale" ? "단일/소수 주체 대형 이동 — 경보 아님" : `점유율 ${(e.share * 100).toFixed(1)}% · 윈도우 ${fmt(e.windowUsd)}`,
            ];
            return (
              <g key={k}>
                <path d={paths.center}
                  stroke="transparent" strokeWidth={lit ? 18 : 10} fill="none"
                  onMouseEnter={(ev) => { setHover(k); onTip(ev, tip); }}
                  onMouseLeave={() => { setHover(null); setTip(null); }}
                  onClick={(ev) => { ev.stopPropagation(); if (lit) togglePin(k); }}
                  style={{ cursor: lit ? "pointer" : undefined }}
                />
                {lit ? paths.lanes.map((lane, i) => (
                  <path key={i} d={lane}
                    stroke={on === false ? BASE_EDGE : color} strokeWidth={laneWidth} fill="none"
                    strokeLinecap="round"
                    opacity={i === 0 ? opacity : opacity * 0.76}
                    style={{ transition: "opacity .15s", pointerEvents: "none" }}
                  />
                )) : (
                  <path d={paths.center}
                    stroke={BASE_EDGE} strokeWidth={width} fill="none"
                    strokeLinecap="round"
                    opacity={opacity}
                    style={{ transition: "opacity .15s", pointerEvents: "none" }}
                  />
                )}
                {lit && on !== false && (
                  <FlowParticles
                    path={paths.lanes[0]}
                    color={color}
                    count={sysm ? 3 : 2}
                    duration={sysm ? 2.8 : 4.4}
                    radius={sysm ? 2.5 : 2.1}
                    opacity={on === null ? (sysm ? 0.95 : 0.72) : 0.95}
                  />
                )}
              </g>
            );
          })}

          {/* ── 레버/언와인드 페어 (같은 tx 원자적 액션 — 추정 아님) ── */}
          {data.levers.slice(0, 4).map((l, i) => {
            const parts = leverSegments(l);
            if (!parts) return null;
            const d = parts.map((p) => p.center).join(" ");
            const k = `lever:${i}`;
            const on = hl ? hl.levers.has(k) : null;
            const width = Math.min(2.6, 1.3 + Math.sqrt(l.usd) / 2600);
            const opacity = on === null ? 0.72 : on ? 0.92 : 0.05;
            return (
              <g key={k}>
                <path d={d} stroke="transparent" strokeWidth={18} fill="none"
                  onMouseEnter={(ev) => { setHover(k); onTip(ev, [`↻ 레버 ${l.collat} ↦ ${l.proto} ↦ ${l.debt}`, `같은 tx 담보예치+차입 · ${l.count}건 · ${fmt(l.usd)}`]); }}
                  onMouseLeave={() => { setHover(null); setTip(null); }} />
                {parts.flatMap((part, partIdx) => part.lanes.map((lane, laneIdx) => (
                  <path key={`${partIdx}-${laneIdx}`} d={lane} stroke={LEVER_COLOR} strokeWidth={width} fill="none"
                    strokeLinecap="round" opacity={laneIdx === 0 ? opacity : opacity * 0.74}
                    style={{ transition: "opacity .15s", pointerEvents: "none" }} />
                )))}
                {on !== false && parts.map((p, j) => (
                  <FlowParticles key={j} path={p.lanes[0]} color={LEVER_COLOR} count={2} duration={3.2} delay={j * 0.25} radius={2.2} opacity={0.85} />
                ))}
              </g>
            );
          })}
          {data.unwinds.slice(0, 3).map((l, i) => {
            const parts = leverSegments({ ...l, collat: l.debt, debt: l.collat }); // 언와인드는 역방향(상환→담보회수)
            if (!parts) return null;
            const d = parts.map((p) => p.center).join(" ");
            const k = `lever:u${i}`;
            const on = hl ? hl.levers.has(k) : null;
            const width = Math.min(2.5, 1.2 + Math.sqrt(l.usd) / 2600);
            const opacity = on === null ? 0.66 : on ? 0.88 : 0.05;
            return (
              <g key={k}>
                <path d={d} stroke="transparent" strokeWidth={18} fill="none"
                  onMouseEnter={(ev) => { setHover(k); onTip(ev, [`↩ 언와인드 ${l.debt} 상환 → ${l.collat} 회수 · ${l.proto}`, `같은 tx 상환+담보인출 · ${l.count}건 · ${fmt(l.usd)}`]); }}
                  onMouseLeave={() => { setHover(null); setTip(null); }} />
                {parts.flatMap((part, partIdx) => part.lanes.map((lane, laneIdx) => (
                  <path key={`${partIdx}-${laneIdx}`} d={lane} stroke={UNWIND_COLOR} strokeWidth={width} fill="none"
                    strokeLinecap="round" opacity={laneIdx === 0 ? opacity : opacity * 0.74}
                    style={{ transition: "opacity .15s", pointerEvents: "none" }} />
                )))}
                {on !== false && parts.map((p, j) => (
                  <FlowParticles key={j} path={p.lanes[0]} color={UNWIND_COLOR} count={2} duration={3.4} delay={j * 0.25} radius={2.1} opacity={0.82} />
                ))}
              </g>
            );
          })}

          {/* ── 프로토콜 노드 (바깥 링) ── */}
          {data.protocols.map((p) => {
            const at = layout.protoPos.get(p.name);
            if (!at) return null;
            const ring = p.state === "danger" ? "#dc2626" : p.state === "warn" ? "#f59e0b" : "var(--color-border-strong)";
            const idle = p.inUsd + p.outUsd === 0;
            const on = hl ? hl.protos.has(p.name) : null;
            const opacity = on === null ? (idle ? 0.5 : 1) : on ? 1 : 0.18;
            return (
              <g key={p.name} opacity={opacity} style={{ transition: "opacity .15s", cursor: "pointer" }}
                onMouseEnter={(ev) => { setHover(`proto:${p.name}`); onTip(ev, [p.name + (pinned === `proto:${p.name}` ? " (고정됨 — 다시 클릭해 해제)" : ""), `유입(예치·상환) ${fmt(p.inUsd)} / 유출(인출·차입) ${fmt(p.outUsd)} (6h)`, p.state === "ok" ? "유출 정상" : `유출 z ${p.outZ.toFixed(1)} — ${p.state === "danger" ? "이상 유출" : "주의"}`]); }}
                onMouseLeave={() => { setHover(null); setTip(null); }}
                onClick={(ev) => { ev.stopPropagation(); togglePin(`proto:${p.name}`); }}>
                {p.state === "danger" && <circle cx={at.x} cy={at.y} r={27} fill="none" stroke="#dc2626" strokeWidth={1.6} className="cs-flow-dash" />}
                <circle cx={at.x} cy={at.y} r={21} fill="var(--color-surface)" stroke={ring} strokeWidth={p.state === "ok" ? 1.2 : 2.4} />
                <image href={protoIcon(p.slug)} x={at.x - 13} y={at.y - 13} width={26} height={26} clipPath="circle(13px)" />
                <text x={at.x} y={at.y + (at.y >= CY ? 36 : -28)} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--color-text-primary)">{p.name}</text>
                {p.state !== "ok" && <text x={at.x} y={at.y + (at.y >= CY ? 48 : -16)} textAnchor="middle" fontSize={9} fill={ring}>유출 z {p.outZ.toFixed(1)}</text>}
              </g>
            );
          })}

          {/* ── 토큰 노드 (안쪽 링) ── */}
          {layout.toks.map((t, ti) => {
            const at = layout.tokPos.get(t.sym)!;
            const focus = t.sym === focusSym;
            const idle = t.inUsd + t.outUsd === 0;
            const ring = t.anomalous ? "#dc2626" : focus ? "var(--color-accent)" : "var(--color-border-strong)";
            const on = hl ? hl.toks.has(t.sym) : null;
            const opacity = on === null ? (idle && !focus ? 0.45 : 1) : on ? 1 : 0.1;
            const r = focus ? 16 : idle ? 8 : 13;
            // 라벨: 노드에서 안쪽(중심 방향)으로 방사형 + 홀짝 스태거 — 59노드 링에서 겹침 최소화
            const rad = (at.deg * Math.PI) / 180;
            const lr = r + 8 + (ti % 2 ? 12 : 2);
            const lx = at.x - Math.cos(rad) * lr, ly = at.y - Math.sin(rad) * lr;
            return (
              <g key={t.sym} opacity={opacity} style={{ transition: "opacity .15s", cursor: "pointer" }}
                onMouseEnter={(ev) => { setHover(`tok:${t.sym}`); onTip(ev, [t.sym + (focus ? " (현재 페이지 토큰)" : "") + (pinned === `tok:${t.sym}` ? " (고정됨)" : "") + (idle ? " · 6h 흐름 없음" : ""), idle ? "지원 토큰 — 최근 흐름 없음" : `유입 ${fmt(t.inUsd)} / 유출 ${fmt(t.outUsd)} (6h)`]); }}
                onMouseLeave={() => { setHover(null); setTip(null); }}
                onClick={(ev) => { ev.stopPropagation(); togglePin(`tok:${t.sym}`); }}>
                <circle cx={at.x} cy={at.y} r={r} fill="var(--color-surface)" stroke={ring} strokeWidth={t.anomalous || focus ? 2.4 : 1.1} />
                <image href={tokenIcon(t.addr, data.meta.chainId)} x={at.x - (r - 2)} y={at.y - (r - 2)} width={(r - 2) * 2} height={(r - 2) * 2} clipPath={`circle(${r - 2}px)`} opacity={idle && on === null ? 0.7 : 1} />
                {(!idle || focus || on) && (
                  <text x={lx} y={ly + 3} textAnchor="middle" fontSize={8.5} fontWeight={focus ? 700 : 500}
                    fill={t.anomalous ? "#dc2626" : "var(--color-text-secondary)"} paintOrder="stroke" stroke="var(--color-surface)" strokeWidth={2.5}>{t.sym}</text>
                )}
              </g>
            );
          })}
        </svg>

        {tip && (
          <div className="pointer-events-none absolute z-20 w-[220px] rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[10.5px] leading-relaxed shadow-lg" style={{ left: tip.x, top: tip.y }}>
            {tip.lines.map((l, i) => <div key={i} className={i === 0 ? "font-semibold text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}>{l}</div>)}
          </div>
        )}
      </div>
      </div>

      {/* ── 우측 레일 — railPortal 주어지면 알림 패널 안으로 합쳐 렌더(포털) ── */}
      <RailHost portal={railPortal}>
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-2">
          <div className="text-[12px] font-bold text-[var(--color-text-primary)]">실시간 상황판 <span className="font-normal text-[var(--color-text-muted)]">· {data.meta.chainLabel}</span></div>
          <button onClick={() => { setLoading(true); load(); }} title="새로고침" className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">↻</button>
        </div>

        {/* 이상 흐름 (systemic — 다수 주체) */}
        <Section title={`⚠ 이상 흐름 (다수 주체 ≥${data.meta.minActors}명) ${anomalies.length}건`} accent={anomalies.length ? "#dc2626" : undefined}>
          {anomalies.length === 0 ? (
            <p className="px-3 pb-2 text-[10.5px] leading-relaxed text-[var(--color-text-muted)]">최근 {agoFmt(winLag)} 전 평가창에서 다수 주체가 동시에 움직인 비정상 흐름 없음. 단일 고래 1건은 아래 &apos;대형 단일 이동&apos;으로 분리 — 경보 아님.</p>
          ) : anomalies.map((e) => (
            <button key={edgeKey(e)} onMouseEnter={() => setHover(edgeKey(e))} onMouseLeave={() => setHover(null)} onClick={() => togglePin(edgeKey(e))}
              className={"block w-full px-3 py-1.5 text-left transition-colors " + (focusKey === edgeKey(e) ? "bg-[var(--color-surface-raised)]" : "hover:bg-[var(--color-surface-raised)]")}>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]">
                <span className="size-2 shrink-0 rounded-full" style={{ background: ACTION_COLOR[e.action] }} />
                {e.token} {e.dir === "in" ? "→" : "←"} {e.proto} <span style={{ color: ACTION_COLOR[e.action] }}>{ACTION_LABEL[e.action]}</span>
              </div>
              <div className="pl-3.5 font-mono text-[10px] text-[var(--color-text-secondary)]">{fmt(e.recentUsd)} <span className="text-[var(--color-text-muted)]">· {e.actors}주체 · {e.txCount}tx · z {e.z.toFixed(1)}{e.poolUsd > 0 ? ` · 풀 ${(e.pctPool * 100).toFixed(0)}%` : ""}</span></div>
            </button>
          ))}
        </Section>

        {/* 대형 단일 이동 (whale — 정보, 경보 아님) */}
        {whales.length > 0 && (
          <Section title={`🐋 대형 단일 이동 ${whales.length}건`} accent={WHALE_COLOR}>
            {whales.slice(0, 8).map((e) => (
              <button key={edgeKey(e)} onMouseEnter={() => setHover(edgeKey(e))} onMouseLeave={() => setHover(null)} onClick={() => togglePin(edgeKey(e))}
                className={"block w-full px-3 py-1 text-left transition-colors " + (focusKey === edgeKey(e) ? "bg-[var(--color-surface-raised)]" : "hover:bg-[var(--color-surface-raised)]")}>
                <div className="text-[10.5px] font-medium text-[var(--color-text-primary)]">
                  {e.token} {e.dir === "in" ? "→" : "←"} {e.proto} <span style={{ color: WHALE_COLOR }}>{ACTION_LABEL[e.action]}</span>
                  <span className="ml-1 font-mono text-[var(--color-text-muted)]">{fmt(e.recentUsd)} · {DEX_PROTOS.has(e.proto) ? "스왑 볼륨 급증(라우터 경유 — 주체식별불가)" : `${e.actors}주체·최대 ${(e.topShare * 100).toFixed(0)}%`}{e.poolUsd > 0 ? ` · 풀 ${(e.pctPool * 100).toFixed(0)}%` : ""}</span>
                </div>
              </button>
            ))}
            <p className="px-3 pt-0.5 pb-1 text-[9px] leading-relaxed text-[var(--color-text-muted)]">소수 주체의 대형 이동(포지션 청산·리밸런싱 등). 다수 주체 run 과 구분 — 그 자체로 위험은 아님.</p>
          </Section>
        )}

        {/* 레버 경로 — 기준 명시 */}
        <Section title={`↻ 레버 / ↩ 언와인드 ${data.levers.length + data.unwinds.length ? "" : "— 없음"}`} accent={LEVER_COLOR}>
          <p className="px-3 pb-1 text-[9px] leading-relaxed text-[var(--color-text-muted)]">
            기준 — <b>레버</b>: 같은 tx·같은 주체가 담보 예치 + 다른 토큰 차입(차입 ≥$100K). <b>언와인드</b>: 같은 tx·같은 주체가 상환 + 담보 회수. 원자적 페어만(추정 없음).
          </p>
          {data.levers.slice(0, 6).map((l, i) => (
            <button key={i} onMouseEnter={() => setHover(`lever:${i}`)} onMouseLeave={() => setHover(null)} onClick={() => togglePin(`lever:${i}`)}
              className={"block w-full px-3 py-1 text-left text-[10.5px] hover:bg-[var(--color-surface-raised)] " + (pinned === `lever:${i}` ? "bg-[var(--color-surface-raised)]" : "")}>
              <span className="font-semibold text-[var(--color-text-primary)]">{l.collat} ↦ {l.proto} ↦ {l.debt}</span>
              <span className="ml-1.5 font-mono text-[var(--color-text-muted)]">{l.count}건 · {fmt(l.usd)}</span>
            </button>
          ))}
          {data.unwinds.slice(0, 3).map((l, i) => (
            <button key={`u${i}`} onMouseEnter={() => setHover(`lever:u${i}`)} onMouseLeave={() => setHover(null)} onClick={() => togglePin(`lever:u${i}`)}
              className={"block w-full px-3 py-1 text-left text-[10.5px] hover:bg-[var(--color-surface-raised)] " + (pinned === `lever:u${i}` ? "bg-[var(--color-surface-raised)]" : "")}>
              <span className="font-medium" style={{ color: UNWIND_COLOR }}>↩ 언와인드</span>{" "}
              <span className="font-semibold text-[var(--color-text-primary)]">{l.collat}/{l.debt} · {l.proto}</span>
              <span className="ml-1.5 font-mono text-[var(--color-text-muted)]">{l.count}건 · {fmt(l.usd)}</span>
            </button>
          ))}
        </Section>

        {/* 범례 */}
        <Section title="범례">
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 px-3 pb-1 text-[10px] text-[var(--color-text-secondary)]">
            {(Object.keys(ACTION_COLOR) as FlowAction[]).map((a) => (
              <span key={a} className="flex items-center gap-1.5"><span className="inline-block h-[3px] w-4 rounded" style={{ background: ACTION_COLOR[a] }} />{ACTION_LABEL[a]} {["supply", "repay", "sell"].includes(a) ? "(토큰→프로토)" : "(프로토→토큰)"}</span>
            ))}
            <span className="flex items-center gap-1.5"><span className="inline-block h-[3px] w-4 rounded" style={{ background: WHALE_COLOR }} />단일 대형(정보)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-[3px] w-4 rounded" style={{ background: LEVER_COLOR }} />레버 페어</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-[3px] w-4 rounded" style={{ background: BASE_EDGE }} />평시 구조(≥1%)</span>
          </div>
          <p className="px-3 pb-2 text-[9.5px] leading-relaxed text-[var(--color-text-muted)]">빨강 입자선 = 다수 주체 이상 흐름(이상치). 호박 = 단일 주체 대형(정보). 흐린 = 구조(점유율 ≥1%).</p>
        </Section>

        {/* 메타 */}
        <div className="space-y-0.5 px-3 py-2 text-[9.5px] leading-relaxed text-[var(--color-text-muted)]">
          <div>윈도우 6h · 버킷 5분 · 평가창 ≈{agoFmt(winLag)} 전~ · 이상치 = 주체≥{data.meta.minActors} ∧ z≥3.5 ∧ ≥{fmt(data.meta.minUsd)}</div>
          <div>소스: {data.meta.protocols.join(" · ")} · 블록 {data.meta.latestBlock.toLocaleString()}{data.meta.historical != null ? " (과거 리플레이)" : ""}</div>
          <div>갱신 {agoFmt(ago)} 전 · 60s 자동 · 추적 토큰 {data.tokens.length}종 · Aave materiality 미적용(2단계)</div>
          {data.meta.errors?.map((e, i) => <div key={i} className="text-[#b45309]">⚠ {e}</div>)}
        </div>
      </RailHost>
    </div>
  );
}

/** 레일 컨테이너 — portal 미지정: 보드 옆 내장 aside / 지정: 그 DOM 으로 포털(없으면 미렌더) */
function RailHost({ portal, children }: { portal?: HTMLElement | null; children: React.ReactNode }) {
  if (portal === undefined) {
    return <aside className="w-full shrink-0 overflow-y-auto border-t border-[var(--color-border-subtle)] bg-[var(--color-surface)] lg:w-[300px] lg:border-l lg:border-t-0">{children}</aside>;
  }
  return portal ? createPortal(children, portal) : null;
}

function Section({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--color-border-subtle)] py-1.5">
      <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: accent ?? "var(--color-text-muted)" }}>{title}</div>
      {children}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[420px] flex-col items-center justify-center">{children}</div>;
}
