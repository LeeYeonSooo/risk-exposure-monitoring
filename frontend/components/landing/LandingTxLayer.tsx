"use client";

import { useEffect, useMemo, useState } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";

import type { GraphEdge } from "@/lib/api";
import type { FlowTx } from "@/lib/flow-types";

/**
 * 메인화면(이중 동심원) 실시간 트랜잭션 입자 — 흐름맵과 같은 방식(실전송·실금액·알 크기=거래액)이되,
 * **흐름이 급변한 토큰만** 표시한다. 게이트 = flow_anomaly 알림(최근 발화, 중앙값 베이스라인 대비
 * 급증·급감 — automation/snapshot-flow.ts 가 시간별 판정). 평상시엔 입자 없음 (요구사항).
 * 평범한 흐름까지 그리는 화면은 /flow 가 담당.
 */

interface Props {
  edges: GraphEdge[];
  tokenInfo: Map<string, { symbol: string; chain: string; address: string | null }>;
  /** 급변 게이트 — 최근 flow_anomaly 알림이 뜬 토큰 심볼(UPPER) */
  anomalySymbols: Set<string>;
}

// 흐름맵 TxFlowLayer 와 동일한 크기 규칙 (알 크기 = 실제 거래액, 최소 가시성 보장)
function radiusForValue(v: number) { return Math.max(3.2, Math.min(8, 3.2 + Math.max(0, Math.log10(v + 10) - 2) * 0.95)); }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function LandingTxLayer({ edges, tokenInfo, anomalySymbols }: Props) {
  const [txs, setTxs] = useState<FlowTx[]>([]);
  // 드래그를 따라가도록 노드 위치를 구독
  const rfNodes = useStore((s) => s.nodes);

  // 게이트에 든 토큰(그래프에 존재 + 주소 보유)만 전송 조회
  const gated = useMemo(() => {
    const out: { id: string; symbol: string; chain: string; address: string }[] = [];
    for (const [id, t] of tokenInfo) {
      if (!t.address) continue;
      if (anomalySymbols.has(t.symbol.toUpperCase())) out.push({ id, symbol: t.symbol, chain: t.chain, address: t.address });
    }
    return out;
  }, [tokenInfo, anomalySymbols]);

  const gateKey = gated.map((g) => `${g.chain}:${g.address}`).join(",");
  useEffect(() => {
    if (!gated.length) { setTxs([]); return; }
    let alive = true;
    const load = () => {
      const addrs = gated.map((g) => `${g.chain}:${encodeURIComponent(g.address)}:${g.symbol}`).join(",");
      fetch(`/api/transactions?addrs=${encodeURIComponent(addrs)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (alive) setTxs((d.txs ?? []) as FlowTx[]); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateKey]);

  const dots = useMemo(() => {
    if (!txs.length) return [];
    // 토큰 노드 / 프로토콜 노드 해석 + 실제 엣지 존재 검증 (없는 경로는 그리지 않음)
    const tokenIdBySym = new Map<string, string>();
    for (const [id, t] of tokenInfo) tokenIdBySym.set(norm(t.symbol), id);
    const protoByKey = new Map<string, string>();
    const pos = new Map<string, { x: number; y: number; r: number }>();
    for (const n of rfNodes) {
      const w = n.measured?.width ?? 64, h = n.measured?.height ?? 64;
      pos.set(n.id, { x: n.position.x + w / 2, y: n.position.y + h / 2, r: Math.min(w, h) / 2 });
      if (n.id.startsWith("protocol:")) {
        const slug = n.id.replace(/^protocol:(dl:)?/, "");
        protoByKey.set(norm(slug), n.id);
        const label = (n.data as { node?: { label?: string } } | undefined)?.node?.label;
        if (label) protoByKey.set(norm(label), n.id);
      }
    }
    const edgeSet = new Set(edges.map((e) => `${e.source}|${e.target}`));
    const out: { d: string; kp: string; r: number; dur: number; begin: number; key: string; color: string }[] = [];
    let i = 0;
    for (const tx of txs.slice(0, 160)) {
      if (!tx.counterparty) continue;
      const srcId = tokenIdBySym.get(norm(tx.token));
      const dstId = protoByKey.get(norm(tx.counterparty));
      if (!srcId || !dstId || !edgeSet.has(`${srcId}|${dstId}`)) continue;
      const s = pos.get(srcId), t = pos.get(dstId);
      if (!s || !t) continue;
      const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const x1 = s.x + ux * (s.r + 2), y1 = s.y + uy * (s.r + 2);
      const x2 = t.x - ux * (t.r + 2), y2 = t.y - uy * (t.r + 2);
      out.push({
        d: `M ${x1} ${y1} L ${x2} ${y2}`,
        kp: tx.direction === "out" ? "1;0" : "0;1",
        r: radiusForValue(tx.valueUsd),
        dur: 1.8 + Math.min(2.4, len / 600),
        begin: (i % 24) * 0.18,
        key: `${tx.hash}-${i}`,
        color: tx.direction === "out" ? "#f97316" : "#6366f1",
      });
      i++;
    }
    return out;
  }, [txs, rfNodes, edges, tokenInfo]);

  if (!dots.length) return null;
  return (
    <ViewportPortal>
      <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", pointerEvents: "none", zIndex: 0 }}>
        {dots.map((d) => (
          <circle key={d.key} r={d.r} fill={d.color} opacity={0.95} stroke="#fff" strokeWidth={0.7}>
            <animateMotion dur={`${d.dur}s`} begin={`${d.begin}s`} repeatCount="indefinite" path={d.d} keyPoints={d.kp} keyTimes="0;1" calcMode="linear" />
          </circle>
        ))}
      </svg>
    </ViewportPortal>
  );
}
