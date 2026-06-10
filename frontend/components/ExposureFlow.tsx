"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatUsd, type GraphNode, type TopologyResponse } from "@/lib/api";

type Depth = "protocol" | "market" | "curator";

interface FlowVault {
  id: string;
  label: string;
  usd: number;
}

interface FlowMarket {
  id: string;
  label: string;
  usd: number;
  pct: number;
  category: string;
  vaults: FlowVault[];
}

interface FlowProtocol {
  id: string;
  label: string;
  chain: string;
  usd: number;
  pct: number;
  category: string;
  markets: FlowMarket[];
}

interface FlowChain {
  id: string;
  chain: string;
  usd: number;
  pct: number;
  protocols: FlowProtocol[];
}

interface VisibleRows<T> {
  rows: T[];
  hiddenUsd: number;
  hiddenPct: number;
  hiddenCount: number;
}

const MAX_CHAINS = 8;
const MAX_PROTOCOLS = 9;
const MAX_MARKETS = 9;

function numberValue(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pctLabel(v: number): string {
  if (!(v > 0)) return "0%";
  const p = v * 100;
  if (p < 0.01) return "<0.01%";
  if (p < 1) return `${p.toFixed(2)}%`;
  if (p < 10) return `${p.toFixed(2)}%`;
  return `${p.toFixed(1)}%`;
}

function titleCaseChain(chain: string): string {
  return chain.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function visibleRows<T extends { id: string; usd: number; pct: number }>(
  rows: T[],
  max: number,
  keepId?: string | null,
): VisibleRows<T> {
  if (rows.length <= max) return { rows, hiddenUsd: 0, hiddenPct: 0, hiddenCount: 0 };
  const picked = rows.find((r) => r.id === keepId);
  const base = rows.slice(0, max);
  const shown = picked && !base.some((r) => r.id === picked.id)
    ? [...base.slice(0, max - 1), picked].sort((a, b) => b.usd - a.usd)
    : base;
  const shownIds = new Set(shown.map((r) => r.id));
  const hidden = rows.filter((r) => !shownIds.has(r.id));
  return {
    rows: shown,
    hiddenUsd: hidden.reduce((s, r) => s + r.usd, 0),
    hiddenPct: hidden.reduce((s, r) => s + r.pct, 0),
    hiddenCount: hidden.length,
  };
}

function buildFlow(topo: TopologyResponse): FlowChain[] {
  const nodesById = new Map(topo.nodes.map((n) => [n.id, n] as const));
  const marketMap = new Map<string, FlowMarket>();
  const protoMap = new Map<string, FlowProtocol>();
  const byChain = new Map<string, FlowChain>();

  for (const n of topo.nodes) {
    if (!n.metadata._market) continue;
    const chain = String(n.metadata.chain ?? "unknown");
    const marketPayload = n.metadata._market as Record<string, unknown>;
    marketMap.set(n.id, {
      id: n.id,
      label: n.label,
      usd: numberValue(n.metadata.sizeUsd),
      pct: numberValue(n.metadata.distributionPct),
      category: String(n.metadata.category ?? marketPayload.kind ?? "market"),
      vaults: [],
    });
    if (!byChain.has(chain)) byChain.set(chain, { id: `chain:${chain}`, chain, usd: 0, pct: 0, protocols: [] });
  }

  for (const n of topo.nodes) {
    if (!n.metadata._vault) continue;
    const mid = n.id.replace(/:v\d+$/, "");
    const vaultPayload = n.metadata._vault as Record<string, unknown>;
    marketMap.get(mid)?.vaults.push({
      id: n.id,
      label: String(vaultPayload.curator ?? vaultPayload.vault ?? n.label),
      usd: numberValue(vaultPayload.allocationUsd),
    });
  }

  for (const n of topo.nodes) {
    if (!n.id.startsWith("c:")) continue;
    if (n.type === "Token" || n.type === "Bridge" || n.type === "IslandHandle") continue;
    if (n.metadata._market || n.metadata._vault) continue;
    const chain = String(n.metadata.chain ?? "unknown");
    protoMap.set(n.id, {
      id: n.id,
      label: n.label,
      chain,
      usd: numberValue(n.metadata.sizeUsd),
      pct: numberValue(n.metadata.distributionPct),
      category: String(n.metadata.category ?? ""),
      markets: [],
    });
    if (!byChain.has(chain)) byChain.set(chain, { id: `chain:${chain}`, chain, usd: 0, pct: 0, protocols: [] });
  }

  for (const market of marketMap.values()) {
    const pid = market.id.replace(/:m\d+$/, "");
    protoMap.get(pid)?.markets.push(market);
  }

  for (const p of protoMap.values()) {
    p.markets.sort((a, b) => b.usd - a.usd);
    const block = byChain.get(p.chain) ?? { id: `chain:${p.chain}`, chain: p.chain, usd: 0, pct: 0, protocols: [] };
    block.protocols.push(p);
    byChain.set(p.chain, block);
  }

  for (const n of topo.nodes) {
    const isChain = n.type === "IslandHandle" || (n.type === "Token" && n.id.startsWith("c:"));
    if (!isChain) continue;
    const chain = String(n.metadata.chain ?? n.label ?? "unknown");
    const block = byChain.get(chain) ?? { id: `chain:${chain}`, chain, usd: 0, pct: 0, protocols: [] };
    block.usd = Math.max(block.usd, numberValue(n.metadata.sizeUsd));
    block.pct = Math.max(block.pct, numberValue(n.metadata.distributionPct));
    byChain.set(chain, block);
  }

  for (const block of byChain.values()) {
    block.protocols.sort((a, b) => b.usd - a.usd);
    if (!(block.usd > 0)) block.usd = block.protocols.reduce((s, p) => s + p.usd, 0);
    if (!(block.pct > 0)) block.pct = block.protocols.reduce((s, p) => s + p.pct, 0);
    for (const p of block.protocols) {
      const source = nodesById.get(p.id);
      p.category = p.category || String(source?.metadata.category ?? "");
    }
  }

  return [...byChain.values()]
    .filter((c) => c.usd > 0 || c.protocols.length > 0)
    .sort((a, b) => b.usd - a.usd);
}

export function ExposureFlow({
  sym,
  topology,
  depth,
  selectedNodeId,
  onSelectNode,
}: {
  sym: string;
  topology: TopologyResponse;
  depth: Depth;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const chains = useMemo(() => buildFlow(topology), [topology]);
  const [activeChainId, setActiveChainId] = useState<string | null>(null);
  const [activeProtocolId, setActiveProtocolId] = useState<string | null>(null);

  useEffect(() => {
    if (!chains.length) {
      setActiveChainId(null);
      setActiveProtocolId(null);
      return;
    }
    const selectedProto = selectedNodeId
      ? chains.flatMap((c) => c.protocols).find((p) => p.id === selectedNodeId || p.markets.some((m) => m.id === selectedNodeId))
      : null;
    const selectedChain = selectedProto ? chains.find((c) => c.chain === selectedProto.chain) : null;
    setActiveChainId((prev) => selectedChain?.id ?? (prev && chains.some((c) => c.id === prev) ? prev : chains[0].id));
    setActiveProtocolId((prev) => selectedProto?.id ?? (prev && chains.some((c) => c.protocols.some((p) => p.id === prev)) ? prev : null));
  }, [chains, selectedNodeId]);

  const activeChain = chains.find((c) => c.id === activeChainId) ?? chains[0] ?? null;
  const protocols = activeChain?.protocols ?? [];
  const activeProtocol = protocols.find((p) => p.id === activeProtocolId) ?? protocols[0] ?? null;
  const chainRows = visibleRows(chains, MAX_CHAINS, activeChain?.id);
  const protocolRows = visibleRows(protocols, MAX_PROTOCOLS, activeProtocol?.id);
  const marketRows = visibleRows(activeProtocol?.markets ?? [], MAX_MARKETS, selectedNodeId);
  const totalUsd = chains.reduce((s, c) => s + c.usd, 0);
  const topChain = chains[0];
  const showMarkets = depth !== "protocol";
  const showVaults = depth === "curator";

  if (!chains.length) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]">
        표시할 익스포저 분포 데이터가 없습니다.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text-primary)]">
      <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-5 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Exposure Flow</div>
            <div className="mt-1 flex items-center gap-2 text-sm font-semibold">
              <span>{sym}</span>
              <ChevronRight size={14} className="text-[var(--color-text-muted)]" />
              <span>체인</span>
              <ChevronRight size={14} className="text-[var(--color-text-muted)]" />
              <span>프로토콜</span>
              {showMarkets && (
                <>
                  <ChevronRight size={14} className="text-[var(--color-text-muted)]" />
                  <span>{showVaults ? "마켓/큐레이터" : "마켓/풀"}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Metric label="총 익스포저" value={formatUsd(totalUsd)} />
            <Metric label="체인" value={`${chains.length}개`} />
            <Metric label="최대 체인" value={topChain ? `${titleCaseChain(topChain.chain)} ${pctLabel(topChain.pct)}` : "—"} />
          </div>
        </div>
      </div>

      <div className={"grid min-h-0 flex-1 gap-3 p-4 " + (showMarkets ? "grid-cols-[1.05fr_1.25fr_1.35fr]" : "grid-cols-[1fr_1.45fr]")}>
        <FlowColumn
          title="체인 분포"
          subtitle="전체 익스포저 기준"
          hidden={chainRows}
        >
          {chainRows.rows.map((c) => (
            <FlowRow
              key={c.id}
              label={titleCaseChain(c.chain)}
              value={formatUsd(c.usd)}
              pct={c.pct}
              active={c.id === activeChain?.id}
              onClick={() => {
                setActiveChainId(c.id);
                setActiveProtocolId(null);
                onSelectNode(null);
              }}
            />
          ))}
        </FlowColumn>

        <FlowColumn
          title={activeChain ? `${titleCaseChain(activeChain.chain)} 프로토콜` : "프로토콜"}
          subtitle={activeChain ? `${formatUsd(activeChain.usd)} · ${pctLabel(activeChain.pct)}` : "체인을 선택하세요"}
          hidden={protocolRows}
        >
          {protocolRows.rows.map((p) => (
            <FlowRow
              key={p.id}
              label={p.label}
              value={formatUsd(p.usd)}
              pct={p.pct}
              sub={p.category || `${p.markets.length}개 마켓`}
              active={p.id === activeProtocol?.id || p.id === selectedNodeId}
              onClick={() => {
                setActiveProtocolId(p.id);
                onSelectNode(p.id);
              }}
            />
          ))}
        </FlowColumn>

        {showMarkets && (
          <FlowColumn
            title={activeProtocol ? `${activeProtocol.label} 마켓/풀` : "마켓/풀"}
            subtitle={activeProtocol ? `${formatUsd(activeProtocol.usd)} · ${pctLabel(activeProtocol.pct)}` : "프로토콜을 선택하세요"}
            hidden={marketRows}
          >
            {marketRows.rows.length ? marketRows.rows.map((m) => (
              <FlowRow
                key={m.id}
                label={m.label}
                value={formatUsd(m.usd)}
                pct={m.pct}
                sub={showVaults && m.vaults.length ? `큐레이터 ${m.vaults.length}개 · ${m.category}` : m.category}
                active={m.id === selectedNodeId}
                onClick={() => onSelectNode(m.id)}
              >
                {showVaults && m.vaults.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-[var(--color-border-subtle)] pt-2">
                    {m.vaults.slice(0, 3).map((v) => (
                      <div key={v.id} className="flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-muted)]">
                        <span className="truncate">{v.label}</span>
                        <span className="shrink-0 font-mono">{v.usd > 0 ? formatUsd(v.usd) : "—"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </FlowRow>
            )) : (
              <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] px-3 py-8 text-center text-xs text-[var(--color-text-muted)]">
                이 프로토콜의 마켓/풀 상세가 아직 없습니다.
              </div>
            )}
          </FlowColumn>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1">
      <span className="mr-1 text-[var(--color-text-muted)]">{label}</span>
      <span className="font-mono font-semibold text-[var(--color-text-primary)]">{value}</span>
    </span>
  );
}

function FlowColumn({
  title,
  subtitle,
  hidden,
  children,
}: {
  title: string;
  subtitle: string;
  hidden: VisibleRows<{ id: string; usd: number; pct: number }>;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-sm">
      <div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{subtitle}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {children}
        {hidden.hiddenCount > 0 && (
          <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            <div className="flex items-center justify-between gap-2">
              <span>Others · {hidden.hiddenCount}개</span>
              <span className="font-mono">{formatUsd(hidden.hiddenUsd)} · {pctLabel(hidden.hiddenPct)}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function FlowRow({
  label,
  value,
  pct,
  sub,
  active,
  onClick,
  children,
}: {
  label: string;
  value: string;
  pct: number;
  sub?: string;
  active: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "group w-full rounded-lg border p-3 text-left transition-colors " +
        (active
          ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_9%,white)]"
          : "border-[var(--color-border-subtle)] bg-white hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-raised)]")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{label}</div>
          {sub && <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{sub}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[12px] font-semibold text-[var(--color-text-primary)]">{pctLabel(pct)}</div>
          <div className="font-mono text-[10px] text-[var(--color-text-muted)]">{value}</div>
        </div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
        <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.min(100, Math.max(1, pct * 100))}%` }} />
      </div>
      {children}
    </button>
  );
}
