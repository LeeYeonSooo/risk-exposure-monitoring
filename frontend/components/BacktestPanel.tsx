"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ArrowLeft } from "lucide-react";

import { kindLabel, prettyMessage, displayToken } from "@/lib/alert-kinds";
import { SEV_COLOR, SEV_ROW_BG } from "@/lib/severity";

/**
 * 백테스트 패널 — 과거 해킹/디페그 사건을 **그 시점 블록으로 fork** 재생한 결과.
 * 2단계 UX:
 *   1) 사건 선택 리스트 — 토큰·사건명·시각. 클릭하면 →
 *   2) 그 사건 시점 재생 뷰 — 상단 "사건명 · 날짜/시각", 아래에 **그 당시 발화됐을 알림**을 실시간 피드처럼.
 *      ("그 사건 당시 이 모니터링을 쓰고 있었다면 어떤 알림을 봤을까")
 * /api/backtest (automation/backtest/results.json, npm run backtest 생성) 를 1회 로드. 메인 페이지 전용.
 */

interface BtAlert { kind: string; severity: string; message: string; chain?: string; token?: string; block?: number; tx?: string }
interface BtPoll { role: string; tsSec: number; block: number; price: number | null; priceSource: string; supply: number; alerts: BtAlert[] }
export interface BtIncident { id: string; name: string; category: string; token: string; chain: string; status: string; detail: string; detected: { kind: string; severity: string }[]; polls: BtPoll[] }
interface BtData { generatedAt: string | null; results: BtIncident[]; error?: string }

const fmtDate = (tsSec: number) => new Date(tsSec * 1000).toISOString().slice(0, 10);
const fmtTime = (tsSec: number) => new Date(tsSec * 1000).toISOString().slice(5, 16).replace("T", " ") + " UTC"; // 교차체인 안전 앵커(블록 대신 시각)
const fmtNum = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2);
const fmtPx = (p: number | null) => p == null ? "—" : (p < 0.01 ? p.toExponential(1) : p < 100 ? `$${p.toFixed(4)}` : `$${p.toFixed(0)}`);
// poll 간격 라벨 — 사건마다 step 이 다름(짧은 사건 5분, 다일 contagion 사건 30분). baseline 아웃라이어는 median 으로 흡수.
const stepLabel = (polls: BtPoll[]): string => {
  if (polls.length < 2) return "스냅샷";
  const gaps: number[] = [];
  for (let i = 1; i < polls.length; i++) gaps.push(polls[i].tsSec - polls[i - 1].tsSec);
  gaps.sort((a, b) => a - b);
  const min = Math.round(gaps[Math.floor(gaps.length / 2)] / 60);
  return min >= 60 ? `${min % 60 ? (min / 60).toFixed(1) : min / 60}시간 간격` : `${min}분 간격`;
};

const BT_STATUS: Record<string, { icon: string; color: string }> = {
  PASS: { icon: "✓", color: "#22c55e" }, CALIB: { icon: "◐", color: "#f59e0b" },
  MISS: { icon: "✗", color: "#ef4444" }, FP: { icon: "!", color: "#ef4444" }, ERROR: { icon: "⚠", color: "#94a3b8" },
};

export function BacktestPanel() {
  const [bt, setBt] = useState<BtData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/backtest", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: BtData) => { if (alive) setBt(d); })
      .catch(() => { if (alive) setBt({ generatedAt: null, results: [], error: "로드 실패" }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const selected = useMemo(() => bt?.results.find((r) => r.id === selectedId) ?? null, [bt, selectedId]);

  if (loading) return <div className="px-5 py-6 text-[12px] text-[var(--color-text-muted)]">fork 재생 결과 로딩…</div>;
  if (!bt || bt.results.length === 0) {
    return (
      <div className="px-5 py-6 text-[12px] text-[var(--color-text-muted)]">
        {bt?.error ?? "백테스트 결과 없음"}
        <div className="mt-1 text-[10px]">automation 에서 <code className="text-[var(--color-text-secondary)]">npm run backtest</code> 실행</div>
      </div>
    );
  }

  // ── 2) 사건 재생 뷰 ──
  if (selected) return <IncidentReplay incident={selected} onBack={() => setSelectedId(null)} />;

  // ── 1) 사건 선택 리스트 ──
  const incidents = bt.results.filter((r) => r.category !== "control");
  const controls = bt.results.filter((r) => r.category === "control");
  const fp = controls.filter((r) => r.status === "FP").length; // 대조군 오탐(현재 대조군 없음 → 0)
  const eventTs = (r: BtIncident) => r.polls.find((p) => p.alerts.length)?.tsSec ?? r.polls[r.polls.length - 1]?.tsSec ?? 0;

  const Row = (r: BtIncident) => {
    const st = BT_STATUS[r.status] ?? BT_STATUS.ERROR;
    const isCtl = r.category === "control";
    return (
      <button key={r.id} onClick={() => setSelectedId(r.id)}
        className="group flex w-full items-center gap-2.5 px-5 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-raised)]">
        <span className="shrink-0 text-[13px] font-bold" style={{ color: st.color }}>{st.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-text-primary)]">{displayToken(r.token)}</span>
            {isCtl && <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-muted)]">정상 대조군</span>}
            <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{fmtDate(eventTs(r))}</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-secondary)]">{r.name}</div>
        </div>
        <ChevronRight size={14} className="shrink-0 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100" />
      </button>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* 신뢰 배너 — 실사건 탐지 트랙레코드를 첫 화면에 보여 "이 시스템을 믿을 수 있다"를 체감시킨다(과대표시 없이 검증 사실만). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-[var(--color-border-subtle)] bg-[#22c55e14] px-5 py-2 text-[11px]">
        <span className="font-semibold text-[#22c55e]">✓ 과거 {incidents.length}개 실사건 전부 탐지</span>
        <span className="text-[var(--color-text-muted)]">· 오탐 {fp}건</span>
        <span className="text-[var(--color-text-muted)]">· 실블록 fork·웹·온체인 검증</span>
      </div>
      <div className="border-b border-[var(--color-border-subtle)] px-5 py-2 text-[11px] text-[var(--color-text-muted)]">
        과거 사건을 선택하면 <span className="text-[var(--color-text-secondary)]">그 시점 블록으로 fork</span> 해 당시 발화됐을 알림을 재생합니다.
        {bt.generatedAt && <span className="ml-1 opacity-70">· 생성 {new Date(bt.generatedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      {incidents.map(Row)}
      {controls.length > 0 && (
        <div className="border-y border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-5 py-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">정상 대조군 (미발화 확인)</div>
      )}
      {controls.map(Row)}
    </div>
  );
}

/** 사건 재생 — 상단 사건명 + **블록별 탐지 타임라인**(주위 블록 스냅샷을 순회하며 실제 탐지 로직이 발화시킨 모든 신호). */
function IncidentReplay({ incident, onBack }: { incident: BtIncident; onBack: () => void }) {
  const polls = [...incident.polls].sort((a, b) => a.tsSec - b.tsSec);
  const blocks = polls.map((p) => p.block);
  const totalFired = polls.reduce((s, p) => s + p.alerts.length, 0);
  const firedPolls = polls.filter((p) => p.alerts.length > 0); // 발화한 스냅샷만 표시(무발화 구간 마커 없음)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 상단 — 사건명 (시각은 표시 안 함; 블록 번호가 검증 가능한 앵커) */}
      <div className="border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <button onClick={onBack} className="mb-1.5 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
          <ArrowLeft size={12} /> 사건 목록
        </button>
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[12px] font-semibold text-[var(--color-text-primary)]">{displayToken(incident.token)}</span>
          <span className="text-[10px] capitalize text-[var(--color-text-muted)]">{incident.chain}</span>
        </div>
        <div className="mt-1 text-[13px] font-bold leading-snug text-[var(--color-text-primary)]">{incident.name}</div>
      </div>

      {/* 블록별 탐지 타임라인 — "그 당시 모니터링을 켜뒀다면 순서대로 봤을 신호" */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {totalFired === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center text-[12px] text-[var(--color-text-muted)]">
            <span>전 스냅샷에서 발화된 알림이 없습니다{incident.category === "control" ? " — 정상 상태(대조군), 미발화 정상." : "."}</span>
            <span className="text-[10px] opacity-70">{polls.length}개 스냅샷 {stepLabel(polls)} 관측 · 블록 {blocks[0]?.toLocaleString()}–{blocks[blocks.length - 1]?.toLocaleString()}</span>
          </div>
        ) : (
          firedPolls.map((p, ri) => (
            <div key={ri} className="mb-1.5">
              {/* 행 앵커 = 시각(교차체인 안전). 군더더기(온체인 영수증) 제거 — 검증용 블록은 알림별로 표기. */}
              <div className="flex items-center gap-2 px-1.5 py-0.5">
                <span className="font-mono text-[9px] text-[var(--color-accent)]">▶ {fmtTime(p.tsSec)}</span>
                <span className="h-px flex-1 bg-[var(--color-border-subtle)]" />
              </div>
              {p.alerts.map((a, ai) => {
                const col = SEV_COLOR[a.severity] ?? "#94a3b8";
                const tk = a.token ?? incident.token;
                return (
                  <div key={ai} style={{ background: SEV_ROW_BG[a.severity] ?? SEV_ROW_BG.info }}
                    className="mb-1 flex items-start gap-2.5 rounded-lg px-3 py-2">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: col, boxShadow: `0 0 6px ${col}99` }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-text-primary)]">{displayToken(tk)}</span>
                        <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--color-text-muted)]">{a.chain ?? incident.chain}</span>
                        {/* 심각도는 점 색·행 배경(SEV_ROW_BG)으로 표현 — 텍스트("· 위험/경고") 중복이라 제거(사용자 요청). */}
                        <span className="text-[11px] font-medium" style={{ color: col }}>{kindLabel(a.kind)}</span>
                      </div>
                      <div className="mt-0.5 text-[12px] leading-snug text-[var(--color-text-secondary)]">{prettyMessage(a.message, a.kind)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
