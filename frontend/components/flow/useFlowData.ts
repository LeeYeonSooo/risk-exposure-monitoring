"use client";

import { useEffect, useMemo, useState } from "react";

import { LIVE_DELAY_SEC, LIVE_WINDOW_SEC, type FlowBaselineCoverage, type FlowBaselineRow, type FlowGraph as FlowGraphData, type FlowTx } from "@/lib/flow-types";

export type FlowViewMode = "live" | "baseline";

export interface BaselineState { rows: FlowBaselineRow[]; coverage: FlowBaselineCoverage[]; error: string | null; at: number | null }

/**
 * 흐름맵 데이터 — 관계 그래프 + 모드별:
 *  · live     — 실시간(≈1분 지연, 최근 30분) 실전송 피드, 30초 폴링 (입자)
 *  · baseline — 평소 모드: 최근 24h 엣지별 흐름 집계(/api/flow-baseline, 서버 20분 캐시)
 * 둘 다 그래프의 REAL 토큰 주소(모든 토큰 노드·모든 체인)를 쓴다. `active` 일 때만 동작.
 */
export function useFlowData({ tokens, chains, active, mode = "live", estimated = false }: { tokens: string[]; chains: string[]; active: boolean; mode?: FlowViewMode; estimated?: boolean }) {
  const [graph, setGraph] = useState<FlowGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [txs, setTxs] = useState<FlowTx[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txAt, setTxAt] = useState<number | null>(null);
  const [txError, setTxError] = useState<string | null>(null); // 피드 실패를 "전송 없음"으로 위장하지 않기 위함
  const [txPartial, setTxPartial] = useState<string[]>([]); // 30분 윈도우 oldest 쪽이 잘렸을 수 있는 토큰(페이지 캡/표시 캡)
  const [universe, setUniverse] = useState<{ symbol: string; tvlUsd: number; pct: number }[]>([]);
  const [baseline, setBaseline] = useState<BaselineState>({ rows: [], coverage: [], error: null, at: null });
  const [baselineLoading, setBaselineLoading] = useState(false);

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
    // 노드가 많아져도 좋다 — 마켓/풀/볼트 후보를 넓게 요청, 컷은 클라이언트 실효비중이 담당.
    // estimated → mint_event(추정) 브릿지 노드도 받음(브릿지 뷰 전용 토글, 기본 꺼짐 — 검증/탐지된 것만).
    const estParam = estimated ? "&estimated=1" : "";
    fetch(`/api/flow?tokens=${encodeURIComponent(tkKey)}&chains=${encodeURIComponent(chKey)}&topPct=0.999&maxProto=28&maxMkt=30${estParam}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((g) => { if (alive) { setGraph(g); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, tkKey, chKey, estimated]);

  // real token addresses (chain:addr:symbol) straight from the graph — every token node, every chain (EVM 전용)
  const addrs = useMemo(() => {
    if (!graph) return "";
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of graph.nodes) {
      if (n.kind !== "token" || !n.address) continue;
      const a = n.address.toLowerCase();
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

  // 그래프 정체(주소 목록)가 바뀌면 이전 선택의 피드/집계를 즉시 비운다 — stale 데이터가 새
  // 그래프의 딤·입자·톱리스트를 결정하면 "데이터 갱신 중"이 "활동 없음"으로 위장된다.
  useEffect(() => {
    setTxs([]); setTxAt(null); setTxError(null);
    setBaseline({ rows: [], coverage: [], error: null, at: null });
  }, [addrs]);

  // ── live: 30s 폴링 (모드가 live 일 때만 — 평소 모드에선 폴링 중단, 마지막 피드는 보존) ──
  useEffect(() => {
    if (!active || mode !== "live" || (!addrs && !tkKey)) return;
    let alive = true;
    let emptyRetries = 0;            // 콜드 첫 폴이 RPC 버스트로 비면 30초 안 기다리고 빠르게 재폴
    let fastTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_FAST_RETRIES = 4;     // 6초 × 4 ≈ 24초 동안 빠른 재시도 후 30초 폴로 복귀
    const load = () => {
      setTxLoading(true);
      const base = addrs ? `addrs=${encodeURIComponent(addrs)}` : `tokens=${encodeURIComponent(tkKey)}&chains=${encodeURIComponent(chKey)}`;
      const qs = base + (nodeAddrs ? `&nodes=${encodeURIComponent(nodeAddrs)}` : "");
      fetch(`/api/transactions?${qs}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          const txs = (d.txs ?? []) as FlowTx[];
          setTxs(txs); setTxError((d as { error?: string }).error ?? null); setTxPartial(((d as { partial?: string[] }).partial ?? [])); setTxLoading(false); setTxAt(Date.now());
          // 결과가 비었는데 에러도 아님 = 콜드 RPC 버스트로 일시 비었을 가능성("거래 있는데 0"). 30초
          // 안 기다리고 6초 뒤 재폴 — 채워지면 멈춘다. (진짜 활동 없음이면 MAX 회 후 30초 폴로 복귀)
          if (txs.length === 0 && !(d as { error?: string }).error && emptyRetries < MAX_FAST_RETRIES) {
            emptyRetries++;
            fastTimer = setTimeout(() => { if (alive) load(); }, 6000);
          } else {
            emptyRetries = 0;
          }
        })
        .catch(() => {
          if (!alive) return;
          setTxError("피드 조회 실패");
          setTxLoading(false);
          // 폴 실패가 이어져도 입자가 "최근 30분" 표기를 어기지 않게 — 윈도우를 벗어난 전송은 노화 제거
          const cutoff = Math.floor(Date.now() / 1000) - (LIVE_WINDOW_SEC + LIVE_DELAY_SEC);
          setTxs((prev) => prev.filter((t) => t.ts >= cutoff));
        });
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); if (fastTimer) clearTimeout(fastTimer); };
  }, [active, mode, addrs, nodeAddrs, tkKey, chKey]);

  // ── baseline: 평소 모드 진입/주소 변경 시 1회 (서버가 20분 캐시 — 폴링 불필요) ──
  useEffect(() => {
    if (!active || mode !== "baseline" || !addrs) return;
    let alive = true;
    setBaselineLoading(true);
    setBaseline({ rows: [], coverage: [], error: null, at: null }); // 재집계 동안 이전 rows 로 딤/톱리스트를 그리지 않는다
    const qs = `addrs=${encodeURIComponent(addrs)}` + (nodeAddrs ? `&nodes=${encodeURIComponent(nodeAddrs)}` : "");
    fetch(`/api/flow-baseline?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setBaseline({ rows: (d.rows ?? []) as FlowBaselineRow[], coverage: (d.coverage ?? []) as FlowBaselineCoverage[], error: (d as { error?: string }).error ?? null, at: Date.now() });
        setBaselineLoading(false);
      })
      .catch(() => { if (alive) { setBaseline({ rows: [], coverage: [], error: "평소 흐름 조회 실패", at: null }); setBaselineLoading(false); } });
    return () => { alive = false; };
  }, [active, mode, addrs, nodeAddrs]);

  return { graph, loading, txs, txLoading, txAt, txError, txPartial, universe, baseline, baselineLoading };
}
