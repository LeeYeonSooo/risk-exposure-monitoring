"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AlertDock } from "@/components/AlertDock";
import { SiteHeader } from "@/components/SiteHeader";
import { EoaFlowGraph } from "@/components/eoa-flow/EoaFlowGraph";
import type { EoaFlowItem, EoaFlowMetadata, EoaFlowPayload } from "@/lib/eoa-flow-types";

const DEFAULT_SEED = "0x325228217e02e31529bf4bc6e32db695ea525669";

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

function graphCounts(payload: EoaFlowPayload | null): { visibleNodes: number; rawNodes: number; visibleEdges: number; rawEdges: number } {
  if (!payload) return { visibleNodes: 0, rawNodes: 0, visibleEdges: 0, rawEdges: 0 };
  const rawNodes = payload.nodes.filter((node) => node.type !== "event" && node.data.kind !== "event");
  const byId = new Map(rawNodes.map((node) => [node.id, node] as const));
  const isWalletNode = (node: (typeof rawNodes)[number]) => node.type === "eoa" || node.data.kind === "eoa" || node.data.kind === "safe";
  const isWallet = (id: string) => {
    const node = byId.get(id);
    return !!node && isWalletNode(node);
  };
  const seedWallet = rawNodes.find((node) => isWalletNode(node) && (node.data.discovered_by === "seed" || (node.data.dfs_depth ?? 0) === 0)) ?? rawNodes.find(isWalletNode) ?? null;
  const visibleNodeIds = new Set(rawNodes.filter((node) => !isWalletNode(node) || node.id === seedWallet?.id).map((node) => node.id));
  const visibleEdges = payload.edges.filter((edge) =>
    byId.has(edge.source) && byId.has(edge.target) && !(isWallet(edge.source) && isWallet(edge.target)) &&
    (!isWallet(edge.source) || edge.source === seedWallet?.id) &&
    (!isWallet(edge.target) || edge.target === seedWallet?.id) &&
    visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  ).length;
  return { visibleNodes: visibleNodeIds.size, rawNodes: rawNodes.length, visibleEdges, rawEdges: payload.edges.length };
}

function EoaFlowPageInner() {
  const sp = useSearchParams();
  const nameParam = sp.get("name");
  const addressParam = sp.get("address")?.trim() ?? "";
  const depthParam = sp.get("depth") && /^\d+$/.test(sp.get("depth") ?? "") ? sp.get("depth")! : "1";
  const [flows, setFlows] = useState<EoaFlowItem[]>([]);
  const [flowsLoaded, setFlowsLoaded] = useState(false);
  const [payload, setPayload] = useState<EoaFlowPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    if (addressParam) {
      params.set("address", addressParam);
      params.set("depth", depthParam);
    } else if (activeName) {
      params.set("name", activeName);
    } else if (flowsLoaded) {
      params.set("address", DEFAULT_SEED);
      params.set("depth", "1");
    }
    return params.toString();
  }, [activeName, addressParam, depthParam, flowsLoaded]);

  useEffect(() => {
    if (!query) return;
    let alive = true;
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

  const meta = payload?.metadata ?? {};
  const categoryCounts = meta.category_counts ?? {};
  const activeFlow = activeName ? flows.find((flow) => flow.name === activeName) : null;
  const counts = useMemo(() => graphCounts(payload), [payload]);

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
        </div>

        <form action="/eoa-flow" className="ml-auto flex min-w-[360px] max-w-full items-center gap-1.5">
          <input
            name="address"
            defaultValue={addressParam}
            placeholder={DEFAULT_SEED}
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-2 font-mono text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />
          <select
            name="depth"
            defaultValue={depthParam}
            className="h-8 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-2 font-mono text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="0">d0</option>
            <option value="1">d1</option>
            <option value="2">d2</option>
          </select>
          <button type="submit" className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[11px] font-semibold text-white hover:bg-[var(--color-accent-dim)]">
            trace
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 font-mono text-[11px] text-[var(--color-text-muted)] lg:px-5">
        <span className="font-semibold text-[var(--color-text-secondary)]">{addressParam ? `seed ${addressParam.slice(0, 6)}...${addressParam.slice(-4)} d${depthParam}` : activeFlow?.label ?? activeName ?? "EOA FLOW"}</span>
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
        <EoaFlowGraph nodes={payload.nodes ?? []} edges={payload.edges ?? []} />
      )}
    </div>
  );
}
