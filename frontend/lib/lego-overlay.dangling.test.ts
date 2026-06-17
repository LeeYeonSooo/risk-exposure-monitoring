// 회귀: 베이스토큰 수용처 마켓 엣지가 "댕글링"(target 노드 부재) 되지 않아야 한다.
//   회장 반려 blocker: sUSDe 의 Morpho USDtb($92.9M)/DAI/USDT 베이스 마켓이 노드 없이 엣지만 허공으로 뻗음.
//   원인: concentric 이 morpho 마켓을 mcap(=7)개로 캡 → tokOverlap hit 이 캡 밖 마켓을 가리키거나,
//   addMarketNode 가 호출되지 않아 lego-base 엣지의 target 이 finalIds 에 없음.
//   이 테스트는 page.tsx 머지 파이프라인(merge → applyConcentricLayout → overlayLego)을 충실히 재현해
//   실데이터 스냅샷으로 모든 lego-base 엣지의 target 이 노드로 존재함을 보장한다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyConcentricLayout, type MorphoMkt, type PoolLike, type EulerVault } from "./concentric-layout";
import { overlayLego, type LegoApiNode, type LegoApiEdge } from "./lego-overlay";
import type { GraphEdge, GraphNode, TopologyResponse } from "./api";

// 고정 스냅샷(2026-06-13 라이브 API 캡처): /api/lego·/api/breadth·/api/topology 의 sUSDe 응답.
//   CI 결정론을 위해 라이브 호출 대신 리포 내 픽스처를 읽는다(데이터 회귀가 아니라 매핑 로직 회귀를 잡는 테스트).
const FIX = path.join(__dirname, "__fixtures__");
const lego = JSON.parse(readFileSync(path.join(FIX, "susde-lego.json"), "utf8")) as { nodes: LegoApiNode[]; edges: LegoApiEdge[] };
const breadthResp = JSON.parse(readFileSync(path.join(FIX, "susde-breadth.json"), "utf8"));
const topoResp = JSON.parse(readFileSync(path.join(FIX, "susde-topology.json"), "utf8"));

const sym = "sUSDe";

// page.tsx 60-66: dbNodes/dbEdges
const dbNodes = new Map<string, GraphNode>();
for (const n of topoResp.nodes ?? []) dbNodes.set(n.id, { id: n.id, type: n.type, label: n.label, metadata: { ...(n.metadata ?? {}), chain: n.chain }, active: true } as GraphNode);
const dbEdges = (topoResp.edges ?? []).map((e: { source: string; target: string; edge_type: string; weight: number; attrs: unknown }) => ({ id: `${e.source}__${e.target}`, source: e.source, target: e.target, type: e.edge_type, weight: e.weight, attrs: e.attrs as GraphEdge["attrs"] })) as GraphEdge[];

// page.tsx 82-92: tokenIdSet / relations
const want = sym.toLowerCase();
const ids = [...dbNodes.keys()].filter((id) => id.startsWith("token:") && id.replace("token:", "").split("@")[0].toLowerCase() === want);
const tokenIdSet = new Set(ids.length ? ids : [`token:${sym}`]);
interface Relation { edge: GraphEdge; otherId: string; otherLabel: string; direction: "in" | "out" }
const relations: Relation[] = dbEdges.filter((e) => tokenIdSet.has(e.source) || tokenIdSet.has(e.target)).map((e) => {
  const out = tokenIdSet.has(e.source); const otherId = out ? e.target : e.source;
  return { edge: e, otherId, otherLabel: dbNodes.get(otherId)?.label ?? otherId, direction: out ? ("out" as const) : ("in" as const) };
}).sort((a, b) => (b.edge.attrs?.core?.amountUsd ?? 0) - (a.edge.attrs?.core?.amountUsd ?? 0));

const breadth = breadthResp.items ?? [];
const morphoByChain: Record<string, MorphoMkt[]> = breadthResp.morphoMarkets ?? {};
const eulerByChain: Record<string, EulerVault[]> = breadthResp.eulerVaults ?? {};
const supplyByChain = breadthResp.supplyByChain ?? {};
const tokenAddr = breadthResp.tokenAddrByChain ?? {};

// page.tsx 95-126: merge
function prettyProject(p: string): string { return p; }
const mergedNodesM = new Map(dbNodes);
const mergedRelations: Relation[] = [...relations];
const tok = [...tokenIdSet][0] ?? `token:${sym}`;
for (const b of breadth) {
  const id = `protocol:dl:${b.project}@${b.chain}`;
  const lbl = prettyProject(b.project);
  if (!mergedNodesM.has(id)) mergedNodesM.set(id, { id, type: "DefiProtocol", label: lbl, metadata: { chain: b.chain, venue: b.project, sizeUsd: b.tvlUsd, category: "", dataSource: "defillama-live" }, active: true } as GraphNode);
  const attrs = { core: { amountUsd: b.tvlUsd }, meta: { dataSource: "defillama-live" } } as unknown as GraphEdge["attrs"];
  mergedRelations.push({ edge: { id: `be:${id}`, source: tok, target: id, type: "collateral", weight: b.tvlUsd, attrs } as GraphEdge, otherId: id, otherLabel: lbl, direction: "out" });
}
for (const [chain, mks] of Object.entries(morphoByChain)) {
  if (!mks.length || [...mergedNodesM.values()].some((n) => n.metadata.chain === chain && /morpho/i.test(n.id))) continue;
  const id = `protocol:dl:morpho-blue@${chain}`;
  const tvl = mks.reduce((s, m) => s + (m.supplyUsd || 0), 0);
  mergedNodesM.set(id, { id, type: "DefiProtocol", label: "Morpho Blue", metadata: { chain, venue: "morpho-blue", sizeUsd: tvl, category: "", dataSource: "morpho-api" }, active: true } as GraphNode);
  const attrs = { core: { amountUsd: tvl }, meta: { dataSource: "morpho-api" } } as unknown as GraphEdge["attrs"];
  mergedRelations.push({ edge: { id: `me:${id}`, source: tok, target: id, type: "collateral", weight: tvl, attrs } as GraphEdge, otherId: id, otherLabel: "Morpho Blue", direction: "out" });
}
for (const [chain, vs] of Object.entries(eulerByChain)) {
  if (!vs.length || [...mergedNodesM.values()].some((n) => n.metadata.chain === chain && /euler/i.test(n.id))) continue;
  const id = `protocol:dl:euler-v2@${chain}`;
  const tvl = vs.reduce((s, v) => s + (v.allocationUsd || 0), 0);
  mergedNodesM.set(id, { id, type: "DefiProtocol", label: "Euler", metadata: { chain, venue: "euler-v2", sizeUsd: tvl, category: "", dataSource: "euler-api" }, active: true } as GraphNode);
  const attrs = { core: { amountUsd: tvl }, meta: { dataSource: "euler-api" } } as unknown as GraphEdge["attrs"];
  mergedRelations.push({ edge: { id: `ee:${id}`, source: tok, target: id, type: "collateral", weight: tvl, attrs } as GraphEdge, otherId: id, otherLabel: "Euler", direction: "out" });
}

// page.tsx 128-159: chains / topChain → 기본은 top 체인만, 나머지 hidden
const chains = (() => {
  const s = new Set<string>();
  for (const r of mergedRelations) s.add((mergedNodesM.get(r.otherId)?.metadata.chain as string) ?? "ethereum");
  const order = ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis", "linea", "scroll"];
  return [...s].sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
})();
const topChain = (() => {
  const tvl = new Map<string, number>();
  for (const r of mergedRelations) {
    const ch = (mergedNodesM.get(r.otherId)?.metadata.chain as string) ?? "ethereum";
    const usd = r.edge.attrs?.core?.amountUsd ?? r.edge.weight ?? 0;
    tvl.set(ch, (tvl.get(ch) ?? 0) + (typeof usd === "number" ? usd : 0));
  }
  let top = chains[0]; let max = -1;
  for (const [ch, v] of tvl) if (v > max) { max = v; top = ch; }
  return top;
})();
const hiddenChains = new Set(chains.filter((c) => c !== topChain));

// page.tsx 164-169: poolsByKey
const poolsByKey = new Map<string, PoolLike[]>();
for (const b of breadth) poolsByKey.set(`${b.chain}|${b.project.replace(/_/g, "-").toLowerCase()}`, b.pools ?? []);

function buildLego(includeMarkets: boolean, includeVaults: boolean): TopologyResponse {
  const { topology: subTopology } = applyConcentricLayout({ symbol: sym, tokenIds: tokenIdSet, relations: mergedRelations, dbNodes: mergedNodesM, hiddenChains, poolsByKey, tokenAddrByChain: tokenAddr, includeMarkets, includeVaults, morphoByChain, eulerByChain, supplyByChain, bridgeAuthByChain: {}, bridgeHub: false });
  return overlayLego(subTopology, lego, hiddenChains);
}

describe("lego-overlay 베이스토큰 수용처 마켓 — 댕글링 엣지 금지 (회장 blocker 회귀)", () => {
  for (const [label, includeMarkets, includeVaults] of [["curator", true, true], ["market", true, false]] as const) {
    it(`${label} 깊이: 모든 엣지의 source/target 이 노드로 존재한다`, () => {
      const topo = buildLego(includeMarkets, includeVaults);
      const nodeIds = new Set(topo.nodes.map((n) => n.id));
      const dangling = topo.edges.filter((e) => !nodeIds.has(e.source) || !nodeIds.has(e.target));
      expect(dangling.map((e) => e.id)).toEqual([]);
    });

    it(`${label} 깊이: 토큰은 프로토콜과만 직접 연결 — 토큰→마켓/볼트/파생 직결 엣지가 없다 (사용자 2026-06-13)`, () => {
      const topo = buildLego(includeMarkets, includeVaults);
      const nodeById = new Map(topo.nodes.map((n) => [n.id, n] as const));
      const tokenEdges = topo.edges.filter((e) => /^c:[^:]+:token$/.test(e.source));
      expect(tokenEdges.length).toBeGreaterThan(0);
      // 토큰에서 나가는 엣지의 대상은 항상 프로토콜/브릿지여야 함(마켓 _market·볼트 _vault·:m 동심원마켓·파생 금지).
      const badTargets = tokenEdges.filter((e) => {
        const t = nodeById.get(e.target);
        return !t || t.metadata._market != null || t.metadata._vault != null || /:m\d+$/.test(e.target) || t.type === "DerivativeToken";
      });
      expect(badTargets.map((e) => `${e.id} → ${e.target}`)).toEqual([]);
    });

    it(`${label} 깊이: sUSDe 베이스 USDtb($92.9M)/DAI/USDT Morpho 마켓이 각자 고유 노드로 렌더된다`, () => {
      const topo = buildLego(includeMarkets, includeVaults);
      const nodeById = new Map(topo.nodes.map((n) => [n.id, n] as const));
      // 베이스토큰 수용처 = 프로토콜→마켓(lego-bmkt) 엣지. 담보 USD(weight_usd)를 이 엣지가 싣는다(자금추적 정본).
      //   토큰→마켓 직결은 폐지(위 테스트). 모든 lego-bmkt 엣지가 살아있는 마켓 노드를 가리켜야 함.
      const baseEdges = topo.edges.filter((e) => e.id.startsWith("lego-bmkt:"));
      expect(baseEdges.length).toBeGreaterThan(0);
      for (const e of baseEdges) expect(nodeById.has(e.target), `base edge ${e.id} → ${e.target} missing`).toBe(true);

      // ★blocker 핵심★ 최대 노출 USDtb($92.9M) base Morpho 마켓이 자기 주소 노드(legomkt:morpho_blue:...)로 존재하고
      //   라벨이 USDtb 이며 엣지 금액이 $92.9M 이어야 한다. (옛 버그: tokOverlap 'usdtb'.startsWith('usdt') 로
      //   USDe/USDT 동심원 노드 m3 에 빨려들어가 오기·은폐됐다.)
      const usdtbEdge = baseEdges.find((e) => (e.attrs?.core?.amountUsd ?? 0) > 9e7);
      expect(usdtbEdge, "USDtb $92.9M base edge 없음").toBeTruthy();
      const usdtbNode = nodeById.get(usdtbEdge!.target);
      expect(usdtbNode?.id.includes("morpho_blue")).toBe(true);     // 자기 주소 노드(동심원 :m 아님)
      expect(/USDtb/i.test(String(usdtbNode?.label))).toBe(true);   // USDe/USDT 로 오기되지 않음

      // 같은 Morpho 프로토콜의 USDtb / USDT base 마켓은 서로 다른 노드여야 한다(콜리전 금지).
      const usdtEdge = baseEdges.find((e) => { const n = nodeById.get(e.target); return n && /^USDT$/i.test(String(n.label)); });
      expect(usdtEdge, "USDT base edge 없음").toBeTruthy();
      expect(usdtEdge!.target).not.toBe(usdtbEdge!.target);
    });
  }
});
