"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bell, ChevronRight, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 알림 패널 — 우측 세로 도킹, 화면 높이의 ~50%.
 * SidePanel(노드/엣지 상세)이 열리면 그 폭만큼 왼쪽으로 밀림(displace).
 * automation diff 엔진이 적재한 /api/alerts 를 폴링.
 */

export interface AlertItem {
  id: string;
  created_at: string;
  snapshot_ts: string | null;
  severity: "critical" | "warning" | "info" | string;
  kind: string;
  token: string;
  protocol_node_id: string | null;
  message: string;
  detail: Record<string, unknown> | null;
  acknowledged: boolean;
}

const SEV_STYLE: Record<string, { dot: string; chip: string; label: string }> = {
  critical: { dot: "bg-[var(--color-danger)]", chip: "bg-[color:var(--color-danger)]/15 text-[var(--color-danger)]", label: "🔴" },
  warning: { dot: "bg-amber-400", chip: "bg-amber-400/15 text-amber-300", label: "🟡" },
  info: { dot: "bg-sky-400", chip: "bg-sky-400/15 text-sky-300", label: "🔵" },
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

type SevFilter = "all" | "critical" | "warning";
type CatFilter = "all" | "minting" | "depeg" | "contract" | "liquidity";

// 알림 kind → 카테고리 (민팅·공급 / 디페깅 / 컨트랙트레벨 / 렌딩유동성)
const CATEGORY: Record<string, Exclude<CatFilter, "all">> = {
  depeg: "depeg",
  bad_debt_threshold: "depeg", // 디페그→부실채권 임계 (디페그 탭)
  // 민팅/공급 무결성 (무한민팅·무담보·mint/burn 불일치) — 설계 #1 시그널
  supply_spike: "minting",
  unbacked_supply: "minting",    // Detector A — Σremote > backing (무담보 공급)
  unmatched_mint: "minting",     // Detector B — 소스 burn 없는 mint (무담보민팅)
  chain_supply_spike: "minting", // 체인 단위 공급 급증
  supply_single_mint: "minting",
  supply_jump: "minting",
  total_supply_jump: "minting",
  // 컨트랙트 레벨 변화 (pause/new listing/oracle/IRM 등)
  new_market: "contract",
  collateral_adoption: "contract",
  oracle_changed: "contract",
  oracle_depeg_flag_flip: "contract",
  oracle_paused_suspect: "contract",
  oracle_hardcoded_switch: "contract", // 정상→하드코딩 오라클 전환(critical) — P1-4
  reserve_frozen: "contract",
  irm_changed: "contract",
  irm_base_rate_jump: "contract",
  high_lltv_market: "contract",
  unverified_large_exposure: "contract",
  // 렌딩 볼트 유동성 변화/부족
  utilization_jump: "liquidity",
  high_utilization: "liquidity",
  liquidity_drop_lending: "liquidity",
  liquidity_drop_dex: "liquidity",
  whale_unwind: "liquidity",
  curator_derisk: "liquidity",
  value_drift: "liquidity", // 총가치(NAV×supply) 급락 = 밸류 유출/대량 인출 — P2-6
};
const catOf = (kind: string): Exclude<CatFilter, "all"> => CATEGORY[kind] ?? "contract";
const CAT_LABEL: Record<CatFilter, string> = {
  all: "전체",
  minting: "민팅/공급",
  depeg: "디페깅",
  contract: "컨트랙트",
  liquidity: "유동성",
};

export function AlertPanel({
  rightOffset,
  onSelectProtocol,
}: {
  /** SidePanel 이 열렸을 때 그 폭만큼 오른쪽에서 밀어내는 px */
  rightOffset: number;
  onSelectProtocol?: (nodeId: string) => void;
}) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [dbConnected, setDbConnected] = useState<boolean>(true);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<SevFilter>("all");
  const [catFilter, setCatFilter] = useState<CatFilter>("all");
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sev = filter === "all" ? "" : `&severity=${filter === "warning" ? "critical,warning" : "critical"}`;
      const res = await fetch(`/api/alerts?limit=200${sev}`, { cache: "no-store" });
      const data = (await res.json()) as { alerts: AlertItem[]; counts: Record<string, number>; dbConnected: boolean };
      setAlerts(data.alerts ?? []);
      setCounts(data.counts ?? {});
      setDbConnected(data.dbConnected ?? false);
    } catch {
      setDbConnected(false);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 30_000); // 30s 폴링
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  const critN = counts.critical ?? 0;
  const warnN = counts.warning ?? 0;
  const shown = alerts.filter((a) => catFilter === "all" || catOf(a.kind) === catFilter);

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        style={{ right: rightOffset + 16 }}
        className="fixed top-20 z-30 flex items-center gap-2 rounded-l-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm shadow-lg transition-[right] duration-300"
      >
        <Bell size={15} className="text-[var(--color-accent)]" />
        <span className="font-medium">알림</span>
        {critN > 0 && <span className="rounded bg-[color:var(--color-danger)]/20 px-1.5 text-[11px] text-[var(--color-danger)]">{critN}</span>}
        {warnN > 0 && <span className="rounded bg-amber-400/20 px-1.5 text-[11px] text-amber-300">{warnN}</span>}
      </button>
    );
  }

  return (
    <aside
      style={{ right: rightOffset, height: "50vh", width: 380 }}
      className="fixed top-16 z-30 flex flex-col overflow-hidden rounded-l-xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 shadow-2xl backdrop-blur transition-[right] duration-300"
    >
      {/* 헤더 */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <AlertTriangle size={15} className="text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold">실시간 알림</span>
          {critN > 0 && <span className="rounded bg-[color:var(--color-danger)]/15 px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-danger)]">{critN} critical</span>}
          {warnN > 0 && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">{warnN} warning</span>}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={load} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]" title="새로고침">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={() => setCollapsed(true)} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]" title="접기">
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      {/* 카테고리 탭 (피드백: 디페깅 / 컨트랙트레벨 / 렌딩유동성) */}
      <div className="flex gap-1 border-b border-[var(--color-border)] px-3 py-1.5 text-[11px]">
        {(["all", "minting", "depeg", "contract", "liquidity"] as CatFilter[]).map((c) => (
          <button
            key={c}
            onClick={() => setCatFilter(c)}
            className={cn(
              "rounded px-2 py-0.5 font-medium transition-colors",
              catFilter === c
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]",
            )}
          >
            {CAT_LABEL[c]}
          </button>
        ))}
      </div>

      {/* 심각도 필터 */}
      <div className="flex gap-1 border-b border-[var(--color-border)] px-3 py-1.5 text-[11px]">
        {(["all", "warning", "critical"] as SevFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              filter === f ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]",
            )}
          >
            {f === "all" ? "전체" : f === "warning" ? "경고+" : "심각만"}
          </button>
        ))}
      </div>

      {/* 3색 의미 (큐레이터 관점) */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-1 text-[9px] text-[var(--color-text-muted)]">
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-[var(--color-danger)]" />🔴 위험 — 즉시 대응</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-amber-400" />🟡 경고 — 관망</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-sky-400" />🔵 정보 — 맥락</span>
      </div>

      {/* 리스트 */}
      <div className="flex-1 overflow-y-auto">
        {!dbConnected ? (
          <div className="p-4 text-[12px] text-[var(--color-text-muted)]">
            DB 미연결 — automation 스냅샷이 돌면 알림이 여기 표시됩니다.
          </div>
        ) : shown.length === 0 ? (
          <div className="p-4 text-[12px] text-[var(--color-text-muted)]">
            {alerts.length === 0
              ? "현재 알림 없음. 스냅샷 간 변화가 임계를 넘으면 표시됩니다."
              : "이 카테고리에 해당하는 알림이 없습니다."}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]/60">
            {shown.map((a) => {
              const sv = SEV_STYLE[a.severity] ?? SEV_STYLE.info;
              return (
                <li
                  key={a.id}
                  className="group px-3 py-2.5 transition-colors hover:bg-[var(--color-surface-raised)]"
                >
                  <div className="flex items-start gap-2">
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", sv.dot)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", sv.chip)}>
                          {a.kind}
                        </span>
                        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{timeAgo(a.created_at)} 전</span>
                      </div>
                      <p className="mt-1 text-[12px] leading-snug text-[var(--color-text-primary)]">{a.message}</p>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                        <span className="font-mono">{a.token}</span>
                        {a.protocol_node_id && (
                          <button
                            onClick={() => onSelectProtocol?.(a.protocol_node_id!)}
                            className="font-mono underline-offset-2 hover:text-[var(--color-accent)] hover:underline"
                          >
                            {a.protocol_node_id.replace("protocol:", "")}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
