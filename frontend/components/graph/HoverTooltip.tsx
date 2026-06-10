"use client";

import { useMemo } from "react";

import type { GraphEdge, GraphNode, TokenBridgeEntry } from "@/lib/api";
import { formatUsd } from "@/lib/api";

interface NodeHover {
  kind: "node";
  node: GraphNode;
  x: number;
  y: number;
}
interface EdgeHover {
  kind: "edge";
  edge: GraphEdge;
  sourceLabel: string;
  targetLabel: string;
  x: number;
  y: number;
}
export type HoverState = NodeHover | EdgeHover;

export function HoverTooltip({ hover }: { hover: HoverState | null }) {
  if (!hover) return null;

  const offsetX = 16;
  const offsetY = 16;

  const style: React.CSSProperties = {
    position: "fixed",
    left: hover.x + offsetX,
    top: hover.y + offsetY,
    zIndex: 50,
    pointerEvents: "none",
    maxWidth: 360,
  };

  return (
    <div
      style={style}
      className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/95 px-3 py-2 text-xs shadow-2xl backdrop-blur-md"
    >
      {hover.kind === "node" ? <NodeBody node={hover.node} /> : <EdgeBody hover={hover} />}
    </div>
  );
}

function NodeBody({ node }: { node: GraphNode }) {
  const m = node.metadata;
  // Phase 1 — Ethereum mainnet 만 렌더. 다른 체인 키는 metadata 안에 보존.
  const bridgesByChain = (m.bridges ?? {}) as Record<string, TokenBridgeEntry[]>;
  const bridges = bridgesByChain.ethereum ?? [];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-[var(--color-text-primary)]">{node.label}</span>
        <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          {node.type}
        </span>
      </div>
      {m.description && (
        <p className="text-[11px] text-[var(--color-text-secondary)]">{m.description}</p>
      )}
      {m.category && m.category !== m.chain && (
        <p className="text-[11px] text-[var(--color-text-secondary)]">{m.category}</p>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        {m.venue && <Row k="Venue" v={m.venue} />}
        {m.role && <Row k="Role" v={m.role} />}
        {m.chain && <Row k="Chain" v={m.chain} />}
        {m.sizeUsd != null && m.sizeUsd > 0 && <Row k="규모" v={formatUsd(m.sizeUsd)} />}
        {m.tokensHeld != null && (
          <Row k="Tokens" v={`${formatNumber(m.tokensHeld)}`} />
        )}
        {m.tokensHeldUsd != null && (
          <Row k="USD" v={formatUsd(m.tokensHeldUsd)} />
        )}
      </div>
      {bridges.length > 0 && (
        <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Bridges · Ethereum ({bridges.length})
          </div>
          <div className="space-y-0.5">
            {bridges.slice(0, 6).map((b) => (
              <div
                key={b.bridge}
                className="flex items-center justify-between text-[11px]"
              >
                <span className="text-[var(--color-text-secondary)]">{b.bridge}</span>
                <span className="font-mono text-[var(--color-text-primary)]">
                  {formatNumber(b.lockedAmount)}
                </span>
              </div>
            ))}
            {bridges.length > 6 && (
              <div className="text-[10px] text-[var(--color-text-muted)]">
                +{bridges.length - 6} more…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EdgeBody({ hover }: { hover: EdgeHover }) {
  const e = hover.edge;
  const a = e.attrs;

  // Hover 는 통일 schema 의 핵심 4가지 + class-specific 한 줄만 보여줌
  const summary = useMemo(() => {
    const rows: [string, string][] = [];
    if (!a) return rows;
    // 모든 중첩 필드는 옵셔널 체이닝 — 엣지마다 attrs 구성이 달라(온체인/breadth/Aave 등)
    // 일부 섹션(core·oracle·lendingRisk…)이 null 일 수 있고, 그걸 그냥 읽으면 페이지 전체가 죽는다.
    const primary = a.classification?.primary_role ?? a.edgeType ?? null;
    const roleCount = a.classification?.roles?.length ?? 1;
    if (primary) rows.push(["Role", roleCount > 1 ? `${primary} +${roleCount - 1}` : primary]);
    const venue = a.classification?.venue_type ?? a.venueType;
    if (venue) rows.push(["Venue", venue]);
    if (a.core?.amountToken != null) rows.push(["Amount", formatNumber(a.core.amountToken)]);
    if (a.core?.amountUsd != null) rows.push(["TVL", formatUsd(a.core.amountUsd)]);
    if (a.core?.pctOfSupply != null) rows.push(["% supply", pct(a.core.pctOfSupply)]);
    if (a.oracle?.type && a.oracle.type !== "NONE") rows.push(["Oracle", a.oracle.type]);
    if (a.lendingRisk?.lt != null) rows.push(["LT", pct(a.lendingRisk.lt)]);
    if (a.dex?.depthAt5pctUsd != null) rows.push(["Depth ±5%", formatUsd(a.dex.depthAt5pctUsd)]);
    if (a.wrapper?.issuedToken) rows.push(["Issued", a.wrapper.issuedToken]);
    // Vault funding info now lives per-market in topMarkets; show aggregate count
    if (Array.isArray(a.topMarkets)) {
      const funded = a.topMarkets.filter((m) => m?.vaultFunded).length;
      if (funded > 0) rows.push(["Vault-funded markets", `${funded} / ${a.topMarkets.length}`]);
    }
    return rows;
  }, [a]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-[var(--color-text-muted)]">
          <span className="text-[var(--color-text-primary)]">{hover.sourceLabel}</span>
          <span className="mx-1">→</span>
          <span className="text-[var(--color-text-primary)]">{hover.targetLabel}</span>
        </span>
        <span className="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-accent)]">
          {a?.classification?.primary_role ?? a?.edgeType ?? e.type}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        {summary.map(([k, v]) => (
          <Row key={k} k={k} v={v} />
        ))}
      </div>
      {a?.topMarkets ? (
        <ListPreview title="Top markets" items={a.topMarkets as unknown as unknown[]} fmt={fmtMarketV2} />
      ) : null}
      {a?.topPools ? (
        <ListPreview title="Top pools" items={a.topPools as unknown as unknown[]} fmt={fmtPoolV2} />
      ) : null}
    </div>
  );
}

function fmtMarketV2(m: Record<string, unknown>): string {
  const loan = (m.loanAsset ?? m.collateralAsset ?? "?") as string;
  const lltv = pct(m.lltv as number);
  const size = formatUsd(m.marketSizeUsd as number);
  const vault = m.vaultFunded ? " 🔗" : "";
  return `${loan} · LLTV ${lltv} · ${size}${vault}`;
}
function fmtPoolV2(p: Record<string, unknown>): string {
  const pair = p.pair as string;
  const fee = typeof p.fee === "number" ? `${((p.fee as number) * 100).toFixed(2)}%` : "—";
  const amt = formatNumber(p.amount as number);
  return `${pair} · fee ${fee} · ${amt}`;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <>
      <span className="text-[var(--color-text-muted)]">{k}</span>
      <span className="text-right font-mono text-[var(--color-text-primary)]">{v}</span>
    </>
  );
}

function ListPreview({
  title,
  items,
  fmt,
}: {
  title: string;
  items: unknown[];
  fmt: (item: Record<string, unknown>) => string;
}) {
  return (
    <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {title} ({items.length})
      </div>
      <div className="space-y-0.5">
        {items.slice(0, 5).map((it, i) => (
          <div key={i} className="text-[11px] text-[var(--color-text-secondary)]">
            {fmt(it as Record<string, unknown>)}
          </div>
        ))}
        {items.length > 5 && (
          <div className="text-[10px] text-[var(--color-text-muted)]">
            +{items.length - 5} more…
          </div>
        )}
      </div>
    </div>
  );
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (n < 1 && n > 0) return n.toFixed(4);
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function pct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}
