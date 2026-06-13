/**
 * Shared counterparty → graph-node resolver. A transaction is "shown on the graph" iff its
 * counterparty resolves to a node here (protocol by name, or market/vault by its own label).
 * Used by both TxFlowLayer (to draw the particle) and FlowTxPanel (to float those tx to the top),
 * so the two never disagree about which transactions are actually rendered.
 */
import { LIVE_WINDOW_SEC, type FlowBaselineCoverage, type FlowBaselineRow, type FlowEdge, type FlowGraph, type FlowTx } from "./flow-types";

export function norm(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]/g, ""); }

export interface CpNodeLike { kind: string; label: string; protocol?: string; chain?: string }

/**
 * CHAIN-SCOPED resolver: in multi-chain views the same protocol exists once per chain
 * (uniswap-v3@ethereum vs @base) — a base tx must resolve to the base node, never an arbitrary
 * one. When the caller passes a chain, only that chain's nodes are candidates; the chain-less
 * lookup is kept for callers without tx context.
 */
export function buildCpResolver<T extends CpNodeLike>(nodes: T[]): (label: string | null | undefined, chain?: string) => T | undefined {
  const byChainLabel = new Map<string, T>();
  const byLabel = new Map<string, T>();
  const put = (m: Map<string, T>, k: string, n: T) => { if (!m.has(k)) m.set(k, n); };
  for (const n of nodes) {
    if (n.kind === "token" || n.kind === "bridge") continue; // bridge 노드 라벨(CCIP 등)은 카운터파티가 아님
    const keys = n.kind === "protocol"
      ? [norm(n.label), ...(n.protocol ? [norm(n.protocol)] : [])]
      : [norm(n.label)]; // market/vault by their OWN name only (avoid colliding with the protocol)
    for (const k of keys) {
      if (n.chain) put(byChainLabel, `${n.chain}|${k}`, n);
      put(byLabel, k, n);
    }
  }
  return (label, chain) => {
    if (!label) return undefined;
    const k = norm(label);
    if (chain) {
      const hit = byChainLabel.get(`${chain}|${k}`);
      if (hit) return hit;
      // fuzzy fallback ONLY within the same chain, protocols, >=5 chars (no short-substring false matches)
      for (const [lk, n] of byChainLabel) {
        if (!lk.startsWith(`${chain}|`)) continue;
        const lk2 = lk.slice(chain.length + 1);
        if (n.kind === "protocol" && Math.min(lk2.length, k.length) >= 5 && (lk2.includes(k) || k.includes(lk2))) return n;
      }
      return undefined; // 다른 체인의 동명 노드로 붙이지 않는다
    }
    if (byLabel.has(k)) return byLabel.get(k);
    for (const [lk, n] of byLabel) if (n.kind === "protocol" && Math.min(lk.length, k.length) >= 5 && (lk.includes(k) || k.includes(lk))) return n;
    return undefined;
  };
}

type NodeLite = { id: string; kind: string; label: string; chain: string; protocol?: string };
type EdgeLite = { source: string; target: string; kind: string };

/**
 * Shared "will this transaction actually animate" router. Resolves the counterparty to a node, builds the
 * REAL path (token→protocol→market→vault), and REQUIRES a drawable edge on the path. Returns the node route
 * (for TxFlowLayer geometry) or null. FlowTxPanel uses `!!route` for its on-graph count — so the displayed
 * count ALWAYS equals what truly renders (edge connectivity verified, not just counterparty resolution).
 */
export interface TxRouteHint { kind?: string; marketHint?: string | null }

/**
 * 프로토콜 아래에서 트랜잭션이 실제로 가리키는 마켓을 찾는다 — 추측 없음:
 *  · marketHint = CREATE2/레지스트리로 식별된 DEX 풀의 페어("WBTC-WETH") → 같은 페어 라벨의 마켓
 *  · 렌딩 예치/출금(aToken·comet) = 전송된 토큰의 리저브 → 토큰 심볼과 같은 라벨의 단일자산 마켓
 * 못 찾으면 undefined (프로토콜 수준에서 멈춤 — 모르포 싱글톤처럼 마켓 식별이 불가한 경우).
 */
export function findMarketChild<T extends NodeLite>(children: T[] | undefined, token: string, hint?: TxRouteHint): T | undefined {
  if (!children?.length || !hint) return undefined;
  if (hint.marketHint) {
    const parts = hint.marketHint.split("-").map(norm).filter(Boolean);
    if (parts.length === 2) {
      const m = children.find((c) => { const l = norm(c.label); return l === parts[0] + parts[1] || l === parts[1] + parts[0]; });
      if (m) return m;
    }
  }
  if ((hint.kind === "deposit" || hint.kind === "withdraw") && token) {
    return children.find((c) => norm(c.label) === norm(token));
  }
  return undefined;
}

export function buildRenderRouter<T extends NodeLite>(nodes: T[], edges: EdgeLite[]) {
  const resolve = buildCpResolver(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const tokenByKey = new Map<string, T>();
  for (const n of nodes) if (n.kind === "token") tokenByKey.set(`${norm(n.label)}|${n.chain}`, n);
  const marketParent = new Map<string, T>(), vaultParent = new Map<string, T>(), edgePair = new Set<string>();
  const marketsOfProto = new Map<string, T[]>();
  for (const e of edges) {
    if (e.kind === "market") {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (s) marketParent.set(e.target, s);
      if (s && t) { const a = marketsOfProto.get(s.id); if (a) a.push(t); else marketsOfProto.set(s.id, [t]); }
    } else if (e.kind === "vault") { const s = byId.get(e.source); if (s) vaultParent.set(e.target, s); }
    edgePair.add(`${e.source}|${e.target}`); edgePair.add(`${e.target}|${e.source}`);
  }
  const pathTo = (src: T, t: T): T[] => {
    if (t.kind === "market") { const p = marketParent.get(t.id); return p && p !== src ? [src, p, t] : [src, t]; }
    if (t.kind === "vault") {
      const m = vaultParent.get(t.id);
      if (!m || m === src) return [src, t];
      if (m.kind === "market") { const p = marketParent.get(m.id); return p && p !== src ? [src, p, m, t] : [src, m, t]; }
      return [src, m, t];
    }
    return [src, t];
  };
  return (token: string, chain: string, counterparty: string | null | undefined, hint?: TxRouteHint): T[] | null => {
    if (!counterparty) return null;
    const src = tokenByKey.get(`${norm(token)}|${chain}`);
    let dest = resolve(counterparty, chain);
    if (!src || !dest || dest === src) return null;
    if (dest.kind === "protocol") {
      // 식별된 풀 페어/렌딩 리저브가 보이는 마켓과 일치하면 입자를 그 마켓까지 내려보낸다
      const mkt = findMarketChild(marketsOfProto.get(dest.id), token, hint);
      if (mkt) dest = mkt;
    }
    if (edgePair.has(`${src.id}|${dest.id}`)) return [src, dest];
    const route = pathTo(src, dest);
    for (let k = 0; k < route.length - 1; k++) if (edgePair.has(`${route[k].id}|${route[k + 1].id}`)) return route; // >=1 drawable hop
    return null;
  };
}

/** Hard cap on total animated hops (perf). The SAME cap is applied to the count and the render via the
 *  shared plan below, so the two never diverge. 30분 윈도우 전수 수집에 맞춰 1000 으로 상향 —
 *  "매칭됐는데 그래프에 안 그려지는" 케이스를 사실상 제거 (260 캡이 499건 중 109건만 그리던 원인). */
export const MAX_RENDER_HOPS = 1000;

/**
 * THE single source of truth for "which transactions animate, and along which hops" — capped. FlowTxPanel
 * uses `plan.length` for "그래프 흐름 N건"; TxFlowLayer renders exactly `plan`'s hops. Because both derive from
 * this one function with the SAME cap, the displayed count ALWAYS equals the rendered particle set (no MAX_DOTS
 * divergence). Each hop is a validated [from,to] node pair that has a real edge.
 */
export function buildRenderPlan<
  N extends NodeLite,
  Tx extends { token: string; chain: string; counterparty?: string | null; direction: "in" | "out"; kind?: string; marketHint?: string | null },
>(nodes: N[], edges: EdgeLite[], txs: Tx[], maxHops = MAX_RENDER_HOPS): { tx: Tx; hops: [N, N][] }[] {
  const route4 = buildRenderRouter(nodes, edges);
  const tokenByKey = new Map<string, N>();
  for (const n of nodes) if (n.kind === "token") tokenByKey.set(`${norm(n.label)}|${n.chain}`, n);
  const edgePair = new Set<string>();
  for (const e of edges) { edgePair.add(`${e.source}|${e.target}`); edgePair.add(`${e.target}|${e.source}`); }
  // 민트/소각은 패널 전용 — 수신 체인의 민트 이벤트만으로는 출발 체인을 증명할 수 없어
  // (CCTP·OFT 멀티소스, 네이티브 발행도 from=0x0) 브릿지 엣지에 태우면 출처 날조가 된다.
  // 정직한 브릿지 흐름은 양쪽 체인 burn↔mint 짝맞춤(mint-burn recon)이 선행돼야 가능.
  const plan: { tx: Tx; hops: [N, N][] }[] = [];
  let total = 0;
  for (const tx of txs) {
    if (total >= maxHops) break;
    let hops: [N, N][] = [];
    if (tx.kind === "wrap" || tx.kind === "unwrap") {
      // wrap rides the token↔token edge if one exists (loop/관계선); otherwise panel-only
      const src = tokenByKey.get(`${norm(tx.token)}|${tx.chain}`);
      const dst = tx.counterparty ? tokenByKey.get(`${norm(tx.counterparty)}|${tx.chain}`) : undefined;
      if (src && dst && edgePair.has(`${src.id}|${dst.id}`)) hops = tx.kind === "wrap" ? [[src, dst]] : [[dst, src]];
    } else {
      const route = route4(tx.token, tx.chain, tx.counterparty, tx);
      if (route) {
        const seq = tx.direction === "out" ? [...route].reverse() : route; // withdraw runs dest→token
        for (let k = 0; k < seq.length - 1; k++) if (edgePair.has(`${seq[k].id}|${seq[k + 1].id}`)) hops.push([seq[k], seq[k + 1]]);
      }
    }
    if (!hops.length) continue;
    hops = hops.slice(0, Math.max(0, maxHops - total));
    total += hops.length;
    if (hops.length) plan.push({ tx, hops });
  }
  return plan;
}

const fmtUsdShort = (u: number) => (u >= 1e6 ? `$${(u / 1e6).toFixed(1)}M` : u >= 1e3 ? `$${(u / 1e3).toFixed(0)}K` : `$${u.toFixed(0)}`);

interface TraceItem {
  token: string; chain: string; counterparty: string | null | undefined;
  kind?: string; marketHint?: string | null;
  /** 실측 방향 — out(출금/매수)이면 trace 엣지의 source/target 을 뒤집어 점선이 실제 방향으로 긴다 */
  direction: "in" | "out";
  usd: number; count: number; sample: string | null;
  /** 항목별 관측 윈도우(초) — 평소 모드는 토큰마다 관측구간이 다르다. 없으면 opts.windowSec */
  windowSec?: number;
  /** 이미 기존 엣지로 렌더 가능한 항목인지 (이벤트 경로는 plan 으로, 평소 경로는 router 로 판정) */
  rendered: boolean;
}

/**
 * 공통 트레이스 코어 — counterparty 는 해석됐지만 기존 엣지로 못 타는 흐름을 (기존 노드 사이에만)
 * trace 엣지로 추가한다. 노드는 절대 만들지 않는다. 실시간 이벤트 피드가 발견한 새 의존성용.
 * ⚠ wrap/unwrap 은 호출부에서 제외할 것 — wrap 의 counterparty 는 "상대 토큰 심볼"이라
 * 동명 단일자산 마켓 노드(예: aave 의 WSTETH 리저브)에 오매칭되어 가짜 의존성을 날조한다.
 */
function addTraceEdges(graph: FlowGraph, items: TraceItem[], opts: { idPrefix: string; source: "event" | "baseline"; windowSec: number; labelOf: (token: string, usd: number, count: number) => string }): FlowGraph {
  const resolve = buildCpResolver(graph.nodes);
  const tokenByKey = new Map(graph.nodes.filter((n) => n.kind === "token").map((n) => [`${norm(n.label)}|${n.chain}`, n] as const));
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const marketsOfProto = new Map<string, FlowGraph["nodes"]>();
  const existingPair = new Set<string>();
  for (const e of graph.edges) {
    existingPair.add(`${e.source}|${e.target}`);
    existingPair.add(`${e.target}|${e.source}`);
    if (e.kind === "market") {
      const t = byId.get(e.target);
      if (!t) continue;
      const arr = marketsOfProto.get(e.source);
      if (arr) arr.push(t);
      else marketsOfProto.set(e.source, [t]);
    }
  }
  const agg = new Map<string, { source: string; target: string; chain: string; token: string; usd: number; count: number; sampleTx: string | null; windowSec: number }>();
  for (const it of items) {
    if (!it.counterparty || it.rendered || it.usd <= 0) continue;
    if (it.kind === "wrap" || it.kind === "unwrap") continue; // 안전망 — 위 ⚠ 참조
    const src = tokenByKey.get(`${norm(it.token)}|${it.chain}`);
    if (!src) continue;
    let dest = resolve(it.counterparty, it.chain);
    if (!dest || dest.id === src.id) continue;
    if (dest.kind === "protocol") {
      const mkt = findMarketChild(marketsOfProto.get(dest.id), it.token, it);
      if (mkt) dest = mkt;
    }
    if (existingPair.has(`${src.id}|${dest.id}`)) continue;
    // 방향 보존: in = 토큰→상대, out = 상대→토큰 (점선 dashoffset 애니메이션이 실측 방향으로 긴다)
    const [a, b] = it.direction === "out" ? [dest.id, src.id] : [src.id, dest.id];
    const key = `${a}|${b}|${it.token.toUpperCase()}`;
    const cur = agg.get(key);
    if (cur) {
      cur.usd += it.usd;
      cur.count += it.count;
      cur.windowSec = Math.max(cur.windowSec, it.windowSec ?? opts.windowSec);
      if (!cur.sampleTx) cur.sampleTx = it.sample;
    } else {
      agg.set(key, { source: a, target: b, chain: it.chain, token: it.token, usd: it.usd, count: it.count, sampleTx: it.sample, windowSec: it.windowSec ?? opts.windowSec });
    }
  }
  const traces = [...agg.values()].sort((a, b) => b.usd - a.usd).slice(0, 32);
  if (!traces.length) return graph;
  const maxUsd = Math.max(1, ...traces.map((t) => t.usd));
  const edges: FlowEdge[] = [...graph.edges];
  for (const t of traces) {
    edges.push({
      id: `${opts.idPrefix}:${t.source}->${t.target}:${t.token}`,
      source: t.source,
      target: t.target,
      kind: "trace",
      tvlUsd: t.usd,
      weight: Math.max(0.25, Math.min(1, Math.log10(t.usd + 1) / Math.log10(maxUsd + 1))),
      chain: t.chain,
      dir: "forward",
      label: opts.labelOf(t.token, t.usd, t.count),
      trace: { assetSymbol: t.token, amountUsd: t.usd, count: t.count, windowSec: t.windowSec, sampleTx: t.sampleTx, source: opts.source },
    });
  }
  return { ...graph, edges, notes: [...(graph.notes ?? []), `${opts.idPrefix}: ${traces.length}개 보강 엣지`] };
}

/**
 * Add only event-discovered trace edges between nodes that already exist in the flow graph.
 * No nodes are created here. If the current graph can already render a transaction on an
 * existing route, we leave it alone; trace edges are only for missing relationships revealed
 * by the live event feed.
 */
export function augmentGraphWithEventTraceEdges(graph: FlowGraph, txs: FlowTx[]): FlowGraph {
  if (!txs.length) return graph;
  const alreadyRendered = new Set<FlowTx>(buildRenderPlan(graph.nodes, graph.edges, txs, Number.MAX_SAFE_INTEGER).map((p) => p.tx));
  return addTraceEdges(
    graph,
    // wrap/unwrap 제외 — counterparty 가 "상대 토큰 심볼"이라 동명 마켓 노드에 오매칭되어
    // 가짜 의존성을 날조한다 (민트/소각이 counterparty null 로 자연 제외되는 것과 같은 취급).
    txs.filter((tx) => tx.kind !== "wrap" && tx.kind !== "unwrap")
      .map((tx) => ({ token: tx.token, chain: tx.chain, counterparty: tx.counterparty, kind: tx.kind, marketHint: tx.marketHint, direction: tx.direction, usd: tx.valueUsd, count: 1, sample: tx.hash, rendered: alreadyRendered.has(tx) })),
    { idPrefix: "event-trace", source: "event", windowSec: LIVE_WINDOW_SEC, labelOf: (token, usd, count) => `이벤트 흐름 ${token} ${fmtUsdShort(usd)} ×${count}` },
  );
}

/**
 * 평소(베이스라인) 트레이스 — 평소 흐름의 counterparty 가 그래프 노드로 해석되는데 기존 엣지가
 * 없으면, 그 "평소부터 존재하는 의존성"을 trace 엣지로 보강한다 (이벤트 트레이스와 같은 규칙).
 * windowSec 는 그 토큰의 실제 관측구간(coverage) — 24h 를 못 본 토큰에 24h 를 새기지 않는다.
 */
export function augmentGraphWithBaselineTraceEdges(graph: FlowGraph, rows: FlowBaselineRow[], coverage: FlowBaselineCoverage[]): FlowGraph {
  if (!rows.length) return graph;
  const router = buildRenderRouter(graph.nodes, graph.edges);
  const obsBySym = new Map(coverage.map((c) => [`${c.token.toUpperCase()}|${c.chain}`, c.observedSec] as const));
  return addTraceEdges(
    graph,
    rows.map((r) => ({
      token: r.token, chain: r.chain, counterparty: r.counterparty, kind: r.kind, marketHint: r.marketHint,
      direction: r.direction, usd: r.usd, count: r.count, sample: r.sampleTx,
      windowSec: r.observedSec ?? obsBySym.get(`${r.token.toUpperCase()}|${r.chain}`),
      rendered: !!router(r.token, r.chain, r.counterparty, r),
    })),
    { idPrefix: "baseline-trace", source: "baseline", windowSec: 24 * 3600, labelOf: (token, usd, count) => `평소 흐름 ${token} ${fmtUsdShort(usd)} ×${count}` },
  );
}

// ── 활동 집합 (하이라이팅) — "TX 가 하나라도 있는 노드·엣지"만 색을 유지하기 위한 단일 판정원 ──
export interface FlowActivity { nodeIds: Set<string>; edgeIds: Set<string> }

/**
 * 실시간 모드 활동 집합: 렌더 플랜(입자가 실제로 타는 hop)의 엣지·노드 + 트랜잭션이 있는 토큰
 * 노드(미해석 지갑 전송도 그 토큰에 활동이 있다는 신호) + trace 엣지(관측 흐름 그 자체).
 */
export function computeActivity<
  N extends NodeLite,
  Tx extends { token: string; chain: string; counterparty?: string | null; direction: "in" | "out"; kind?: string; marketHint?: string | null },
>(nodes: N[], edges: (EdgeLite & { id: string; kind: string })[], txs: Tx[]): FlowActivity {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const edgeByPair = new Map<string, string>();
  for (const e of edges) {
    edgeByPair.set(`${e.source}|${e.target}`, e.id);
    edgeByPair.set(`${e.target}|${e.source}`, e.id);
    if (e.kind === "trace") { edgeIds.add(e.id); nodeIds.add(e.source); nodeIds.add(e.target); }
  }
  for (const { hops } of buildRenderPlan(nodes, edges, txs, Number.MAX_SAFE_INTEGER)) {
    for (const [a, b] of hops) {
      nodeIds.add(a.id); nodeIds.add(b.id);
      const id = edgeByPair.get(`${a.id}|${b.id}`);
      if (id) edgeIds.add(id);
    }
  }
  const tokenByKey = new Map<string, N>();
  for (const n of nodes) if (n.kind === "token") tokenByKey.set(`${norm(n.label)}|${n.chain}`, n);
  for (const t of txs) {
    const n = tokenByKey.get(`${norm(t.token)}|${t.chain}`);
    if (n) nodeIds.add(n.id);
  }
  return { nodeIds, edgeIds };
}

/** 평소 모드 오버레이 — "평소에 얼마나 다니는가"를 그래프 **전체 엣지**에 입힌다:
 *  ① 실전송 스캔(rows)을 실시간과 같은 라우터로 엣지에 귀속 — 유입/유출·거래수 분리 집계
 *  ② 스캔이 못 덮은 DEX 엣지(volUsd 보유 — DeFiLlama 일거래량)는 24h 거래량으로 보충
 *  공유 엣지는 관측구간이 다른 토큰들의 합산일 수 있어 구간을 min/max 범위로 보존(정직 표기). */
export type BaselineEdgeStat = NonNullable<FlowEdge["baseline"]>;
export function buildBaselineOverlay(graph: FlowGraph, rows: FlowBaselineRow[], coverage: FlowBaselineCoverage[]): { edgeStats: Map<string, BaselineEdgeStat>; activity: FlowActivity } {
  const router = buildRenderRouter(graph.nodes, graph.edges);
  const edgeByPair = new Map<string, FlowEdge>();
  for (const e of graph.edges) { edgeByPair.set(`${e.source}|${e.target}`, e); edgeByPair.set(`${e.target}|${e.source}`, e); }
  const obsBySym = new Map(coverage.map((c) => [`${c.token.toUpperCase()}|${c.chain}`, c.observedSec] as const));
  const edgeStats = new Map<string, BaselineEdgeStat>();
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const tokenByKey = new Map(graph.nodes.filter((n) => n.kind === "token").map((n) => [`${norm(n.label)}|${n.chain}`, n] as const));
  for (const e of graph.edges) if (e.kind === "trace") { edgeIds.add(e.id); nodeIds.add(e.source); nodeIds.add(e.target); }
  const bump = (eid: string, r: FlowBaselineRow, observedSec: number) => {
    let cur = edgeStats.get(eid);
    if (!cur) {
      cur = { usd: 0, count: 0, usdPerHour: 0, txPerHour: 0, inUsdPerHour: 0, outUsdPerHour: 0, inTxPerHour: 0, outTxPerHour: 0, observedSecMin: observedSec, observedSecMax: observedSec, source: "scan", byToken: {} };
      edgeStats.set(eid, cur);
    }
    cur.usd += r.usd; cur.count += r.count; cur.usdPerHour += r.usdPerHour; cur.txPerHour += r.txPerHour;
    if (r.direction === "in") { cur.inUsdPerHour += r.usdPerHour; cur.inTxPerHour += r.txPerHour; }
    else { cur.outUsdPerHour += r.usdPerHour; cur.outTxPerHour += r.txPerHour; }
    cur.observedSecMin = Math.min(cur.observedSecMin, observedSec); cur.observedSecMax = Math.max(cur.observedSecMax, observedSec);
    // 토큰별 분해 — 평소 입자도 라이브처럼 "색=토큰"으로 칠하기 위함 (차선이 방향을 담당)
    const sym = r.token.toUpperCase();
    const bt = (cur.byToken ??= {});
    const slot = (bt[sym] ??= { inUsdPerHour: 0, outUsdPerHour: 0, volPerHour: 0 });
    if (r.direction === "in") slot.inUsdPerHour += r.usdPerHour; else slot.outUsdPerHour += r.usdPerHour;
    edgeIds.add(eid);
  };
  // ① 실전송 스캔 — 방향(유입/유출)·거래수까지 분리해 "양 비교"가 가능하게.
  //    랩/언랩 행은 기초↔파생(derive) 토큰-토큰 엣지에 귀속 (in=발행 방향, out=상환 방향).
  for (const r of rows) {
    if (r.kind === "wrap" || r.kind === "unwrap") {
      const a = tokenByKey.get(`${norm(r.token)}|${r.chain}`);
      const b = r.counterparty ? tokenByKey.get(`${norm(r.counterparty)}|${r.chain}`) : undefined;
      if (!a || !b) continue;
      const e = edgeByPair.get(`${a.id}|${b.id}`);
      if (!e) continue;
      nodeIds.add(a.id); nodeIds.add(b.id);
      bump(e.id, r, r.observedSec ?? obsBySym.get(`${r.token.toUpperCase()}|${r.chain}`) ?? 24 * 3600);
      continue;
    }
    const route = router(r.token, r.chain, r.counterparty, r);
    if (!route) continue;
    // 행별 관측구간 우선(렌딩 이벤트 행 = 정확히 24h), 없으면 토큰 전송-스캔 커버리지
    const observedSec = r.observedSec ?? obsBySym.get(`${r.token.toUpperCase()}|${r.chain}`) ?? 24 * 3600;
    for (let k = 0; k < route.length - 1; k++) {
      const e = edgeByPair.get(`${route[k].id}|${route[k + 1].id}`);
      if (!e) continue;
      nodeIds.add(route[k].id); nodeIds.add(route[k + 1].id);
      bump(e.id, r, observedSec);
    }
  }
  // ② DEX 엣지 보충 — 스캔이 못 덮은(초활성 토큰의 짧은 관측창 등) 풀/프로토콜 엣지는 DeFiLlama
  //    일거래량(volUsd)으로 평소 흐름을 채운다. 방향·건수는 집계원에 없으므로 0 으로 두고
  //    source:"volume" 으로 표기 — 지어내지 않는다. 스캔 값이 이미 있으면 source 만 mixed 로.
  //    토큰 귀속(입자 색): holds = 출발 토큰, market = 그 마켓의 대표 토큰.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const e of graph.edges) {
    if (e.kind !== "holds" && e.kind !== "market") continue;
    const vol = e.volUsd ?? 0;
    if (!(vol > 0)) continue;
    const cur = edgeStats.get(e.id);
    if (cur) { cur.source = "mixed"; continue; } // 스캔 실측 우선 — FlowDetail 이 일거래량을 별도 행으로 보여줌
    const sym = (e.kind === "holds" ? nodeById.get(e.source)?.label : nodeById.get(e.target)?.token)?.toUpperCase();
    edgeStats.set(e.id, {
      usd: vol, count: 0, usdPerHour: vol / 24, txPerHour: 0,
      inUsdPerHour: 0, outUsdPerHour: 0, inTxPerHour: 0, outTxPerHour: 0,
      observedSecMin: 24 * 3600, observedSecMax: 24 * 3600, source: "volume",
      byToken: sym ? { [sym]: { inUsdPerHour: 0, outUsdPerHour: 0, volPerHour: vol / 24 } } : {},
    });
    edgeIds.add(e.id); nodeIds.add(e.source); nodeIds.add(e.target);
  }
  // 평소 흐름이 관측된 토큰 노드도 활동으로 (행이 라우트되지 못해도 그 토큰에 흐름은 있었다)
  for (const r of rows) {
    const n = tokenByKey.get(`${norm(r.token)}|${r.chain}`);
    if (n) nodeIds.add(n.id);
  }
  return { edgeStats, activity: { nodeIds, edgeIds } };
}

/**
 * Client-side node filter — NO user dial. Tokens always shown. A node is kept when its EFFECTIVE
 * share of the token's total exposure (parent's effective share × share within the parent) is
 * >= minShare — per-parent-only rules let a 2% market inside a 1.2% protocol (0.02% overall)
 * through, and cumulative rules drag in the 80%/0.1%/0.1%… tail. Exceptions: the largest protocol
 * per token is always kept, and tx-active nodes are always pinned (+ parent chain + hinted market).
 * Real data only (edge tvlUsd / live txs).
 */
export function filterGraphByDetail(
  graph: FlowGraph,
  minShare: number,
  txs?: { counterparty?: string | null; token?: string; chain?: string; kind?: string; marketHint?: string | null }[],
): FlowGraph {
  const visible = new Set<string>();
  // "의미있다" = 토큰 전체 노출 대비 실효 비중(부모 실효 비중 × 부모 내 점유율)이 minShare 이상.
  // 부모-내-점유율만 보면 군소 프로토콜(토큰의 1.2%)의 2%짜리 마켓(전체의 0.02%)까지 통과해
  // 마켓이 범람한다. 프로토콜 레벨만 토큰당 최대 1개 보장; 마켓·볼트는 실효 비중으로만.
  const eff = new Map<string, number>();
  for (const n of graph.nodes) if (n.kind === "token") { visible.add(n.id); eff.set(n.id, 1); }
  // 브릿지 노드는 항상 표시 — 양끝이 토큰(항상 표시)이고, 락/민트 경유를 보는 게 목적.
  for (const n of graph.nodes) if (n.kind === "bridge") visible.add(n.id);
  // 비중 척도 = max(TVL, 일 거래량) — 스톡(렌딩)과 플로우(DEX)를 같은 컷에 태우기 위한 가시성
  // 휴리스틱 (사이즈만 보면 거래량 본진 Uniswap 이 잘린다 — 멘토 피드백).
  const groupBySource = (kind: string) => {
    const m = new Map<string, { id: string; usd: number }[]>();
    for (const e of graph.edges) if (e.kind === kind) { let a = m.get(e.source); if (!a) { a = []; m.set(e.source, a); } a.push({ id: e.target, usd: Math.max(e.tvlUsd, e.volUsd ?? 0) }); }
    return m;
  };
  // 서버가 카테고리 쿼터로 보장한 프로토콜(coreKeep) — 실효 비중과 무관하게 표시 + 그 안의
  // 최대 마켓 1개도 보장 (DEX 의 "LP 안 펼쳐짐" 방지).
  const coreKeepIds = new Set(graph.nodes.filter((n) => n.kind === "protocol" && n.meta?.coreKeep === true).map((n) => n.id));
  const cut = (groups: Map<string, { id: string; usd: number }[]>, guaranteeLargest: (parent: string) => boolean) => {
    for (const [parent, arr] of groups) {
      const pEff = eff.get(parent);
      if (pEff == null || !visible.has(parent)) continue;
      arr.sort((a, b) => b.usd - a.usd);
      const total = arr.reduce((s, x) => s + x.usd, 0) || 1;
      arr.forEach((x, i) => {
        const e = pEff * (x.usd / total);
        const prev = eff.get(x.id);
        if (prev == null || e > prev) eff.set(x.id, e); // 공유 노드(여러 토큰의 프로토콜)는 최대 실효 비중
        if (e >= minShare || (guaranteeLargest(parent) && i === 0)) visible.add(x.id);
      });
    }
  };
  cut(groupBySource("holds"), () => true);                       // token → protocols (토큰당 최대 1개는 항상)
  for (const id of coreKeepIds) visible.add(id);                 // 쿼터 보장 프로토콜은 항상 표시
  cut(groupBySource("market"), (p) => coreKeepIds.has(p));       // visible protocol → markets (+core 는 최대 마켓 보장)
  cut(groupBySource("vault"), () => false);                      // visible protocol/market → vaults (실효 비중만)
  // 브릿지 노드(검증·탐지된 것만 서버가 생성) — 부착된 토큰이 보이면 함께 표시
  for (const e of graph.edges) {
    if (e.kind === "bridge" && e.target.startsWith("bridge:") && visible.has(e.source)) visible.add(e.target);
  }
  // 파생(derive) 엣지 양끝은 항상 표시 — LP/랩 토큰이 떠 있는데 발행처(풀 마켓)가 숨으면
  // 머니레고 사슬(기초→풀→LP→재예치)이 중간에 끊긴다.
  for (const e of graph.edges) if (e.kind === "derive") { visible.add(e.source); visible.add(e.target); }
  // tx-active nodes are ALWAYS shown (+ parent chain, + 식별된 풀/리저브 마켓): a flow map must
  // render real activity even when the node sits below the share cutoff. Real recent transactions,
  // not TVL share, are the strongest signal.
  if (txs?.length) {
    const resolve = buildCpResolver(graph.nodes);
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const protoOfMarket = new Map<string, string>(), srcOfVault = new Map<string, string>();
    const marketsOfProto = new Map<string, FlowGraph["nodes"]>();
    for (const e of graph.edges) {
      if (e.kind === "market") {
        protoOfMarket.set(e.target, e.source);
        const t = byId.get(e.target);
        if (t) { const a = marketsOfProto.get(e.source); if (a) a.push(t); else marketsOfProto.set(e.source, [t]); }
      } else if (e.kind === "vault") srcOfVault.set(e.target, e.source);
    }
    for (const t of txs) {
      const n = resolve(t.counterparty, t.chain);
      if (!n) continue;
      visible.add(n.id);
      const m = srcOfVault.get(n.id);
      if (m) { visible.add(m); const p = protoOfMarket.get(m); if (p) visible.add(p); }
      const p2 = protoOfMarket.get(n.id);
      if (p2) visible.add(p2);
      if (n.kind === "protocol") {
        const mkt = findMarketChild(marketsOfProto.get(n.id), t.token ?? "", t);
        if (mkt) visible.add(mkt.id); // 실거래가 특정 마켓(풀/리저브)을 가리키면 그 마켓도 표시
      }
    }
  }
  return { ...graph, nodes: graph.nodes.filter((n) => visible.has(n.id)), edges: graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target)) };
}
