"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import { formatUsd } from "@/lib/api";

/**
 * 패널 공용 스펙 — 규칙 3개를 강제한다:
 *  1) 값은 한 줄 토큰. 문장 금지 — 위험은 ⚠·빨강.
 *  2) 없으면 행 자체를 숨김 (— 남발 금지) → 행 컴포넌트가 null 값이면 안 그려짐.
 *  3) 주소·tx 는 클릭 가능한 ↗ 링크, 값 옆 ✓검증/~추정 작은 뱃지.
 */

export const ADDR_EXPLORER: Record<string, (a: string) => string> = {
  ethereum: (a) => `https://etherscan.io/address/${a}`,
  base: (a) => `https://basescan.org/address/${a}`,
  arbitrum: (a) => `https://arbiscan.io/address/${a}`,
};
export const TX_EXPLORER: Record<string, (h: string) => string> = {
  ethereum: (h) => `https://etherscan.io/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
};
export const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** 한 줄 행 — v 가 null/빈문자면 행 자체를 그리지 않는다 (규칙 2). */
export function PRow({ k, v, warn, badge, href }: {
  k: string; v: string | null | undefined;
  /** 위험 표시 — ⚠ + 빨강 (규칙 1) */
  warn?: boolean;
  /** ✓ = 온체인/공식 검증, ~ = 추정 (규칙 3) */
  badge?: "verified" | "estimated";
  /** 주소·tx ↗ 링크 (규칙 3) */
  href?: string | null;
}) {
  if (v == null || v === "") return null;
  return (
    <div className="flex items-center justify-between gap-3 py-0.5 text-[12px]">
      <span className="shrink-0 text-[var(--color-text-muted)]">{k}</span>
      <span className={"flex min-w-0 items-center gap-1 font-mono " + (warn ? "text-[var(--color-danger)]" : "text-[var(--color-text-primary)]")}>
        {warn && <span aria-label="위험">⚠</span>}
        <span className="truncate">{v}</span>
        {badge === "verified" && <span title="온체인/공식 검증" className="shrink-0 text-[10px] text-emerald-600">✓</span>}
        {badge === "estimated" && <span title="추정" className="shrink-0 text-[10px] text-[var(--color-text-muted)]">~</span>}
        {href && (
          <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]" title="탐색기에서 열기">
            <ExternalLink size={11} />
          </a>
        )}
      </span>
    </div>
  );
}

export const sevDots = (crit: number, warnN: number) =>
  crit > 0 || warnN > 0 ? `🔴 ${crit} 🟡 ${warnN}` : null;

export const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

// 메커니즘 강도: 번&민트(권한만으로 발행) 가 락&민트(원본 잠금) 보다 약하다
const BURN_TYPES = new Set(["xerc20", "ccip_pool", "ccip_remote", "oft_peer", "minter_role", "cctp", "wormhole_ntt", "axelar_its", "hyperlane", "layerzero"]);
const LOCK_TYPES = new Set(["op_bridge", "l2_canonical", "polygon_pos", "xerc20_lockbox", "wormhole", "ibc", "starkgate", "sui_bridge"]);
export function weakestMech(authTypes: string[]): string | null {
  if (!authTypes.length) return null;
  if (authTypes.some((t) => BURN_TYPES.has(t))) return "번&민트";
  if (authTypes.some((t) => LOCK_TYPES.has(t))) return "락&민트";
  return null;
}

// ── 토큰 패널 데이터 (관계맵·흐름맵 공용) — /api/dossier + /api/bridge-authority ──
interface DossierAlert { severity: string; kind: string; detail?: Record<string, unknown> | null }
export interface TokenPanelData {
  crit: number; warnN: number;
  verdict: string | null;          // "위험 · 자기참조·무담보" 같은 한 줄
  supply24hPct: number | null;
  unbacked: { usd: number | null; n: number } | null;
  bridges: { count: number; weakest: string | null } | null;
}

const _cache = new Map<string, { at: number; d: TokenPanelData }>();
export function useTokenPanelData(symbol: string | null): TokenPanelData | null {
  const [data, setData] = useState<TokenPanelData | null>(null);
  useEffect(() => {
    if (!symbol) { setData(null); return; }
    const hit = _cache.get(symbol.toUpperCase());
    if (hit && Date.now() - hit.at < 60_000) { setData(hit.d); return; }
    let alive = true;
    setData(null);
    Promise.all([
      fetch(`/api/dossier/${encodeURIComponent(symbol)}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch(`/api/bridge-authority/${encodeURIComponent(symbol)}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]).then(([dos, ba]) => {
      if (!alive) return;
      const alerts: DossierAlert[] = dos?.alerts ?? [];
      const crit = dos?.alertCounts?.critical ?? alerts.filter((a) => a.severity === "critical").length;
      const warnN = dos?.alertCounts?.warning ?? alerts.filter((a) => a.severity === "warning").length;
      const loops = (dos?.loops ?? []) as unknown[];
      const unbackedAlerts = alerts.filter((a) => a.kind === "unbacked_supply" || a.kind === "unmatched_mint");
      const depeg = alerts.some((a) => a.kind === "depeg");
      // 판결 — 토큰 페이지 판결식의 부분집합(이 패널에서 구할 수 있는 입력만; 추측 없음)
      const level = crit > 0 || unbackedAlerts.some((a) => a.severity === "critical") ? "위험" : warnN > 0 || depeg || loops.length > 0 ? "주의" : "안전";
      const tags: string[] = [];
      if (loops.length > 0) tags.push("자기참조");
      if (unbackedAlerts.length > 0) tags.push("무담보");
      if (depeg) tags.push("디페그");
      const unbackedUsd = unbackedAlerts
        .map((a) => Number((a.detail as { unbackedUsd?: unknown; deficitUsd?: unknown } | null)?.unbackedUsd ?? (a.detail as { deficitUsd?: unknown } | null)?.deficitUsd))
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => b - a)[0] ?? null;
      const byChain = (ba?.byChain ?? {}) as Record<string, { authType: string }[]>;
      const flat = Object.values(byChain).flat();
      const d: TokenPanelData = {
        crit, warnN,
        verdict: `${level}${tags.length ? ` · ${tags.slice(0, 2).join("·")}` : ""}`,
        supply24hPct: typeof dos?.supply24hChangePct === "number" ? dos.supply24hChangePct : null,
        unbacked: unbackedAlerts.length ? { usd: unbackedUsd, n: unbackedAlerts.length } : null,
        bridges: flat.length ? { count: flat.length, weakest: weakestMech(flat.map((x) => x.authType)) } : null,
      };
      _cache.set(symbol.toUpperCase(), { at: Date.now(), d });
      setData(d);
    });
    return () => { alive = false; };
  }, [symbol]);
  return data;
}

// 노드(protocol_node_id 정확 일치) 알림 집계 — /api/alerts 1회 캐시
let _nodeAlerts: { at: number; rows: { severity: string; protocol_node_id: string | null }[] } | null = null;
export function useNodeAlertCounts(nodeId: string | null): { crit: number; warnN: number } | null {
  const [v, setV] = useState<{ crit: number; warnN: number } | null>(null);
  useEffect(() => {
    if (!nodeId) { setV(null); return; }
    let alive = true;
    const compute = (rows: NonNullable<typeof _nodeAlerts>["rows"]) => {
      const mine = rows.filter((r) => (r.protocol_node_id ?? "").split("@")[0] === nodeId);
      if (alive) setV({ crit: mine.filter((r) => r.severity === "critical").length, warnN: mine.filter((r) => r.severity === "warning").length });
    };
    if (_nodeAlerts && Date.now() - _nodeAlerts.at < 60_000) { compute(_nodeAlerts.rows); return; }
    fetch("/api/alerts?limit=300", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      _nodeAlerts = { at: Date.now(), rows: d.alerts ?? [] };
      compute(_nodeAlerts.rows);
    }).catch(() => {});
    return () => { alive = false; };
  }, [nodeId]);
  return v;
}

/** 토큰 스펙 행 6개 — 없으면 행 숨김. chainPcts 는 호출측(각 맵의 실데이터)에서 계산해 전달. */
export function TokenSpecRows({ symbol, chainPcts }: { symbol: string; chainPcts?: { chain: string; pct: number }[] | null }) {
  const d = useTokenPanelData(symbol);
  if (!d) return <div className="py-1 text-[11px] text-[var(--color-text-muted)]">불러오는 중…</div>;
  const top = (chainPcts ?? []).filter((c) => c.pct > 0).slice(0, 3);
  return (
    <>
      <PRow k="판결" v={d.verdict} warn={d.verdict?.startsWith("위험")} />
      <PRow k="알림" v={sevDots(d.crit, d.warnN)} warn={d.crit > 0} />
      <PRow
        k="24h 공급"
        v={d.supply24hPct != null ? `${d.supply24hPct >= 0 ? "+" : ""}${(d.supply24hPct * 100).toFixed(1)}%` : null}
        warn={d.supply24hPct != null && Math.abs(d.supply24hPct) >= 0.03}
      />
      <PRow k="주 체인" v={top.length ? top.map((c) => `${c.chain} ${Math.round(c.pct * 100)}%`).join(" · ") : null} />
      <PRow k="백킹" v={d.unbacked ? `무담보 ${d.unbacked.usd != null ? formatUsd(d.unbacked.usd) : `의심 ${d.unbacked.n}건`}` : null} warn={!!d.unbacked} />
      <PRow k="브릿지" v={d.bridges ? `${d.bridges.count}개${d.bridges.weakest ? ` · 최약 ${d.bridges.weakest}` : ""}` : null} warn={d.bridges?.weakest === "번&민트"} />
    </>
  );
}
