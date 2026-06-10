"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import type { GraphEdge, GraphNode, NodeTickState } from "@/lib/api";
import { formatUsd } from "@/lib/api";
import { hasDepth } from "@/lib/depth-graph";
import type { MarketEntry } from "@/lib/edge-schema";
import { ADDR_EXPLORER, PRow, TokenSpecRows, TX_EXPLORER, pct1, sevDots, shortAddr } from "@/components/panel/spec";

/**
 * 관계맵 선택 패널 — 스펙 고정 (사용자 정의 행 구성 전부, 그 외 없음):
 *  값은 한 줄 토큰 · 문장 금지 · 위험 ⚠빨강 · 없으면 행 숨김 · 주소/tx ↗ · ✓검증/~추정.
 */

interface Relation { edge: GraphEdge; otherId: string; otherLabel: string; direction: "out" | "in" }

export function SidePanel({
  node, state, edges, nodesById, onClose, onSelectNode, selectedEdge, onOpenDepth,
}: {
  node: GraphNode | null;
  state: NodeTickState | null;
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
  onClose: () => void;
  onSelectNode: (id: string) => void;
  selectedEdge?: GraphEdge | null;
  onOpenDepth?: (symbol: string) => void;
}) {
  const open = !!selectedEdge || (!!node && !!state);
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key={selectedEdge ? `edge:${selectedEdge.id}` : `node:${node?.id}`}
          initial={{ x: 400, opacity: 0.4 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 400, opacity: 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          className="absolute right-0 top-0 z-40 flex h-full w-[400px] flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
        >
          {selectedEdge ? (
            <EdgeBody edge={selectedEdge} nodesById={nodesById} onClose={onClose} onSelectNode={onSelectNode} />
          ) : (
            <NodeBody node={node!} edges={edges} nodesById={nodesById} onClose={onClose} onOpenDepth={onOpenDepth} />
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Header({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between border-b border-[var(--color-border-subtle)] px-5 py-3.5">
      <div className="min-w-0">
        <div className="truncate text-[15px] font-bold text-[var(--color-text-primary)]">{title}</div>
        <div className="truncate text-[11px] text-[var(--color-text-muted)]">{subtitle}</div>
      </div>
      <button onClick={onClose} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"><X size={15} /></button>
    </div>
  );
}

// 관계맵 노드 id = DB protocol_node_id 와 동일 체계 → 정확 일치로 알림 집계
let _alertsCache: { at: number; rows: { severity: string; protocol_node_id: string | null; token: string }[] } | null = null;
function useNodeAlertCounts(nodeId: string | null): { crit: number; warnN: number } | null {
  const [v, setV] = useState<{ crit: number; warnN: number } | null>(null);
  useEffect(() => {
    if (!nodeId) { setV(null); return; }
    let alive = true;
    const compute = (rows: NonNullable<typeof _alertsCache>["rows"]) => {
      const mine = rows.filter((r) => (r.protocol_node_id ?? "").split("@")[0] === nodeId);
      if (alive) setV({ crit: mine.filter((r) => r.severity === "critical").length, warnN: mine.filter((r) => r.severity === "warning").length });
    };
    if (_alertsCache && Date.now() - _alertsCache.at < 60_000) { compute(_alertsCache.rows); return; }
    fetch("/api/alerts?limit=300", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      _alertsCache = { at: Date.now(), rows: d.alerts ?? [] };
      compute(_alertsCache.rows);
    }).catch(() => {});
    return () => { alive = false; };
  }, [nodeId]);
  return v;
}

function relationsOf(node: GraphNode, edges: GraphEdge[], nodesById: Map<string, GraphNode>): Relation[] {
  return edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => {
      const out = e.source === node.id;
      const otherId = out ? e.target : e.source;
      return { edge: e, otherId, otherLabel: nodesById.get(otherId)?.label ?? otherId, direction: out ? ("out" as const) : ("in" as const) };
    })
    .sort((a, b) => (b.edge.attrs?.core?.amountUsd ?? 0) - (a.edge.attrs?.core?.amountUsd ?? 0));
}

function NodeBody({ node, edges, nodesById, onClose, onOpenDepth }: {
  node: GraphNode; edges: GraphEdge[]; nodesById: Map<string, GraphNode>;
  onClose: () => void; onOpenDepth?: (symbol: string) => void;
}) {
  const relations = relationsOf(node, edges, nodesById);
  const md = node.metadata as Record<string, unknown>;
  const market = md._market as MarketEntry | undefined;
  const isToken = node.type === "Token";
  const isBridge = !isToken && (md.mechanism != null || /브릿지|bridge/i.test(String(md.category ?? "")) || node.id.startsWith("bridge"));
  const isMarket = !isToken && !!market;
  const isVault = !isToken && !isMarket && !isBridge && /vault|볼트|curator|큐레이터/i.test(`${node.type} ${String(md.category ?? "")}`);
  const protoCounts = useNodeAlertCounts(!isToken && !isMarket && !isVault && !isBridge ? node.id : null);
  const chain = (md.chain as string) ?? "ethereum";

  let body: React.ReactNode = null;
  if (isToken) {
    // 주 체인 = 관계 엣지의 상대 노드 체인별 노출 비중 (실데이터)
    const byChain = new Map<string, number>();
    for (const r of relations) {
      const c = (nodesById.get(r.otherId)?.metadata.chain as string) ?? "ethereum";
      byChain.set(c, (byChain.get(c) ?? 0) + (r.edge.attrs?.core?.amountUsd ?? 0));
    }
    const tot = [...byChain.values()].reduce((s, v) => s + v, 0) || 1;
    const chainPcts = [...byChain.entries()].map(([c, v]) => ({ chain: c, pct: v / tot })).sort((a, b) => b.pct - a.pct);
    const sym = (md.symbol as string) ?? node.label;
    body = (
      <>
        <TokenSpecRows symbol={sym} chainPcts={chainPcts.length > 1 ? chainPcts : null} />
        {onOpenDepth && hasDepth(sym) && (
          <button onClick={() => onOpenDepth(sym)}
            className="mt-2 w-full rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2 text-left text-[12px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20">
            상세 의존성 (재귀 언랩) ▸
          </button>
        )}
      </>
    );
  } else if (isMarket && market) {
    const agg = market.borrowUsd != null && market.collateralUsd ? market.borrowUsd / market.collateralUsd : null;
    const cushion = agg != null && market.lltv ? (market.lltv - agg) * 100 : null; // %p
    const curators = [...new Set((market.fundingVaults ?? []).map((v) => (v as { curator?: string | null; vault?: string | null }).curator ?? (v as { vault?: string | null }).vault).filter(Boolean))] as string[];
    body = (
      <>
        <PRow k="페어" v={`${market.collateralAsset ?? "?"} / ${market.loanAsset ?? "?"}`} />
        <PRow k="LLTV / 여유" v={cushion != null ? `${pct1(market.lltv)} · ${cushion.toFixed(1)}%p` : market.lltv ? pct1(market.lltv) : null}
          warn={market.lltv >= 0.945 || (cushion != null && cushion <= 8)} badge={agg != null ? "verified" : undefined} />
        <PRow k="이용률" v={market.utilization != null ? pct1(market.utilization) : null} warn={(market.utilization ?? 0) >= 0.95} />
        <PRow k="규모" v={market.marketSizeUsd > 0 ? formatUsd(market.marketSizeUsd) : null} />
        <PRow k="오라클" v={market.oracleAddress ? shortAddr(market.oracleAddress) : null}
          href={market.oracleAddress ? ADDR_EXPLORER[chain]?.(market.oracleAddress) : null} badge={market.oracleAddress ? "verified" : undefined} />
        <PRow k="큐레이터" v={curators.length ? `${curators.slice(0, 2).join(" · ")}${curators.length > 2 ? ` +${curators.length - 2}` : ""}` : null} />
        {market.ouroborosRisk && <PRow k="구조" v="자기참조 (ouroboros)" warn />}
      </>
    );
  } else if (isVault) {
    const aum = (md.sizeUsd as number) ?? null;
    const shared = relations.length;
    const derisk = md.inWithdrawQueue === true;
    body = (
      <>
        <PRow k="AUM" v={aum && aum > 0 ? formatUsd(aum) : null} />
        <PRow k="공유 마켓" v={shared > 0 ? `${shared}개` : null} />
        <PRow k="디리스킹" v={derisk ? "인출 큐 진입" : null} warn={derisk} />
      </>
    );
  } else if (isBridge) {
    const mech = md.mechanism != null ? String(md.mechanism) : null;
    const mintLimit = md.mintLimit as number | null | undefined;
    const verified = md.verified === true || md.authTypes != null;
    const types = Array.isArray(md.authTypes) ? (md.authTypes as string[]).join("·") : md.tag != null ? String(md.tag) : null;
    body = (
      <>
        <PRow k="mint 한도" v={mintLimit != null ? Intl.NumberFormat("en", { notation: "compact" }).format(mintLimit) : null} />
        <PRow k="권한" v={types ?? mech} badge={verified ? "verified" : "estimated"} />
        <PRow k="메커니즘" v={mech === "lock_mint" ? "락&민트" : mech === "burn_mint" ? "번&민트" : mech} warn={mech === "burn_mint"} />
        <PRow k="백킹" v={verified ? "온체인 권한 검증" : null} badge="verified" />
      </>
    );
  } else {
    // 프로토콜
    const markets: MarketEntry[] = relations.flatMap((r) => r.edge.attrs?.topMarkets ?? []);
    const totalUsd = relations.reduce((s, r) => s + (r.edge.attrs?.core?.amountUsd ?? 0), 0);
    const lltvs = markets.map((m) => m.lltv).filter((v) => v > 0);
    const utils = markets.map((m) => m.utilization).filter((v): v is number => v != null);
    const maxLltv = lltvs.length ? Math.max(...lltvs) : null;
    const avgUtil = utils.length ? utils.reduce((s, v) => s + v, 0) / utils.length : null;
    body = (
      <>
        <PRow k="담보 · 마켓" v={markets.length ? `${markets.length}개 · ${formatUsd(totalUsd)}` : totalUsd > 0 ? formatUsd(totalUsd) : null} />
        <PRow k="최고 LLTV" v={maxLltv != null ? pct1(maxLltv) : null} warn={maxLltv != null && maxLltv >= 0.945} />
        <PRow k="평균 이용률" v={avgUtil != null ? pct1(avgUtil) : null} warn={avgUtil != null && avgUtil >= 0.95} />
        <PRow k="알림" v={protoCounts ? sevDots(protoCounts.crit, protoCounts.warnN) : null} warn={(protoCounts?.crit ?? 0) > 0} />
      </>
    );
  }

  const addr = (md.tokenAddr as string) ?? (md.address as string) ?? null;
  return (
    <>
      <Header title={node.label} subtitle={`${node.type}${md.chain ? ` · ${String(md.chain)}` : ""}`} onClose={onClose} />
      <div className="flex-1 space-y-0.5 overflow-y-auto px-5 py-3.5">
        {body}
        {addr && <PRow k="주소" v={shortAddr(addr)} href={ADDR_EXPLORER[chain]?.(addr)} badge="verified" />}
      </div>
    </>
  );
}

// ── 엣지: 문단 없음 — 핵심 수치 + 오라클(타입·제공자·검증) + trace(있을 때만) ──
function EdgeBody({ edge, nodesById, onClose, onSelectNode }: {
  edge: GraphEdge; nodesById: Map<string, GraphNode>; onClose: () => void; onSelectNode: (id: string) => void;
}) {
  const a = edge.attrs;
  const sourceLabel = nodesById.get(edge.source)?.label ?? edge.source;
  const targetLabel = nodesById.get(edge.target)?.label ?? edge.target;
  const chain = (nodesById.get(edge.target)?.metadata.chain as string) ?? "ethereum";
  const est = (a?.meta?.dataSource ?? "").toString().startsWith("defillama");
  // trace 류(있을 때만): attrs.trace = { asset, amountUsd, count14d, sampleTxs[] } 형태를 기대
  const trace = (a as unknown as { trace?: { asset?: string; amountUsd?: number; count14d?: number; sampleTxs?: string[] } } | undefined)?.trace;

  return (
    <>
      <Header title={`${sourceLabel} → ${targetLabel}`} subtitle={`엣지 · ${a?.classification?.primary_role ?? edge.type}`} onClose={onClose} />
      <div className="flex-1 space-y-0.5 overflow-y-auto px-5 py-3.5">
        <PRow k="노출" v={a?.core?.amountUsd != null ? formatUsd(a.core.amountUsd) : null} badge={est ? "estimated" : "verified"} />
        <PRow k="공급 비중" v={a?.core?.pctOfSupply != null ? pct1(a.core.pctOfSupply) : null} />

        {/* 오라클 — 타입 · 제공자 · 검증만 */}
        <PRow k="오라클" v={a?.oracle?.type ? `${a.oracle.type}${a.oracle.provider ? ` · ${a.oracle.provider}` : ""}` : null}
          warn={!!a?.oracle && /hard|fixed|nav/i.test(`${a.oracle.type ?? ""} ${a.oracle.provider ?? ""}`)}
          badge={a?.oracle?.address ? "verified" : undefined}
          href={a?.oracle?.address ? ADDR_EXPLORER[chain]?.(a.oracle.address) : null} />
        {a?.oracle?.depegSensitive && <PRow k="디페그 민감" v="예" warn />}

        {/* 렌딩 — 있는 값만 */}
        <PRow k="청산 임계 (LT)" v={a?.lendingRisk?.lt != null ? pct1(a.lendingRisk.lt) : null} />
        <PRow k="이용률" v={a?.lendingRisk?.utilization != null ? pct1(a.lendingRisk.utilization) : null} warn={(a?.lendingRisk?.utilization ?? 0) >= 0.95} />
        <PRow k="가용 유동성" v={a?.lendingRisk?.liquidityUsd != null ? formatUsd(a.lendingRisk.liquidityUsd) : null} />
        {a?.lendingRisk?.isFrozen && <PRow k="동결" v="예" warn />}

        {/* DEX — 있는 값만 */}
        <PRow k="DEX 유동성" v={a?.dex?.liquidityUsd != null ? formatUsd(a.dex.liquidityUsd) : null} />
        <PRow k="±1% 깊이" v={a?.dex?.depthAt1pctUsd != null ? formatUsd(a.dex.depthAt1pctUsd) : null} />

        {/* trace — 자산 · 금액 · N회/14일 + 샘플 tx ↗ */}
        {trace && (
          <>
            <PRow k="자산" v={trace.asset ?? null} />
            <PRow k="금액" v={trace.amountUsd != null ? formatUsd(trace.amountUsd) : null} />
            <PRow k="횟수" v={trace.count14d != null ? `${trace.count14d}회/14일` : null} />
            {(trace.sampleTxs ?? []).slice(0, 3).map((h) => (
              <PRow key={h} k="샘플 tx" v={shortAddr(h)} href={TX_EXPLORER[chain]?.(h)} badge="verified" />
            ))}
          </>
        )}

        {/* 마켓 목록 — 한 줄 토큰만 */}
        {(a?.topMarkets?.length ?? 0) > 0 && (
          <div className="pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">마켓 ({a!.topMarkets!.length})</div>
            {[...a!.topMarkets!].sort((x, y) => y.marketSizeUsd - x.marketSizeUsd).slice(0, 6).map((m, i) => (
              <PRow key={i} k={`${m.collateralAsset ?? "?"}/${m.loanAsset ?? "?"}`} v={`${m.lltv ? pct1(m.lltv) : ""} · ${formatUsd(m.marketSizeUsd)}`} warn={m.lltv >= 0.945 || !!m.ouroborosRisk} />
            ))}
          </div>
        )}

        {/* 양 끝 노드 이동 */}
        <div className="flex gap-2 pt-3">
          <button onClick={() => onSelectNode(edge.source)} className="flex-1 truncate rounded-md bg-[var(--color-surface-raised)] px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg)]">◂ {sourceLabel}</button>
          <button onClick={() => onSelectNode(edge.target)} className="flex-1 truncate rounded-md bg-[var(--color-surface-raised)] px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg)]">{targetLabel} ▸</button>
        </div>
      </div>
    </>
  );
}
