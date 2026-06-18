"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Background, BackgroundVariant, Controls, Panel, ReactFlow, ReactFlowProvider,
  type Edge, type Node, useEdgesState, useNodesState, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { FloatingFlowEdge } from "../flow/FloatingFlowEdge";
import { FlowNodeShell } from "../flow/FlowNodes";
import { TxFlowLayer } from "../flow/TxFlowLayer";
import { useFlowData } from "../flow/useFlowData";
import { buildBridgeRenderPlan } from "@/lib/bridge-flow-match";
import { radiusOf } from "@/lib/flow-layout";
import type { FlowNode, FlowTx } from "@/lib/flow-types";

/**
 * 브릿지 맵 — 토큰 하나의 크로스체인 브릿지 구조 + 실시간 트랜잭션.
 *   체인을 원(ring)으로 두고, 두 체인을 잇는 직선 엣지 **위**에 그 둘을 연결하는 브릿지 노드를 둔다.
 *   · burn&mint(전 체인 동일 토큰): 같은 브릿지가 여러 체인에 있으면 그 체인쌍을 모두 연결.
 *   · lock&mint(래핑): L1 잠금 → L2 가 래핑본(USDC.e 등) 민팅 → eth↔L2 한 쌍을 연결.
 * 스코프: eth/base/arbitrum 만(미구현 체인 브릿지는 숨김). 입자 = 브릿지 주소 입출금 실시간 전송.
 */

const nodeTypes = { flow: FlowNodeShell };
const edgeTypes = { flow: FloatingFlowEdge };

const SCOPE = new Set(["ethereum", "base", "arbitrum"]); // 구현된 체인만 (미구현 체인 브릿지는 숨김)
const LOCK_MINT = new Set(["l2_canonical", "op_bridge", "polygon_pos", "xerc20_lockbox"]); // 래핑(L1 잠금→L2 다른 토큰)
const CHAIN_ORDER = ["ethereum", "base", "arbitrum"];
const CENTER = { x: 720, y: 560 };

function tokenColor(i: number, n: number): string {
  const hue = Math.round((i * 360) / Math.max(1, n));
  return `hsl(${hue}, 72%, ${i % 2 === 0 ? 52 : 42}%)`;
}

function BridgeInner({ sym, chains, active }: { sym: string; chains: string[]; active: boolean }) {
  // 추정 브릿지(mint_event = Method E view-probe 추정) 표시 토글 — 기본 꺼짐(검증/탐지된 것만).
  const [showEstimated, setShowEstimated] = useState(false);
  // 스코프(eth/base/arbitrum) 안에서 mint_event 가 걸린 체인 수 — 2개 이상이어야 추정 토글이 의미가 있다
  // (같은 라벨이 2체인+ 있어야 체인쌍이 생겨 노드가 그려짐. 단일 체인이면 켜도 노드 0).
  const [estChains, setEstChains] = useState(0);
  const { graph, loading } = useFlowData({ tokens: [sym], chains, active, estimated: showEstimated });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [txs, setTxs] = useState<FlowTx[]>([]);
  const [winMin, setWinMin] = useState(60);
  const [liveByKey, setLiveByKey] = useState<Map<string, Record<string, unknown>>>(new Map()); // 브릿지별 라이브 DVN/attester 실측(meta.live)
  const { fitView } = useReactFlow();

  // 추정(mint_event) 브릿지가 스코프 안 몇 개 체인에 있는지 가볍게 조회 — 검증 브릿지가 0이라
  // 빈 화면이 떠도, 멀티체인 추정 경로가 있으면 토글을 노출해 사용자가 도달할 수 있게 한다.
  // bridge-authority API 는 이미 eth/base/arbitrum 로 스코프가 좁혀져 있어 그대로 활용.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetch(`/api/bridge-authority/${encodeURIComponent(sym)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { byChain?: Record<string, { authType: string }[]> }) => {
        if (!alive) return;
        const byChain = d.byChain ?? {};
        const n = Object.values(byChain).filter((list) => list.some((e) => e.authType === "mint_event")).length;
        setEstChains(n);
      })
      .catch(() => { if (alive) setEstChains(0); });
    return () => { alive = false; };
  }, [active, sym]);

  // 체인 = 바깥 링, 브릿지 = 체인쌍 엣지 위. 직선 연결. (스코프 밖 체인·브릿지는 제외)
  const layout = useMemo(() => {
    if (!graph) return null;
    // 체인 노드 = "선택한 토큰의 체인별 인스턴스"만. /api/flow 그래프엔 연관 토큰·LP(syrupUSDC·3Crv…)가
    //   token 노드로 다수 섞여 오므로, viewed 심볼과 일치하는 것만 골라 체인당 1개(첫 매치)로 한정한다.
    //   (이전엔 scope 내 모든 token 노드를 잡아 "체인 29개"로 흩어졌다 — 사용자 2026-06-17.)
    const wantSym = sym.toUpperCase();
    const byChain = new Map<string, FlowNode>();
    for (const n of graph.nodes) {
      if (n.kind !== "token" || !SCOPE.has(n.chain)) continue;
      if ((n.label || "").toUpperCase() !== wantSym) continue;
      if (!byChain.has(n.chain)) byChain.set(n.chain, n);
    }
    const chainNodes = [...byChain.values()].sort((a, b) => CHAIN_ORDER.indexOf(a.chain) - CHAIN_ORDER.indexOf(b.chain));
    const chainOf = new Map(chainNodes.map((n) => [n.chain, n] as const));

    // 브릿지 노드 디둡 — (체인, 라벨)당 1개, ccip_remote(같은 CCIP의 원격 엔드포인트)는 제외.
    const seen = new Set<string>();
    const bridgeNodes = graph.nodes.filter((n) => {
      if (n.kind !== "bridge" || !SCOPE.has(n.chain)) return false;
      if (n.meta?.authType === "ccip_remote") return false;
      const k = `${n.chain}|${n.label}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // 체인 링 좌표
    const R = Math.max(360, chainNodes.length * 150);
    const chainPos = new Map<string, { x: number; y: number }>();
    chainNodes.forEach((n, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, chainNodes.length);
      chainPos.set(n.chain, { x: CENTER.x + Math.cos(a) * R, y: CENTER.y + Math.sin(a) * R });
    });

    // 락&민트 래핑본(USDC.e@arbitrum · USDbC@base 등) — 목적지를 native 토큰이 아니라 "바뀐 형태" 노드로 그린다.
    //   (체인, 래핑심볼)당 1개로 디둡. chainNode 아님(라벨이 래핑 심볼이어야 하므로). meta.wrapped* 는 /api/flow 가 채움.
    const wrappedNodes = new Map<string, FlowNode>();
    const wrappedPos = new Map<string, { x: number; y: number }>();
    const wrappedIdFor = (b: FlowNode): string | null => {
      const m = b.meta ?? {};
      const wsym = m.wrappedSymbol as string | undefined;
      const wchain = (m.wrappedChain as string | undefined) ?? b.chain;
      if (!wsym || !chainPos.has(wchain)) return null;
      const key = `${wchain}|${wsym}`;
      const id = `wrap:${key}`;
      if (!wrappedNodes.has(key)) {
        const base = chainOf.get(wchain)!;
        const cp = chainPos.get(wchain)!;
        const ang = Math.atan2(cp.y - CENTER.y, cp.x - CENTER.x); // 체인 노드 바깥쪽 방사 위치
        wrappedPos.set(id, { x: cp.x + Math.cos(ang) * 135, y: cp.y + Math.sin(ang) * 135 });
        wrappedNodes.set(key, {
          ...base, id, label: wsym, tvlUsd: 0, // native 체인 TVL 상속 방지(래핑본 자체 규모는 별도)
          address: (m.wrappedAddr as string | undefined) ?? base.address,
          meta: { ...(base.meta ?? {}), wrapped: true, wrappedOf: sym, chain: wchain },
        });
      }
      return id;
    };

    // 체인쌍 → 브릿지 목록 (lock&mint = eth↔L2, burn&mint = 같은 브릿지가 있는 체인쌍 모두)
    type PairEntry = { a: string; b: string; list: { node: FlowNode; lock: boolean }[] };
    const pairs = new Map<string, PairEntry>();
    const addToPair = (a: string, b: string, node: FlowNode, lock: boolean) => {
      if (a === b || !chainPos.has(a) || !chainPos.has(b)) return;
      const [x, y] = [a, b].sort();
      const key = `${x}|${y}`;
      let e = pairs.get(key);
      if (!e) { e = { a: x, b: y, list: [] }; pairs.set(key, e); }
      if (!e.list.some((it) => it.node.label === node.label)) e.list.push({ node, lock });
    };
    const burnByLabel = new Map<string, FlowNode[]>();
    for (const b of bridgeNodes) {
      if (LOCK_MINT.has(b.meta?.authType as string)) {
        addToPair("ethereum", b.chain, b, true); // 래핑: L1(eth) ↔ L2
      } else {
        (burnByLabel.get(b.label) ?? burnByLabel.set(b.label, []).get(b.label)!).push(b);
      }
    }
    // note 에서 peer 체인 추출 — "→ ethereum"(OFT) 또는 본문에 박힌 연결 체인(CCIP).
    const peerOf = (note: string, self: string): string | null => {
      const arrow = note.match(/→\s*([a-z]+)/i)?.[1]?.toLowerCase();
      if (arrow && CHAIN_ORDER.includes(arrow) && arrow !== self) return arrow;
      for (const c of CHAIN_ORDER) if (c !== self && new RegExp(`\\b${c}\\b`, "i").test(note)) return c;
      return null;
    };
    for (const list of burnByLabel.values()) {
      const byChain = new Map(list.map((n) => [n.chain, n] as const));
      const cs = [...byChain.keys()];
      if (cs.length >= 2) {
        for (let i = 0; i < cs.length; i++)
          for (let j = i + 1; j < cs.length; j++) addToPair(cs[i], cs[j], byChain.get(cs[i])!, false);
      } else if (cs.length === 1) {
        // 한 in-scope 체인에만 있는 메커니즘 — CCIP 는 getSupportedChains 실측(meta.ccipChains), 그 외(OFT 등)는 note 의 명시 peer.
        //   (addToPair 가 peer 체인 노드 유무 검증 → 노드 없으면 자동 스킵. 추측 아님: 실측·명시 근거만.)
        const only = list[0];
        const ccipChains = only.meta?.ccipChains as string[] | undefined;
        if (ccipChains?.length) {
          for (const peer of ccipChains) if (peer !== only.chain) addToPair(only.chain, peer, only, false);
        } else {
          const peer = peerOf(String(only.meta?.note ?? ""), only.chain);
          if (peer) addToPair(only.chain, peer, only, false);
        }
      }
    }

    // 브릿지 노드를 체인쌍 엣지 위(중점, 여러 개면 수직 오프셋)에 배치 + 직선 엣지(체인→브릿지→체인).
    // 같은 메커니즘(예: CCTP)이 여러 쌍을 연결하면 쌍마다 **고유 합성 노드**를 만든다(노드 재사용 금지 — id 충돌).
    const pos = new Map<string, { x: number; y: number }>();
    const placed: (FlowNode & { _pair: [string, string]; _lock: boolean })[] = [];
    const fedges: { id: string; source: string; target: string; kind: string }[] = [];
    for (const { a, b, list } of pairs.values()) {
      const pa = chainPos.get(a)!, pb = chainPos.get(b)!;
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
      const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len; // 수직(여러 브릿지 분리)
      list.forEach((it, k) => {
        const off = (k - (list.length - 1) / 2) * 78;
        const id = `bm:${a}|${b}|${it.node.label}`; // 쌍+메커니즘 고유 id
        pos.set(id, { x: mx + px * off, y: my + py * off });
        placed.push({ ...it.node, id, _pair: [a, b], _lock: it.lock });
        // 락&민트면 L2 쪽 끝점을 래핑 노드로(형태 변경). a/b 는 정렬된 쌍이라 실제 L2 는 it.node.chain 으로 판별.
        const wid = it.lock ? wrappedIdFor(it.node) : null;
        const l2 = it.node.chain;
        const srcA = wid && a === l2 ? wid : chainOf.get(a)!.id;
        const tgtB = wid && b === l2 ? wid : chainOf.get(b)!.id;
        fedges.push({ id: `be:${a}->${id}`, source: srcA, target: id, kind: "bridge" });
        fedges.push({ id: `be:${id}->${b}`, source: id, target: tgtB, kind: "bridge" });
      });
    }

    return { chainNodes, chainPos, placed, pos, fedges, wrappedNodes, wrappedPos };
  }, [graph]);

  // 전용 브릿지 피드 — 브릿지 주소 to/from 직접 조회.
  const fetchParams = useMemo(() => {
    if (!graph) return null;
    const tokenAddrs: string[] = [];
    for (const n of graph.nodes) if (n.kind === "token" && SCOPE.has(n.chain) && n.address) tokenAddrs.push(`${n.chain}:${n.address.toLowerCase()}`);
    const bridges: string[] = [];
    for (const n of graph.nodes) if (n.kind === "bridge" && SCOPE.has(n.chain) && n.address) bridges.push(`${n.chain}:${n.address.toLowerCase()}:${n.label}`);
    if (!bridges.length || !tokenAddrs.length) return null;
    return { tokenAddrs: tokenAddrs.join(","), bridges: bridges.join("|") };
  }, [graph]);

  useEffect(() => {
    if (!active || !fetchParams) { setTxs([]); return; }
    let alive = true;
    const load = () => {
      const qs = `token=${encodeURIComponent(sym)}&tokenAddrs=${encodeURIComponent(fetchParams.tokenAddrs)}&bridges=${encodeURIComponent(fetchParams.bridges)}`;
      fetch(`/api/bridge-transactions?${qs}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (alive) { setTxs((d.txs ?? []) as FlowTx[]); if (d.windowSec) setWinMin(Math.round(d.windowSec / 60)); } })
        .catch(() => { if (alive) setTxs([]); });
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, [active, fetchParams, sym]);

  // 라이브 온체인 실측 — OFT(LayerZero DVN)·CCTP(attester) 브릿지에 한해 /api/bridge-dvn 조회 → meta.live.
  useEffect(() => {
    if (!active || !layout) { setLiveByKey(new Map()); return; }
    const targets = layout.placed.filter((b) => { const at = b.meta?.authType; return at === "oft_peer" || at === "cctp"; });
    if (!targets.length) { setLiveByKey(new Map()); return; }
    let alive = true;
    (async () => {
      const entries = await Promise.all(targets.map(async (b) => {
        const at = b.meta?.authType as string;
        let url: string;
        if (at === "cctp") {
          url = `/api/bridge-dvn?mech=cctp`;
        } else {
          const oapp = (b.meta?.addr as string | undefined) ?? b.address ?? "";
          const remote = String(b.meta?.note ?? "").match(/→\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? "ethereum"; // OFT peer 체인
          url = `/api/bridge-dvn?mech=oft&chain=${encodeURIComponent(b.chain)}&oapp=${encodeURIComponent(oapp)}&remote=${encodeURIComponent(remote)}`;
        }
        try { const d = await fetch(url, { cache: "no-store" }).then((r) => r.json()); return [b.id, d.live] as const; }
        catch { return [b.id, null] as const; }
      }));
      if (!alive) return;
      const m = new Map<string, Record<string, unknown>>();
      for (const [id, live] of entries) if (live) m.set(id, live as Record<string, unknown>);
      setLiveByKey(m);
    })();
    return () => { alive = false; };
  }, [active, layout]);

  // TxFlowLayer 입력용 positioned 노드(중심좌표 + 반경)
  const positioned = useMemo(() => {
    if (!layout) return [];
    const chainP = layout.chainNodes.map((n) => ({ ...n, x: layout.chainPos.get(n.chain)!.x, y: layout.chainPos.get(n.chain)!.y, radius: radiusOf(n) }));
    const bridgeP = layout.placed.map((node) => ({ ...node, x: layout.pos.get(node.id)!.x, y: layout.pos.get(node.id)!.y, radius: radiusOf(node) }));
    const wrapP = [...layout.wrappedNodes.values()].map((node) => ({ ...node, x: layout.wrappedPos.get(node.id)!.x, y: layout.wrappedPos.get(node.id)!.y, radius: radiusOf(node) }));
    return [...chainP, ...bridgeP, ...wrapP];
  }, [layout]);

  const colorByToken = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const syms = [...new Set(graph.nodes.filter((n) => n.kind === "token").map((n) => n.label.toUpperCase()))].sort();
    return new Map(syms.map((s, i) => [s, tokenColor(i, syms.length)] as const));
  }, [graph]);

  // RF 노드/엣지 세팅
  useEffect(() => {
    if (!layout) return;
    const chainRF = layout.chainNodes.map((n) => {
      const p = layout.chainPos.get(n.chain)!;
      const r = radiusOf(n);
      return { id: n.id, type: "flow", position: { x: p.x - r, y: p.y - r }, zIndex: 1, data: { ...n, radius: r, chainNode: true }, draggable: true } as Node;
    });
    const bridgeRF = layout.placed.map((node) => {
      const p = layout.pos.get(node.id)!;
      const r = radiusOf(node);
      // 메커니즘·연결 체인쌍 + 라이브 실측(meta.live) 을 메타로 → hover 구조특성 카드가 실측값(X-of-Y DVN 등) 표시.
      const live = liveByKey.get(node.id);
      const meta = { ...(node.meta ?? {}), fromChain: node._pair[0], toChain: node._pair[1], ...(live ? { live } : {}) };
      const est = node.meta?.estimated === true; // mint_event 추정 — 점선·"추정" 배지(FlowNodes)
      const label = est ? node.label : `${node.label}${node._lock ? " · 락&민트(래핑)" : " · 번&민트"}`;
      return { id: node.id, type: "flow", position: { x: p.x - r, y: p.y - r }, zIndex: 2, data: { ...node, label, meta, radius: r, risk: est || node._lock ? "caution" : "safe" }, draggable: true } as Node;
    });
    // 래핑 형태 노드(USDC.e·USDbC 등) — chainNode 아님(라벨=래핑 심볼). 락&민트 목적지.
    const wrapRF = [...layout.wrappedNodes.values()].map((node) => {
      const p = layout.wrappedPos.get(node.id)!;
      const r = radiusOf(node);
      return { id: node.id, type: "flow", position: { x: p.x - r, y: p.y - r }, zIndex: 1, data: { ...node, radius: r, risk: "caution" }, draggable: true } as Node;
    });
    setNodes([...chainRF, ...bridgeRF, ...wrapRF]);
    setEdges(layout.fedges.map((e) => ({
      id: e.id, source: e.source, target: e.target, type: "flow",
      data: { kind: e.kind, weight: 0.4, tvlUsd: 0, mode: "transaction", dir: "both", straight: true },
      zIndex: 0,
    } as Edge)));
    const t = setTimeout(() => fitView({ padding: 0.18, duration: 500 }).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [layout, liveByKey, setNodes, setEdges, fitView]);

  if (!layout) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">{loading ? "브릿지 데이터 로딩…" : "브릿지 데이터 없음"}</div>;
  }
  if (!layout.placed.length) {
    // 멀티체인 추정(mint_event) 경로가 있으면 빈 화면 대신 안내 + 토글을 노출 — 토글을 켜면
    // estimated=1 재조회로 추정 노드가 들어와 체인쌍이 생기고 맵이 그려진다(기본 꺼짐 유지).
    const hasEstPath = estChains >= 2;
    if (hasEstPath) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-sm text-[var(--color-text-muted)]">
          <p className="max-w-md leading-relaxed">
            {sym} 의 검증된 브릿지가 없습니다 — 추정 브릿지 표시를 켜면 민트 이벤트 기반 추정 경로를 볼 수 있어요.
          </p>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/80 px-2.5 py-1.5 text-[var(--color-text-secondary)] shadow-sm">
            <input type="checkbox" checked={showEstimated} onChange={(e) => setShowEstimated(e.target.checked)} className="size-3 accent-[var(--color-accent)]" />
            추정 브릿지 표시 <span className="text-[var(--color-text-muted)]">(점선 · 민트 이벤트 기반 추정)</span>
          </label>
          {showEstimated && loading ? <p className="text-[10px]">추정 경로 불러오는 중…</p> : null}
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]">
        {sym} 의 검증된 브릿지가 없습니다 — 단일 체인 자산이거나 표준 브릿지 권한이 탐지되지 않았어요.
      </div>
    );
  }

  const lockCount = layout.placed.filter((b) => b._lock).length;
  const estCount = layout.placed.filter((b) => b.meta?.estimated === true).length; // mint_event 추정 노드 수

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      minZoom={0.1} maxZoom={2.6} proOptions={{ hideAttribution: true }}
      nodesConnectable={false} elementsSelectable colorMode="light" fitView
    >
      <Background variant={BackgroundVariant.Dots} gap={30} size={1} color="#dde5f0" />
      <Controls showInteractive={false} />
      <Panel position="top-left" className="!m-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/80 px-2.5 py-1.5 text-[10px] leading-relaxed shadow-sm backdrop-blur">
        <div className="font-bold text-[var(--color-text-primary)]">브릿지 맵 <span className="font-normal text-[var(--color-text-muted)]">· 체인 사이 엣지 위 = 브릿지</span></div>
        <div className="font-medium text-[var(--color-text-secondary)]">체인 {layout.chainNodes.length} · 브릿지 {layout.placed.length}개 {lockCount > 0 ? `(락&민트 ${lockCount} · 래핑 포착)` : ""}{estCount > 0 ? ` · 추정 ${estCount}` : ""}</div>
        <div className="text-[var(--color-text-muted)]">번&민트=전 체인 동일 토큰 · 락&민트=L1 잠금→L2 래핑(USDC.e 등)</div>
        <div className="text-[var(--color-text-muted)]">
          {txs.length > 0 ? `입자: 최근 ${winMin}분 ${txs.length}건 · 1분 지연` : `입자: 최근 ${winMin}분 거래 없음`}
        </div>
        <label className="mt-1 flex cursor-pointer items-center gap-1.5 border-t border-[var(--color-border-subtle)] pt-1 text-[var(--color-text-secondary)]">
          <input type="checkbox" checked={showEstimated} onChange={(e) => setShowEstimated(e.target.checked)} className="size-3 accent-[var(--color-accent)]" />
          추정 브릿지 표시 <span className="text-[var(--color-text-muted)]">(점선 · 민트 이벤트 기반 추정)</span>
        </label>
      </Panel>
      {txs.length > 0 && (
        <TxFlowLayer nodes={positioned} edges={layout.fedges as never} txs={txs} colorByToken={colorByToken} buildPlan={buildBridgeRenderPlan} straight />
      )}
    </ReactFlow>
  );
}

export function BridgeView({ sym, chains, active }: { sym: string; chains: string[]; active: boolean }) {
  return (
    <ReactFlowProvider>
      <BridgeInner sym={sym} chains={chains} active={active} />
    </ReactFlowProvider>
  );
}
