"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight, Link2, X } from "lucide-react";
import { useState } from "react";

import type {
  GraphEdge,
  GraphNode,
  NodeTickState,
  RiskLevel,
  TokenBridgeEntry,
} from "@/lib/api";
import { formatUsd } from "@/lib/api";
import { hasDepth } from "@/lib/depth-graph";
import type { MarketEntry } from "@/lib/edge-schema";
import { cn } from "@/lib/utils";
import { TokenDossier } from "./TokenDossier";

const RISK_META: Record<RiskLevel, { label: string; color: string }> = {
  safe: { label: "Safe", color: "var(--color-healthy)" },
  caution: { label: "Caution", color: "var(--color-caution)" },
  danger: { label: "Danger", color: "var(--color-danger)" },
};

interface Relation {
  edge: GraphEdge;
  otherId: string;
  otherLabel: string;
  direction: "out" | "in";
}

export function SidePanel({
  node,
  state,
  edges,
  nodesById,
  onClose,
  onSelectNode,
  selectedEdge,
  onOpenDepth,
}: {
  node: GraphNode | null;
  state: NodeTickState | null;
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
  onClose: () => void;
  onSelectNode: (id: string) => void;
  /** When set, render edge details instead of node details. */
  selectedEdge?: GraphEdge | null;
  /** 토큰 노드에서 "상세(depth)" 클릭 → 맵 위 오버레이 오픈 (symbol 전달). */
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
            <EdgeBody
              edge={selectedEdge}
              nodesById={nodesById}
              onClose={onClose}
              onSelectNode={onSelectNode}
            />
          ) : (
            <NodeBody
              node={node!}
              state={state!}
              edges={edges}
              nodesById={nodesById}
              onClose={onClose}
              onSelectNode={onSelectNode}
              onOpenDepth={onOpenDepth}
            />
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

// ────────────────────────────────────────────────────────────
// NODE detail
// ────────────────────────────────────────────────────────────

function NodeBody({
  node,
  state,
  edges,
  nodesById,
  onClose,
  onSelectNode,
  onOpenDepth,
}: {
  node: GraphNode;
  state: NodeTickState;
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
  onClose: () => void;
  onSelectNode: (id: string) => void;
  onOpenDepth?: (symbol: string) => void;
}) {
  const relations: Relation[] = edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => {
      const out = e.source === node.id;
      const otherId = out ? e.target : e.source;
      return {
        edge: e,
        otherId,
        otherLabel: nodesById.get(otherId)?.label ?? otherId,
        direction: out ? ("out" as const) : ("in" as const),
      };
    })
    // TVL(노출 USD) 내림차순 — 큐레이터가 큰 노출부터 보게.
    .sort(
      (a, b) =>
        (b.edge.attrs?.core?.amountUsd ?? b.edge.weight ?? 0) -
        (a.edge.attrs?.core?.amountUsd ?? a.edge.weight ?? 0),
    );

  const risk = RISK_META[state.riskLevel];
  // Phase 1 — Ethereum mainnet 만 표시. 다른 체인 브릿지는 metadata에는 있지만 UI에 X.
  const bridgesByChain = (node.metadata.bridges ?? {}) as Record<string, TokenBridgeEntry[]>;
  const bridges = bridgesByChain.ethereum ?? [];
  const hoverPayload = node.metadata.hoverPayload as Record<string, unknown> | null | undefined;

  return (
    <>
      <Header
        title={node.label}
        subtitle={`${node.type}${node.metadata.chain ? ` · ${node.metadata.chain}` : ""}${node.metadata.category ? ` · ${node.metadata.category}` : ""}`}
        onClose={onClose}
      />

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Section title="Current state">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: risk.color }}
              />
              <span className="text-sm font-medium" style={{ color: risk.color }}>
                {risk.label}
              </span>
            </span>
            {state.liquidated && (
              <span className="rounded bg-[color:var(--color-danger)]/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--color-danger)]">
                liquidated
              </span>
            )}
          </div>
          {state.note && (
            <p className="mt-2 rounded-lg bg-[var(--color-surface-raised)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
              {state.note}
            </p>
          )}
          <dl className="mt-3 space-y-1.5 text-sm">
            {state.tvl != null && <Row label="TVL" value={formatUsd(state.tvl)} />}
            {state.pegRatio != null && (
              <Row
                label={node.type === "Oracle" ? "Reports" : "Peg ratio"}
                value={state.pegRatio.toFixed(4)}
              />
            )}
            {node.metadata.tokensHeld != null && (
              <Row label="Tokens held" value={formatNumber(node.metadata.tokensHeld)} />
            )}
            {node.metadata.tokensHeldUsd != null && (
              <Row label="USD" value={formatUsd(node.metadata.tokensHeldUsd)} />
            )}
          </dl>
        </Section>

        {node.type === "Token" && (
          <TokenDossier node={node} relations={relations} state={state} />
        )}

        {node.type === "Token" && (
          <TokenLendingExposure relations={relations} nodesById={nodesById} />
        )}

        {node.type === "Token" && onOpenDepth && (() => {
          const sym = ((node.metadata.symbol as string) ?? node.label);
          return hasDepth(sym) ? (
            <button
              onClick={() => onOpenDepth(sym)}
              className="flex w-full items-center justify-between rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2.5 text-[13px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20"
            >
              <span>상세 의존성 — 진짜 누가 들고 있나 (재귀 언랩) ▸</span>
            </button>
          ) : (
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/40 px-3 py-2.5 text-[12px] text-[var(--color-text-muted)]">
              상세(재귀 언랩) 그래프 준비 중 · 현재 rsETH · stETH · wstETH 지원
            </div>
          );
        })()}

        {node.metadata.description && (
          <Section title="About">
            <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
              {node.metadata.description}
            </p>
          </Section>
        )}

        {bridges.length > 0 && (
          <Section title={`Bridges · Ethereum (${bridges.length})`}>
            <ul className="space-y-1.5">
              {bridges.map((b) => (
                <li
                  key={b.bridge}
                  className="rounded-lg bg-[var(--color-surface-raised)] px-3 py-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-[var(--color-text-primary)]">
                      {b.bridge}
                    </span>
                    <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">
                      {formatNumber(b.lockedAmount)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[var(--color-text-muted)]">
                    {b.mechanism && (
                      <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5">
                        {b.mechanism}
                      </span>
                    )}
                    {b.destChains.length > 0 && (
                      <span>→ {b.destChains.join(", ")}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {hoverPayload && Object.keys(hoverPayload).length > 0 && (
          <Section title="Details">
            <KeyValueList payload={hoverPayload} />
          </Section>
        )}

        <Section title={`Dependencies (${relations.length})`}>
          <ul className="space-y-1">
            {relations.map((r) => (
              <li key={r.edge.id}>
                <button
                  onClick={() => onSelectNode(r.otherId)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--color-surface-raised)]"
                >
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[10px]",
                      r.direction === "out"
                        ? "text-[var(--color-accent)]"
                        : "text-[var(--color-text-muted)]",
                    )}
                  >
                    {r.direction === "out" ? "→" : "←"}
                  </span>
                  <span className="truncate">{r.otherLabel}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--color-text-secondary)]">
                    {r.edge.attrs?.core?.amountUsd != null
                      ? formatUsd(r.edge.attrs.core.amountUsd)
                      : "—"}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] uppercase text-[var(--color-text-muted)]">
                    {r.edge.attrs?.classification?.primary_role ?? r.edge.type}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────
// EDGE detail
// ────────────────────────────────────────────────────────────

function EdgeBody({
  edge,
  nodesById,
  onClose,
  onSelectNode,
}: {
  edge: GraphEdge;
  nodesById: Map<string, GraphNode>;
  onClose: () => void;
  onSelectNode: (id: string) => void;
}) {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  const sourceLabel = source?.label ?? edge.source;
  const targetLabel = target?.label ?? edge.target;
  const a = edge.attrs;

  return (
    <>
      <Header
        title={`${sourceLabel} → ${targetLabel}`}
        subtitle={`Edge · ${edge.type}`}
        onClose={onClose}
      />

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* 1. Endpoints */}
        <Section title="Endpoints">
          <div className="space-y-1.5">
            <button
              onClick={() => onSelectNode(edge.source)}
              className="flex w-full items-center justify-between rounded-md bg-[var(--color-surface-raised)] px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--color-surface)]"
            >
              <span className="text-[var(--color-text-muted)]">Source</span>
              <span className="font-medium text-[var(--color-text-primary)]">{sourceLabel}</span>
            </button>
            <button
              onClick={() => onSelectNode(edge.target)}
              className="flex w-full items-center justify-between rounded-md bg-[var(--color-surface-raised)] px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--color-surface)]"
            >
              <span className="text-[var(--color-text-muted)]">Target</span>
              <span className="font-medium text-[var(--color-text-primary)]">{targetLabel}</span>
            </button>
          </div>
        </Section>

        {/* 2. Classification — primary_role + roles[] */}
        <Section title="Classification">
          <dl className="space-y-1.5 text-sm">
            <Row
              label="Primary role"
              value={a?.classification?.primary_role ?? a?.edgeType ?? edge.type}
            />
            <Row
              label="Venue type"
              value={a?.classification?.venue_type ?? a?.venueType ?? "—"}
            />
            <Row
              label="Protocol class"
              value={a?.classification?.protocol_class ?? a?.protocolClass ?? "—"}
            />
          </dl>
          {a?.classification?.roles && a.classification.roles.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                Roles ({a.classification.roles.length})
              </div>
              <div className="space-y-1.5">
                {a.classification.roles.map((r, i) => (
                  <div
                    key={`${r.edge_type}-${i}`}
                    className="flex items-center justify-between rounded-md bg-[var(--color-surface-raised)] px-3 py-2 text-[13px]"
                  >
                    <span className="font-medium text-[var(--color-text-primary)]">
                      {r.edge_type}
                    </span>
                    <span className="font-mono text-[var(--color-text-muted)]">
                      {formatNumber(r.amount_token)} · {formatUsd(r.amount_usd)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* 3. Core weight — 항상 */}
        <Section title="Core weight">
          <dl className="space-y-1.5 text-sm">
            <Row label="Amount (token)" value={a ? formatNumber(a.core.amountToken) : "—"} />
            <Row label="TVL (USD)" value={a ? formatUsd(a.core.amountUsd) : "—"} />
            <Row label="% of supply" value={a?.core.pctOfSupply != null ? pct(a.core.pctOfSupply) : "—"} />
            <Row label="% of protocol TVL" value={a?.core.pctOfProtocolTvl != null ? pct(a.core.pctOfProtocolTvl) : "—"} />
          </dl>
        </Section>

        {/* 4. Oracle — 항상 */}
        <Section title="Oracle">
          <dl className="space-y-1.5 text-sm">
            <Row label="Type" value={a?.oracle.type ?? "—"} />
            <Row label="Provider" value={a?.oracle.provider ?? "—"} />
            <Row label="Address" value={a?.oracle.address ?? "—"} />
            <Row label="Depeg-sensitive" value={a?.oracle ? (a.oracle.depegSensitive ? "Yes" : "No") : "—"} />
          </dl>
        </Section>

        {/* 5. Lending risk — 항상 헤더, 값은 lending 외엔 "—" */}
        <Section title="Lending risk">
          <dl className="space-y-1.5 text-sm">
            <Row label="LTV" value={a?.lendingRisk?.ltv != null ? pct(a.lendingRisk.ltv) : "—"} />
            <Row label="Liquidation threshold" value={a?.lendingRisk?.lt != null ? pct(a.lendingRisk.lt) : "—"} />
            <Row label="Liquidation bonus" value={a?.lendingRisk?.liquidationBonus != null ? pct(a.lendingRisk.liquidationBonus) : "—"} />
            <Row label="Supply cap" value={a?.lendingRisk?.supplyCap != null ? formatNumber(a.lendingRisk.supplyCap) : "—"} />
            <Row label="Borrow cap" value={a?.lendingRisk?.borrowCap != null ? formatNumber(a.lendingRisk.borrowCap) : "—"} />
            <Row label="Reserve factor" value={a?.lendingRisk?.reserveFactor != null ? pct(a.lendingRisk.reserveFactor) : "—"} />
            <Row label="Utilization" value={a?.lendingRisk?.utilization != null ? pct(a.lendingRisk.utilization) : "—"} />
            <Row label="E-Mode" value={a?.lendingRisk?.eModeCategory ?? "—"} />
            <Row label="Frozen" value={a?.lendingRisk?.isFrozen == null ? "—" : a.lendingRisk.isFrozen ? "Yes" : "No"} />
            <Row label="Liquidity (USD)" value={a?.lendingRisk?.liquidityUsd != null ? formatUsd(a.lendingRisk.liquidityUsd) : "—"} />
            <Row label="IRM" value={a?.lendingRisk?.irm?.address ?? "—"} />
            <Row label="IRM family" value={a?.lendingRisk?.irm?.family ?? "—"} />
          </dl>
        </Section>

        {/* 6. DEX metrics */}
        <Section title="DEX metrics">
          <dl className="space-y-1.5 text-sm">
            <Row label="Pool count" value={a?.dex?.poolCount != null ? String(a.dex.poolCount) : "—"} />
            <Row label="Liquidity" value={a?.dex?.liquidityUsd != null ? formatUsd(a.dex.liquidityUsd) : "—"} />
            <Row label="Depth ±1%" value={a?.dex?.depthAt1pctUsd != null ? formatUsd(a.dex.depthAt1pctUsd) : "—"} />
            <Row label="Depth ±5%" value={a?.dex?.depthAt5pctUsd != null ? formatUsd(a.dex.depthAt5pctUsd) : "—"} />
            <Row label="Top pairs" value={a?.dex?.topPairs?.join(", ") ?? "—"} />
          </dl>
        </Section>

        {/* 7. Wrapper / mint backing */}
        <Section title="Wrapper / mint backing">
          <dl className="space-y-1.5 text-sm">
            <Row label="Issued token" value={a?.wrapper?.issuedToken ?? "—"} />
            <Row label="Backing share" value={a?.wrapper?.backingShare != null ? pct(a.wrapper.backingShare) : "—"} />
            <Row label="Co-backing" value={a?.wrapper?.coBackingTokens?.join(", ") ?? "—"} />
            <Row label="Redemption" value={a?.wrapper?.redemption ?? "—"} />
            <Row label="Manager" value={a?.wrapper?.manager ?? "—"} />
          </dl>
        </Section>

        {/* 8. Sub-items: Top markets (with vault funding inline) */}
        {a?.topMarkets && a.topMarkets.length > 0 && (
          <Section title={`Top markets (${a.topMarkets.length})`}>
            <ul className="space-y-1.5">
              {[...a.topMarkets]
                .sort((x, y) => y.marketSizeUsd - x.marketSizeUsd)
                .map((m, i) => (
                  <MarketRow key={i} market={m} />
                ))}
            </ul>
          </Section>
        )}

        {/* 9. Sub-items: Top pools */}
        {a?.topPools && a.topPools.length > 0 && (
          <Section title={`Top pools (${a.topPools.length})`}>
            <ul className="space-y-1.5">
              {sortDesc(a.topPools as unknown as Record<string, unknown>[], "amount")?.map((p, i) => (
                <li key={i} className="rounded-lg bg-[var(--color-surface-raised)] px-3 py-2">
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="font-medium text-[var(--color-text-primary)]">
                      {String(p.pair as string)}
                    </span>
                    <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">
                      {typeof p.fee === "number" ? `fee ${((p.fee as number) * 100).toFixed(2)}%` : "—"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                    amount {formatNumber(p.amount as number)}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* 10. Meta — 항상 */}
        <Section title="Meta">
          <dl className="space-y-1.5 text-sm">
            <Row label="Snapshot" value={a?.meta.snapshotTs ?? "—"} />
            <Row label="Confidence" value={a?.meta.confidence ?? "—"} />
            <Row label="Verifiable on-chain" value={a?.meta.verifiableOnchain == null ? "—" : a.meta.verifiableOnchain ? "Yes" : "No"} />
            <Row label="Source" value={a?.meta.dataSource ?? "—"} />
          </dl>
        </Section>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────
// Shared bits
// ────────────────────────────────────────────────────────────

function Header({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between border-b border-[var(--color-border-subtle)] px-5 py-4">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{subtitle}</p>
      </div>
      <button
        onClick={onClose}
        className="ml-2 shrink-0 rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-primary)]"
      >
        <X size={16} />
      </button>
    </div>
  );
}

/**
 * P0 — 토큰의 "렌딩 노출 & 유동성" 표 (디페깅 전염 핵심 뷰).
 * 선택한 토큰이 담보/공급으로 들어간 렌딩·CDP 마켓을 체인×댑별로:
 *   노출 USD · LT · 가용 유동성 · 가동률 → 디페깅 시 부실채권 후보 + 인출 여력.
 * 정렬: 노출순(리스크 관점) ↔ 유동성순(고래 "어디 루핑" 관점).
 */
function TokenLendingExposure({
  relations,
  nodesById,
}: {
  relations: Relation[];
  nodesById: Map<string, GraphNode>;
}) {
  const [sortBy, setSortBy] = useState<"exposure" | "liquidity" | "safest">("exposure");
  const rows = relations
    .filter((r) => r.edge.attrs?.lendingRisk != null)
    .map((r) => {
      const a = r.edge.attrs!;
      const proto = nodesById.get(r.otherId);
      return {
        id: r.otherId,
        label: proto?.label ?? r.otherId,
        chain: (proto?.metadata.chain as string) ?? "ethereum",
        exposureUsd: a.core?.amountUsd ?? 0,
        lt: a.lendingRisk?.lt ?? null,
        liqUsd: a.lendingRisk?.liquidityUsd ?? null,
        util: a.lendingRisk?.utilization ?? null,
      };
    })
    .sort((x, y) =>
      sortBy === "liquidity" ? (y.liqUsd ?? 0) - (x.liqUsd ?? 0)
        : sortBy === "safest" ? (x.util ?? 1) - (y.util ?? 1) // 가동률 낮은 = 인출 여력 큰 = 안전
          : y.exposureUsd - x.exposureUsd,
    );
  if (rows.length === 0) return null;
  const totalExposure = rows.reduce((s, r) => s + r.exposureUsd, 0);
  const maxLiq = Math.max(1, ...rows.map((r) => r.liqUsd ?? 0));
  // 동향 기준 가동률 밴드: <80 정상(초록) / 80–95 상승(황) / ≥95 punitive·락업(적)
  const utilColor = (u: number | null) =>
    u == null ? "var(--color-text-muted)" : u >= 0.95 ? "var(--color-danger)" : u >= 0.8 ? "#fbbf24" : "#34d399";

  const sortLabels: Record<typeof sortBy, string> = { exposure: "노출순", liquidity: "유동성순", safest: "안전순(가동률↓)" };

  return (
    <Section title="렌딩 노출 & 유동성">
      <p className="mb-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
        디페깅 시 부실채권 후보 · 어느 풀이 유동성 풍부/가동률 낮은지.
        <span className="ml-1 font-mono text-[var(--color-text-primary)]">총 {formatUsd(totalExposure)}</span>
      </p>
      <div className="mb-1.5 flex items-center gap-1 text-[10px]">
        <span className="text-[var(--color-text-muted)]">정렬</span>
        {(["exposure", "liquidity", "safest"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setSortBy(k)}
            className={
              "rounded px-1.5 py-0.5 transition-colors " +
              (sortBy === k ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]")
            }
          >
            {sortLabels[k]}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-[var(--color-surface-raised)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              <th className="px-1.5 py-1 text-left font-medium">댑 · 체인</th>
              <th className="px-1.5 py-1 text-right font-medium">노출</th>
              <th className="px-1.5 py-1 text-right font-medium">LT</th>
              <th className="px-1.5 py-1 text-left font-medium">유동성</th>
              <th className="px-1.5 py-1 text-left font-medium">가동률</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-[var(--color-border-subtle)]">
                <td className="px-1.5 py-1">
                  <div className="font-medium leading-tight text-[var(--color-text-primary)]">{r.label}</div>
                  <div className="text-[9px] uppercase text-[var(--color-text-muted)]">{r.chain}</div>
                </td>
                <td className="px-1.5 py-1 text-right font-mono text-[var(--color-text-secondary)]">{formatUsd(r.exposureUsd)}</td>
                <td className="px-1.5 py-1 text-right font-mono text-[var(--color-text-secondary)]">{r.lt != null ? pct(r.lt) : "—"}</td>
                {/* 유동성 막대 — 길수록 인출 여력 풍부 */}
                <td className="px-1.5 py-1">
                  {r.liqUsd != null ? (
                    <div className="flex items-center gap-1">
                      <span className="h-1.5 w-9 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                        <span className="block h-full rounded-full bg-[#60a5fa]" style={{ width: `${Math.max(4, ((r.liqUsd ?? 0) / maxLiq) * 100)}%` }} />
                      </span>
                      <span className="font-mono text-[10px] text-[var(--color-text-secondary)]">{formatUsd(r.liqUsd)}</span>
                    </div>
                  ) : <span className="font-mono text-[10px] text-[var(--color-text-muted)]">—</span>}
                </td>
                {/* 가동률 막대 — 색 밴드로 즉시 위험도 */}
                <td className="px-1.5 py-1">
                  {r.util != null ? (
                    <div className="flex items-center gap-1">
                      <span className="h-1.5 w-9 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                        <span className="block h-full rounded-full" style={{ width: `${Math.min(100, r.util * 100)}%`, backgroundColor: utilColor(r.util) }} />
                      </span>
                      <span className="font-mono text-[10px]" style={{ color: utilColor(r.util) }}>{pct(r.util)}</span>
                    </div>
                  ) : <span className="font-mono text-[10px] text-[var(--color-text-muted)]">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-[var(--color-text-muted)]">
        가동률: <span style={{ color: "#34d399" }}>초록 &lt;80%</span> 정상 · <span style={{ color: "#fbbf24" }}>황 80–95%</span> 금리 급등 · <span style={{ color: "var(--color-danger)" }}>적 ≥95%</span> 인출 불가/락업. 유동성 막대 = 인출 여력.
      </p>
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function KeyValueList({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).filter(([, v]) => v != null);
  if (entries.length === 0) return null;
  return (
    <dl className="space-y-1.5 text-sm">
      {entries.map(([k, v]) => (
        <Row key={k} label={prettyKey(k)} value={renderValue(k, v)} />
      ))}
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="break-all text-right font-mono text-[var(--color-text-primary)]">
        {value}
      </dd>
    </div>
  );
}

function prettyKey(k: string): string {
  // camelCase or snake_case → Title Case
  return k
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function renderValue(key: string, v: unknown): string {
  if (typeof v === "number") {
    if (/usd$/i.test(key) || /amountUsd|sizeUsd|tvl/i.test(key)) return formatUsd(v);
    if (/percent|pct|ltv|lt|lltv|share|factor|rate|apy/i.test(key) && Math.abs(v) <= 1) return pct(v);
    return formatNumber(v);
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return `[${v.length} items]`;
  return String(v);
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (n < 1 && n > 0) return n.toFixed(4);
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/** Single market row — vault funding 펼치기 가능 */
function MarketRow({ market }: { market: MarketEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasFunding = market.vaultFunded && market.fundingVaults && market.fundingVaults.length > 0;
  const label = (market.loanAsset ?? market.collateralAsset ?? "?") as string;

  return (
    <li className="rounded-lg bg-[var(--color-surface-raised)] px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="flex items-center gap-1.5 font-medium text-[var(--color-text-primary)]">
          {label}
          {market.vaultFunded ? (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="ml-1 inline-flex items-center gap-0.5 rounded bg-[var(--color-accent)]/15 px-1 py-0.5 text-[10px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25"
              title="Vault-funded — 클릭으로 펼치기"
            >
              <Link2 size={10} />
              {hasFunding ? (
                expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />
              ) : null}
            </button>
          ) : null}
        </span>
        <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">
          LLTV {pct(market.lltv)}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        size {formatUsd(market.marketSizeUsd)}
        {market.utilization != null ? ` · util ${pct(market.utilization)}` : ""}
        {market.vaultFundedShareOfSupply != null ? ` · vault ${pct(market.vaultFundedShareOfSupply)}` : ""}
        {market.oracleAddress ? <div className="truncate">oracle {market.oracleAddress}</div> : null}
        {market.irmAddress ? <div className="truncate">IRM {market.irmAddress}</div> : null}
      </div>

      {expanded && hasFunding && market.fundingVaults && (
        <ul className="mt-2 space-y-1 border-t border-[var(--color-border-subtle)] pt-2">
          {[...market.fundingVaults]
            .sort((a, b) => b.allocationUsd - a.allocationUsd)
            .map((v, i) => (
              <li key={i} className="text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--color-text-primary)]">
                    {v.vaultName}
                  </span>
                  <span className="font-mono text-[var(--color-text-secondary)]">
                    {v.allocationUsd > 0 ? formatUsd(v.allocationUsd) : "—"}
                  </span>
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  {v.curator} · deposit: {v.depositAsset}
                </div>
              </li>
            ))}
        </ul>
      )}
    </li>
  );
}

/** Sort an array of objects by a numeric key, descending. Stable & undefined-safe. */
function sortDesc<T extends Record<string, unknown>>(
  items: T[] | undefined,
  key: string,
): T[] | undefined {
  if (!items) return undefined;
  return [...items].sort((a, b) => {
    const av = typeof a[key] === "number" ? (a[key] as number) : -Infinity;
    const bv = typeof b[key] === "number" ? (b[key] as number) : -Infinity;
    return bv - av;
  });
}
