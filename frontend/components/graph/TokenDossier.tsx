"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ShieldCheck } from "lucide-react";

import type { GraphEdge, GraphNode, NodeTickState } from "@/lib/api";
import { formatUsd } from "@/lib/api";

interface Relation {
  edge: GraphEdge;
  otherId: string;
  otherLabel: string;
  direction: "out" | "in";
}

export interface DossierData {
  dbConnected: boolean;
  alerts?: Array<{ created_at: string; severity: string; kind: string; message: string; source: string }>;
  alertCounts?: Record<string, number>;
  totalSupply?: number | null;
  supply24hChangePct?: number | null;
  supplyHistory?: Array<{ ts: string; supply: number }>;
  loops?: Array<{
    kind: string; collateral_symbol: string | null; loan_symbol: string | null;
    looped_usd: string | null; lltv: string | null; confidence: string | null; source: string;
    detail?: Record<string, unknown> | null;
  }>;
  curators?: Array<{
    curator: string; vault_name: string; chain: string;
    supply_usd: string | null; in_withdraw_queue: boolean; utilization: string | null;
  }>;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function TokenDossier({
  node,
  relations,
  state,
  data,
  dataLoading,
}: {
  node: GraphNode;
  relations: Relation[];
  state: NodeTickState;
  /** 부모(페이지)가 이미 /api/dossier 를 받아왔으면 그걸 공유 — 중복 fetch 방지. */
  data?: DossierData | null;
  dataLoading?: boolean;
}) {
  const shared = data !== undefined; // 부모가 데이터를 내려주면 자체 fetch 안 함
  const [fetchedD, setFetchedD] = useState<DossierData | null>(null);
  const [fetchedLoading, setFetchedLoading] = useState(true);
  const d = shared ? (data ?? null) : fetchedD;
  const loading = shared ? !!dataLoading : fetchedLoading;

  useEffect(() => {
    if (shared) return; // 공유 모드면 fetch 생략
    let live = true;
    setFetchedLoading(true);
    fetch(`/api/dossier/${encodeURIComponent(node.label)}`)
      .then((r) => r.json())
      .then((j) => { if (live) { setFetchedD(j); setFetchedLoading(false); } })
      .catch(() => { if (live) setFetchedLoading(false); });
    return () => { live = false; };
  }, [node.label, shared]);

  // ── 엣지-파생 지표 (topology 에서 즉시 계산) ───────────────
  const derived = useMemo(() => {
    const exp = relations
      .map((r) => ({ label: r.otherLabel, usd: r.edge.attrs?.core?.amountUsd ?? r.edge.weight ?? 0, a: r.edge.attrs }))
      .filter((e) => e.usd > 0)
      .sort((a, b) => b.usd - a.usd);
    const total = exp.reduce((s, e) => s + e.usd, 0);
    // 집중도 — HHI. 분포 상세는 메인 Exposure Flow가 담당한다.
    const shares = exp.map((e) => e.usd / (total || 1));
    const hhi = shares.reduce((s, x) => s + x * x, 0);

    // 빠질 수 있는(DEX/available) vs 잠긴(담보) 유동성
    let withdrawable = 0, locked = 0;
    for (const r of relations) {
      const a = r.edge.attrs;
      if (!a) continue;
      const et = a.edgeType ?? "";
      if (a.dex?.liquidityUsd) withdrawable += a.dex.liquidityUsd;
      else if (a.dex?.depthAt5pctUsd) withdrawable += a.dex.depthAt5pctUsd;
      if (/collateral|cdp/.test(et)) locked += a.core?.amountUsd ?? 0;
      else if (a.lendingRisk?.liquidityUsd) withdrawable += a.lendingRisk.liquidityUsd;
    }

    // 오라클 분류
    const oracles: Record<string, number> = {};
    for (const r of relations) {
      const o = r.edge.attrs?.oracle;
      if (o?.provider || o?.type) {
        const key = o.provider ? `${o.type ?? ""} · ${o.provider}` : (o.type ?? "?");
        oracles[key] = (oracles[key] ?? 0) + 1;
      }
    }

    // 부실채권 at-risk — 마켓별 (collateralUsd/borrowUsd 있으면 정밀 aggLTV, 없으면 worst-case)
    //   + 각 마켓 오라클이 하드코딩/고정이면 디페그가 온체인에 안 잡혀 청산 미발동 → 별도 표기.
    const badDebt: Array<{ market: string; lltv: number; aggLtv: number | null; drop: number; debtUsd: number; mode: string; oracle: string; hardcoded: boolean }> = [];
    for (const r of relations) {
      const o = r.edge.attrs?.oracle;
      const oracleKey = o ? (o.provider ? `${o.type ?? ""} · ${o.provider}` : (o.type ?? "")) : "";
      const hardcoded = /hard|fixed|nav|rwa/i.test(oracleKey);
      for (const m of r.edge.attrs?.topMarkets ?? []) {
        if ((m.marketSizeUsd ?? 0) < 100_000) continue;
        const lltv = m.lltv;
        if (!lltv) continue;
        const borrow = m.borrowUsd ?? (m.utilization != null ? m.marketSizeUsd * m.utilization : null);
        const collat = m.collateralUsd ?? null;
        const base = { market: `${m.collateralAsset ?? node.label}/${m.loanAsset}`, oracle: oracleKey || "—", hardcoded };
        if (collat && collat > 0 && borrow && borrow > 0) {
          const aggLtv = borrow / collat;
          badDebt.push({ ...base, lltv, aggLtv, drop: Math.max(0, 1 - aggLtv), debtUsd: borrow, mode: "정밀" });
        } else {
          badDebt.push({ ...base, lltv, aggLtv: null, drop: Math.max(0, 1 - lltv), debtUsd: borrow ?? m.marketSizeUsd, mode: "worst" });
        }
      }
    }
    badDebt.sort((a, b) => a.drop - b.drop);

    // at-risk(p) 곡선 — 담보가 −p% 빠질 때 underwater 되는 마켓들의 누적 debt$ (정적 계산, 백테스트 무관).
    const DROP_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
    const atRiskCurve = DROP_STEPS.map((p) => ({ p, usd: badDebt.filter((b) => b.drop <= p).reduce((s, b) => s + b.debtUsd, 0) }));
    const atRiskMax = Math.max(1, ...atRiskCurve.map((c) => c.usd));

    return { exp, total, hhi, withdrawable, locked, oracles, badDebt, atRiskCurve, atRiskMax };
  }, [relations, node.label]);

  const counts = d?.alertCounts ?? {};
  const peg = state.pegRatio ?? null;
  const depegBps = peg != null ? Math.round((peg - 1) * 10000) : null;
  const concentLabel = derived.hhi >= 0.5 ? "쏠림" : derived.hhi >= 0.25 ? "보통" : "분산";
  const concentColor = derived.hhi >= 0.5 ? "var(--color-danger)" : derived.hhi >= 0.25 ? "#fbbf24" : "var(--color-healthy)";
  const alertTotal = (counts.critical ?? 0) + (counts.warning ?? 0) + (counts.info ?? 0);
  const hardOracleCount = Object.keys(derived.oracles).filter((k) => /hard|fixed|nav|rwa/i.test(k)).length;
  const panelLevel = (counts.critical ?? 0) > 0 || hardOracleCount > 0
    ? "위험 신호 확인 필요"
    : (counts.warning ?? 0) > 0 || derived.hhi >= 0.4
      ? "주의 관찰"
      : "즉시 위험 신호 없음";
  const panelColor = panelLevel.startsWith("위험")
    ? "var(--color-danger)"
    : panelLevel.startsWith("주의")
      ? "#fbbf24"
      : "var(--color-healthy)";

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/55 p-3">
        <div className="mb-1 flex items-center justify-between gap-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Risk Dossier</div>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: panelColor, backgroundColor: `${panelColor}18` }}>
            {panelLevel}
          </span>
        </div>
        <div className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
          경고·오라클·청산 취약성 중심의 판단 근거
        </div>
      </div>

      {/* ═══ TIER 1 — 핵심 위험 신호 ═══ */}
      <section className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/40 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          <Activity size={12} /> Tier 1 · 핵심 신호
        </div>
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <Stat label="총 공급" value={d?.totalSupply != null ? compact(d.totalSupply) : (state.tvl != null ? formatUsd(state.tvl) : "—")} />
          <Stat
            label="24h 공급변화"
            value={d?.supply24hChangePct != null ? `${d.supply24hChangePct >= 0 ? "+" : ""}${(d.supply24hChangePct * 100).toFixed(2)}%` : "—"}
            color={d?.supply24hChangePct != null && Math.abs(d.supply24hChangePct) > 0.05 ? "var(--color-caution)" : undefined}
          />
          <Stat
            label="디페그"
            value={depegBps != null ? `${depegBps >= 0 ? "+" : ""}${depegBps} bps` : "—"}
            color={depegBps != null && depegBps <= -50 ? "var(--color-danger)" : depegBps != null && depegBps <= -20 ? "#fbbf24" : "var(--color-healthy)"}
          />
          <Stat label="집중도(HHI)" value={`${derived.hhi.toFixed(2)} · ${concentLabel}`} color={concentColor} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Signal label="알림" value={`${alertTotal}건`} tone={(counts.critical ?? 0) > 0 ? "danger" : (counts.warning ?? 0) > 0 ? "warn" : "ok"} />
          <Signal label="오라클" value={hardOracleCount > 0 ? `고정 ${hardOracleCount}` : Object.keys(derived.oracles).length ? "시장 기반" : "미확인"} tone={hardOracleCount > 0 ? "danger" : "ok"} />
          <Signal label="정밀 엣지" value={`${relations.length}개`} tone={relations.length ? "ok" : "warn"} />
          <Signal label="DB" value={d?.dbConnected === false ? "연결 실패" : "연결"} tone={d?.dbConnected === false ? "warn" : "ok"} />
        </div>
        {/* 알림 카운트 + 히스토리 */}
        <div className="mt-2.5 flex items-center gap-2">
          <SevPill n={counts.critical ?? 0} color="var(--color-danger)" label="critical" />
          <SevPill n={counts.warning ?? 0} color="#fbbf24" label="warning" />
          <SevPill n={counts.info ?? 0} color="#60a5fa" label="info" />
          <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">위험 히스토리 ↓</span>
        </div>
        <AlertHistory loading={loading} alerts={d?.alerts ?? []} />
      </section>

      {/* ═══ TIER 2 — 리스크 경로 ═══ */}
      <section className="rounded-lg border border-[var(--color-border-subtle)] p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          <ShieldCheck size={12} /> Tier 2 · 리스크 경로
        </div>

        {/* 빠질 수 있는 vs 잠긴 유동성 */}
        <MiniLabel>유동성 상태</MiniLabel>
        <div className="mb-2.5 grid grid-cols-2 gap-2 text-[12px]">
          <Stat label="빠질 수 있음 (DEX·가용)" value={formatUsd(derived.withdrawable)} color="var(--color-healthy)" />
          <Stat label="잠김 (담보)" value={formatUsd(derived.locked)} color="#fbbf24" />
        </div>

        {/* 오라클 분류 */}
        {Object.keys(derived.oracles).length > 0 ? (
          <>
            <MiniLabel>오라클</MiniLabel>
            <div className="mb-2.5 flex flex-wrap gap-1">
              {Object.entries(derived.oracles).map(([k, n]) => {
                const hard = /hard|fixed|nav|rwa/i.test(k);
                return (
                  <span key={k} className={"rounded px-1.5 py-0.5 text-[10px] " + (hard ? "bg-[var(--color-caution)]/15 text-[var(--color-caution)]" : "bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)]")}>
                    {k}{n > 1 ? ` ×${n}` : ""}
                  </span>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <MiniLabel>오라클</MiniLabel>
            <div className="mb-2.5 rounded-md border border-dashed border-[var(--color-border-subtle)] px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
              오라클 메타데이터 없음
            </div>
          </>
        )}

        {/* 부실채권 at-risk(p) 곡선 + 마켓별 표 (E) — 정적 계산 */}
        {derived.badDebt.length > 0 && (
          <>
            <MiniLabel>부실채권 at-risk — 담보 −X% 빠질 때 누적 위험$</MiniLabel>
            {/* 곡선: 가격 하락폭(x) → underwater 되는 마켓 debt 누적합(y) */}
            <div className="mb-1 flex items-end gap-1" style={{ height: 56 }}>
              {derived.atRiskCurve.map((c, i) => {
                const h = Math.max(2, Math.round((c.usd / derived.atRiskMax) * 52));
                const col = c.p <= 0.1 ? "var(--color-danger)" : c.p <= 0.2 ? "#fbbf24" : "#60a5fa";
                return (
                  <div key={i} className="flex flex-1 flex-col items-center justify-end" title={`담보 −${(c.p * 100).toFixed(0)}% → ${formatUsd(c.usd)} underwater`}>
                    <div className="w-full rounded-t" style={{ height: h, backgroundColor: col, opacity: c.usd > 0 ? 0.9 : 0.18 }} />
                    <span className="mt-0.5 text-[8px] text-[var(--color-text-muted)]">−{(c.p * 100).toFixed(0)}</span>
                  </div>
                );
              })}
            </div>
            <div className="mb-1.5 flex justify-between text-[9px] text-[var(--color-text-muted)]">
              <span>← 담보 가격 하락폭</span><span>최대 {formatUsd(derived.atRiskMax)} at-risk</span>
            </div>
            {/* 마켓별 표 — 위험$ · 바닥−% · 오라클 · 청산가능 */}
            <div className="overflow-hidden rounded border border-[var(--color-border-subtle)]">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-[var(--color-surface-raised)] text-[9px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    <th className="px-1.5 py-1 text-left">마켓</th>
                    <th className="px-1.5 py-1 text-right">바닥−%</th>
                    <th className="px-1.5 py-1 text-left">오라클</th>
                    <th className="px-1.5 py-1 text-center">청산</th>
                    <th className="px-1.5 py-1 text-right">위험$</th>
                  </tr>
                </thead>
                <tbody>
                  {derived.badDebt.slice(0, 6).map((b, i) => (
                    <tr key={i} className="border-t border-[var(--color-border-subtle)]">
                      <td className="px-1.5 py-1 text-[var(--color-text-primary)]" title={`LLTV ${pct(b.lltv)}${b.aggLtv != null ? ` · aggLTV ${pct(b.aggLtv)}` : ""} · ${b.mode}`}>{b.market}</td>
                      <td className="px-1.5 py-1 text-right font-mono" style={{ color: b.drop <= 0.07 ? "var(--color-danger)" : b.drop <= 0.15 ? "#fbbf24" : "var(--color-text-secondary)" }}>
                        −{(b.drop * 100).toFixed(1)}%
                      </td>
                      <td className="max-w-[78px] truncate px-1.5 py-1 text-[10px]" style={{ color: b.hardcoded ? "var(--color-caution)" : "var(--color-text-muted)" }} title={b.oracle}>{b.hardcoded ? "하드코딩" : (b.oracle.split("·")[0]?.trim() || "시장")}</td>
                      <td className="px-1.5 py-1 text-center">
                        {b.hardcoded
                          ? <span className="text-[var(--color-danger)]" title="하드코딩/고정 오라클 — 디페그가 온체인에 안 잡혀 청산 미발동 → bad debt 누적">✗</span>
                          : <span className="text-[var(--color-healthy)]" title="시장 오라클 — 디페그 시 청산 발동">✓</span>}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono text-[var(--color-text-secondary)]">{formatUsd(b.debtUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[9px] leading-snug text-[var(--color-text-muted)]">
              바닥−% = 그 마켓이 underwater 되는 담보 하락폭(=1−aggLTV, 없으면 worst-case LLTV). 청산✗ = 하드코딩 오라클이라 디페그가 안 잡혀 청산 미발동. 정밀값은 스냅샷 후 채워짐.
            </p>
          </>
        )}
      </section>

      {/* ═══ TIER 3 — 심층 ═══ */}
      {(derived.badDebt.length > 0 || (d?.loops?.length ?? 0) > 0 || (d?.curators?.length ?? 0) > 0) && (
        <section className="rounded-lg border border-[var(--color-border-subtle)] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Tier 3 · 근거 데이터</div>

          {/* 루핑 / ouroboros (loop_findings 슬롯) */}
          {(d?.loops?.length ?? 0) > 0 && (
            <>
              <MiniLabel>셀프루핑 · ouroboros <span className="text-[var(--color-text-muted)]">(structural-v1)</span></MiniLabel>
              <div className="mb-2.5 space-y-1">
                {d!.loops!.slice(0, 5).map((l, i) => (
                  <div key={i} className="flex items-center justify-between rounded bg-[var(--color-danger)]/8 px-2 py-1 text-[11px]">
                    <span className="text-[var(--color-text-primary)]">{l.collateral_symbol}/{l.loan_symbol}</span>
                    <span className="font-mono text-[var(--color-text-secondary)]">
                      {l.lltv ? `LLTV ${(Number(l.lltv) * 100).toFixed(1)}%` : ""} · {l.looped_usd ? formatUsd(Number(l.looped_usd)) : ""}
                    </span>
                  </div>
                ))}
                <p className="text-[9px] text-[var(--color-text-muted)]">구조적 가능성(실 루핑 미검증) — 외부 자금추적 알고리즘 swap 시 실값으로 교체.</p>
              </div>
            </>
          )}

          {/* 큐레이터 (D5) */}
          {(d?.curators?.length ?? 0) > 0 && (
            <>
              <MiniLabel>이 담보를 다루는 큐레이터 · 볼트</MiniLabel>
              <div className="mb-2.5 space-y-1">
                {d!.curators!.slice(0, 6).map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className="font-medium text-[var(--color-text-primary)]">{c.curator}</span>
                    <span className="truncate text-[10px] text-[var(--color-text-muted)]">{c.vault_name}</span>
                    {c.in_withdraw_queue && <span className="rounded bg-[var(--color-caution)]/15 px-1 text-[9px] text-[var(--color-caution)]">wq</span>}
                    <span className="ml-auto font-mono text-[var(--color-text-secondary)]">{c.supply_usd ? formatUsd(Number(c.supply_usd)) : ""}</span>
                  </div>
                ))}
              </div>
            </>
          )}

        </section>
      )}
    </div>
  );
}

// ── 소형 헬퍼 컴포넌트 ──────────────────────────────────
function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
      <div className="font-mono text-[13px] font-medium" style={{ color: color ?? "var(--color-text-primary)" }}>{value}</div>
    </div>
  );
}

function MiniLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">{children}</div>;
}

function Signal({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "danger" }) {
  const color = tone === "danger" ? "var(--color-danger)" : tone === "warn" ? "#fbbf24" : "var(--color-healthy)";
  return (
    <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color }}>
        <span className="size-1.5 rounded-full bg-current" />
        {value}
      </div>
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

function AlertHistory({ loading, alerts }: { loading: boolean; alerts: DossierData["alerts"] }) {
  const [open, setOpen] = useState(false);
  const sevColor = (s: string) => (s === "critical" ? "var(--color-danger)" : s === "warning" ? "#fbbf24" : "#60a5fa");
  if (loading) return <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">위험 히스토리 로딩…</div>;
  if (!alerts || alerts.length === 0) return <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">기록된 알림 없음</div>;
  const shown = open ? alerts.slice(0, 30) : alerts.slice(0, 4);
  return (
    <div className="mt-2 space-y-1">
      {shown.map((a, i) => (
        <div key={i} className="flex items-start gap-1.5 text-[10px] leading-snug">
          <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: sevColor(a.severity) }} />
          <span className="shrink-0 text-[var(--color-text-muted)]">{new Date(a.created_at).toISOString().slice(5, 16).replace("T", " ")}</span>
          <span className="text-[var(--color-text-secondary)]">{a.message}</span>
        </div>
      ))}
      {alerts.length > 4 && (
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[10px] text-[var(--color-accent)] hover:underline">
          <AlertTriangle size={10} /> {open ? "접기" : `전체 ${alerts.length}건 보기`}
        </button>
      )}
    </div>
  );
}
