"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Activity, X } from "lucide-react";

import { AlertDock } from "@/components/AlertDock";
import { SiteHeader } from "@/components/SiteHeader";
import { chainOptions } from "@/lib/chains-ui";
import { BridgeView } from "@/components/bridge/BridgeView";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { TokenDossier, type DossierData } from "@/components/graph/TokenDossier";
import { ADDR_EXPLORER, PRow, TokenSpecRows, pct1, sevDots, shortAddr, useNodeAlertCounts } from "@/components/panel/spec";
import { SAFE_NODE_STATE, formatUsd, type GraphEdge, type GraphNode, type LstFlowData, type NodeTickState, type RelationDetailMetrics, type RelationMarketRow } from "@/lib/api";
import { normalizeToBoost, pageRank, usdLogWeight } from "@/lib/centrality";
import { applyConcentricLayout, type PoolLike, type MorphoMkt, type EulerVault } from "@/lib/concentric-layout";
import { overlayLego, type LegoApiEdge, type LegoApiNode } from "@/lib/lego-overlay";
import { mapAlertsToNodeRisk, type RiskAlertLike } from "@/lib/alert-link";
import { deOverlapConcentric } from "@/lib/deoverlap-layout";
import { relayoutConcentric } from "@/lib/concentric-relayout";
import { applyTreeLayout } from "@/lib/tree-layout";
import { EDGE_GROUPS, EDGE_TYPE_COLORS, EDGE_TYPE_LABELS } from "@/lib/edge-colors";

interface Relation { edge: GraphEdge; otherId: string; otherLabel: string; direction: "out" | "in" }
interface BreadthItem { chain: string; project: string; tvlUsd: number; category: string | null; pools: PoolLike[] }
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
// DeFiLlama apy 는 이미 퍼센트 단위(예: 5.99 = 5.99%)
const apyFmt = (n: number | null | undefined) => (n == null ? "—" : n < 0.01 ? "~0%" : `${n.toFixed(2)}%`);
// breadth 프로토콜 슬러그 → 보기 좋은 라벨 (aave-v3 → Aave V3, sky-lending → Sky Lending)
const prettyProject = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function TokenPage() {
  const params = useParams<{ symbol: string }>();
  const sym = decodeURIComponent(params.symbol);
  // 탭 → 직교 컨트롤(깊이·형태). 스코프(체인내부/체인간)는 하나로 합침 — 여러 체인이면 자동으로
  // 컴팩트+브릿지(매크로), 한 체인만 보면 풀 디테일(마이크로). 멘탈모델 1개.
  const [depth, setDepth] = useState<"protocol" | "market" | "curator">("curator"); // 기본 = +큐레이터 고정 (머니레고 끝단까지)
  // 보기: 관계맵(단일 체인 머니레고) / 브릿지 뷰(크로스체인 브릿지 + 실시간 트랜잭션 입자)
  const [view, setView] = useState<"map" | "bridge">("map");
  const [shape, setShape] = useState<"tree" | "concentric">("tree"); // 관계맵 형태: 트리(위→아래) 기본 / 동심원
  const [panelOpen, setPanelOpen] = useState(true);             // 우측 상세 패널 토글 (관계맵 전용)
  const [hiddenChains, setHiddenChains] = useState<Set<string>>(new Set());        // 체크 해제된(숨긴) 체인
  const [dbNodes, setDbNodes] = useState<Map<string, GraphNode>>(new Map());
  const [dbEdges, setDbEdges] = useState<GraphEdge[]>([]);
  const [picked, setPicked] = useState<Record<string, unknown> | null>(null);
  const [dossier, setDossier] = useState<DossierData | null>(null);
  const [dossierLoading, setDossierLoading] = useState(true);
  const [lstFlow, setLstFlow] = useState<LstFlowData | null>(null);
  const [lstFlowLoading, setLstFlowLoading] = useState(false);
  const [breadth, setBreadth] = useState<BreadthItem[]>([]);
  const [tokenAddr, setTokenAddr] = useState<Record<string, string>>({});
  const [morphoByChain, setMorphoByChain] = useState<Record<string, MorphoMkt[]>>({});
  const [eulerByChain, setEulerByChain] = useState<Record<string, EulerVault[]>>({});
  const [supplyByChain, setSupplyByChain] = useState<Record<string, { supply: number; supplyUsd: number }>>({});
  const [relationDetailsByKey, setRelationDetailsByKey] = useState<Record<string, RelationDetailMetrics>>({});
  const [bridgeAuth, setBridgeAuth] = useState<Record<string, { bridgeAddr: string; authType: string; mintLimit: number | null; note: string | null }[]>>({});
  const [breadthLoading, setBreadthLoading] = useState(false); // 라이브 데이터 수집 중
  // 머니레고 레이어 — 파생토큰(PT/YT/LP/aToken) + 구조 엣지 (snapshot-lego 적재분)
  const [lego, setLego] = useState<{ nodes: LegoApiNode[]; edges: LegoApiEdge[] }>({ nodes: [], edges: [] });
  const [showDerivs, setShowDerivs] = useState(true);

  useEffect(() => {
    // 이 토큰의 정밀(DB) 서브그래프만 온디맨드로 — 전체 스냅샷(/api/graph) 통째로 받지 않음.
    fetch(`/api/topology/${encodeURIComponent(sym)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const nodes = new Map<string, GraphNode>();
      for (const n of d.nodes ?? []) nodes.set(n.id, { id: n.id, type: n.type, label: n.label, metadata: { ...(n.metadata ?? {}), chain: n.chain }, active: true } as GraphNode);
      setDbNodes(nodes);
      setDbEdges((d.edges ?? []).map((e: { source: string; target: string; edge_type: string; weight: number; attrs: unknown }) => ({ id: `${e.source}__${e.target}`, source: e.source, target: e.target, type: e.edge_type, weight: e.weight, attrs: e.attrs as GraphEdge["attrs"] })));
    }).catch(() => { setDbNodes(new Map()); setDbEdges([]); });
    // dossier(판결 바 + 우측 도시에 공유) — 페이지에서 한 번만 받아 양쪽에 내려줌.
    setDossier(null); setDossierLoading(true);
    fetch(`/api/dossier/${encodeURIComponent(sym)}`, { cache: "no-store" }).then((r) => r.json()).then((j) => setDossier(j)).catch(() => {}).finally(() => setDossierLoading(false));
    // LST/LRT 발행·상환·출금큐 흐름 — 별도 API로 분리해 그래프 로딩을 막지 않음.
    setLstFlow(null); setLstFlowLoading(true);
    fetch(`/api/lst-flow/${encodeURIComponent(sym)}`, { cache: "no-store" }).then((r) => r.json()).then((j) => setLstFlow(j)).catch(() => {}).finally(() => setLstFlowLoading(false));
    // breadth(전 체인 DeFiLlama 라이브) — DB 가 못 잡는 체인/프로토콜/마켓·풀까지 으아아악 수집
    setBreadth([]); setTokenAddr({}); setMorphoByChain({}); setEulerByChain({}); setSupplyByChain({}); setRelationDetailsByKey({}); setBridgeAuth({}); setBreadthLoading(true);
    fetch(`/api/breadth/${encodeURIComponent(sym)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => { setBreadth(d.items ?? []); setTokenAddr(d.tokenAddrByChain ?? {}); setMorphoByChain(d.morphoMarkets ?? {}); setEulerByChain(d.eulerVaults ?? {}); setSupplyByChain(d.supplyByChain ?? {}); setRelationDetailsByKey(d.relationDetailsByKey ?? {}); }).catch(() => {}).finally(() => setBreadthLoading(false));
    fetch(`/api/bridge-authority/${encodeURIComponent(sym)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => setBridgeAuth(d.byChain ?? {})).catch(() => {});
    // 머니레고 구조 (파생토큰·수용처) — 없으면 빈 배열(레이어 안 그림)
    setLego({ nodes: [], edges: [] });
    fetch(`/api/lego/${encodeURIComponent(sym)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => setLego({ nodes: d.nodes ?? [], edges: d.edges ?? [] })).catch(() => {});
    setPicked(null);
  }, [sym]);

  // 같은 심볼의 체인별 토큰 노드(token:USDC, token:USDC@base, token:USDC@arbitrum) 통합 →
  // 엣지가 여러 체인에 걸치게 되고, 동심원이 체인별 원으로 갈라짐.
  const tokenIdSet = useMemo(() => {
    const want = sym.toLowerCase();
    const ids = [...dbNodes.keys()].filter((id) => id.startsWith("token:") && id.replace("token:", "").split("@")[0].toLowerCase() === want);
    return new Set(ids.length ? ids : [`token:${sym}`]);
  }, [dbNodes, sym]);
  const relations: Relation[] = useMemo(() =>
    dbEdges.filter((e) => tokenIdSet.has(e.source) || tokenIdSet.has(e.target)).map((e) => {
      const out = tokenIdSet.has(e.source); const otherId = out ? e.target : e.source;
      return { edge: e, otherId, otherLabel: dbNodes.get(otherId)?.label ?? otherId, direction: out ? ("out" as const) : ("in" as const) };
    }).sort((a, b) => (b.edge.attrs?.core?.amountUsd ?? 0) - (a.edge.attrs?.core?.amountUsd ?? 0)),
    [dbEdges, dbNodes, tokenIdSet]);

  // breadth(DeFiLlama 라이브) 머지 — DB 미수집 체인·프로토콜 보강. concentric 가 정밀 우선 dedup.
  const { mergedRelations, mergedNodes } = useMemo(() => {
    if (!breadth.length && !Object.keys(morphoByChain).length && !Object.keys(eulerByChain).length) return { mergedRelations: relations, mergedNodes: dbNodes };
    const nodes = new Map(dbNodes);
    const rels: Relation[] = [...relations];
    const tok = [...tokenIdSet][0] ?? `token:${sym}`;
    for (const b of breadth) {
      const id = `protocol:dl:${b.project}@${b.chain}`;
      const lbl = prettyProject(b.project);
      if (!nodes.has(id)) nodes.set(id, { id, type: "DefiProtocol", label: lbl, metadata: { chain: b.chain, venue: b.project, sizeUsd: b.tvlUsd, category: "", dataSource: "defillama-live" }, active: true } as GraphNode);
      const attrs = { core: { amountUsd: b.tvlUsd }, meta: { dataSource: "defillama-live" } } as unknown as GraphEdge["attrs"];
      rels.push({ edge: { id: `be:${id}`, source: tok, target: id, type: "collateral", weight: b.tvlUsd, attrs } as GraphEdge, otherId: id, otherLabel: lbl, direction: "out" });
    }
    // Morpho 노드 보강 — 라이브 Morpho 마켓이 있는 체인엔 Morpho 프로토콜 노드 보장(DeFiLlama 미수록 체인 포함)
    for (const [chain, mks] of Object.entries(morphoByChain)) {
      if (!mks.length || [...nodes.values()].some((n) => n.metadata.chain === chain && /morpho/i.test(n.id))) continue;
      const id = `protocol:dl:morpho-blue@${chain}`;
      const tvl = mks.reduce((s, m) => s + (m.supplyUsd || 0), 0);
      nodes.set(id, { id, type: "DefiProtocol", label: "Morpho Blue", metadata: { chain, venue: "morpho-blue", sizeUsd: tvl, category: "", dataSource: "morpho-api" }, active: true } as GraphNode);
      const attrs = { core: { amountUsd: tvl }, meta: { dataSource: "morpho-api" } } as unknown as GraphEdge["attrs"];
      rels.push({ edge: { id: `me:${id}`, source: tok, target: id, type: "collateral", weight: tvl, attrs } as GraphEdge, otherId: id, otherLabel: "Morpho Blue", direction: "out" });
    }
    // Euler 노드 보강 — Euler Earn 큐레이터 볼트가 있는 체인엔 Euler 노드 보장
    for (const [chain, vs] of Object.entries(eulerByChain)) {
      if (!vs.length || [...nodes.values()].some((n) => n.metadata.chain === chain && /euler/i.test(n.id))) continue;
      const id = `protocol:dl:euler-v2@${chain}`;
      const tvl = vs.reduce((s, v) => s + (v.allocationUsd || 0), 0);
      nodes.set(id, { id, type: "DefiProtocol", label: "Euler", metadata: { chain, venue: "euler-v2", sizeUsd: tvl, category: "", dataSource: "euler-api" }, active: true } as GraphNode);
      const attrs = { core: { amountUsd: tvl }, meta: { dataSource: "euler-api" } } as unknown as GraphEdge["attrs"];
      rels.push({ edge: { id: `ee:${id}`, source: tok, target: id, type: "collateral", weight: tvl, attrs } as GraphEdge, otherId: id, otherLabel: "Euler", direction: "out" });
    }
    return { mergedRelations: rels, mergedNodes: nodes };
  }, [relations, dbNodes, breadth, morphoByChain, eulerByChain, tokenIdSet, sym]);

  const chains = useMemo(() => {
    const s = new Set<string>();
    for (const r of mergedRelations) s.add((mergedNodes.get(r.otherId)?.metadata.chain as string) ?? "ethereum");
    const order = ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis", "linea", "scroll"];
    return [...s].sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
  }, [mergedRelations, mergedNodes]);
  // 관계맵·흐름맵 공통 체인 목록 = 실데이터 가능 전체 ∪ 이 토큰의 실제 노출 체인.
  const chainOpts = useMemo(() => chainOptions(chains), [chains]);

  // 체인별 TVL → 최고 TVL 체인(기본 표시 대상).
  const topChain = useMemo(() => {
    const tvl = new Map<string, number>();
    for (const r of mergedRelations) {
      const ch = (mergedNodes.get(r.otherId)?.metadata.chain as string) ?? "ethereum";
      const usd = r.edge.attrs?.core?.amountUsd ?? r.edge.weight ?? 0;
      tvl.set(ch, (tvl.get(ch) ?? 0) + (typeof usd === "number" ? usd : 0));
    }
    let top = chains[0];
    let max = -1;
    for (const [ch, v] of tvl) if (v > max) { max = v; top = ch; }
    return top;
  }, [mergedRelations, mergedNodes, chains]);

  // 관계맵 기본 포맷 = 가장 TVL 높은 체인 하나만. 사용자가 칩을 직접 만지기 전까지 자동 유지.
  const userToggledChains = useRef(false);
  useEffect(() => { userToggledChains.current = false; }, [sym]);
  useEffect(() => {
    if (userToggledChains.current) return;
    if (!topChain) return;
    // 기본은 top 체인만 보이게 — 나머지 공통 체인은 꺼두고 사용자가 켬.
    setHiddenChains(new Set(chainOpts.map((c) => c.key).filter((c) => c !== topChain)));
  }, [chainOpts, topChain]);

  const tokenNode: GraphNode = useMemo(() => dbNodes.get(`token:${sym}`) ?? dbNodes.get([...tokenIdSet][0]) ?? ({ id: `token:${sym}`, type: "Token", label: sym, metadata: { symbol: sym, chain: "ethereum" }, active: true } as GraphNode), [dbNodes, tokenIdSet, sym]);
  const state: NodeTickState = SAFE_NODE_STATE;

  // breadth 풀을 (체인|정규화슬러그) → 풀목록 으로. concentric 이 프로토콜별 마켓/풀 링2 로 씀.
  const poolsByKey = useMemo(() => {
    const m = new Map<string, PoolLike[]>();
    for (const b of breadth) m.set(`${b.chain}|${b.project.replace(/_/g, "-").toLowerCase()}`, b.pools ?? []);
    return m;
  }, [breadth]);

  // 깊이 → 레이아웃 옵션
  const includeMarkets = depth !== "protocol";   // 마켓·큐레이터 깊이 → 마켓 링 on
  const includeVaults = depth === "curator";     // 큐레이터 깊이 → 볼트 링까지
  // 합쳐진 스코프: 보이는 체인 2개+ → 매크로(컴팩트 그리드 + 체인 간 브릿지), 1개 → 마이크로(풀 디테일).
  const visibleChainCount = chains.filter((c) => !hiddenChains.has(c)).length;
  const bridgeHub = visibleChainCount > 1;

  // 4-링 동심원(체인별 원): 토큰→프로토콜→마켓/풀→볼트. GraphCanvas staticLayout 으로 고정 렌더.
  const [selNode, setSelNode] = useState<string | null>(null);
  const { topology: subTopology } = useMemo(
    () => applyConcentricLayout({ symbol: sym, tokenIds: tokenIdSet, relations: mergedRelations, dbNodes: mergedNodes, hiddenChains, poolsByKey, tokenAddrByChain: tokenAddr, includeMarkets, includeVaults, morphoByChain, eulerByChain, supplyByChain, relationDetailsByKey, bridgeAuthByChain: bridgeAuth, bridgeHub }),
    [sym, tokenIdSet, mergedRelations, mergedNodes, hiddenChains, poolsByKey, tokenAddr, includeMarkets, includeVaults, morphoByChain, eulerByChain, supplyByChain, relationDetailsByKey, bridgeAuth, bridgeHub],
  );
  // 머니레고 오버레이 — 동심원 위에 파생토큰 노드·구조 엣지를 얹음 (토글로 끔/켬, B11 때 정식 레이아웃)
  const legoTopology = useMemo(() => {
    const base = showDerivs ? overlayLego(subTopology, lego, hiddenChains) : subTopology;
    // C14/C15→C1: 노드 크기 = 규모(TVL) 단일이 아니라 "연결성"도 반영. 단순 차수 대신 진짜 PageRank
    // (엣지 방향 그대로 + log1p(USD) 가중) — 많은 파생/토큰이 거쳐가는 허브일수록 크게 (멘토 §6).
      const deg = new Map<string, number>(); // 무방향 차수 — 제외 규칙(연결 2 미만)용으로만 유지
    for (const e of base.edges) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); }
    // USD 추출: attrs.core.amountUsd 우선, 없으면 weight(>1 만 — 0.2/0.3/1 류는 구조 상수라 USD 아님)
    const pr = pageRank(base.nodes, base.edges.map((e) => ({
      source: e.source, target: e.target,
      weight: usdLogWeight(e.attrs?.core?.amountUsd ?? (typeof e.weight === "number" && e.weight > 1 ? e.weight : null)),
    })));
    // 제외 규칙 유지: Token/체인라벨/파생토큰(40px 고정 디자인) + 연결 2 미만은 boost 없음.
    // 나머지 후보의 PR 점수만 [1.0, 1.7] 로 정규화 → 기존 캡(1.7x) 의미 보존.
    const eligible = new Map<string, number>();
    for (const n of base.nodes) {
      if ((deg.get(n.id) ?? 0) < 2 || n.type === "Token" || n.type === "IslandHandle" || n.type === "DerivativeToken") continue;
      eligible.set(n.id, pr.get(n.id) ?? 0);
    }
    const boostById = normalizeToBoost(eligible, 1, 1.4); // 최저=1.0, 최고=1.4 (1.7→1.4: 부스트가 큰 프로토콜에 곱해져 크기 차이를 키우던 것 완화 — 사용자 2026-06-13)
    const nodes = base.nodes.map((n) => {
      const boost = boostById.get(n.id);
      return boost === undefined ? n : { ...n, metadata: { ...n.metadata, connImportance: boost } };
    });
    // 형태: 트리(토큰 root 최상단, 위→아래 계층) 또는 동심원(토큰 중심 링).
    if (shape === "tree") return applyTreeLayout({ ...base, nodes }, hiddenChains);
    // 동심원: 브릿지 허브가 아니면 역할 기반 동심원 재배치(합성 프로토콜 포함 전부 링1, 마켓은 부모 wedge 링2 동심 arc)
    //   → 마켓 많은 합성 프로토콜이 한쪽 부챗살로 뻗던 것 제거. 그 뒤 deOverlap 으로 잔여 겹침만 미세 조정.
    const ring = bridgeHub ? { ...base, nodes } : relayoutConcentric({ ...base, nodes }, hiddenChains);
    return deOverlapConcentric(ring);
  }, [subTopology, lego, hiddenChains, showDerivs, shape, bridgeHub]);
  const subNodeById = useMemo(() => { const m = new Map<string, GraphNode>(); for (const n of legoTopology.nodes) m.set(n.id, n); return m; }, [legoTopology]);
  const subNodeStates = useMemo(() => {
    // 노드 위험색 — 엔진이 이미 판정해 적재한 알림(dossier.alerts)을 노드에 결정론적으로 매핑(alert-link 순수 함수).
    //   ouroboros(같은 계열 담보↔대출) 류 추정 휴리스틱은 쓰지 않음. critical→danger(빨강)·warning→caution(노랑).
    const riskById = mapAlertsToNodeRisk(
      (dossier?.alerts ?? []) as RiskAlertLike[],
      // _market(loan·lltv) 도 넘겨 마켓 단위 조인(같은 프로토콜이라도 알림이 가리킨 그 마켓만 위험색).
      legoTopology.nodes.map((n) => ({ id: n.id, metadata: { venue: n.metadata.venue, brandSlug: n.metadata.brandSlug, _market: n.metadata._market } })),
    );
    const m: Record<string, NodeTickState> = {};
    for (const n of legoTopology.nodes) {
      const risk = riskById.get(n.id);
      m[n.id] = risk ? { ...SAFE_NODE_STATE, riskLevel: risk } : SAFE_NODE_STATE;
    }
    return m;
  }, [legoTopology, dossier]);

  const distributionRows = useMemo(() => {
    const grouped = new Map<string, { label: string; usd: number; pct: number; chain: string }>();
    for (const n of subTopology.nodes) {
      if (n.type !== "DefiProtocol") continue;
      if (n.metadata._market || n.metadata._vault) continue;
      const pct = n.metadata.distributionPct ?? 0;
      const usd = n.metadata.sizeUsd ?? 0;
      if (!(pct > 0) || !(usd > 0)) continue;
      const key = n.label;
      const prior = grouped.get(key) ?? { label: n.label, usd: 0, pct: 0, chain: (n.metadata.chain as string) ?? "multi" };
      prior.usd += usd;
      prior.pct += pct;
      grouped.set(key, prior);
    }
    return [...grouped.values()].sort((a, b) => b.pct - a.pct).slice(0, 6);
  }, [subTopology]);

  // Tier 0 판결 — 맵을 어떻게 돌리든 안 변하는 "이 토큰 위험한가" 한 줄.
  // 집중도(HHI)는 우측 도시에와 같은 relations(정밀) 기준으로 계산 → 두 곳 수치 일치.
  const verdict = useMemo(() => {
    const exp = relations.map((r) => r.edge.attrs?.core?.amountUsd ?? r.edge.weight ?? 0).filter((x) => x > 0);
    const total = exp.reduce((s, x) => s + x, 0) || 1;
    const hhi = exp.reduce((s, x) => s + (x / total) ** 2, 0);
    const conc = hhi >= 0.4 ? "높음" : hhi >= 0.2 ? "중간" : "낮음";
    const ac = dossier?.alertCounts ?? {};
    const crit = ac.critical ?? 0, warn = ac.warning ?? 0, info = ac.info ?? 0;
    const supply24h = dossier?.supply24hChangePct ?? null;

    // 디페그 — DB 알림(kind=depeg) 이력 기준 (현재 peg 피드가 페이지엔 없음 → 엔진이 이미 판정한 알림 사용).
    const depegAlerts = (dossier?.alerts ?? []).filter((a) => a.kind === "depeg");
    const depegCrit = depegAlerts.some((a) => a.severity === "critical");
    const depeg = depegAlerts.length > 0;

    // 하드코딩/고정 오라클 — 디페그가 온체인 가격에 안 잡혀 청산이 지연/불가 → bad debt 조용히 누적(설계 §1.4).
    // 단, RWA(국채/펀드형)는 NAV 대비 의도적 디스카운트 고정이 정상 설계(mF-ONE 류) → 위험에서 제외(P2-8).
    const RWA_KEYS = ["MF1", "MF-ONE", "MFONE", "RWA", "TBILL", "USTB", "BUIDL", "OUSG", "USYC", "USYE", "USCC", "JTRSY", "USDY"];
    const isRwa = RWA_KEYS.some((k) => sym.toUpperCase().includes(k));
    const hardOracleProtos = new Set<string>();
    const rwaDiscountProtos = new Set<string>();
    for (const r of relations) {
      const o = r.edge.attrs?.oracle;
      const key = o ? `${o.type ?? ""} ${o.provider ?? ""}` : "";
      if (/hard|fixed|nav|rwa/i.test(key)) {
        if (isRwa) rwaDiscountProtos.add(r.otherLabel); // RWA 의도적 디스카운트 = 정상 설계
        else hardOracleProtos.add(r.otherLabel);        // 비-RWA 하드코딩 = 위험
      }
    }
    const hardOracle = hardOracleProtos.size > 0;
    const rwaDiscount = rwaDiscountProtos.size > 0;

    // 무담보민팅 — Detector A(unbacked_supply: Σremote>backing) / Detector B(unmatched_mint: 소스 burn 없는 mint). Kelp rsETH형.
    const unbackedAlerts = (dossier?.alerts ?? []).filter((a) => a.kind === "unbacked_supply" || a.kind === "unmatched_mint");
    const unbackedCrit = unbackedAlerts.some((a) => a.severity === "critical");
    const unbacked = unbackedAlerts.length > 0;

    // 합성 레벨 — critical 알림 / 무담보민팅 / 복합조건(하드코딩 오라클 ∧ 디페그 등)이 "위험"으로 승격(설계 §7.2).
    const danger = crit > 0 || unbackedCrit || (hardOracle && depeg) || (hhi >= 0.5 && (depeg || hardOracle));
    const caution = warn > 0 || hhi >= 0.4 || hardOracle || depeg || unbacked;
    const level: "위험" | "주의" | "안전" = danger ? "위험" : caution ? "주의" : "안전";

    // 한 줄 사유 — 발화한 4신호만 나열 + 핵심 함의.
    const factors: string[] = [];
    if (crit > 0) factors.push(`critical 알림 ${crit}건`);
    if (unbacked) factors.push(`무담보민팅 의심 ${unbackedAlerts.length}건${unbackedCrit ? "·critical" : ""}`);
    if (hhi >= 0.4) factors.push(`집중도 ${hhi.toFixed(2)}(쏠림)`);
    if (depeg) factors.push(`디페그 이력 ${depegAlerts.length}건${depegCrit ? "·critical" : ""}`);
    if (hardOracle) factors.push(`하드코딩 오라클(${[...hardOracleProtos].slice(0, 2).join("·")})`);
    let reason: string;
    if (!factors.length) {
      reason = "리스크 신호 없음 — 노출 분산 · 페그 정상 · 무담보민팅/하드코딩 오라클 없음.";
    } else {
      reason = factors.join(" · ");
      if (unbackedCrit) reason += " → 소스 락/번 없는 발행 = 무담보(Kelp rsETH형).";
      else if (hardOracle && depeg) reason += " → 디페그가 온체인 가격에 안 잡혀 청산 지연 → bad debt 누적 위험.";
      else if (hhi >= 0.5) reason += " → 한 곳에 쏠려 단일 실패점.";
    }
    return { hhi, conc, crit, warn, info, supply24h, depeg, hardOracle, rwaDiscount, unbacked, level, reason };
  }, [relations, dossier, sym]);

  const onGraphSelect = (id: string | null) => {
    if (id?.startsWith("island:")) return; // 체인 라벨 — 선택/패널 변화 없음 (드래그만)
    setSelNode(id);
    const node = id ? subNodeById.get(id) : undefined;
    const md = node?.metadata as Record<string, unknown> | undefined;
    if (md?._market) setPicked({ kind: "market", ...(md._market as Record<string, unknown>), market: node?.label, chain: md.chain });
    else if (md?._vault) setPicked({ kind: "vault", ...(md._vault as Record<string, unknown>), chain: md.chain });
    else if (md && (md.mechanism != null || /브릿지|bridge/i.test(String(md.category ?? "")))) {
      setPicked({ kind: "bridge", ...md, label: node?.label });
    } else if (node?.type === "Token") {
      setPicked({ kind: "token", symbol: (md?.symbol as string) ?? node.label });
    } else if (node?.type === "DerivativeToken") {
      // 파생토큰 — 역할·출처 프로토콜·기초토큰·수용처(레고 엣지) 모아 상세
      const accepts = (legoTopology.edges ?? [])
        .filter((e) => e.source === id && (e.type === "collateral_at" || e.type === "staked_in"))
        .map((e) => ({ rel: e.type, to: legoTopology.nodes.find((n) => n.id === e.target)?.label ?? e.target, evidence: (e.attrs as { legoEvidence?: Record<string, unknown> } | undefined)?.legoEvidence ?? null }));
      setPicked({ kind: "derivative", label: node.label, role: md?.derivRole, source: md?.venue, address: md?.address, chain: md?.chain, evidence: md?.legoEvidence, accepts,
        terminal: md?.terminal, terminalReason: md?.terminalReason, rewardSource: md?.rewardSource });
    } else if (id && node) {
      // 프로토콜 — 전 체인 관계의 topMarkets 를 모아 스펙 행 입력으로
      const realId = id.replace(/^c:[^:]+:/, "");
      const rels = mergedRelations.filter((r) => r.otherId === realId || r.otherId.split("@")[0] === realId.split("@")[0]);
      if (!rels.length) { setPicked(null); return; }
      const markets = rels.flatMap((r) => r.edge.attrs?.topMarkets ?? []);
      const totalUsd = rels.reduce((s, r) => s + (r.edge.attrs?.core?.amountUsd ?? 0), 0);
      setPicked({ kind: "protocol", nodeId: realId.split("@")[0], label: node.label, markets, totalUsd, chain: md?.chain, relationMetrics: md?.relationMetrics });
    } else setPicked(null);
  };

  const verdictStyle = verdict.level === "위험"
    ? { color: "var(--color-danger)", background: "color-mix(in srgb, var(--color-danger) 16%, transparent)" }
    : verdict.level === "주의"
      ? { color: "#fbbf24", background: "rgba(251,191,36,0.16)" }
      : { color: "#34d399", background: "rgba(52,211,153,0.16)" };

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)] lg:h-screen">
      <AlertDock />
      <SiteHeader />

      {/* ── Tier 0 판결 바 (full-width 고정) — 맵을 어떻게 돌리든 안 변하는 "이 토큰 위험한가" ── */}
      <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 shadow-sm lg:px-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <a href="/" className="text-[12px] text-[var(--color-accent)] hover:underline">◀ 검색</a>
          <span className="text-lg font-bold text-[var(--color-text-primary)]">{sym}</span>
          <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold" style={verdictStyle}>
            <span className="size-2 rounded-full bg-current" /> {verdict.level}
          </span>
          <Stat label="집중도(HHI)" value={`${verdict.hhi.toFixed(2)} · ${verdict.conc}`} warn={verdict.hhi >= 0.4} />
          <Stat label="디페그" value={verdict.depeg ? "이력 있음" : "정상"} warn={verdict.depeg} />
          <Stat label="무담보민팅" value={verdict.unbacked ? "의심" : "정상"} warn={verdict.unbacked} />
          <Stat label="오라클" value={verdict.hardOracle ? "하드코딩" : verdict.rwaDiscount ? "RWA NAV(정상)" : "시장"} warn={verdict.hardOracle} />
          <Stat label="알림" value={`⚠ ${verdict.crit + verdict.warn}`} sub={`${verdict.crit}C·${verdict.warn}W·${verdict.info}i`} warn={verdict.crit > 0} />
          {dossierLoading && <span className="text-[10px] text-[var(--color-text-muted)]">판결 갱신 중…</span>}
        </div>
      </div>

      {/* ── 컨트롤 레일 (직교 손잡이: 보기·깊이·형태) — 스코프는 체인 수로 자동 합침, 렌즈는 제거 ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 lg:px-5">
        <ControlGroup label="보기">
          <Seg active={view === "map"} onClick={() => setView("map")}>관계맵</Seg>
          <Seg active={view === "bridge"} onClick={() => setView("bridge")}>브릿지 맵</Seg>
        </ControlGroup>
        {view === "map" && (
          <ControlGroup label="깊이">
            <Seg active={depth === "protocol"} onClick={() => setDepth("protocol")}>프로토콜</Seg>
            <Seg active={depth === "market"} onClick={() => setDepth("market")}>+마켓</Seg>
            <Seg active={depth === "curator"} onClick={() => setDepth("curator")}>+큐레이터</Seg>
          </ControlGroup>
        )}
        {view === "map" && (
          <ControlGroup label="형태">
            <Seg active={shape === "tree"} onClick={() => setShape("tree")}>트리</Seg>
            <Seg active={shape === "concentric"} onClick={() => setShape("concentric")}>동심원</Seg>
          </ControlGroup>
        )}
        {view === "map" && lego.nodes.length > 0 && (
          <ControlGroup>
            <Seg active={showDerivs} onClick={() => setShowDerivs((v) => !v)}>파생토큰 {showDerivs ? "켜짐" : "꺼짐"}</Seg>
          </ControlGroup>
        )}
        {view === "map" && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase text-[var(--color-text-muted)]">체인</span>
          {/* 단일 선택 — 한 번에 한 체인의 머니레고 구조만 (사용자 지시: 체크박스→하나씩) */}
          {chainOpts.map((c) => {
            const ch = c.key;
            const selected = !hiddenChains.has(ch);
            return (
              <button key={ch}
                onClick={() => { userToggledChains.current = true; setHiddenChains(new Set(chainOpts.map((x) => x.key).filter((k) => k !== ch))); setPicked(null); setSelNode(null); }}
                className={"flex items-center gap-1 rounded-md px-2.5 py-0.5 text-[11px] font-medium transition-colors " + (selected ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]")}>
                {c.label}
              </button>
            );
          })}
        </div>
        )}
        {view === "bridge" && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            크로스체인 브릿지 구조 + 실시간 트랜잭션 — 체인 사이 엣지 위 = 브릿지 (래핑 토큰 포착·브릿지 주소 직접 조회)
          </span>
        )}
        <Link href={`/flow?token=${encodeURIComponent(sym)}`}
          className="ml-auto flex items-center gap-1 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-raised)]">
          <Activity size={12} /> 흐름맵에서 보기
        </Link>
        {view === "map" && (
        <button onClick={() => setPanelOpen((o) => !o)} title="상세 패널 토글"
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
          {panelOpen ? "상세 패널 ▸" : "◂ 상세 패널"}
        </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 좌: 그래프 — 보기에 따라 관계맵(단일체인 머니레고) / 브릿지 뷰(크로스체인+실시간 입자) */}
        <div className="relative h-[560px] min-h-[560px] flex-none lg:h-auto lg:min-h-0 lg:flex-1">
          {view === "bridge" ? (
            <BridgeView sym={sym} chains={chains} active={view === "bridge"} />
          ) : breadthLoading ? (
            // 라이브 수집이 끝날 때까지 "부분 그래프"를 보여주지 않고 깔끔한 로딩만.
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-center text-[var(--color-text-secondary)]">
                <span className="size-8 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
                <span className="text-sm">{sym} 데이터 로딩 중…</span>
                <span className="max-w-[260px] text-[11px] leading-relaxed text-[var(--color-text-muted)]">전 체인 풀·마켓·큐레이터·브릿지·온체인 공급을 모으는 중입니다</span>
              </div>
            </div>
          ) : legoTopology.nodes.length > 1 ? (
            <GraphCanvas graphKey={`tok-${sym}-${depth}-${shape}-${bridgeHub ? "macro" : "micro"}-${[...hiddenChains].sort().join(",") || "all"}-${legoTopology.nodes.length}`} topology={legoTopology} nodeStates={subNodeStates} selectedNodeId={selNode} onSelectNode={onGraphSelect} staticLayout straightEdges />
          ) : (
            <Empty msg={`${sym} 의 온체인 엣지가 DB 에 없음 — 스냅샷 대상 토큰이 아닐 수 있어요.`} />
          )}
          {view === "map" && !breadthLoading && legoTopology.nodes.length > 1 && (
            <>
              <DistributionCard rows={distributionRows} />
              <GraphLegend bridge={bridgeHub} lego={showDerivs && lego.nodes.length > 0} />
            </>
          )}
        </div>

        {/* 우: 상세 패널 (관계맵 전용 — 상황판·레버루프는 자체 레일/패널 사용) */}
        {view === "map" && panelOpen && (
          <aside className="w-full shrink-0 overflow-y-auto border-t border-[var(--color-border-subtle)] bg-[var(--color-surface)] lg:w-[400px] lg:border-l lg:border-t-0">
            {picked ? (
              <PickDetail d={picked} onClose={() => setPicked(null)} />
            ) : (
              <div className="px-5 py-4">
                <div className="mb-3"><div className="text-lg font-semibold text-[var(--color-text-primary)]">{sym}</div></div>
                <TokenDossier node={tokenNode} relations={relations} state={state} data={dossier} dataLoading={dossierLoading} lstFlow={lstFlow} lstFlowLoading={lstFlowLoading} />
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]">{msg}</div>;
}

function DistributionCard({ rows }: { rows: Array<{ label: string; usd: number; pct: number; chain: string }> }) {
  if (!rows.length) return null;
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 w-[170px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/92 p-2 text-[10px] shadow-sm backdrop-blur lg:w-[185px]">
      <div className="mb-1.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">상위 분포</div>
      <div className="space-y-1">
        {rows.slice(0, 6).map((r, i) => (
          <div key={`${r.label}-${i}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-[var(--color-text-primary)]">{r.label}</span>
              <span className="shrink-0 font-mono font-semibold text-[var(--color-text-primary)]">{(r.pct * 100).toFixed(1)}%</span>
            </div>
            <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
              <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.max(1, r.pct * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 판결 바의 수치 1개 (라벨 + 값 + 보조)
function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
      <span className={"font-mono text-[13px] font-semibold " + (warn ? "text-[#fbbf24]" : "text-[var(--color-text-primary)]")}>{value}</span>
      {sub && <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{sub}</span>}
    </span>
  );
}

// 컨트롤 그룹 (라벨 + 세그먼트 버튼들)
function ControlGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>}
      <div className="flex items-center gap-0.5 rounded-lg bg-[var(--color-surface-raised)] p-0.5">{children}</div>
    </div>
  );
}

function Seg({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={"rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors " + (active ? "bg-[var(--color-accent)] text-white" : disabled ? "cursor-not-allowed text-[var(--color-text-muted)] opacity-40" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]")}>
      {children}
    </button>
  );
}

function GraphLegend({ bridge, lego }: { bridge: boolean; lego?: boolean }) {
  // 엣지를 4개 의미 그룹으로(종류 최소화). 브릿지맵은 메커니즘 3종.
  const edges: [string, string][] = bridge
    ? [["락 & 민트", "#2563eb"], ["번 & 민트", "#dc2626"], ["유동성 풀", "#0d9488"]]
    : EDGE_GROUPS.map((g) => [g.label, g.color] as [string, string]);
  const oracles: [string, string][] = [["시장가", "#34d399"], ["환율(LST)", "#60a5fa"], ["풀 현물가", "#fbbf24"], ["하드코딩", "#f87171"]];
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-10 hidden w-fit max-w-[160px] space-y-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/90 px-2 py-1.5 text-[10px] leading-tight text-[var(--color-text-secondary)] shadow-sm backdrop-blur lg:block">
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
        {edges.map(([l, c]) => (
          <span key={l} className="flex items-center gap-1">
            <span className="inline-block h-0 w-3.5 border-t-2" style={{ borderColor: c }} />
            {l}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 border-t border-[var(--color-border-subtle)] pt-1">
        <span className="text-[var(--color-text-muted)]">오라클</span>
        {oracles.map(([l, c]) => (
          <span key={l} className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-full" style={{ backgroundColor: c }} />
            {l}
          </span>
        ))}
      </div>
      {lego && !bridge && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 border-t border-[var(--color-border-subtle)] pt-1">
          <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-full border-2" style={{ borderColor: "#eab308", backgroundColor: "#fefce8" }} />큐레이터 볼트</span>
          <span className="flex items-center gap-1"><span className="inline-flex size-3 items-center justify-center rounded-full bg-[var(--color-accent)] text-[7px] font-bold leading-none text-white">끝</span>종착</span>
        </div>
      )}
    </div>
  );
}

const compact = (n: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(n);
const missing = (m: RelationDetailMetrics | null, key: string) => m?.dataGaps?.includes(key) ? "미수집" : null;
function eoaFlowHref(address: string, chain: string) {
  const params = new URLSearchParams({ address });
  if (chain) params.set("chain", chain);
  return `/eoa-flow?${params.toString()}`;
}
function selectCounterparties(rows: RelationDetailMetrics["topDepositors"]) {
  const valid = (rows ?? []).filter((r) => /^0x[0-9a-fA-F]{40}$/.test(r.address));
  const out: typeof valid = [];
  let cumulative = 0;
  let hasShare = false;
  for (const row of valid.slice(0, 25)) {
    const share = typeof row.sharePct === "number" && Number.isFinite(row.sharePct) ? row.sharePct : null;
    if (share != null) {
      cumulative += share;
      hasShare = true;
    }
    out.push(row);
    const rowCumulative = row.cumulativeSharePct ?? (hasShare ? cumulative : null);
    if (out.length >= 10 && rowCumulative != null && rowCumulative >= 0.9) break;
  }
  return out;
}
function CounterpartyList({ label, rows, missingValue, chain, badge, availableLiquidityUsd, showLiquidityCoverage = false }: {
  label: string;
  rows: RelationDetailMetrics["topDepositors"];
  missingValue?: string | null;
  chain: string;
  badge?: "verified" | "estimated";
  availableLiquidityUsd?: number | null;
  showLiquidityCoverage?: boolean;
}) {
  const visible = selectCounterparties(rows);
  const cumulativeShare = visible.length
    ? visible[visible.length - 1]?.cumulativeSharePct ?? visible.reduce((s, r) => s + (r.sharePct ?? 0), 0)
    : null;
  if (!visible.length && !missingValue) return null;
  return (
    <div className="py-1 text-[12px]">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="shrink-0 text-[var(--color-text-muted)]">{label}</span>
        {visible.length ? (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {visible.length}개{cumulativeShare != null && cumulativeShare > 0 ? ` · 합 ${pct1(cumulativeShare)}` : ""}
          </span>
        ) : (
          <span className="flex items-center gap-1 font-mono text-[var(--color-text-primary)]">
            {missingValue}
            {badge === "estimated" && <span title="추정" className="shrink-0 text-[10px] text-[var(--color-text-muted)]">~</span>}
          </span>
        )}
      </div>
      {visible.length > 0 && (
        <div className="space-y-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5">
          {visible.map((r) => {
            const amount = r.amountUsd != null ? formatUsd(r.amountUsd) : r.amount != null ? compact(r.amount) : null;
            const liquidityCoverage = showLiquidityCoverage && availableLiquidityUsd != null && r.amountUsd != null && r.amountUsd > 0
              ? availableLiquidityUsd / r.amountUsd
              : null;
            return (
              <div key={r.address} className="grid grid-cols-[minmax(76px,1fr)_auto] items-center gap-x-2 gap-y-0.5">
                <Link href={eoaFlowHref(r.address, chain)} className="min-w-0 truncate font-mono text-[var(--color-accent)] hover:underline" title={`${chain}:${r.address}`}>
                  {r.label || shortAddr(r.address)}
                </Link>
                <span className="shrink-0 text-right font-mono text-[var(--color-text-primary)]">
                  {r.sharePct != null ? pct1(r.sharePct) : "비중 미상"}
                  {liquidityCoverage != null && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">가용/주소 {pct1(liquidityCoverage)}</span>}
                </span>
                <span className="truncate text-[10px] text-[var(--color-text-muted)]">{r.kind ?? "unknown"}</span>
                {amount && <span className="truncate text-right font-mono text-[10px] text-[var(--color-text-secondary)]">{amount}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type MorphoBorrowerRisk = {
  address?: string | null;
  marketPosition?: {
    borrowUsd?: number | null;
    collateralUsd?: number | null;
  };
  riskInputs?: {
    liquidation?: {
      ltv?: number | null;
      lltv?: number | null;
      liquidationBufferPct?: number | null;
    };
    liquidity?: {
      availableLiquidToDebt?: number | null;
      highQualityLiquidToDebt?: number | null;
    };
    externalization?: {
      knownInfraOutflowToDebt30d?: number | null;
      knownCexBridgeOutflowToDebt30d?: number | null;
      routerOutflowToDebt30d?: number | null;
      solverOutflowToDebt30d?: number | null;
      protocolOutflowToDebt30d?: number | null;
      walletOutflowToDebt30d?: number | null;
      eoaOutflowToDebt30d?: number | null;
      contractOutflowToDebt30d?: number | null;
    };
  };
  externalOutflows?: {
    totals?: {
      knownInfraUsd30d?: number | null;
      knownCexBridgeUsd30d?: number | null;
      routerUsd30d?: number | null;
      solverUsd30d?: number | null;
      protocolUsd30d?: number | null;
      walletUsd30d?: number | null;
      eoaUsd30d?: number | null;
      contractUsd30d?: number | null;
      largeUnclassifiedUsd30d?: number | null;
    };
  } | null;
  riskBand?: string | null;
};

type MorphoBorrowerAnalysis = {
  markets?: Array<{
    marketKey?: string;
    marketLabel?: string;
    borrowers?: MorphoBorrowerRisk[];
  }>;
  dataGaps?: string[];
};

function pctMaybe(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? pct1(value) : "—";
}

function MorphoBorrowerRiskPanel({ marketKey, chain }: { marketKey: string | null; chain: string }) {
  const [data, setData] = useState<MorphoBorrowerAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!marketKey || chain !== "ethereum") return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    const params = new URLSearchParams({
      market: marketKey,
      limit: "10",
      includePortfolio: "true",
      includeOutflows: "true",
      outflowOffset: "500",
    });
    fetch(`/api/morpho-borrower-analysis?${params.toString()}`, { cache: "no-store", signal: ctrl.signal })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`/api/morpho-borrower-analysis -> ${res.status}`)))
      .then((json: MorphoBorrowerAnalysis) => setData(json))
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [chain, marketKey]);

  if (!marketKey || chain !== "ethereum") return null;
  const market = data?.markets?.[0] ?? null;
  const borrowers = market?.borrowers ?? [];

  return (
    <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-[var(--color-text-primary)]">차입자 유동성 체크</span>
        <span className="font-mono text-[10px] text-[var(--color-text-muted)]">score pending</span>
      </div>
      {loading && <div className="font-mono text-[10px] text-[var(--color-text-muted)]">pseudo-DeBank 분석 중...</div>}
      {error && <div className="font-mono text-[10px] text-[var(--color-danger)]">{error}</div>}
      {!loading && !error && borrowers.length === 0 && <div className="font-mono text-[10px] text-[var(--color-text-muted)]">분석 가능한 차입자 없음</div>}
      {borrowers.length > 0 && (
        <div className="space-y-1.5">
          {borrowers.slice(0, 10).map((b, idx) => {
            const address = b.address && /^0x[0-9a-fA-F]{40}$/.test(b.address) ? b.address : null;
            const liq = b.riskInputs?.liquidity?.availableLiquidToDebt ?? b.riskInputs?.liquidity?.highQualityLiquidToDebt ?? null;
            const infraOut = b.externalOutflows?.totals?.knownInfraUsd30d ?? null;
            const cexBridge = b.externalOutflows?.totals?.knownCexBridgeUsd30d ?? null;
            const walletOut = b.externalOutflows?.totals?.walletUsd30d ?? null;
            const walletOutToDebt = b.riskInputs?.externalization?.walletOutflowToDebt30d ?? null;
            const unclassified = b.externalOutflows?.totals?.largeUnclassifiedUsd30d ?? null;
            return (
              <div key={address ?? `${marketKey}:${idx}`} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  {address ? (
                    <Link
                      href={`/eoa-flow?address=${address}&depth=1&market=${marketKey}&limit=5`}
                      className="min-w-0 truncate font-mono text-[11px] text-[var(--color-accent)] hover:underline"
                    >
                      {shortAddr(address)}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate font-mono text-[11px] text-[var(--color-text-muted)]">unknown</span>
                  )}
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-primary)]">debt {formatUsd(b.marketPosition?.borrowUsd)}</span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
                  <span>LTV {pctMaybe(b.riskInputs?.liquidation?.ltv)} / {pctMaybe(b.riskInputs?.liquidation?.lltv)}</span>
                  <span>buf {pctMaybe(b.riskInputs?.liquidation?.liquidationBufferPct)}</span>
                  <span>liq/debt {pctMaybe(liq)}</span>
                  <span>infra out {formatUsd(infraOut)}</span>
                  <span>CEX+bridge {formatUsd(cexBridge)}</span>
                  <span>EOA/Safe out {formatUsd(walletOut)}</span>
                  <span>out/debt {pctMaybe(walletOutToDebt)}</span>
                  {unclassified != null && unclassified > 0 && <span className="col-span-2 text-[var(--color-text-muted)]">대형 미분류 30d {formatUsd(unclassified)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!!data?.dataGaps?.length && (
        <div className="mt-1 truncate font-mono text-[9px] text-[var(--color-text-muted)]" title={data.dataGaps.join(", ")}>
          gap · {data.dataGaps[0]}
        </div>
      )}
    </div>
  );
}
function tokenList(v: unknown): string | null {
  if (!Array.isArray(v) || !v.length) return null;
  return v.slice(0, 3).map((x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x) ? shortAddr(x) : String(x)).join(" · ");
}

function MetricRows({ metrics, showDex = false, showTopBorrowers = true, chain = "ethereum" }: {
  metrics: RelationDetailMetrics | null;
  showDex?: boolean;
  showTopBorrowers?: boolean;
  chain?: string;
}) {
  if (!metrics) return null;
  const tokenAmount = metrics.tokenAmount != null
    ? `${compact(metrics.tokenAmount)}${metrics.tokenAmountUsd != null ? ` · ${formatUsd(metrics.tokenAmountUsd)}` : ""}`
    : metrics.tokenAmountUsd != null
      ? `${formatUsd(metrics.tokenAmountUsd)} · 수량 미수집`
      : missing(metrics, "token_amount");
  const ltv = metrics.ltv != null || metrics.lltv != null
    ? `${metrics.ltv != null ? pct1(metrics.ltv) : "—"} / ${metrics.lltv != null ? pct1(metrics.lltv) : "—"}`
    : null;
  const weekly = metrics.weeklySwapTokenAmount != null || metrics.weeklySwapUsd != null
    ? metrics.weeklySwapTokenAmount != null
      ? `${compact(metrics.weeklySwapTokenAmount)}${metrics.weeklySwapUsd != null ? ` · ${formatUsd(metrics.weeklySwapUsd)}` : ""}`
      : metrics.weeklySwapUsd != null ? formatUsd(metrics.weeklySwapUsd) : null
    : missing(metrics, "weekly_swap");
  const marketRows = metrics.marketRows?.filter((r) => r.count > 0) ?? [];
  const marketRowValue = (r: RelationMarketRow) => {
    if (r.label.endsWith("량")) return r.amountUsd != null ? formatUsd(r.amountUsd) : "미수집";
    return `${r.count}개${r.amountUsd != null ? ` · ${formatUsd(r.amountUsd)}` : ""}`;
  };
  return (
    <>
      <PRow k="토큰 예치" v={tokenAmount} badge={metrics.tokenAmount == null && tokenAmount ? "estimated" : undefined} />
      <PRow k="TVL" v={metrics.tvlUsd != null ? formatUsd(metrics.tvlUsd) : null} />
      {marketRows.map((r) => (
        <PRow key={r.label} k={r.label} v={marketRowValue(r)} />
      ))}
      <PRow
        k="가용 유동성"
        v={metrics.availableLiquidityUsd != null
          ? `${formatUsd(metrics.availableLiquidityUsd)}${metrics.availableLiquidityPct != null ? ` · ${pct1(metrics.availableLiquidityPct)}` : ""}`
          : null}
        warn={(metrics.availableLiquidityPct ?? 1) <= 0.1}
      />
      <PRow k="LTV / LLTV" v={ltv} warn={(metrics.lltv ?? 0) >= 0.945 || (metrics.ltv ?? 0) >= 0.9} />
      <PRow k="이용률" v={metrics.utilization != null ? pct1(metrics.utilization) : null} warn={(metrics.utilization ?? 0) >= 0.95} />
      {showDex && <PRow k="DEX 유동성" v={metrics.dexLiquidityUsd != null && metrics.dexLiquidityUsd > 0 ? formatUsd(metrics.dexLiquidityUsd) : null} />}
      {showDex && <PRow k="주간 swap" v={weekly} badge={weekly === "미수집" ? "estimated" : undefined} />}
      {(!showDex || metrics.topDepositors?.length) && (
        <CounterpartyList
          label={showDex ? "탑 LP" : "탑 예치자"}
          rows={metrics.topDepositors}
          missingValue={missing(metrics, "top_depositors")}
          chain={chain}
          badge={!metrics.topDepositors?.length && missing(metrics, "top_depositors") ? "estimated" : undefined}
          availableLiquidityUsd={metrics.availableLiquidityUsd}
          showLiquidityCoverage={!showDex}
        />
      )}
      {showTopBorrowers && (
        <CounterpartyList
          label="탑 차입자"
          rows={metrics.topBorrowers}
          missingValue={missing(metrics, "top_borrowers")}
          chain={chain}
          badge={!metrics.topBorrowers?.length && missing(metrics, "top_borrowers") ? "estimated" : undefined}
        />
      )}
    </>
  );
}

function PickDetail({ d, onClose }: { d: Record<string, unknown>; onClose: () => void }) {
  // 스펙 패널 — 값은 한 줄 토큰 · 없으면 행 숨김 · 위험 ⚠빨강 · 주소 ↗ · ✓검증/~추정
  const kind = String(d.kind ?? (("curator" in d || "allocationUsd" in d) ? "vault" : "market"));
  const chain = String(d.chain ?? "ethereum");
  const protoCounts = useNodeAlertCounts(kind === "protocol" ? String(d.nodeId ?? "") || null : null);
  const ROLE_DESC: Record<string, string> = { pt: "원금 토큰 (PT)", yt: "수익 토큰 (YT)", lp: "유동성 풀 토큰 (LP)", receipt: "예치 영수증", wrapper: "볼트 쉐어" };
  const head = kind === "token" ? "토큰" : kind === "vault" ? "볼트 (큐레이터 운용)" : kind === "bridge" ? "브릿지" : kind === "protocol" ? "프로토콜" : kind === "derivative" ? "파생토큰 (머니레고)" : kind === "pool" ? "풀/마켓" : "마켓";
  const title = kind === "token" ? String(d.symbol) : kind === "vault" ? String(d.curator ?? d.vault ?? "vault") : String(d.label ?? d.market ?? d.protocol ?? "");
  const metrics = (d.relationMetrics as RelationDetailMetrics | null | undefined) ?? null;
  const isDexDetail = kind === "pool"
    ? d.exposure === "multi"
    : kind === "protocol"
      ? String(d.protocolClass ?? d.category ?? "").toLowerCase().includes("dex")
      : false;
  const showDexMetrics = !!metrics && isDexDetail && ((metrics.dexLiquidityUsd ?? 0) > 0 || !!metrics.dataGaps?.includes("weekly_swap"));

  let body: React.ReactNode = null;
  if (kind === "token") {
    body = <TokenSpecRows symbol={String(d.symbol)} />;
  } else if (kind === "derivative") {
    const accepts = (d.accepts as { rel: string; to: string }[] | undefined) ?? [];
    // 브릿지 래핑본(venue=bridge)은 wrapper 역할이지만 볼트 쉐어가 아님 — 종류 표기 분리.
    const roleDesc = (d.role === "wrapper" && d.source === "bridge") ? "브릿지 래핑본" : ROLE_DESC[String(d.role)] ?? "파생토큰";
    body = (
      <>
        <PRow k="종류" v={roleDesc} />
        <PRow k="발행 프로토콜" v={d.source != null ? String(d.source) : null} />
        <PRow k="컨트랙트" v={d.address != null ? shortAddr(String(d.address)) : null} href={d.address != null ? ADDR_EXPLORER[chain]?.(String(d.address)) : undefined} />
        {accepts.length > 0
          ? accepts.map((a, i) => <PRow key={i} k={a.rel === "collateral_at" ? "담보로 쓰임" : a.rel === "staked_in" ? "스테이킹 수용" : "수용처"} v={a.to} />)
          : d.terminal === true
            ? <PRow k="종착" v="여기가 끝 — 다음 예치 홉 없음" />
            : <PRow k="수용처" v="아직 담보·스테이킹 수용 확인 안 됨" />}
        {d.terminal === true && d.terminalReason != null && <TerminalNote reason={String(d.terminalReason)} rewardSource={d.rewardSource != null ? String(d.rewardSource) : null} />}
      </>
    );
  } else if (kind === "vault") {
    body = (
      <>
        <PRow k="AUM" v={(d.allocationUsd as number) > 0 ? formatUsd(d.allocationUsd as number) : null} />
        <PRow k="펀딩 마켓" v={d.market != null ? String(d.market) : null} />
        <PRow k="예치자산" v={d.depositAsset != null ? String(d.depositAsset) : null} />
        <PRow k="디리스킹" v={d.inWithdrawQueue === true ? "인출 큐 진입" : null} warn={d.inWithdrawQueue === true} />
        {/* 보상 재원 — 이 볼트의 수익이 어느 마켓 이자에서 나오는지(감사관 [고정2]). */}
        {d.rewardSource != null && <TerminalNote label="보상 재원" reason={String(d.rewardSource)} rewardSource={null} />}
      </>
    );
  } else if (kind === "bridge") {
    const mech = d.mechanism != null ? String(d.mechanism) : null;
    const verified = d.verified === true || d.types != null;
    const types = Array.isArray(d.types) ? (d.types as string[]).join("·") : d.tag != null ? String(d.tag) : null;
    body = (
      <>
        <PRow k="mint 한도" v={d.mintLimit != null ? Intl.NumberFormat("en", { notation: "compact" }).format(d.mintLimit as number) : null} />
        <PRow k="권한" v={types ?? mech} badge={verified ? "verified" : "estimated"} />
        <PRow k="메커니즘" v={mech === "lock_mint" ? "락&민트" : mech === "burn_mint" ? "번&민트" : mech} warn={mech === "burn_mint"} />
        <PRow k="백킹" v={verified ? "온체인 권한 검증" : null} badge="verified" />
      </>
    );
  } else if (kind === "protocol") {
    const markets = (d.markets as { lltv: number; utilization?: number | null }[] | undefined) ?? [];
    const lltvs = markets.map((m) => m.lltv).filter((v) => v > 0);
    const utils = markets.map((m) => m.utilization).filter((v): v is number => v != null);
    const maxLltv = lltvs.length ? Math.max(...lltvs) : null;
    const avgUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;
    body = (
      <>
        <MetricRows metrics={metrics} showDex={showDexMetrics} chain={chain} />
        <PRow k="최고 LLTV" v={maxLltv != null ? pct1(maxLltv) : null} warn={maxLltv != null && maxLltv >= 0.945} />
        <PRow k="평균 이용률" v={avgUtil != null ? pct1(avgUtil) : null} warn={avgUtil != null && avgUtil >= 0.95} />
        <PRow k="알림" v={protoCounts ? sevDots(protoCounts.crit, protoCounts.warnN) : null} warn={(protoCounts?.crit ?? 0) > 0} />
      </>
    );
  } else if (kind === "pool") {
    body = (
      <>
        <MetricRows metrics={metrics} showDex={d.exposure === "multi" || showDexMetrics} showTopBorrowers={false} chain={chain} />
        <PRow k="페어" v={d.poolMeta != null ? String(d.poolMeta) : String(d.market ?? "")} />
        <PRow k="구성 토큰" v={tokenList(d.underlyingTokens)} />
        <PRow k="프로토콜" v={d.protocol != null ? String(d.protocol) : null} />
        <PRow k="규모" v={(d.sizeUsd as number) > 0 ? formatUsd(d.sizeUsd as number) : null} badge="estimated" />
        <PRow k="APY" v={d.apy != null ? `${(d.apy as number).toFixed(2)}%` : null} badge="estimated" />
        <PRow k="IL 위험" v={d.ilRisk === "yes" ? "있음" : null} warn={d.ilRisk === "yes"} />
      </>
    );
  } else {
    // 마켓 (_market payload — MarketEntry)
    const lltv = (d.lltv as number) ?? 0;
    const coll = d.collateralUsd as number | null | undefined;
    const borrow = d.borrowUsd as number | null | undefined;
    const agg = coll && borrow != null ? borrow / coll : null;
    const cushion = agg != null && lltv ? (lltv - agg) * 100 : null;
    const fv = (d.fundingVaults as { curator?: string | null; vault?: string | null }[] | null | undefined) ?? [];
    const curators = [...new Set(fv.map((v) => v.curator ?? v.vault).filter(Boolean))] as string[];
    const oracleAddr = d.oracleAddress != null ? String(d.oracleAddress) : null;
    const marketSizeUsd = Number(d.marketSizeUsd ?? d.sizeUsd ?? metrics?.tvlUsd ?? metrics?.tokenAmountUsd ?? 0);
    const marketKey = typeof d.marketKey === "string" ? d.marketKey : null;
    body = (
      <>
        <MetricRows metrics={metrics} chain={chain} />
        <MorphoBorrowerRiskPanel marketKey={marketKey} chain={chain} />
        <PRow k="페어" v={d.collateralAsset != null || d.loanAsset != null ? `${String(d.collateralAsset ?? "?")} / ${String(d.loanAsset ?? "?")}` : String(d.market ?? "")} />
        <PRow k="LLTV / 여유" v={cushion != null ? `${pct1(lltv)} · ${cushion.toFixed(1)}%p` : lltv ? pct1(lltv) : null}
          warn={lltv >= 0.945 || (cushion != null && cushion <= 8)} badge={agg != null ? "verified" : undefined} />
        <PRow k="이용률" v={d.utilization != null ? pct1(d.utilization as number) : null} warn={((d.utilization as number) ?? 0) >= 0.95} />
        <PRow k="규모" v={marketSizeUsd > 0 ? formatUsd(marketSizeUsd) : null} />
        <PRow k="오라클" v={oracleAddr ? shortAddr(oracleAddr) : null} href={oracleAddr ? ADDR_EXPLORER[chain]?.(oracleAddr) : null} badge={oracleAddr ? "verified" : undefined} />
        <PRow k="큐레이터" v={curators.length ? `${curators.slice(0, 2).join(" · ")}${curators.length > 2 ? ` +${curators.length - 2}` : ""}` : null} />
        {d.ouroborosRisk === true && <PRow k="구조" v="자기참조 (ouroboros)" warn />}
        {/* 담보 종착 — 담보가 여기서 잠기고 청산, 원금 회수는 역방향 상환(감사관 [추궁]·[고정3]). */}
        {d.terminal === true && <PRow k="종착" v="담보 종착 — 여기서 잠김·청산" />}
        {d.terminal === true && d.terminalReason != null && <TerminalNote reason={String(d.terminalReason)} rewardSource={d.rewardSource != null ? String(d.rewardSource) : null} />}
      </>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{head}</div>
          <div className="text-lg font-semibold text-[var(--color-text-primary)]">{title}</div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"><X size={16} /></button>
      </div>
      <div className="space-y-0.5">{body}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-[var(--color-text-muted)]">{k}</span><span className="font-mono text-[var(--color-text-secondary)]">{v}</span></div>;
}

// 종착/보상-재원 설명 블록 — "여기가 끝"인 이유 + 수익·보상 출처 + 역방향(출금/상환) 안내.
// 감사관 [고정2 보상재원]·[고정3 역경로]·[고정4 출처불명수익]·[추궁 종착구분] 을 한 곳에서 트리에 읽히게.
function TerminalNote({ reason, rewardSource, label = "종착 설명" }: { reason: string; rewardSource: string | null; label?: string }) {
  return (
    <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <p className="text-[var(--color-text-secondary)]">{reason}</p>
      {rewardSource && <p className="mt-1 text-[var(--color-text-secondary)]">재원 · {rewardSource}</p>}
      <p className="mt-1 text-[var(--color-text-muted)]">예치·담보·스테이킹은 가역 — 출금/상환은 이 경로를 역방향으로 되돌아 나갑니다.</p>
    </div>
  );
}
