import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import type { EoaFlowPayload } from "@/lib/eoa-flow-types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_EOA_API = "http://127.0.0.1:8000";
const DEFAULT_FLOW_DIR = "/Users/link/defi-dagggg/graphs/frontend";
const NAME_RE = /^[a-zA-Z0-9._:-]+$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type EnrichmentResult<T> = { value: T | null; ok: boolean; error?: string };

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
  return raw && /^\d+$/.test(raw) ? String(Math.min(3, Number(raw))) : "1";
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

async function readLocalPayload(name: string | null, address: string | null, depth: string): Promise<EoaFlowPayload | null> {
  const dir = flowDir();
  for (const fileName of candidateFileNames(name, address, depth)) {
    if (!NAME_RE.test(fileName.replace(/\.json$/, ""))) continue;
    try {
      const raw = await readFile(path.join(dir, fileName), "utf8");
      return JSON.parse(raw) as EoaFlowPayload;
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

async function fetchUpstreamPayload(name: string | null, address: string | null, depth: string): Promise<EoaFlowPayload | null> {
  const params = new URLSearchParams();
  if (address) {
    params.set("address", address);
    params.set("depth", depth);
  } else if (name) {
    params.set("name", name);
  }

  try {
    const res = await fetch(`${flowApiBase()}/api/eoa-flow?${params.toString()}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
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

async function fetchEnrichment<T>(url: URL, timeoutMs: number): Promise<EnrichmentResult<T>> {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { value: null, ok: false, error: `HTTP ${res.status}` };
    return { value: (await res.json()) as T, ok: true };
  } catch (error) {
    return { value: null, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function disabledEnrichment<T>(): EnrichmentResult<T> {
  return { value: null, ok: true };
}

async function enrichPayload(payload: EoaFlowPayload, reqUrl: URL, address: string | null): Promise<EoaFlowPayload> {
  const includePortfolio = reqUrl.searchParams.get("includePortfolio") !== "false";
  const includeBorrowerAnalysis = reqUrl.searchParams.get("includeBorrowerAnalysis") !== "false";
  const seed = seedAddress(payload, address);
  const portfolioUrl = seed && includePortfolio ? new URL("/api/wallet-portfolio", reqUrl.origin) : null;
  if (portfolioUrl && seed) {
    portfolioUrl.searchParams.set("address", seed);
    portfolioUrl.searchParams.set("chain", "ethereum");
    portfolioUrl.searchParams.set("includeFlow", "false");
    portfolioUrl.searchParams.set("minUsd", reqUrl.searchParams.get("portfolioMinUsd") ?? "1");
    portfolioUrl.searchParams.set("maxTokens", reqUrl.searchParams.get("portfolioMaxTokens") ?? "220");
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

  const [portfolio, morpho] = await Promise.all([
    portfolioUrl ? fetchEnrichment<unknown>(portfolioUrl, 35_000) : Promise.resolve(disabledEnrichment<unknown>()),
    morphoUrl ? fetchEnrichment<unknown>(morphoUrl, 60_000) : Promise.resolve(disabledEnrichment<unknown>()),
  ]);

  if (!portfolio.value && !morpho.value) {
    if (portfolio.ok && morpho.ok) return payload;
  }

  return {
    ...payload,
    ...(portfolio.value ? { pseudoDebank: portfolio.value } : {}),
    ...(morpho.value ? { morphoBorrowerAnalysis: morpho.value } : {}),
    metadata: {
      ...payload.metadata,
      enrichment: {
        pseudoDebank: portfolioUrl ? { ok: portfolio.ok, error: portfolio.error ?? null, seed } : { ok: false, error: "disabled_or_no_seed", seed },
        morphoBorrowerAnalysis: morphoUrl ? { ok: morpho.ok, error: morpho.error ?? null } : { ok: false, error: "not_requested" },
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

  const upstream = await fetchUpstreamPayload(name, address, depth);
  if (upstream) return NextResponse.json(await enrichPayload(upstream, url, address));

  const local = await readLocalPayload(name, address, depth);
  if (local) return NextResponse.json(await enrichPayload(local, url, address));

  return NextResponse.json(emptyPayload("no eoa-flow graph found"), { status: 404 });
}
