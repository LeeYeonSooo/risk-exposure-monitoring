/**
 * Shared counterparty → graph-node resolver. A transaction is "shown on the graph" iff its
 * counterparty resolves to a node here (protocol by name, or market/vault by its own label).
 * Used by both TxFlowLayer (to draw the particle) and FlowTxPanel (to float those tx to the top),
 * so the two never disagree about which transactions are actually rendered.
 */
import type { FlowGraph } from "./flow-types";

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
    const route = pathTo(src, dest);
    for (let k = 0; k < route.length - 1; k++) if (edgePair.has(`${route[k].id}|${route[k + 1].id}`)) return route; // >=1 drawable hop
    return null;
  };
}

/** Hard cap on total animated hops (perf). The SAME cap is applied to the count and the render via the
 *  shared plan below, so the two never diverge. */
export const MAX_RENDER_HOPS = 260;

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
  const groupBySource = (kind: string) => {
    const m = new Map<string, { id: string; usd: number }[]>();
    for (const e of graph.edges) if (e.kind === kind) { let a = m.get(e.source); if (!a) { a = []; m.set(e.source, a); } a.push({ id: e.target, usd: e.tvlUsd }); }
    return m;
  };
  const cut = (groups: Map<string, { id: string; usd: number }[]>, guaranteeLargest: boolean) => {
    for (const [parent, arr] of groups) {
      const pEff = eff.get(parent);
      if (pEff == null || !visible.has(parent)) continue;
      arr.sort((a, b) => b.usd - a.usd);
      const total = arr.reduce((s, x) => s + x.usd, 0) || 1;
      arr.forEach((x, i) => {
        const e = pEff * (x.usd / total);
        const prev = eff.get(x.id);
        if (prev == null || e > prev) eff.set(x.id, e); // 공유 노드(여러 토큰의 프로토콜)는 최대 실효 비중
        if (e >= minShare || (guaranteeLargest && i === 0)) visible.add(x.id);
      });
    }
  };
  cut(groupBySource("holds"), true);    // token → protocols (토큰당 최대 1개는 항상)
  cut(groupBySource("market"), false);  // visible protocol → markets (실효 비중만)
  cut(groupBySource("vault"), false);   // visible protocol/market → vaults (실효 비중만)
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
