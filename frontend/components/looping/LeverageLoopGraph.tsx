"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * 레버리지 루프 그래프 — LST/LRT·스테이블의 정상 레버리지 루핑을 Morpho 포지션으로.
 *   루퍼(담보+차입 동시)를 링으로, 마켓을 중앙에. 각 루퍼:
 *     →[토큰 담보, 초록]→ 마켓   +   마켓 →[loan 차입, 빨강]→ 루퍼   = 레버리지 루프(왕복 화살표).
 *   차입금을 토큰으로 스왑해 재담보 → 루프가 닫힘(점선으로 암시).
 *   루퍼 색 = LTV/LLTV 근접도(청산 위험). 크기 = 담보 규모.
 */

interface Market { id: string; label: string; loan: string; lltv: number; util: number | null; borrowUsd: number; collatUsd: number; loopers: number }
interface Looper { addr: string; collatUsd: number; borrowUsd: number; hf: number | null; ltv: number; loans: string[]; marketIds: string[] }
interface Resp { available: boolean; reason?: string; symbol?: string; markets?: Market[]; loopers?: Looper[]; looperCount?: number; totalCollatUsd?: number; totalBorrowUsd?: number; maxLltv?: number; loanAssets?: string[]; known?: string[] }

const fmt = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);
const EXPLORER = "https://etherscan.io/address/";
const W = 1000, H = 600;
const LOAN_TINT: Record<string, string> = { WETH: "#3b82f6", USDT: "#0d9488", USDC: "#2563eb", DAI: "#d97706", USDS: "#6366f1" };

export function LeverageLoopGraph({ sym }: { sym: string }) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [hov, setHov] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true); setResp(null);
    fetch(`/api/leverageloop/${encodeURIComponent(sym)}`, { cache: "no-store" })
      .then((r) => r.json()).then(setResp).catch(() => setResp({ available: false })).finally(() => setLoading(false));
  }, [sym]);

  const layout = useMemo(() => (resp?.available ? build(resp) : null), [resp]);

  if (loading) return <Center>Morpho 포지션에서 레버리지 루퍼 찾는 중…</Center>;
  if (!resp?.available) return (
    <Center>
      <div className="font-semibold text-[var(--color-text-secondary)]">{resp?.reason ?? `${sym} 레버리지 루프 데이터 없음`}</div>
      {resp?.known?.length ? <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">대상: <span className="font-mono">{resp.known.map((k) => k.toUpperCase()).slice(0, 14).join(" · ")}…</span></div> : null}
    </Center>
  );
  if (!layout) return <Center>루프 그래프를 구성할 수 없습니다</Center>;

  const avgLtv = (resp.totalBorrowUsd ?? 0) / Math.max(1, resp.totalCollatUsd ?? 1);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded-full px-2.5 py-1 text-[12px] font-bold" style={{ color: "#b45309", background: "#f59e0b1a" }}>
            🔁 레버리지 루핑 — {resp.looperCount}개 주소
          </span>
          <span className="text-[12px] text-[var(--color-text-secondary)]">
            {sym} 담보 {fmt(resp.totalCollatUsd ?? 0)} → {(resp.loanAssets ?? []).join("/")} 차입 {fmt(resp.totalBorrowUsd ?? 0)} · 평균 LTV {(avgLtv * 100).toFixed(0)}% (LLTV 최대 {((resp.maxLltv ?? 0) * 100).toFixed(0)}%)
          </span>
          <span className="ml-auto font-mono text-[10px] text-[var(--color-text-muted)]">Morpho 포지션 라이브</span>
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">담보 예치 ▸ 상관자산 차입 ▸ 토큰으로 스왑 ▸ 재담보 = 닫힌 레버리지 루프. LTV가 LLTV에 가까울수록(빨강) 청산 위험.</div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-4 py-1 text-[10px] text-[var(--color-text-muted)]">
        <span className="flex items-center gap-1"><Arrow c="#16a34a" />{sym} 담보 예치</span>
        <span className="flex items-center gap-1"><Arrow c="#dc2626" />차입</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 rounded border-t border-dashed border-[#94a3b8]" />스왑·재담보(암시)</span>
        <span className="ml-auto">노드 크기=담보 · 색=청산 근접도 · 클릭=익스플로러</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-bg)]">
        <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block h-full max-h-[640px] w-full" preserveAspectRatio="xMidYMid meet">
          <defs>
            {["#16a34a", "#dc2626"].map((c) => (
              <marker key={c} id={`llarr-${c.slice(1)}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e, i) => {
            const s = layout.pos.get(e.source), t = layout.pos.get(e.target);
            if (!s || !t) return null;
            const lit = !hov || hov === e.looper;
            const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len, px = -uy, py = ux, off = 7;
            const x1 = s.x + ux * s.r + px * off, y1 = s.y + uy * s.r + py * off, x2 = t.x - ux * t.r + px * off, y2 = t.y - uy * t.r + py * off;
            const mx = (x1 + x2) / 2 + px * Math.min(34, len * 0.16), my = (y1 + y2) / 2 + py * Math.min(34, len * 0.16);
            const c = e.role === "collateral" ? "#16a34a" : "#dc2626";
            const w = 1 + Math.min(6, Math.sqrt(e.amount / layout.maxAmt) * 6);
            return <path key={i} d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`} fill="none" stroke={c} strokeWidth={w}
              strokeOpacity={lit ? 0.85 : 0.06} markerEnd={`url(#llarr-${c.slice(1)})`} />;
          })}
          {layout.nodes.map((n) => {
            const p = layout.pos.get(n.id)!;
            const dim = hov && hov !== n.id && !(n.kind === "market");
            if (n.kind === "market") {
              return (
                <g key={n.id} onMouseEnter={() => setHov(n.id)} onMouseLeave={() => setHov(null)}>
                  <rect x={p.x - 46} y={p.y - 16} width={92} height={32} rx={7} fill="#dbeafe" stroke={LOAN_TINT[n.loan ?? ""] ?? "#2563eb"} strokeWidth={2} />
                  <text x={p.x} y={p.y - 1} textAnchor="middle" className="pointer-events-none fill-[var(--color-text-primary)] font-bold" style={{ fontSize: 10 }}>{n.label}</text>
                  <text x={p.x} y={p.y + 10} textAnchor="middle" className="pointer-events-none fill-[var(--color-text-muted)] font-mono" style={{ fontSize: 8 }}>LLTV {(n.lltv! * 100).toFixed(0)}% · {fmt(n.borrowUsd!)}</text>
                </g>
              );
            }
            return (
              <g key={n.id} style={{ opacity: dim ? 0.25 : 1, cursor: "pointer" }} onMouseEnter={() => setHov(n.id)} onMouseLeave={() => setHov(null)} onClick={() => window.open(EXPLORER + n.addr, "_blank")}>
                {n.danger && <circle cx={p.x} cy={p.y} r={p.r + 3.5} fill="none" stroke="#ef4444" strokeWidth={1.2} strokeOpacity={0.6} className="cs-flow-dash" style={{ animationDuration: "2s" }} />}
                <circle cx={p.x} cy={p.y} r={p.r} fill={n.color} stroke={n.danger ? "#dc2626" : "#94a3b8"} strokeWidth={n.danger ? 2.2 : 1.3} />
                {(hov === n.id || p.r > 13) && <>
                  <text x={p.x} y={p.y + p.r + 11} textAnchor="middle" className="pointer-events-none fill-[var(--color-text-primary)] font-mono font-semibold" style={{ fontSize: 9 }}>{n.addr!.slice(0, 8)}…</text>
                  <text x={p.x} y={p.y + p.r + 20} textAnchor="middle" className="pointer-events-none fill-[var(--color-text-muted)] font-mono" style={{ fontSize: 8 }}>{fmt(n.collatUsd!)} · LTV{(n.ltv! * 100).toFixed(0)}%</text>
                </>}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

interface LN { id: string; kind: "market" | "looper"; label?: string; loan?: string; lltv?: number; borrowUsd?: number; addr?: string; collatUsd?: number; ltv?: number; color?: string; danger?: boolean }
function build(resp: Resp) {
  const markets = resp.markets ?? [], loopers = resp.loopers ?? [];
  const maxLltv = resp.maxLltv ?? 1;
  const cx = W / 2, cy = H / 2;
  const pos = new Map<string, { x: number; y: number; r: number }>();
  const nodes: LN[] = [];
  const maxCollat = Math.max(1, ...loopers.map((l) => l.collatUsd));
  const ltvRatio = (l: Looper) => Math.min(1, l.ltv / Math.max(0.5, maxLltv));
  const ringColor = (r: number) => (r >= 0.85 ? "#fecaca" : r >= 0.6 ? "#fed7aa" : "#e2e8f0");

  // 섹터(wedge) 배치 — 각 마켓이 한 각도 구역을 소유, 그 마켓의 루퍼들을 같은 구역 바깥에 부채꼴.
  //   → 루퍼↔마켓 화살표가 짧고 국소적 = 중앙 교차 폭주 제거.
  const M = Math.max(1, markets.length);
  const RM = 120, R1 = 245;
  const byMarket = new Map<string, Looper[]>();
  for (const l of loopers) { const mid = markets.find((m) => l.marketIds.includes(m.id))?.id ?? markets[0]?.id; if (mid) (byMarket.get(mid) ?? byMarket.set(mid, []).get(mid)!).push(l); }

  markets.forEach((m, i) => {
    const ca = -Math.PI / 2 + (2 * Math.PI * i) / M;
    pos.set(m.id, { x: cx + Math.cos(ca) * RM, y: cy + Math.sin(ca) * RM, r: 24 });
    nodes.push({ id: m.id, kind: "market", label: m.label, loan: m.loan, lltv: m.lltv, borrowUsd: m.borrowUsd });
    const list = (byMarket.get(m.id) ?? []).sort((a, b) => b.collatUsd - a.collatUsd);
    const wedge = (2 * Math.PI / M) * 0.86;
    const N = list.length;
    list.forEach((l, j) => {
      const a = N <= 1 ? ca : ca - wedge / 2 + (wedge * j) / (N - 1);
      const r = 7 + Math.sqrt(l.collatUsd / maxCollat) * 14;
      pos.set(`L:${l.addr}`, { x: cx + Math.cos(a) * R1, y: cy + Math.sin(a) * R1, r });
      const rr = ltvRatio(l);
      nodes.push({ id: `L:${l.addr}`, kind: "looper", addr: l.addr, collatUsd: l.collatUsd, ltv: l.ltv, color: ringColor(rr), danger: rr >= 0.85, market: m.id } as LN & { market: string });
    });
  });

  // 엣지: 루퍼 ↔ 자기 마켓(담보 초록 in, 차입 빨강 out) — 합계를 그 마켓 1곳으로(국소).
  const edges: { source: string; target: string; role: "collateral" | "borrow"; amount: number; looper: string }[] = [];
  const maxAmt = Math.max(1, maxCollat);
  for (const m of markets) {
    for (const l of (byMarket.get(m.id) ?? [])) {
      const lid = `L:${l.addr}`;
      edges.push({ source: lid, target: m.id, role: "collateral", amount: l.collatUsd, looper: lid });
      edges.push({ source: m.id, target: lid, role: "borrow", amount: l.borrowUsd, looper: lid });
    }
  }
  return { nodes, edges, pos, maxAmt };
}

function Arrow({ c }: { c: string }) { return <svg width="18" height="8"><line x1="1" y1="4" x2="14" y2="4" stroke={c} strokeWidth="2" /><path d="M14 1 L18 4 L14 7 z" fill={c} /></svg>; }
function Center({ children }: { children: React.ReactNode }) { return <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]"><div>{children}</div></div>; }
