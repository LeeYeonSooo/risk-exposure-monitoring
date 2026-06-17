"use client";

import { useMemo } from "react";

import type { GraphEdge, GraphNode, TokenBridgeEntry } from "@/lib/api";
import { formatUsd } from "@/lib/api";
import { oracleClassOf } from "@/lib/oracle";

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
      {/* 종착(terminal) — "여기가 끝"인 이유 + 재원 + 가역(출금) 안내. 감사관 [고정2·3·4]·[추궁] 대응. */}
      {m.terminal === true && (
        <div className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-1 text-[10px] leading-snug">
          <span className="font-semibold text-[var(--color-accent)]">종착</span>
          {m.terminalReason ? <span className="text-[var(--color-text-secondary)]"> — {String(m.terminalReason)}</span> : null}
          {m.rewardSource ? <div className="mt-0.5 text-[var(--color-text-muted)]">재원 · {String(m.rewardSource)}</div> : null}
          <div className="mt-0.5 text-[var(--color-text-muted)]">출금/상환은 역방향으로 되돌아 나감.</div>
        </div>
      )}
      {/* 큐레이터 볼트 — 보상 재원을 트리 경로(부모 마켓 → 이 볼트)로 읽히게. 감사관 [고정2].
          볼트로 들어오는 엣지는 부모 마켓(market→vault)뿐이고, 그 마켓의 대출 이자가 곧 이 볼트 보상 재원이다. */}
      {m._vault != null && (() => {
        const v = m._vault as Record<string, unknown>;
        return (
          <div className="rounded border border-[#eab308]/40 bg-[#fefce8] px-1.5 py-1 text-[10px] leading-snug">
            <span className="font-semibold text-[#a16207]">큐레이터 볼트</span>
            {v.market ? <span className="text-[var(--color-text-secondary)]"> — 한 홉 위 마켓 “{String(v.market)}” 이 보상 재원</span> : null}
            {v.rewardSource ? <div className="mt-0.5 text-[var(--color-text-muted)]">보상 재원 · {String(v.rewardSource)}</div> : null}
            <div className="mt-0.5 text-[var(--color-text-muted)]">마켓→볼트 엣지(보상 재원) = 그 마켓 대출 이자가 이 볼트로 누적. 원금 회수는 거꾸로 인출.</div>
          </div>
        );
      })()}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        {m.venue && <Row k="Venue" v={m.venue} />}
        {m.role && <Row k="Role" v={m.role} />}
        {m.chain && <Row k="Chain" v={m.chain} />}
        {m.sizeUsd != null && m.sizeUsd > 0 ? (
          <Row k="규모" v={formatUsd(m.sizeUsd)} />
        ) : m.sizeUnknown === true ? (
          // 무료 소스로 금액을 못 구한 마켓 — 0 이 아니라 "미상"으로 명시(결정론·추측 금지).
          <Row k="규모" v="금액 미상" />
        ) : null}
        {m.tokensHeld != null && (
          <Row k="Tokens" v={`${formatNumber(m.tokensHeld)}`} />
        )}
        {m.tokensHeldUsd != null && (
          <Row k="USD" v={formatUsd(m.tokensHeldUsd)} />
        )}
      </div>
      {/* 마켓 변별 컨텍스트(동일 loan-token 라벨 구분) — LLTV·큐레이터. _market payload 에서. */}
      <MarketContext m={m} />
      {node.type === "Bridge" && <BridgeMech m={m} />}
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

/** 브릿지 노드 메커니즘/한도 — 예전 RiskNode 자체 툴팁을 이 통합 툴팁으로 일원화(중복 제거). */
function BridgeMech({ m }: { m: import("@/lib/api").NodeMetadata }) {
  const mech = m.bridgeMechanism as string | undefined;
  const color = mech === "burn_mint" ? "#f87171" : mech === "liquidity" ? "#2dd4bf" : "#60a5fa";
  const ko = mech === "burn_mint" ? "번 & 민트" : mech === "liquidity" ? "유동성 풀" : "락 & 민트";
  const note = mech === "burn_mint"
    ? "메시지층 침해 시 무담보 무한 민팅 → 디페그 위험."
    : mech === "liquidity"
      ? "민팅 없음. 유동성 고갈·슬리피지 위험."
      : "L1 담보 백킹(보통 가장 감사). 브릿지 침해 시 무담보 위험.";
  const limit = m.bridgeMintLimit;
  return (
    <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        {m.bridgeProtocol && <span className="font-semibold text-[var(--color-text-primary)]">{m.bridgeVerified ? "✓ " : ""}{m.bridgeProtocol}</span>}
        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color, background: `${color}22` }}>{ko}</span>
        {m.bridgeWeak ? <span className="text-[10px] text-[var(--color-danger,#dc2626)]">⚠️ 사고이력</span> : null}
      </div>
      <p className="mt-1 leading-snug text-[var(--color-text-secondary)]">{note}</p>
      {typeof limit === "number" && limit > 0 && (
        <div className="mt-0.5 font-mono text-[var(--color-text-muted)]">mint 한도: {formatUsd(limit)}</div>
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
    // 엣지 위 오라클 원과 동일한 보정 분류로 표시(원/범례와 일치) — LST/LRT 의 MARKET 은 환율(LST)로 보정.
    if (a.oracle?.type && a.oracle.type !== "NONE") rows.push(["Oracle", oracleClassOf(a.oracle.type, (a.oracle as { provider?: string | null }).provider ?? null, hover.sourceLabel)]);
    if (a.lendingRisk?.lt != null) rows.push(["LT", pct(a.lendingRisk.lt)]);
    if (a.dex?.depthAt5pctUsd != null) rows.push(["Depth ±5%", formatUsd(a.dex.depthAt5pctUsd)]);
    if (a.wrapper?.issuedToken) rows.push(["Issued", a.wrapper.issuedToken]);
    // Vault funding info now lives per-market in topMarkets; show aggregate count
    if (Array.isArray(a.topMarkets)) {
      const funded = a.topMarkets.filter((m) => m?.vaultFunded).length;
      if (funded > 0) rows.push(["Vault-funded markets", `${funded} / ${a.topMarkets.length}`]);
    }
    return rows;
  }, [a, hover.sourceLabel]);

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

// 마켓 hover 변별 컨텍스트 — Morpho/Euler 마켓의 동일 loan-token 라벨을 LLTV·큐레이터로 구분.
//   _market payload(lego addMarketNode 가 얹음) 에서만 — 일반 프로토콜 노드엔 안 뜸.
function MarketContext({ m }: { m: import("@/lib/api").NodeMetadata }) {
  const mk = m._market as Record<string, unknown> | undefined;
  if (!mk) return null;
  const lltv = typeof mk.lltv === "number" ? `${(mk.lltv * 100).toFixed(0)}%` : null;
  const loan = typeof mk.loan === "string" ? mk.loan : null;
  const curators = Array.isArray(mk.curators) ? (mk.curators as string[]).filter(Boolean) : [];
  if (!lltv && !loan && !curators.length) return null;
  return (
    <div className="mt-1 border-t border-[var(--color-border-subtle)] pt-1 text-[11px]">
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {loan && <Row k="대출" v={loan} />}
        {lltv && <Row k="LLTV" v={lltv} />}
      </div>
      {curators.length > 0 && (
        <div className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]">
          큐레이터 · {curators.slice(0, 3).join(" · ")}{curators.length > 3 ? ` +${curators.length - 3}` : ""}
        </div>
      )}
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
