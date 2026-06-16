import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import type { EoaAddressPortfolioSummary, EoaClusterPortfolioSummary, EoaFlowPayload, EoaWalletClusterPayload } from "@/lib/eoa-flow-types";
import { normalizeEoaFlowPayload } from "@/lib/eoa-flow-normalize";
import { buildWalletClusters } from "@/lib/wallet-clusters";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_EOA_API = "http://127.0.0.1:8000";
const DEFAULT_FLOW_DIR = "/Users/link/defi-dagggg/graphs/frontend";
const NAME_RE = /^[a-zA-Z0-9._:-]+$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type EnrichmentResult<T> = { value: T | null; ok: boolean; error?: string };
type MiniPortfolio = {
  address?: string;
  totalUsd?: number | null;
  walletTokenUsd?: number | null;
  protocolNetUsd?: number | null;
  walletTokens?: Array<{ tokenAddress?: string | null; symbol?: string | null; amount?: number | null; valueUsd?: number | null; mappedProtocolId?: string | null }>;
  protocols?: Array<{ protocolId?: string | null; protocolName?: string | null; netUsd?: number | null; assetUsd?: number | null; debtUsd?: number | null; positions?: unknown[] }>;
  externalOutflows?: MiniExternalOutflows | null;
  dataGaps?: string[];
};

type MiniOutflowRow = {
  category?: string | null;
  label?: string | null;
  counterparty?: string | null;
  tokenAddress?: string | null;
  symbol?: string | null;
  amount?: number | null;
  valueUsd?: number | null;
  txCount?: number | null;
  firstSeenUtc?: string | null;
  lastSeenUtc?: string | null;
  sampleTx?: string | null;
};

type MiniExternalOutflows = {
  totals?: Partial<Record<OutflowTotalKey, number | null>>;
  cex?: MiniOutflowRow[];
  bridge?: MiniOutflowRow[];
  router?: MiniOutflowRow[];
  solver?: MiniOutflowRow[];
  protocol?: MiniOutflowRow[];
  eoa?: MiniOutflowRow[];
  contract?: MiniOutflowRow[];
  unclassifiedLarge?: MiniOutflowRow[];
  dataGaps?: string[];
};

type OutflowTotalKey =
  | "knownInfraUsd7d"
  | "knownInfraUsd30d"
  | "knownInfraUsdAll"
  | "knownCexBridgeUsd7d"
  | "knownCexBridgeUsd30d"
  | "knownCexBridgeUsdAll"
  | "cexUsd30d"
  | "bridgeUsd30d"
  | "routerUsd30d"
  | "solverUsd30d"
  | "protocolUsd30d"
  | "walletUsd7d"
  | "walletUsd30d"
  | "walletUsdAll"
  | "eoaUsd30d"
  | "contractUsd30d"
  | "largeUnclassifiedUsd30d";

const OUTFLOW_TOTAL_KEYS: OutflowTotalKey[] = [
  "knownInfraUsd7d",
  "knownInfraUsd30d",
  "knownInfraUsdAll",
  "knownCexBridgeUsd7d",
  "knownCexBridgeUsd30d",
  "knownCexBridgeUsdAll",
  "cexUsd30d",
  "bridgeUsd30d",
  "routerUsd30d",
  "solverUsd30d",
  "protocolUsd30d",
  "walletUsd7d",
  "walletUsd30d",
  "walletUsdAll",
  "eoaUsd30d",
  "contractUsd30d",
  "largeUnclassifiedUsd30d",
];

function flowApiBase(): string {
  return (process.env.EOA_FLOW_API_BASE ?? process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_EOA_API).replace(/\/+$/, "");
}

function flowDir(): string {
  return process.env.EOA_FLOW_DIR ?? DEFAULT_FLOW_DIR;
}

function emptyPayload(error: string): EoaFlowPayload {
  return { nodes: [], edges: [], metadata: { view: "eoa_flow", error } };
}

function safeDepth(raw: string | null): string {
  return raw && /^\d+$/.test(raw) ? String(Math.min(99, Number(raw))) : "1";
}

function shortSeedName(address: string, depth: string): string {
  const lower = address.toLowerCase();
  return `seed.${lower.slice(0, 6)}${lower.slice(-4)}.d${depth}`;
}

function candidateFileNames(name: string | null, address: string | null, depth: string): string[] {
  const names: string[] = [];
  if (name && NAME_RE.test(name)) {
    names.push(name.endsWith(".json") ? name : `${name}.json`);
    names.push(name.startsWith("eoa.") ? `${name}.json` : `eoa.${name}.json`);
  }
  if (address && ADDRESS_RE.test(address)) names.push(`eoa.${shortSeedName(address, depth)}.json`);
  return [...new Set(names)];
}

function localPayloadUsable(payload: EoaFlowPayload, depth: string, reqUrl: URL): boolean {
  const requestedDepth = Number(depth);
  const actualDepth = Number(payload.metadata?.dfs?.depth ?? -1);
  if (Number.isFinite(requestedDepth) && requestedDepth > 0 && actualDepth < requestedDepth) return false;
  const requestedReceipt = reqUrl.searchParams.get("receiptTransfers");
  if (requestedReceipt && payload.metadata?.receipt_transfers !== requestedReceipt) return false;
  const requestedMaxAddresses = Number(reqUrl.searchParams.get("maxAddresses") ?? 0);
  const actualAddresses = Number(payload.metadata?.address_count ?? payload.nodes?.length ?? 0);
  if (requestedMaxAddresses > 0 && actualAddresses < Math.min(requestedMaxAddresses, 20) && requestedDepth > 1) return false;
  return true;
}

async function readLocalPayload(name: string | null, address: string | null, depth: string, reqUrl: URL): Promise<EoaFlowPayload | null> {
  if (address && (reqUrl.searchParams.get("force") === "true" || reqUrl.searchParams.get("force") === "1")) return null;
  const dir = flowDir();
  for (const fileName of candidateFileNames(name, address, depth)) {
    if (!NAME_RE.test(fileName.replace(/\.json$/, ""))) continue;
    try {
      const raw = await readFile(path.join(dir, fileName), "utf8");
      const payload = JSON.parse(raw) as EoaFlowPayload;
      if (!address || localPayloadUsable(payload, depth, reqUrl)) return payload;
    } catch {
      /* try next candidate */
    }
  }

  if (!name && !address) {
    try {
      const entries = await readdir(dir);
      const files = entries.filter((entry) => /^eoa\..+\.json$/.test(entry)).sort();
      let best: EoaFlowPayload | null = null;
      let bestEvents = -1;
      for (const file of files) {
        try {
          const payload = JSON.parse(await readFile(path.join(dir, file), "utf8")) as EoaFlowPayload;
          const events = payload.metadata?.event_count ?? payload.edges?.reduce((sum, edge) => sum + (edge.event_count ?? edge.details?.length ?? 0), 0) ?? 0;
          if (events > bestEvents) {
            best = payload;
            bestEvents = events;
          }
        } catch {
          /* skip bad local graph */
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  return null;
}

function safeIntParam(raw: string | null, fallback: string, max: number): string {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return String(Math.max(1, Math.min(max, Number(raw))));
}

async function fetchUpstreamPayload(name: string | null, address: string | null, depth: string, reqUrl: URL): Promise<EoaFlowPayload | null> {
  const params = new URLSearchParams();
  if (address) {
    params.set("address", address);
    params.set("depth", depth);
    params.set("maxAddresses", safeIntParam(reqUrl.searchParams.get("maxAddresses"), depth === "0" ? "1" : "20", 300));
    params.set("maxNeighbors", safeIntParam(reqUrl.searchParams.get("maxNeighbors"), depth === "0" ? "1" : "50", 100));
    params.set("receiptTransfers", reqUrl.searchParams.get("receiptTransfers") ?? "none");
    if (reqUrl.searchParams.get("force") === "true" || reqUrl.searchParams.get("force") === "1") params.set("force", "1");
  } else if (name) {
    params.set("name", name);
  }

  try {
    const timeoutMs = Number(depth) > 1 ? 300_000 : 30_000;
    const res = await fetch(`${flowApiBase()}/api/eoa-flow?${params.toString()}`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const payload = await res.json() as EoaFlowPayload;
    if ((payload.nodes?.length ?? 0) === 0 && payload.metadata?.error) return null;
    return payload;
  } catch {
    return null;
  }
}

function seedAddress(payload: EoaFlowPayload, requested: string | null): string | null {
  if (requested && ADDRESS_RE.test(requested)) return requested.toLowerCase();
  const seed = payload.nodes.find((node) =>
    (node.data.kind === "eoa" || node.data.kind === "safe" || node.type === "eoa") &&
    ADDRESS_RE.test(node.data.address ?? "") &&
    (node.data.discovered_by === "seed" || (node.data.dfs_depth ?? 0) === 0),
  ) ?? payload.nodes.find((node) =>
    (node.data.kind === "eoa" || node.data.kind === "safe" || node.type === "eoa") &&
    ADDRESS_RE.test(node.data.address ?? ""),
  );
  return seed?.data.address?.toLowerCase() ?? null;
}

async function fetchEnrichment<T>(source: URL | (() => Promise<T>), timeoutMs: number): Promise<EnrichmentResult<T>> {
  try {
    if (typeof source === "function") return { value: await source(), ok: true };
    const res = await fetch(source, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { value: null, ok: false, error: `HTTP ${res.status}` };
    return { value: (await res.json()) as T, ok: true };
  } catch (error) {
    return { value: null, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function disabledEnrichment<T>(): EnrichmentResult<T> {
  return { value: null, ok: true };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addNullable(a: number | null, b: unknown): number | null {
  const n = finiteOrNull(b);
  if (n == null) return a;
  return (a ?? 0) + n;
}

function emptyOutflowTotals(): Record<OutflowTotalKey, number> {
  return Object.fromEntries(OUTFLOW_TOTAL_KEYS.map((key) => [key, 0])) as Record<OutflowTotalKey, number>;
}

function addOutflowRows(
  map: Map<string, MiniOutflowRow & { addressSet: Set<string>; txCount: number; amount: number | null; valueUsd: number | null }>,
  address: string,
  rows: MiniOutflowRow[] | undefined,
) {
  for (const row of rows ?? []) {
    const category = row.category || "unknown";
    const counterparty = row.counterparty?.toLowerCase();
    if (!counterparty) continue;
    const symbol = row.symbol || row.tokenAddress?.slice(0, 8) || "TOKEN";
    const key = `${category}:${counterparty}:${row.tokenAddress?.toLowerCase() ?? "native"}:${symbol}`;
    const cur = map.get(key) ?? {
      category,
      label: row.label || category,
      counterparty,
      tokenAddress: row.tokenAddress ?? null,
      symbol,
      amount: null,
      valueUsd: null,
      txCount: 0,
      firstSeenUtc: row.firstSeenUtc ?? null,
      lastSeenUtc: row.lastSeenUtc ?? null,
      sampleTx: row.sampleTx ?? null,
      addressSet: new Set<string>(),
    };
    cur.amount = addNullable(cur.amount, row.amount);
    cur.valueUsd = addNullable(cur.valueUsd, row.valueUsd);
    cur.txCount += typeof row.txCount === "number" && Number.isFinite(row.txCount) ? row.txCount : 0;
    if (row.firstSeenUtc && (!cur.firstSeenUtc || row.firstSeenUtc < cur.firstSeenUtc)) cur.firstSeenUtc = row.firstSeenUtc;
    if (row.lastSeenUtc && (!cur.lastSeenUtc || row.lastSeenUtc > cur.lastSeenUtc)) cur.lastSeenUtc = row.lastSeenUtc;
    if (!cur.sampleTx && row.sampleTx) cur.sampleTx = row.sampleTx;
    cur.addressSet.add(address);
    map.set(key, cur);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R | null>): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const value = await fn(items[index]);
      if (value != null) out.push(value);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchMiniPortfolio(origin: string, address: string, reqUrl: URL): Promise<MiniPortfolio | null> {
  const url = new URL("/api/wallet-portfolio", origin);
  url.searchParams.set("address", address);
  url.searchParams.set("chain", "ethereum");
  url.searchParams.set("includeFlow", "false");
  url.searchParams.set("minUsd", reqUrl.searchParams.get("clusterPortfolioMinUsd") ?? "1");
  url.searchParams.set("maxTokens", reqUrl.searchParams.get("clusterPortfolioMaxTokens") ?? "220");
  url.searchParams.set("includeOutflows", reqUrl.searchParams.get("includeOutflows") ?? "true");
  url.searchParams.set("outflowOffset", reqUrl.searchParams.get("outflowOffset") ?? "500");
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(50_000) });
  if (!res.ok) return null;
  return (await res.json()) as MiniPortfolio;
}

function aggregatePortfolio(clusterId: string, label: string, addresses: string[], portfolios: MiniPortfolio[], capped: boolean): EoaClusterPortfolioSummary {
  const tokenMap = new Map<string, { tokenAddress?: string | null; symbol: string; amount: number | null; valueUsd: number | null; addresses: Set<string> }>();
  const protocolMap = new Map<string, { protocolId: string; protocolName: string; netUsd: number | null; assetUsd: number | null; debtUsd: number | null; addresses: Set<string>; positionCount: number }>();
  const outflowTotals = emptyOutflowTotals();
  const outflowRows = new Map<string, MiniOutflowRow & { addressSet: Set<string>; txCount: number; amount: number | null; valueUsd: number | null }>();
  const dataGaps = new Set<string>();
  let totalUsd: number | null = null;
  let walletTokenUsd: number | null = null;
  let protocolNetUsd: number | null = null;

  for (const portfolio of portfolios) {
    const address = portfolio.address?.toLowerCase() ?? "";
    totalUsd = addNullable(totalUsd, portfolio.totalUsd);
    walletTokenUsd = addNullable(walletTokenUsd, portfolio.walletTokenUsd);
    protocolNetUsd = addNullable(protocolNetUsd, portfolio.protocolNetUsd);
    for (const gap of portfolio.dataGaps ?? []) dataGaps.add(gap);

    for (const token of portfolio.walletTokens ?? []) {
      if (token.mappedProtocolId) continue;
      const symbol = token.symbol || token.tokenAddress?.slice(0, 8) || "TOKEN";
      const key = `${token.tokenAddress?.toLowerCase() ?? "native"}:${symbol}`;
      const row = tokenMap.get(key) ?? { tokenAddress: token.tokenAddress ?? null, symbol, amount: null, valueUsd: null, addresses: new Set<string>() };
      row.amount = addNullable(row.amount, token.amount);
      row.valueUsd = addNullable(row.valueUsd, token.valueUsd);
      if (address) row.addresses.add(address);
      tokenMap.set(key, row);
    }

    for (const protocol of portfolio.protocols ?? []) {
      const protocolId = protocol.protocolId || protocol.protocolName || "unknown";
      const key = protocolId.toLowerCase();
      const row = protocolMap.get(key) ?? {
        protocolId,
        protocolName: protocol.protocolName || protocolId,
        netUsd: null,
        assetUsd: null,
        debtUsd: null,
        addresses: new Set<string>(),
        positionCount: 0,
      };
      row.netUsd = addNullable(row.netUsd, protocol.netUsd);
      row.assetUsd = addNullable(row.assetUsd, protocol.assetUsd);
      row.debtUsd = addNullable(row.debtUsd, protocol.debtUsd);
      row.positionCount += Array.isArray(protocol.positions) ? protocol.positions.length : 0;
      if (address) row.addresses.add(address);
      protocolMap.set(key, row);
    }

    const outflows = portfolio.externalOutflows;
    if (outflows) {
      for (const key of OUTFLOW_TOTAL_KEYS) {
        const value = finiteOrNull(outflows.totals?.[key]);
        if (value != null) outflowTotals[key] += value;
      }
      for (const gap of outflows.dataGaps ?? []) dataGaps.add(gap);
      addOutflowRows(outflowRows, address, outflows.cex);
      addOutflowRows(outflowRows, address, outflows.bridge);
      addOutflowRows(outflowRows, address, outflows.router);
      addOutflowRows(outflowRows, address, outflows.solver);
      addOutflowRows(outflowRows, address, outflows.protocol);
      addOutflowRows(outflowRows, address, outflows.eoa);
      addOutflowRows(outflowRows, address, outflows.contract);
      addOutflowRows(outflowRows, address, outflows.unclassifiedLarge);
    }
  }

  if (capped) dataGaps.add("cluster_portfolio_address_cap_applied");
  if (portfolios.length < addresses.length) dataGaps.add("cluster_portfolio_partial_fetch");
  const topCounterparties = [...outflowRows.values()]
    .filter((row) => (row.valueUsd ?? 0) > 0)
    .sort((a, b) => Math.abs(b.valueUsd ?? 0) - Math.abs(a.valueUsd ?? 0) || b.txCount - a.txCount)
    .slice(0, 16)
    .map((row) => ({
      category: row.category ?? "unknown",
      label: row.label ?? row.category ?? "unknown",
      counterparty: row.counterparty ?? "",
      tokenAddress: row.tokenAddress ?? null,
      symbol: row.symbol ?? "TOKEN",
      amount: row.amount,
      valueUsd: row.valueUsd,
      txCount: row.txCount,
      addressCount: row.addressSet.size,
      firstSeenUtc: row.firstSeenUtc ?? null,
      lastSeenUtc: row.lastSeenUtc ?? null,
      sampleTx: row.sampleTx ?? null,
    }));

  return {
    clusterId,
    label,
    addressCount: addresses.length,
    sampledAddressCount: portfolios.length,
    totalUsd,
    walletTokenUsd,
    protocolNetUsd,
    topWalletTokens: [...tokenMap.values()]
      .sort((a, b) => Math.abs(b.valueUsd ?? 0) - Math.abs(a.valueUsd ?? 0))
      .slice(0, 12)
      .map((row) => ({ tokenAddress: row.tokenAddress, symbol: row.symbol, amount: row.amount, valueUsd: row.valueUsd, addressCount: row.addresses.size })),
    topProtocols: [...protocolMap.values()]
      .sort((a, b) => Math.abs(b.netUsd ?? b.assetUsd ?? 0) - Math.abs(a.netUsd ?? a.assetUsd ?? 0))
      .slice(0, 12)
      .map((row) => ({ protocolId: row.protocolId, protocolName: row.protocolName, netUsd: row.netUsd, assetUsd: row.assetUsd, debtUsd: row.debtUsd, addressCount: row.addresses.size, positionCount: row.positionCount })),
    externalOutflows: {
      totals: outflowTotals,
      topCounterparties,
    },
    dataGaps: [...dataGaps],
  };
}

function summarizeMiniPortfolio(portfolio: MiniPortfolio): EoaAddressPortfolioSummary | null {
  const address = portfolio.address?.toLowerCase();
  if (!address || !ADDRESS_RE.test(address)) return null;
  const outflowTotals = emptyOutflowTotals();
  const outflows = portfolio.externalOutflows;
  if (outflows) {
    for (const key of OUTFLOW_TOTAL_KEYS) {
      const value = finiteOrNull(outflows.totals?.[key]);
      if (value != null) outflowTotals[key] = value;
    }
  }
  const outflowRows = [
    ...(outflows?.cex ?? []),
    ...(outflows?.bridge ?? []),
    ...(outflows?.router ?? []),
    ...(outflows?.solver ?? []),
    ...(outflows?.protocol ?? []),
    ...(outflows?.eoa ?? []),
    ...(outflows?.contract ?? []),
    ...(outflows?.unclassifiedLarge ?? []),
  ]
    .filter((row) => row.counterparty || row.label)
    .filter((row) => (row.valueUsd ?? 0) > 0)
    .sort((a, b) => Math.abs(b.valueUsd ?? 0) - Math.abs(a.valueUsd ?? 0) || (b.txCount ?? 0) - (a.txCount ?? 0))
    .slice(0, 12)
    .map((row) => ({
      category: row.category ?? "unknown",
      label: row.label ?? row.category ?? "unknown",
      counterparty: row.counterparty ?? "",
      tokenAddress: row.tokenAddress ?? null,
      symbol: row.symbol ?? "TOKEN",
      amount: row.amount ?? null,
      valueUsd: row.valueUsd ?? null,
      txCount: row.txCount ?? 0,
      addressCount: 1,
      firstSeenUtc: row.firstSeenUtc ?? null,
      lastSeenUtc: row.lastSeenUtc ?? null,
      sampleTx: row.sampleTx ?? null,
    }));

  return {
    address,
    totalUsd: finiteOrNull(portfolio.totalUsd),
    walletTokenUsd: finiteOrNull(portfolio.walletTokenUsd),
    protocolNetUsd: finiteOrNull(portfolio.protocolNetUsd),
    topWalletTokens: (portfolio.walletTokens ?? [])
      .filter((token) => !token.mappedProtocolId)
      .sort((a, b) => Math.abs(b.valueUsd ?? 0) - Math.abs(a.valueUsd ?? 0))
      .slice(0, 12)
      .map((token) => ({
        tokenAddress: token.tokenAddress ?? null,
        symbol: token.symbol ?? token.tokenAddress?.slice(0, 8) ?? "TOKEN",
        amount: finiteOrNull(token.amount),
        valueUsd: finiteOrNull(token.valueUsd),
      })),
    topProtocols: (portfolio.protocols ?? [])
      .sort((a, b) => Math.abs(b.netUsd ?? b.assetUsd ?? 0) - Math.abs(a.netUsd ?? a.assetUsd ?? 0))
      .slice(0, 12)
      .map((protocol) => ({
        protocolId: protocol.protocolId ?? protocol.protocolName ?? "unknown",
        protocolName: protocol.protocolName ?? protocol.protocolId ?? "unknown",
        netUsd: finiteOrNull(protocol.netUsd),
        assetUsd: finiteOrNull(protocol.assetUsd),
        debtUsd: finiteOrNull(protocol.debtUsd),
        positionCount: Array.isArray(protocol.positions) ? protocol.positions.length : 0,
      })),
    externalOutflows: outflows ? {
      totals: outflowTotals,
      topCounterparties: outflowRows,
    } : undefined,
    dataGaps: [...new Set([...(portfolio.dataGaps ?? []), ...(outflows?.dataGaps ?? [])])],
  };
}

async function enrichClusterPortfolios(clusters: EoaWalletClusterPayload, reqUrl: URL): Promise<EoaWalletClusterPayload> {
  if (reqUrl.searchParams.get("includeClusterPortfolio") !== "true") return clusters;
  const addressCap = Math.max(1, Math.min(120, Number(reqUrl.searchParams.get("clusterPortfolioMaxAddresses") ?? 40)));
  const allAddresses = [...new Set(clusters.addresses.map((row) => row.address.toLowerCase()))];
  const portfolioByAddress = new Map<string, MiniPortfolio>();
  const priority: string[] = [];
  for (const cluster of clusters.clusters) {
    if (cluster.hasSeed || cluster.size > 1) {
      for (const address of cluster.addresses) priority.push(address.toLowerCase());
    }
  }
  priority.push(...allAddresses);
  const fetchAddresses = [...new Set(priority)].slice(0, addressCap);
  const portfolios = await mapLimit(fetchAddresses, 4, async (address) => {
    const portfolio = await fetchMiniPortfolio(reqUrl.origin, address, reqUrl).catch(() => null);
    if (portfolio) portfolioByAddress.set(address, portfolio);
    return portfolio;
  });
  void portfolios;

  const summaries: EoaClusterPortfolioSummary[] = [];
  summaries.push(aggregatePortfolio(
    "wallet-cluster:all",
    "all discovered wallets",
    allAddresses,
    fetchAddresses.map((address) => portfolioByAddress.get(address)).filter((row): row is MiniPortfolio => !!row),
    allAddresses.length > addressCap,
  ));
  for (const cluster of clusters.clusters.filter((row) => row.hasSeed || row.size > 1).slice(0, 12)) {
    const addresses = cluster.addresses.map((address) => address.toLowerCase());
    summaries.push(aggregatePortfolio(
      cluster.id,
      cluster.hasSeed ? "seed cluster" : cluster.id,
      addresses,
      addresses.slice(0, addressCap).map((address) => portfolioByAddress.get(address)).filter((row): row is MiniPortfolio => !!row),
      addresses.length > addressCap,
    ));
  }
  return {
    ...clusters,
    clusterPortfolios: summaries,
    addressPortfolios: fetchAddresses
      .map((address) => portfolioByAddress.get(address))
      .filter((row): row is MiniPortfolio => !!row)
      .map(summarizeMiniPortfolio)
      .filter((row): row is EoaAddressPortfolioSummary => !!row),
    sources: [
      ...(clusters.sources ?? []),
      { source: "wallet-portfolio:cluster-aggregate", ok: true, detail: { requestedAddresses: fetchAddresses.length, addressCap } },
    ],
  };
}

async function enrichPayload(payload: EoaFlowPayload, reqUrl: URL, address: string | null): Promise<EoaFlowPayload> {
  const includePortfolio = reqUrl.searchParams.get("includePortfolio") !== "false";
  const includeBorrowerAnalysis = reqUrl.searchParams.get("includeBorrowerAnalysis") !== "false";
  const includeWalletClusters = reqUrl.searchParams.get("includeWalletClusters") !== "false";
  const seed = seedAddress(payload, address);
  const portfolioUrl = seed && includePortfolio ? new URL("/api/wallet-portfolio", reqUrl.origin) : null;
  if (portfolioUrl && seed) {
    portfolioUrl.searchParams.set("address", seed);
    portfolioUrl.searchParams.set("chain", "ethereum");
    portfolioUrl.searchParams.set("includeFlow", "false");
    portfolioUrl.searchParams.set("minUsd", reqUrl.searchParams.get("portfolioMinUsd") ?? "1");
    portfolioUrl.searchParams.set("maxTokens", reqUrl.searchParams.get("portfolioMaxTokens") ?? "220");
    portfolioUrl.searchParams.set("includeOutflows", reqUrl.searchParams.get("includeOutflows") ?? "true");
    portfolioUrl.searchParams.set("outflowOffset", reqUrl.searchParams.get("outflowOffset") ?? "500");
  }

  const morphoParam = reqUrl.searchParams.get("market") ?? reqUrl.searchParams.get("marketKey") ?? reqUrl.searchParams.get("markets");
  const symbolParam = reqUrl.searchParams.get("symbol");
  const wantsMorphoAnalysis = includeBorrowerAnalysis && (!!morphoParam || !!symbolParam);
  const morphoUrl = wantsMorphoAnalysis ? new URL("/api/morpho-borrower-analysis", reqUrl.origin) : null;
  if (morphoUrl) {
    for (const key of ["market", "marketKey", "markets", "symbol", "borrower", "limit", "marketLimit", "minUsd", "outflowOffset", "includePortfolio", "includeOutflows"]) {
      const value = reqUrl.searchParams.get(key);
      if (value) morphoUrl.searchParams.set(key, value);
    }
  }

  const [portfolio, morpho, rawWalletClusters] = await Promise.all([
    portfolioUrl ? fetchEnrichment<unknown>(portfolioUrl, 35_000) : Promise.resolve(disabledEnrichment<unknown>()),
    morphoUrl ? fetchEnrichment<unknown>(morphoUrl, 60_000) : Promise.resolve(disabledEnrichment<unknown>()),
    includeWalletClusters
      ? fetchEnrichment<EoaWalletClusterPayload>(() => buildWalletClusters(payload), 30_000)
      : Promise.resolve(disabledEnrichment<EoaWalletClusterPayload>()),
  ]);
  const walletClusters = rawWalletClusters.value
    ? await fetchEnrichment<EoaWalletClusterPayload>(() => enrichClusterPortfolios(rawWalletClusters.value!, reqUrl), 60_000)
    : rawWalletClusters;

  if (!portfolio.value && !morpho.value && !walletClusters.value) {
    if (portfolio.ok && morpho.ok && walletClusters.ok) return payload;
  }

  return {
    ...payload,
    ...(portfolio.value ? { pseudoDebank: portfolio.value } : {}),
    ...(morpho.value ? { morphoBorrowerAnalysis: morpho.value } : {}),
    ...(walletClusters.value ? { walletClusters: walletClusters.value } : {}),
    metadata: {
      ...payload.metadata,
      enrichment: {
        pseudoDebank: portfolioUrl ? { ok: portfolio.ok, error: portfolio.error ?? null, seed } : { ok: false, error: "disabled_or_no_seed", seed },
        morphoBorrowerAnalysis: morphoUrl ? { ok: morpho.ok, error: morpho.error ?? null } : { ok: false, error: "not_requested" },
        walletClusters: includeWalletClusters ? { ok: walletClusters.ok, error: walletClusters.error ?? null } : { ok: false, error: "disabled" },
      },
    },
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  const address = url.searchParams.get("address")?.trim() ?? null;
  const depth = safeDepth(url.searchParams.get("depth"));

  if (name && !NAME_RE.test(name)) return NextResponse.json(emptyPayload("invalid eoa-flow name"), { status: 400 });
  if (address && !ADDRESS_RE.test(address)) return NextResponse.json(emptyPayload("invalid ethereum address"), { status: 400 });

  const upstream = await fetchUpstreamPayload(name, address, depth, url);
  if (upstream) return NextResponse.json(await enrichPayload(await normalizeEoaFlowPayload(upstream), url, address));

  const local = await readLocalPayload(name, address, depth, url);
  if (local) return NextResponse.json(await enrichPayload(await normalizeEoaFlowPayload(local), url, address));

  return NextResponse.json(emptyPayload("no eoa-flow graph found"), { status: 404 });
}
