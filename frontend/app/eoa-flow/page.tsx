"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AlertDock } from "@/components/AlertDock";
import { SiteHeader } from "@/components/SiteHeader";
import { EoaFlowGraph } from "@/components/eoa-flow/EoaFlowGraph";
import type { EoaFlowItem, EoaFlowMetadata, EoaFlowPayload } from "@/lib/eoa-flow-types";

const DEFAULT_SEED = "0x325228217e02e31529bf4bc6e32db695ea525669";
const KELP_ATTACKER = "0x8B1b6c9A6DB1304000412dd21Ae6A70a82d60D3b";

export default function EoaFlowPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-[var(--color-bg)] text-sm text-[var(--color-text-muted)]">로딩...</div>}>
      <EoaFlowPageInner />
    </Suspense>
  );
}

function bestFlowName(flows: EoaFlowItem[]): string | null {
  if (!flows.length) return null;
  return [...flows].sort((a, b) => b.events - a.events || b.addresses - a.addresses || a.name.localeCompare(b.name))[0]?.name ?? null;
}

function formatBlockRange(meta: EoaFlowMetadata): string | null {
  if (meta.from_block == null && meta.to_block == null) return null;
  return `${meta.from_block?.toLocaleString() ?? "?"}-${meta.to_block?.toLocaleString() ?? "?"}`;
}

function fmtUsd(value: unknown): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : null;
  if (n == null) return "-";
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(value: unknown): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : null;
  return n == null ? "-" : `${(n * 100).toFixed(1)}%`;
}

function shortAddr(address: string | null | undefined): string {
  return address && /^0x[a-fA-F0-9]{40}$/.test(address) ? `${address.slice(0, 6)}...${address.slice(-4)}` : "-";
}

type EoaViewMode = "d0" | "d-inf";

function graphCounts(payload: EoaFlowPayload | null, mode: EoaViewMode): { visibleNodes: number; rawNodes: number; visibleEdges: number; rawEdges: number } {
  if (!payload) return { visibleNodes: 0, rawNodes: 0, visibleEdges: 0, rawEdges: 0 };
  if (mode === "d-inf") {
    const rawNodes = payload.nodes.filter((node) => node.type !== "event" && node.data.kind !== "event");
    return {
      visibleNodes: payload.walletClusters?.addresses.length ?? rawNodes.filter((node) => node.type === "eoa" || node.data.kind === "eoa" || node.data.kind === "safe").length,
      rawNodes: rawNodes.length,
      visibleEdges: payload.walletClusters?.edges.length ?? payload.edges.filter((edge) => edge.edge_type === "wallet_move" || edge.edge_type === "wallet_transfer").length,
      rawEdges: payload.edges.length,
    };
  }
  const rawNodes = payload.nodes.filter((node) => node.type !== "event" && node.data.kind !== "event");
  const byId = new Map(rawNodes.map((node) => [node.id, node] as const));
  const isWalletNode = (node: (typeof rawNodes)[number]) => node.type === "eoa" || node.data.kind === "eoa" || node.data.kind === "safe";
  const isWallet = (id: string) => {
    const node = byId.get(id);
    return !!node && isWalletNode(node);
  };
  const seedWallet = rawNodes.find((node) => isWalletNode(node) && (node.data.discovered_by === "seed" || (node.data.dfs_depth ?? 0) === 0)) ?? rawNodes.find(isWalletNode) ?? null;
  const edgeVisible = (edge: EoaFlowPayload["edges"][number]) => {
    if (!byId.has(edge.source) || !byId.has(edge.target)) return false;
    if (isWallet(edge.source) && isWallet(edge.target)) return false;
    if (isWallet(edge.source) && edge.source !== seedWallet?.id) return false;
    if (isWallet(edge.target) && edge.target !== seedWallet?.id) return false;
    return true;
  };
  const visibleEdges = payload.edges.filter(edgeVisible).length;
  const visibleNodeIds = new Set<string>();
  for (const edge of payload.edges) {
    if (!edgeVisible(edge)) continue;
    visibleNodeIds.add(edge.source);
    visibleNodeIds.add(edge.target);
  }
  if (seedWallet) visibleNodeIds.add(seedWallet.id);
  return { visibleNodes: visibleNodeIds.size, rawNodes: rawNodes.length, visibleEdges, rawEdges: payload.edges.length };
}

type PortfolioSummary = {
  totalUsd?: number | null;
  walletTokenUsd?: number | null;
  protocolNetUsd?: number | null;
  protocols?: Array<{ protocolName?: string | null; assetUsd?: number | null; debtUsd?: number | null; netUsd?: number | null }>;
  walletTokens?: Array<{ symbol?: string; valueUsd?: number | null; mappedProtocolId?: string | null }>;
  externalOutflows?: ExternalOutflowSummary | null;
};

type ExternalOutflowSummary = {
  totals?: {
    knownInfraUsd30d?: number | null;
    knownCexBridgeUsd30d?: number | null;
    knownCexBridgeUsdAll?: number | null;
    routerUsd30d?: number | null;
    solverUsd30d?: number | null;
    protocolUsd30d?: number | null;
    walletUsd30d?: number | null;
    eoaUsd30d?: number | null;
    contractUsd30d?: number | null;
    knownInfraUsdAll?: number | null;
    walletUsdAll?: number | null;
  };
  cex?: OutflowCounterparty[];
  bridge?: OutflowCounterparty[];
  router?: OutflowCounterparty[];
  solver?: OutflowCounterparty[];
  protocol?: OutflowCounterparty[];
  eoa?: OutflowCounterparty[];
  contract?: OutflowCounterparty[];
  unclassifiedLarge?: OutflowCounterparty[];
};

type OutflowCounterparty = {
  category?: string | null;
  label?: string | null;
  counterparty?: string | null;
  symbol?: string | null;
  valueUsd?: number | null;
  txCount?: number | null;
};

type BorrowerSummary = {
  address?: string | null;
  marketPosition?: {
    borrowUsd?: number | null;
    collateralUsd?: number | null;
  };
  portfolioSnapshot?: {
    liquidAssets?: {
      availableLiquidUsd?: number | null;
      highQualityLiquidUsd?: number | null;
    };
  } | null;
  externalOutflows?: {
    totals?: {
      knownInfraUsd30d?: number | null;
      knownCexBridgeUsd30d?: number | null;
      routerUsd30d?: number | null;
      solverUsd30d?: number | null;
      protocolUsd30d?: number | null;
      walletUsd30d?: number | null;
      eoaUsd30d?: number | null;
      contractUsd30d?: number | null;
      largeUnclassifiedUsd30d?: number | null;
    };
  } | null;
  riskInputs?: {
    liquidation?: {
      ltv?: number | null;
      lltv?: number | null;
      liquidationBufferPct?: number | null;
    };
    liquidity?: {
      availableLiquidToDebt?: number | null;
      highQualityLiquidToDebt?: number | null;
    };
    externalization?: {
      knownInfraOutflowToDebt30d?: number | null;
      knownCexBridgeOutflowToDebt30d?: number | null;
      routerOutflowToDebt30d?: number | null;
      solverOutflowToDebt30d?: number | null;
      protocolOutflowToDebt30d?: number | null;
      walletOutflowToDebt30d?: number | null;
      eoaOutflowToDebt30d?: number | null;
      contractOutflowToDebt30d?: number | null;
    };
  };
  riskBand?: string | null;
};

type MorphoBorrowerAnalysis = {
  markets?: Array<{
    marketKey?: string;
    marketLabel?: string;
    marketBorrowUsd?: number | null;
    utilization?: number | null;
    borrowers?: BorrowerSummary[];
  }>;
  dataGaps?: string[];
};

function asPortfolio(value: unknown): PortfolioSummary | null {
  return value && typeof value === "object" ? value as PortfolioSummary : null;
}

function asMorphoAnalysis(value: unknown): MorphoBorrowerAnalysis | null {
  return value && typeof value === "object" ? value as MorphoBorrowerAnalysis : null;
}

function topOutflowRows(outflows: ExternalOutflowSummary | null | undefined, limit = 4): OutflowCounterparty[] {
  if (!outflows) return [];
  return [
    ...(outflows.cex ?? []),
    ...(outflows.bridge ?? []),
    ...(outflows.router ?? []),
    ...(outflows.solver ?? []),
    ...(outflows.protocol ?? []),
    ...(outflows.eoa ?? []),
    ...(outflows.contract ?? []),
    ...(outflows.unclassifiedLarge ?? []),
  ]
    .filter((row) => row.counterparty || row.label)
    .filter((row) => (row.valueUsd ?? 0) > 0)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || (b.txCount ?? 0) - (a.txCount ?? 0))
    .slice(0, limit);
}

function WalletClusterCard({ payload }: { payload: EoaFlowPayload }) {
  const [expanded, setExpanded] = useState(false);
  const clusters = payload.walletClusters;
  if (!clusters) return null;
  const seedCluster = clusters.clusters.find((cluster) => cluster.hasSeed) ?? clusters.clusters[0] ?? null;
  const strongEdges = clusters.edges.filter((edge) => edge.strength === "strong").length;
  const deployerEdges = clusters.edges.filter((edge) => edge.relation === "deployer").length;
  const clusterPortfolio = clusters.clusterPortfolios?.find((row) => row.clusterId === "wallet-cluster:all")
    ?? clusters.clusterPortfolios?.find((row) => row.clusterId === seedCluster?.id)
    ?? clusters.clusterPortfolios?.[0]
    ?? null;
  const outflows = clusterPortfolio?.externalOutflows ?? null;
  return (
    <div className="min-w-[320px] flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-bold text-[var(--color-text-primary)]">wallet cluster</div>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]"
        >
          {expanded ? "접기" : "상세 열기"}
        </button>
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">SCC · protocol excluded</div>
      <div className="mt-1 grid grid-cols-4 gap-2 font-mono text-[11px]">
        <MiniMetric label="addresses" value={String(clusters.addresses.length)} />
        <MiniMetric label="clusters" value={String(clusters.clusters.length)} />
        <MiniMetric label="wallet edges" value={String(clusters.edges.length)} />
        <MiniMetric label="strong" value={String(strongEdges)} />
      </div>
      {clusterPortfolio && (
        <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px]">
          <MiniMetric label="cluster total" value={fmtUsd(clusterPortfolio.totalUsd)} />
          <MiniMetric label="wallet out all" value={fmtUsd(outflows?.totals.walletUsdAll)} />
          <MiniMetric label="sampled" value={`${clusterPortfolio.sampledAddressCount}/${clusterPortfolio.addressCount}`} />
        </div>
      )}
      {expanded && seedCluster && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
            seed cluster {seedCluster.size} addr · {seedCluster.transferTxCount} tx
          </span>
          {deployerEdges > 0 && (
            <span className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
              deployer {deployerEdges}
            </span>
          )}
          {seedCluster.addresses.slice(0, 4).map((address) => (
            <span key={address} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
              {shortAddr(address)}
            </span>
          ))}
        </div>
      )}
      {expanded && !!clusters.dataGaps?.length && (
        <div className="mt-1 truncate font-mono text-[9px] text-[var(--color-text-muted)]" title={clusters.dataGaps.join(", ")}>
          gap · {clusters.dataGaps[0]}
        </div>
      )}
      {expanded && clusterPortfolio && (
        <div className="mt-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-[10px] font-bold text-[var(--color-text-primary)]">{clusterPortfolio.label}</div>
            <div className="font-mono text-[9px] text-[var(--color-text-muted)]">
              sampled {clusterPortfolio.sampledAddressCount}/{clusterPortfolio.addressCount}
            </div>
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px]">
            <MiniMetric label="cluster total" value={fmtUsd(clusterPortfolio.totalUsd)} />
            <MiniMetric label="wallet tokens" value={fmtUsd(clusterPortfolio.walletTokenUsd)} />
            <MiniMetric label="protocol net" value={fmtUsd(clusterPortfolio.protocolNetUsd)} />
          </div>
          {clusterPortfolio.externalOutflows && (
            <>
              <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px]">
                <MiniMetric label="infra out 30d" value={fmtUsd(clusterPortfolio.externalOutflows.totals.knownInfraUsd30d)} />
                <MiniMetric label="cex/bridge 30d" value={fmtUsd(clusterPortfolio.externalOutflows.totals.knownCexBridgeUsd30d)} />
                <MiniMetric label="wallet out 30d" value={fmtUsd(clusterPortfolio.externalOutflows.totals.walletUsd30d)} />
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px]">
                <MiniMetric label="infra out all" value={fmtUsd(clusterPortfolio.externalOutflows.totals.knownInfraUsdAll)} />
                <MiniMetric label="cex/bridge all" value={fmtUsd(clusterPortfolio.externalOutflows.totals.knownCexBridgeUsdAll)} />
                <MiniMetric label="wallet out all" value={fmtUsd(clusterPortfolio.externalOutflows.totals.walletUsdAll)} />
              </div>
              {!!clusterPortfolio.externalOutflows.topCounterparties.length && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {clusterPortfolio.externalOutflows.topCounterparties.slice(0, 4).map((row) => (
                    <span key={`${row.category}:${row.counterparty}:${row.symbol}`} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]" title={row.counterparty}>
                      {row.category} {shortAddr(row.counterparty)} {row.symbol} {fmtUsd(row.valueUsd)}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
          {!!clusterPortfolio.topProtocols.length && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {clusterPortfolio.topProtocols.slice(0, 4).map((protocol) => (
                <span key={protocol.protocolId} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                  {protocol.protocolName} {fmtUsd(protocol.netUsd ?? protocol.assetUsd)}
                </span>
              ))}
            </div>
          )}
          {!!clusterPortfolio.topWalletTokens.length && (
            <div className="mt-1 flex flex-wrap gap-1">
              {clusterPortfolio.topWalletTokens.slice(0, 4).map((token) => (
                <span key={`${token.tokenAddress ?? "native"}:${token.symbol}`} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
                  {token.symbol} {fmtUsd(token.valueUsd)}
                </span>
              ))}
            </div>
          )}
          {!!clusterPortfolio.dataGaps.length && (
            <div className="mt-1 truncate font-mono text-[9px] text-[var(--color-text-muted)]" title={clusterPortfolio.dataGaps.join(", ")}>
              portfolio gap · {clusterPortfolio.dataGaps[0]}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EoaEnrichmentStrip({ payload, mode }: { payload: EoaFlowPayload; mode: EoaViewMode }) {
  const portfolio = asPortfolio(payload.pseudoDebank);
  const morpho = asMorphoAnalysis(payload.morphoBorrowerAnalysis);
  const clusters = payload.walletClusters;
  if (!portfolio && !morpho && !clusters) return null;
  const walletLiquid = portfolio?.walletTokens
    ?.filter((token) => !token.mappedProtocolId && (token.valueUsd ?? 0) > 0)
    .reduce((sum, token) => sum + (token.valueUsd ?? 0), 0) ?? null;
  const topProtocols = portfolio?.protocols
    ?.slice()
    .sort((a, b) => (b.assetUsd ?? b.netUsd ?? 0) - (a.assetUsd ?? a.netUsd ?? 0))
    .slice(0, 4) ?? [];
  const markets = morpho?.markets?.slice(0, 3) ?? [];
  return (
    <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 lg:px-5">
      <div className="flex flex-wrap items-start gap-2">
        {mode === "d-inf" && <WalletClusterCard payload={payload} />}

        {portfolio && (
          <div className="min-w-[260px] flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-bold text-[var(--color-text-primary)]">pseudo-DeBank 현재 스냅샷</div>
              <div className="font-mono text-[10px] text-[var(--color-text-muted)]">score pending</div>
            </div>
            <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[11px]">
              <MiniMetric label="total" value={fmtUsd(portfolio.totalUsd)} />
              <MiniMetric label="wallet liquid" value={fmtUsd(walletLiquid)} />
              <MiniMetric label="protocol net" value={fmtUsd(portfolio.protocolNetUsd)} />
            </div>
            {portfolio.externalOutflows?.totals && (
              <>
                <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px]">
                  <MiniMetric label="infra out 30d" value={fmtUsd(portfolio.externalOutflows.totals.knownInfraUsd30d)} />
                  <MiniMetric label="cex/bridge 30d" value={fmtUsd(portfolio.externalOutflows.totals.knownCexBridgeUsd30d)} />
                  <MiniMetric label="wallet out 30d" value={fmtUsd(portfolio.externalOutflows.totals.walletUsd30d)} />
                </div>
                <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px]">
                  <MiniMetric label="infra out all" value={fmtUsd(portfolio.externalOutflows.totals.knownInfraUsdAll)} />
                  <MiniMetric label="cex/bridge all" value={fmtUsd(portfolio.externalOutflows.totals.knownCexBridgeUsdAll)} />
                  <MiniMetric label="wallet out all" value={fmtUsd(portfolio.externalOutflows.totals.walletUsdAll)} />
                </div>
              </>
            )}
            {topProtocols.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {topProtocols.map((protocol, idx) => (
                  <span key={`${protocol.protocolName ?? "protocol"}:${idx}`} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                    {protocol.protocolName ?? "protocol"} {fmtUsd(protocol.netUsd ?? protocol.assetUsd)}
                  </span>
                ))}
              </div>
            )}
            {topOutflowRows(portfolio.externalOutflows).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {topOutflowRows(portfolio.externalOutflows).map((row, idx) => (
                  <span key={`${row.category ?? "out"}:${row.counterparty ?? idx}:${row.symbol ?? "TOKEN"}`} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]" title={row.counterparty ?? undefined}>
                    {row.category ?? "out"} {shortAddr(row.counterparty)} {row.symbol ?? "TOKEN"} {fmtUsd(row.valueUsd)}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {markets.length > 0 && (
          <div className="min-w-[520px] flex-[2] rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-bold text-[var(--color-text-primary)]">Morpho borrower risk inputs</div>
              <div className="font-mono text-[10px] text-[var(--color-text-muted)]">final risk score not computed</div>
            </div>
            <div className="mt-1.5 space-y-1.5">
              {markets.map((market) => (
                <div key={market.marketKey ?? market.marketLabel} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-[var(--color-text-muted)]">
                    <span className="font-semibold text-[var(--color-text-primary)]">{market.marketLabel ?? "Morpho market"}</span>
                    <span>borrow {fmtUsd(market.marketBorrowUsd)}</span>
                    <span>util {fmtPct(market.utilization)}</span>
                  </div>
                  <div className="mt-1 grid gap-1">
                    {(market.borrowers ?? []).slice(0, 5).map((borrower, idx) => (
                      <div key={borrower.address ?? `${market.marketKey ?? market.marketLabel}:borrower:${idx}`} className="grid grid-cols-[92px_repeat(8,minmax(0,1fr))] items-center gap-2 font-mono text-[10px] text-[var(--color-text-secondary)]">
                        {borrower.address
                          ? <Link href={`/eoa-flow?address=${borrower.address}&depth=1`} className="truncate text-[var(--color-accent)] hover:underline">{shortAddr(borrower.address)}</Link>
                          : <span className="truncate">{shortAddr(borrower.address)}</span>}
                        <span>debt {fmtUsd(borrower.marketPosition?.borrowUsd)}</span>
                        <span>coll {fmtUsd(borrower.marketPosition?.collateralUsd)}</span>
                        <span>LTV {fmtPct(borrower.riskInputs?.liquidation?.ltv)} / {fmtPct(borrower.riskInputs?.liquidation?.lltv)}</span>
                        <span>buf {fmtPct(borrower.riskInputs?.liquidation?.liquidationBufferPct)}</span>
                        <span>liq/debt {fmtPct(borrower.riskInputs?.liquidity?.availableLiquidToDebt)}</span>
                        <span>infra 30d {fmtUsd(borrower.externalOutflows?.totals?.knownInfraUsd30d)}</span>
                        <span>CEX+bridge 30d {fmtUsd(borrower.externalOutflows?.totals?.knownCexBridgeUsd30d)}</span>
                        <span>EOA/Safe out {fmtUsd(borrower.externalOutflows?.totals?.walletUsd30d)}</span>
                      </div>
                    ))}
                    {!(market.borrowers ?? []).length && <div className="font-mono text-[10px] text-[var(--color-text-muted)]">borrower 없음 또는 필터 결과 없음</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] text-[var(--color-text-muted)]">{label}</div>
      <div className="truncate text-[11px] font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  );
}

function EoaFlowPageInner() {
  const sp = useSearchParams();
  const nameParam = sp.get("name");
  const addressParam = sp.get("address")?.trim() ?? "";
  const viewParam: EoaViewMode = sp.get("view") === "d-inf" ? "d-inf" : "d0";
  const fetchDepth = viewParam === "d-inf" ? (sp.get("depth") && /^\d+$/.test(sp.get("depth") ?? "") ? sp.get("depth")! : "99") : "0";
  const marketParam = sp.get("market") ?? sp.get("marketKey") ?? sp.get("markets") ?? "";
  const symbolParam = sp.get("symbol") ?? "";
  const borrowerParam = sp.get("borrower") ?? "";
  const limitParam = sp.get("limit") ?? "";
  const marketLimitParam = sp.get("marketLimit") ?? "";
  const maxAddressesParam = sp.get("maxAddresses") ?? "";
  const maxNeighborsParam = sp.get("maxNeighbors") ?? "";
  const receiptTransfersParam = sp.get("receiptTransfers") ?? "";
  const includeClusterPortfolioParam = sp.get("includeClusterPortfolio") ?? "";
  const includePortfolioParam = sp.get("includePortfolio") ?? "";
  const includeOutflowsParam = sp.get("includeOutflows") ?? "";
  const includeBorrowerAnalysisParam = sp.get("includeBorrowerAnalysis") ?? "";
  const forceParam = sp.get("force") ?? "";
  const [flows, setFlows] = useState<EoaFlowItem[]>([]);
  const [flowsLoaded, setFlowsLoaded] = useState(false);
  const [payload, setPayload] = useState<EoaFlowPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clusterLoadKey, setClusterLoadKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/eoa-flows", { cache: "no-store" })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`/api/eoa-flows -> ${res.status}`)))
      .then((data: EoaFlowItem[]) => { if (alive) setFlows(Array.isArray(data) ? data : []); })
      .catch(() => { if (alive) setFlows([]); })
      .finally(() => { if (alive) setFlowsLoaded(true); });
    return () => { alive = false; };
  }, []);

  const activeName = useMemo(() => {
    if (addressParam) return null;
    return nameParam ?? bestFlowName(flows);
  }, [addressParam, flows, nameParam]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("view", viewParam);
    params.set("includeWalletClusters", viewParam === "d-inf" ? "true" : "false");
    if (addressParam) {
      params.set("address", addressParam);
      params.set("depth", fetchDepth);
    } else if (activeName) {
      params.set("name", activeName);
    } else if (flowsLoaded) {
      params.set("address", DEFAULT_SEED);
      params.set("depth", fetchDepth);
    }
    if (marketParam) params.set("market", marketParam);
    if (symbolParam) params.set("symbol", symbolParam);
    if (borrowerParam) params.set("borrower", borrowerParam);
    if (limitParam) params.set("limit", limitParam);
    if (marketLimitParam) params.set("marketLimit", marketLimitParam);
    params.set("maxAddresses", maxAddressesParam || (viewParam === "d-inf" ? "20" : "1"));
    params.set("maxNeighbors", maxNeighborsParam || (viewParam === "d-inf" ? "50" : "1"));
    params.set("receiptTransfers", receiptTransfersParam || "none");
    params.set("includeClusterPortfolio", includeClusterPortfolioParam === "true" ? "true" : "false");
    if (includePortfolioParam) params.set("includePortfolio", includePortfolioParam);
    if (includeOutflowsParam) params.set("includeOutflows", includeOutflowsParam);
    if (includeBorrowerAnalysisParam) params.set("includeBorrowerAnalysis", includeBorrowerAnalysisParam);
    if (forceParam) params.set("force", forceParam);
    return params.toString();
  }, [activeName, addressParam, borrowerParam, fetchDepth, flowsLoaded, forceParam, includeBorrowerAnalysisParam, includeClusterPortfolioParam, includeOutflowsParam, includePortfolioParam, limitParam, marketLimitParam, maxAddressesParam, maxNeighborsParam, marketParam, receiptTransfersParam, symbolParam, viewParam]);

  useEffect(() => {
    if (!query) return;
    let alive = true;
    setClusterLoadKey(null);
    setLoading(true);
    setError(null);
    fetch(`/api/eoa-flow?${query}`, { cache: "no-store" })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`/api/eoa-flow -> ${res.status}`)))
      .then((data: EoaFlowPayload) => {
        if (!alive) return;
        setPayload(data);
        if (data.metadata?.error) setError(data.metadata.error);
      })
      .catch((err: Error) => {
        if (!alive) return;
        setPayload(null);
        setError(err.message);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query]);

  const clusterPortfolioQuery = useMemo(() => {
    if (viewParam !== "d-inf" || includeClusterPortfolioParam === "false") return "";
    if (!payload?.walletClusters) return "";
    if (payload.walletClusters.clusterPortfolios?.length || payload.walletClusters.addressPortfolios?.length) return "";
    const params = new URLSearchParams(query);
    params.set("includeClusterPortfolio", "true");
    params.set("includePortfolio", "false");
    params.delete("force");
    return params.toString();
  }, [includeClusterPortfolioParam, payload, query, viewParam]);

  useEffect(() => {
    if (!clusterPortfolioQuery || clusterLoadKey === clusterPortfolioQuery) return;
    let alive = true;
    setClusterLoadKey(clusterPortfolioQuery);
    fetch(`/api/eoa-flow?${clusterPortfolioQuery}`, { cache: "no-store" })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`/api/eoa-flow cluster portfolio -> ${res.status}`)))
      .then((data: EoaFlowPayload) => {
        if (!alive) return;
        setPayload((current) => {
          if (!current) return data;
          if (!data.walletClusters) return current;
          return {
            ...current,
            walletClusters: data.walletClusters,
            metadata: {
              ...current.metadata,
              enrichment: data.metadata?.enrichment ?? current.metadata?.enrichment,
            },
          };
        });
      })
      .catch(() => {
        /* cluster portfolio is optional; keep graph interactive */
      });
    return () => { alive = false; };
  }, [clusterLoadKey, clusterPortfolioQuery]);

  const meta = payload?.metadata ?? {};
  const categoryCounts = meta.category_counts ?? {};
  const activeFlow = activeName ? flows.find((flow) => flow.name === activeName) : null;
  const counts = useMemo(() => graphCounts(payload, viewParam), [payload, viewParam]);

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]">
      <AlertDock />
      <SiteHeader />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 lg:px-5">
        <span className="text-sm font-bold text-[var(--color-text-primary)]">
          EOA 흐름 <span className="text-[11px] font-normal text-[var(--color-text-muted)]">· 지갑/세이프와 프로토콜 사이 semantic trail</span>
        </span>

        <div className="flex max-w-full flex-wrap items-center gap-1.5">
          {flows.map((flow) => {
            const active = !addressParam && flow.name === activeName;
            return (
              <Link
                key={flow.name}
                href={`/eoa-flow?name=${encodeURIComponent(flow.name)}`}
                title={`${flow.addresses} addresses · ${flow.events} events`}
                className={
                  "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors " +
                  (active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                    : "border-[var(--color-border-subtle)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]")
                }
              >
                {flow.label}
                <span className={active ? "ml-1 text-white/75" : "ml-1 text-[var(--color-text-muted)]"}>{flow.events}</span>
              </Link>
            );
          })}
          <Link
            href={`/eoa-flow?address=${KELP_ATTACKER}&view=d-inf&depth=99&maxAddresses=20&maxNeighbors=50&receiptTransfers=none&includePortfolio=false&includeBorrowerAnalysis=false&includeOutflows=true`}
            title="KelpDAO rsETH exploit attacker wallet cluster example"
            className={
              "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors " +
              (addressParam.toLowerCase() === KELP_ATTACKER.toLowerCase()
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-border-subtle)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]")
            }
          >
            Kelp hacker
            <span className={addressParam.toLowerCase() === KELP_ATTACKER.toLowerCase() ? "ml-1 text-white/75" : "ml-1 text-[var(--color-text-muted)]"}>d-inf</span>
          </Link>
        </div>

        <form action="/eoa-flow" className="ml-auto flex min-w-[360px] max-w-full items-center gap-1.5">
          <input
            name="address"
            defaultValue={addressParam}
            placeholder={DEFAULT_SEED}
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-2 font-mono text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />
          <select
            name="view"
            defaultValue={viewParam}
            className="h-8 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-2 font-mono text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="d0">d0</option>
            <option value="d-inf">d-inf</option>
          </select>
          <button type="submit" className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[11px] font-semibold text-white hover:bg-[var(--color-accent-dim)]">
            trace
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 font-mono text-[11px] text-[var(--color-text-muted)] lg:px-5">
        <span className="font-semibold text-[var(--color-text-secondary)]">{addressParam ? `seed ${addressParam.slice(0, 6)}...${addressParam.slice(-4)} ${viewParam}` : `${activeFlow?.label ?? activeName ?? "EOA FLOW"} ${viewParam}`}</span>
        <span>addresses <span className="text-[var(--color-text-secondary)]">{meta.address_count ?? activeFlow?.addresses ?? 0}</span></span>
        <span>events <span className="text-[var(--color-text-secondary)]">{meta.event_count ?? activeFlow?.events ?? payload?.edges?.length ?? 0}</span></span>
        <span>graph nodes <span className="text-[var(--color-text-secondary)]">{payload ? counts.visibleNodes : activeFlow?.nodes ?? 0}</span>{payload && counts.rawNodes !== counts.visibleNodes ? <span> / raw <span className="text-[var(--color-text-secondary)]">{counts.rawNodes}</span></span> : null}</span>
        <span>graph edges <span className="text-[var(--color-text-secondary)]">{payload ? counts.visibleEdges : activeFlow?.edges ?? 0}</span>{payload && counts.rawEdges !== counts.visibleEdges ? <span> / raw <span className="text-[var(--color-text-secondary)]">{counts.rawEdges}</span></span> : null}</span>
        {formatBlockRange(meta) && <span>block <span className="text-[var(--color-text-secondary)]">{formatBlockRange(meta)}</span></span>}
        {meta.generated_at_utc && <span>generated <span className="text-[var(--color-text-secondary)]">{meta.generated_at_utc.replace("T", " ").replace(/Z$/, "")}</span></span>}
        {Object.keys(categoryCounts).length > 0 && (
          <span className="ml-auto flex flex-wrap gap-1 text-[10px]">
            {Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([category, count]) => (
              <span key={category} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-1.5 py-0.5">
                {category} {count}
              </span>
            ))}
          </span>
        )}
      </div>

      {error ? (
        <div className="flex flex-1 items-center justify-center p-12 text-center">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-[var(--color-danger)]">EOA flow를 불러오지 못했습니다</h2>
            <p className="text-sm text-[var(--color-text-muted)]">{error}</p>
          </div>
        </div>
      ) : loading || !payload ? (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
          EOA semantic flow 구성 중...
        </div>
      ) : (
        <>
          <EoaEnrichmentStrip payload={payload} mode={viewParam} />
          <EoaFlowGraph nodes={payload.nodes ?? []} edges={payload.edges ?? []} events={payload.events ?? []} mode={viewParam} walletClusters={payload.walletClusters} />
        </>
      )}
    </div>
  );
}
