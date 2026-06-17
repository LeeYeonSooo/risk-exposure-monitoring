import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import type { EoaFlowItem, EoaFlowPayload } from "@/lib/eoa-flow-types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_EOA_API = "http://127.0.0.1:8000";
const DEFAULT_FLOW_DIR = "/Users/link/defi-dagggg/graphs/frontend";

function flowApiBase(): string {
  return (process.env.EOA_FLOW_API_BASE ?? process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_EOA_API).replace(/\/+$/, "");
}

function flowDir(): string {
  return process.env.EOA_FLOW_DIR ?? DEFAULT_FLOW_DIR;
}

async function fetchUpstreamList(): Promise<EoaFlowItem[] | null> {
  try {
    const res = await fetch(`${flowApiBase()}/api/eoa-flows`, { cache: "no-store", signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as EoaFlowItem[] : null;
  } catch {
    return null;
  }
}

function itemFromPayload(fileName: string, payload: EoaFlowPayload): EoaFlowItem {
  const name = fileName.replace(/^eoa\./, "").replace(/\.json$/, "");
  return {
    name,
    label: name,
    nodes: payload.nodes?.length ?? 0,
    edges: payload.edges?.length ?? 0,
    events: payload.metadata?.event_count ?? payload.edges?.reduce((sum, edge) => sum + (edge.event_count ?? edge.details?.length ?? 0), 0) ?? 0,
    addresses: payload.metadata?.address_count ?? payload.nodes?.filter((node) => node.type === "eoa").length ?? 0,
    from_block: payload.metadata?.from_block,
    to_block: payload.metadata?.to_block,
  };
}

async function readLocalList(): Promise<EoaFlowItem[]> {
  try {
    const entries = await readdir(flowDir());
    const files = entries.filter((name) => /^eoa\..+\.json$/.test(name)).sort();
    const rows = await Promise.all(files.map(async (fileName) => {
      try {
        const raw = await readFile(path.join(flowDir(), fileName), "utf8");
        return itemFromPayload(fileName, JSON.parse(raw) as EoaFlowPayload);
      } catch {
        return null;
      }
    }));
    return rows
      .filter((row): row is EoaFlowItem => !!row)
      .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function GET() {
  const upstream = await fetchUpstreamList();
  if (upstream?.length) return NextResponse.json(upstream);

  return NextResponse.json(await readLocalList());
}
