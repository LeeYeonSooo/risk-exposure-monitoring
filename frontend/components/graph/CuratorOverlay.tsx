"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, ShieldAlert, X } from "lucide-react";

import { formatUsd, type GraphEdge, type GraphNode, type TopologyResponse } from "@/lib/api";
import type { CuratorGroup } from "@/app/api/curators/route";

const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
// 동향 기준 가동률 밴드: <80 정상(초록) / 80–95 상승(황) / ≥95 punitive·락업(적)
const utilColor = (u: number | null) =>
  u == null ? "var(--color-text-muted)" : u >= 0.95 ? "var(--color-danger)" : u >= 0.8 ? "#fbbf24" : "#34d399";

interface AlertLike { kind: string; token: string; detail?: Record<string, unknown> | null; }

/**
 * 큐레이터/배분 도구 — 맵 위 오버레이. 두 관점:
 *  ① 배분(Allocate): 토큰 선택 → 전 마켓 + 유동성 풍부·가동률 낮은 "배분 적합" 짚기 (투자 입장)
 *  ② 리스크(De-risk): 큐레이터별 위험담보 노출 + 디리스킹 (방어 입장)
 */
export function CuratorOverlay({ open, onClose, topology }: { open: boolean; onClose: () => void; topology: TopologyResponse }) {
  const [tab, setTab] = useState<"allocate" | "risk">("allocate");
  const [curators, setCurators] = useState<CuratorGroup[]>([]);
  const [alerts, setAlerts] = useState<AlertLike[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);

  // 리스크 탭 데이터 (큐레이터 + 디페깅/디리스킹 알림) — 오버레이 열릴 때 1회.
  useEffect(() => {
    if (!open || loaded) return;
    setLoading(true);
    Promise.all([
      fetch("/api/curators", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ curators: [] })),
      fetch("/api/alerts?limit=500", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ alerts: [] })),
    ]).then(([c, a]) => {
      setCurators(c.curators ?? []);
      setAlerts(a.alerts ?? []);
    }).finally(() => { setLoading(false); setLoaded(true); });
  }, [open, loaded]);

  // 배분 탭: 토큰 → 렌딩 마켓 (topology 의 lendingRisk 엣지)
  const tokenMarkets = useMemo(() => {
    const labelById = new Map(topology.nodes.map((n) => [n.id, n.label] as const));
    const byToken = new Map<string, { node: GraphNode; markets: { proto: string; chain: string; lt: number | null; liqUsd: number | null; util: number | null; exposureUsd: number }[]; total: number }>();
    for (const n of topology.nodes) {
      if (n.type !== "Token") continue;
      byToken.set(n.id, { node: n, markets: [], total: 0 });
    }
    for (const e of topology.edges as GraphEdge[]) {
      if (e.attrs?.lendingRisk == null) continue;
      const t = byToken.get(e.source);
      if (!t) continue;
      const usd = e.attrs.core?.amountUsd ?? 0;
      t.markets.push({ proto: labelById.get(e.target) ?? e.target.replace(/^protocol:/, ""), chain: (topology.nodes.find((x) => x.id === e.target)?.metadata.chain as string) ?? "ethereum", lt: e.attrs.lendingRisk?.lt ?? null, liqUsd: e.attrs.lendingRisk?.liquidityUsd ?? null, util: e.attrs.lendingRisk?.utilization ?? null, exposureUsd: usd });
      t.total += usd;
    }
    return [...byToken.values()].filter((t) => t.markets.length > 0).sort((a, b) => b.total - a.total);
  }, [topology]);

  const [selSym, setSelSym] = useState<string>("");
  const selected = useMemo(() => {
    const want = selSym || tokenMarkets[0]?.node.label;
    return tokenMarkets.find((t) => t.node.label === want) ?? tokenMarkets[0] ?? null;
  }, [selSym, tokenMarkets]);

  // 배분 적합도: 가동률 낮고(인출/진입 여유) 유동성 풍부 → "적합". ≥95% → 회피.
  const allocRows = useMemo(() => {
    if (!selected) return [];
    const maxLiq = Math.max(1, ...selected.markets.map((m) => m.liqUsd ?? 0));
    return selected.markets
      .map((m) => {
        const fit = m.util == null ? 0 : (1 - Math.min(1, m.util)) * Math.sqrt((m.liqUsd ?? 0) / maxLiq);
        const verdict = m.util != null && m.util >= 0.95 ? "회피" : m.util != null && m.util < 0.8 && (m.liqUsd ?? 0) >= 0.25 * maxLiq ? "적합" : "보통";
        return { ...m, maxLiq, verdict };
      })
      .sort((a, b) => (a.util ?? 1) - (b.util ?? 1) || (b.liqUsd ?? 0) - (a.liqUsd ?? 0));
  }, [selected]);

  // 리스크 탭: 큐레이터별 위험담보(디페깅 or 가동률≥95) 노출
  const depegSyms = useMemo(() => new Set(alerts.filter((a) => a.kind === "depeg").map((a) => a.token)), [alerts]);
  const deriskByCurator = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of alerts) if (a.kind === "curator_derisk") { const c = (a.detail?.curator as string) ?? ""; if (c) m.set(c, (m.get(c) ?? 0) + 1); }
    return m;
  }, [alerts]);
  const riskRows = useMemo(() => {
    return curators.map((c) => {
      let riskyUsd = 0; const collat = new Set<string>();
      for (const v of c.vaults) for (const al of v.allocations) {
        const isDepeg = depegSyms.has(al.collateral);
        const isHot = (al.utilization ?? 0) >= 0.95;
        if (isDepeg || isHot) { riskyUsd += al.supplyUsd; if (isDepeg) collat.add(`${al.collateral}⚠`); else collat.add(al.collateral); }
      }
      return { name: c.name, source: c.source, protocol: c.protocol, hhi: c.ownBookHHI, markets: c.marketCount, aum: c.aumUsd, riskyUsd, riskyPct: c.aumUsd > 0 ? riskyUsd / c.aumUsd : 0, collat: [...collat].slice(0, 6), derisk: deriskByCurator.get(c.name) ?? 0 };
    }).sort((a, b) => b.riskyUsd - a.riskyUsd || b.aum - a.aum);
  }, [curators, depegSyms, deriskByCurator]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[var(--color-background)]/96 backdrop-blur-sm">
      <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-5 py-2.5">
        <h2 className="text-[14px] font-semibold">큐레이터 / 배분</h2>
        <div className="flex gap-1 text-[12px]">
          {(["allocate", "risk"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={"rounded px-2.5 py-1 font-medium transition-colors " + (tab === t ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]")}>
              {t === "allocate" ? "배분 (어디 넣나)" : "리스크 (어디서 빼나)"}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="ml-auto rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]" title="닫기"><X size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-4xl">
          {tab === "allocate" ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-[var(--color-text-secondary)]">토큰</span>
                <select value={selected?.node.label ?? ""} onChange={(e) => setSelSym(e.target.value)} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[12px]">
                  {tokenMarkets.map((t) => <option key={t.node.id} value={t.node.label}>{t.node.label} · {formatUsd(t.total)}</option>)}
                </select>
                <span className="text-[12px] text-[var(--color-text-muted)]">의 렌딩 마켓 — 유동성 풍부·가동률 낮은 = 배분 적합</span>
              </div>
              {!selected ? <div className="py-10 text-[var(--color-text-muted)]">렌딩 노출 토큰 없음.</div> : (
                <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)]">
                  <table className="w-full text-[12px]">
                    <thead><tr className="bg-[var(--color-surface)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      <th className="px-3 py-2 text-left font-medium">댑 · 체인</th><th className="px-3 py-2 text-right font-medium">현재 노출</th><th className="px-3 py-2 text-right font-medium">LT</th><th className="px-3 py-2 text-left font-medium">가용 유동성</th><th className="px-3 py-2 text-left font-medium">가동률</th><th className="px-3 py-2 text-center font-medium">배분</th>
                    </tr></thead>
                    <tbody>
                      {allocRows.map((m, i) => (
                        <tr key={i} className="border-t border-[var(--color-border-subtle)]">
                          <td className="px-3 py-2"><div className="font-medium">{m.proto}</div><div className="text-[9px] uppercase text-[var(--color-text-muted)]">{m.chain}</div></td>
                          <td className="px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">{formatUsd(m.exposureUsd)}</td>
                          <td className="px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">{m.lt != null ? pct(m.lt) : "—"}</td>
                          <td className="px-3 py-2"><Bar val={m.liqUsd} max={m.maxLiq} color="#60a5fa" label={m.liqUsd != null ? formatUsd(m.liqUsd) : "—"} /></td>
                          <td className="px-3 py-2"><Bar val={m.util} max={1} color={utilColor(m.util)} label={pct(m.util)} pctMode /></td>
                          <td className="px-3 py-2 text-center">
                            <span className={"rounded px-1.5 py-0.5 text-[10px] font-medium " + (m.verdict === "적합" ? "bg-[#34d399]/15 text-[#34d399]" : m.verdict === "회피" ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]" : "text-[var(--color-text-muted)]")}>{m.verdict}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">배분 적합 = 가동률 &lt;80%(진입·인출 여유) + 유동성 풍부. 회피 = 가동률 ≥95%(인출 불가 위험). 고래/큐레이터가 이 토큰 깔 때 어디가 좋은지.</p>
            </>
          ) : loading ? (
            <div className="flex items-center gap-2 py-16 text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" /> 로딩 중…</div>
          ) : (
            <>
              <p className="mb-3 text-[12px] text-[var(--color-text-secondary)]">큐레이터별 <b>위험담보 노출</b> — 디페깅(⚠) 또는 가동률 ≥95% 마켓에 들어간 금액. 큰 순. 디리스킹(withdraw queue 제거/대량인출) 횟수 표시.</p>
              <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)]">
                <table className="w-full text-[12px]">
                  <thead><tr className="bg-[var(--color-surface)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    <th className="px-3 py-2 text-left font-medium">큐레이터 · 베뉴</th><th className="px-3 py-2 text-right font-medium">AUM</th><th className="px-3 py-2 text-right font-medium" title="자기북 집중도 HHI — 1=한 마켓 몰빵">자기북 집중</th><th className="px-3 py-2 text-right font-medium">위험 노출</th><th className="px-3 py-2 text-right font-medium">비중</th><th className="px-3 py-2 text-left font-medium">위험 담보</th><th className="px-3 py-2 text-center font-medium">디리스킹</th>
                  </tr></thead>
                  <tbody>
                    {riskRows.map((r) => (
                      <tr key={r.name} className="border-t border-[var(--color-border-subtle)]">
                        <td className="px-3 py-2 font-medium">
                          <span>{r.name}</span>
                          <span className={"ml-1.5 rounded px-1 py-0.5 text-[9px] " + (r.source === "defillama" ? "bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]" : "bg-[var(--color-accent)]/12 text-[var(--color-accent)]")} title={r.source === "defillama" ? "DeFiLlama 집계 (미검증)" : "Morpho 온체인 (검증)"}>{r.protocol}{r.source === "defillama" ? " ·추정" : ""}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">{formatUsd(r.aum)}</td>
                        <td className="px-3 py-2 text-right font-mono" style={{ color: r.hhi >= 0.5 ? "var(--color-danger)" : r.hhi >= 0.3 ? "#fbbf24" : "var(--color-text-muted)" }} title={`${r.markets}개 마켓에 배분 · HHI ${r.hhi.toFixed(2)} (1=한 마켓 몰빵)`}>{r.hhi > 0 ? r.hhi.toFixed(2) : "—"}</td>
                        <td className="px-3 py-2 text-right font-mono" style={{ color: r.riskyUsd > 0 ? "var(--color-danger)" : "var(--color-text-muted)" }}>{r.riskyUsd > 0 ? formatUsd(r.riskyUsd) : "—"}</td>
                        <td className="px-3 py-2 text-right font-mono" style={{ color: r.riskyPct >= 0.2 ? "var(--color-danger)" : r.riskyPct >= 0.05 ? "#fbbf24" : "var(--color-text-muted)" }}>{r.riskyUsd > 0 ? pct(r.riskyPct) : "—"}</td>
                        <td className="px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">{r.collat.length ? r.collat.join(", ") : "—"}</td>
                        <td className="px-3 py-2 text-center">{r.derisk > 0 ? <span className="flex items-center justify-center gap-1 text-amber-300"><ShieldAlert size={11} /> {r.derisk}</span> : <span className="text-[var(--color-text-muted)]">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] text-[var(--color-text-muted)]"><b className="text-[var(--color-caution)]">유명 ≠ 안전</b> — AUM(명성)이 커도 <b>자기북 집중(HHI)</b>이 높으면 한 마켓에 몰빵돼 위험. ⚠ = 디페깅 담보. 비중 ≥20% 적색 = AUM 상당부분이 위험담보. 디리스킹 ↑ = 위험 감지하고 빠지는 중(선행 신호). 데이터: Morpho blue-api(검증) + DeFiLlama Euler/Silo/Fluid(추정) + 알림.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Bar({ val, max, color, label, pctMode }: { val: number | null; max: number; color: string; label: string; pctMode?: boolean }) {
  if (val == null) return <span className="font-mono text-[10px] text-[var(--color-text-muted)]">—</span>;
  const w = pctMode ? Math.min(100, val * 100) : Math.max(4, (val / max) * 100);
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-surface-raised)]"><span className="block h-full rounded-full" style={{ width: `${w}%`, backgroundColor: color }} /></span>
      <span className="font-mono text-[10px]" style={{ color: pctMode ? color : "var(--color-text-secondary)" }}>{label}</span>
    </div>
  );
}
