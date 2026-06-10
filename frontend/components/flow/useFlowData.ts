"use client";

import { useEffect, useMemo, useState } from "react";

import type { FlowGraph as FlowGraphData, FlowTx } from "@/lib/flow-types";

/**
 * Flow data fetching for the 흐름맵 (transaction flow). Fetches the relationship graph, then
 * the near-real-time (≈1 min) real transfer feed using the graph's REAL token addresses
 * (every token node, every chain) so we don't miss transactions. Only runs while `active`.
 */
export function useFlowData({ tokens, chains, active }: { tokens: string[]; chains: string[]; active: boolean }) {
  const [graph, setGraph] = useState<FlowGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [txs, setTxs] = useState<FlowTx[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txAt, setTxAt] = useState<number | null>(null);
  const [txError, setTxError] = useState<string | null>(null); // 피드 실패를 "전송 없음"으로 위장하지 않기 위함
  const [universe, setUniverse] = useState<{ symbol: string; tvlUsd: number; pct: number }[]>([]);

  const tkKey = tokens.join(",");
  const chKey = chains.join(",");

  useEffect(() => {
    if (!active || universe.length) return;
    fetch("/api/token-universe", { cache: "no-store" }).then((r) => r.json()).then((d) => setUniverse(d.tokens ?? [])).catch(() => {});
  }, [active, universe.length]);

  useEffect(() => {
    if (!active || !tkKey || !chKey) return;
    let alive = true;
    setLoading(true);
    // request a GENEROUS candidate set (incl. lower-rank protocols like Uniswap V4) — the client's
    // fixed individual-share filter (flow-match filterGraphByDetail) trims it, and tx-active nodes
    // below the share floor still need to be IN the payload to be pinned.
    fetch(`/api/flow?tokens=${encodeURIComponent(tkKey)}&chains=${encodeURIComponent(chKey)}&topPct=0.998&maxProto=24&maxMkt=14`, { cache: "no-store" })
      .then((r) => r.json())
      .then((g) => { if (alive) { setGraph(g); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, tkKey, chKey]);

  // real token addresses (chain:addr:symbol) straight from the graph — every token node, every chain
  const addrs = useMemo(() => {
    if (!graph) return "";
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of graph.nodes) {
      if (n.kind !== "token" || !n.address) continue;
      // 비-EVM 주소는 케이스 보존(base58/타입경로), aptos·sui 의 "::" 는 URI 인코딩으로 구분자 충돌 방지
      const NONEVM = new Set(["solana", "tron", "sui", "aptos", "starknet"]);
      const a = NONEVM.has(n.chain) ? n.address : n.address.toLowerCase();
      const key = `${n.chain}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${n.chain}:${encodeURIComponent(a)}:${n.label}`);
    }
    return out.join(",");
  }, [graph]);

  // non-token node addresses (vaults etc.) → chain:addr~label pairs so the API can attribute
  // transfers to them — chain-scoped so the label can't bleed onto another chain's address.
  const nodeAddrs = useMemo(() => {
    if (!graph) return "";
    const out: string[] = [];
    for (const n of graph.nodes) {
      if (n.kind === "token" || !n.address || !/^0x[0-9a-fA-F]{40}$/.test(n.address)) continue;
      out.push(`${n.chain}:${n.address.toLowerCase()}~${n.label}`);
    }
    return out.join("|");
  }, [graph]);

  useEffect(() => {
    if (!active || (!addrs && !tkKey)) { setTxs([]); return; }
    let alive = true;
    const load = () => {
      setTxLoading(true);
      const base = addrs ? `addrs=${encodeURIComponent(addrs)}` : `tokens=${encodeURIComponent(tkKey)}&chains=${encodeURIComponent(chKey)}`;
      const qs = base + (nodeAddrs ? `&nodes=${encodeURIComponent(nodeAddrs)}` : "");
      fetch(`/api/transactions?${qs}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (alive) { setTxs((d.txs ?? []) as FlowTx[]); setTxError((d as { error?: string }).error ?? null); setTxLoading(false); setTxAt(Date.now()); } })
        .catch(() => { if (alive) { setTxError("피드 조회 실패"); setTxLoading(false); } });
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, [active, addrs, nodeAddrs, tkKey, chKey]);

  return { graph, loading, txs, txLoading, txAt, txError, universe };
}
