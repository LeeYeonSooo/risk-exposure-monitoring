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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  const address = url.searchParams.get("address")?.trim() ?? null;
  const depth = safeDepth(url.searchParams.get("depth"));

  if (name && !NAME_RE.test(name)) return NextResponse.json(emptyPayload("invalid eoa-flow name"), { status: 400 });
  if (address && !ADDRESS_RE.test(address)) return NextResponse.json(emptyPayload("invalid ethereum address"), { status: 400 });

  const upstream = await fetchUpstreamPayload(name, address, depth);
  if (upstream) return NextResponse.json(upstream);

  const local = await readLocalPayload(name, address, depth);
  if (local) return NextResponse.json(local);

  return NextResponse.json(emptyPayload("no eoa-flow graph found"), { status: 404 });
}
