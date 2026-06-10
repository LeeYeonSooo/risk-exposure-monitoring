"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Activity, X } from "lucide-react";

import { AlertDock } from "@/components/AlertDock";
import { SiteHeader } from "@/components/SiteHeader";
import { chainOptions } from "@/lib/chains-ui";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { TokenDossier, type DossierData } from "@/components/graph/TokenDossier";
import { SAFE_NODE_STATE, formatUsd, type GraphEdge, type GraphNode, type NodeTickState } from "@/lib/api";
import { applyConcentricLayout, type PoolLike, type MorphoMkt, type EulerVault } from "@/lib/concentric-layout";
import { EDGE_TYPE_COLORS, EDGE_TYPE_LABELS } from "@/lib/edge-colors";

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
  const [depth, setDepth] = useState<"protocol" | "market" | "curator">("market"); // 기본은 체인→프로토콜→마켓 분포.
  const [panelOpen, setPanelOpen] = useState(true);             // 우측 상세 패널 토글
  const [hiddenChains, setHiddenChains] = useState<Set<string>>(new Set());        // 체크 해제된(숨긴) 체인
  const [dbNodes, setDbNodes] = useState<Map<string, GraphNode>>(new Map());
  const [dbEdges, setDbEdges] = useState<GraphEdge[]>([]);
  const [picked, setPicked] = useState<Record<string, unknown> | null>(null);
  const [dossier, setDossier] = useState<DossierData | null>(null);
  const [dossierLoading, setDossierLoading] = useState(true);
  const [breadth, setBreadth] = useState<BreadthItem[]>([]);
  const [tokenAddr, setTokenAddr] = useState<Record<string, string>>({});
  const [morphoByChain, setMorphoByChain] = useState<Record<string, MorphoMkt[]>>({});
  const [eulerByChain, setEulerByChain] = useState<Record<string, EulerVault[]>>({});
  const [supplyByChain, setSupplyByChain] = useState<Record<string, { supply: number; supplyUsd: number }>>({});
  const [bridgeAuth, setBridgeAuth] = useState<Record<string, { bridgeAddr: string; authType: string; mintLimit: number | null; note: string | null }[]>>({});
  const [breadthLoading, setBreadthLoading] = useState(false); // 라이브 데이터 수집 중

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
    // breadth(전 체인 DeFiLlama 라이브) — DB 가 못 잡는 체인/프로토콜/마켓·풀까지 으아아악 수집
    setBreadth([]); setTokenAddr({}); setMorphoByChain({}); setEulerByChain({}); setSupplyByChain({}); setBridgeAuth({}); setBreadthLoading(true);
    fetch(`/api/breadth/${encodeURIComponent(sym)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => { setBreadth(d.items ?? []); setTokenAddr(d.tokenAddrByChain ?? {}); setMorphoByChain(d.morphoMarkets ?? {}); setEulerByChain(d.eulerVaults ?? {}); setSupplyByChain(d.supplyByChain ?? {}); }).catch(() => {}).finally(() => setBreadthLoading(false));
    fetch(`/api/bridge-authority/${encodeURIComponent(sym)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => setBridgeAuth(d.byChain ?? {})).catch(() => {});
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
    () => applyConcentricLayout({ symbol: sym, tokenIds: tokenIdSet, relations: mergedRelations, dbNodes: mergedNodes, hiddenChains, poolsByKey, tokenAddrByChain: tokenAddr, includeMarkets, includeVaults, morphoByChain, eulerByChain, supplyByChain, bridgeAuthByChain: bridgeAuth, bridgeHub }),
    [sym, tokenIdSet, mergedRelations, mergedNodes, hiddenChains, poolsByKey, tokenAddr, includeMarkets, includeVaults, morphoByChain, eulerByChain, supplyByChain, bridgeAuth, bridgeHub],
  );
  const subNodeById = useMemo(() => { const m = new Map<string, GraphNode>(); for (const n of subTopology.nodes) m.set(n.id, n); return m; }, [subTopology]);
  const subNodeStates = useMemo(() => {
    // ouroboros(같은 계열 담보↔대출) 신호 전면 제외 — "같은 계열이면 레버리지 가능"은 약한 추정 휴리스틱.
    const m: Record<string, NodeTickState> = {};
    for (const n of subTopology.nodes) m[n.id] = SAFE_NODE_STATE;
    return m;
  }, [subTopology]);

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
    const md = id ? (subNodeById.get(id)?.metadata as Record<string, unknown> | undefined) : undefined;
    if (md?._market) setPicked({ ...(md._market as Record<string, unknown>), market: subNodeById.get(id!)?.label });
    else if (md?._vault) setPicked(md._vault as Record<string, unknown>);
    else if (id && subNodeById.get(id)?.type !== "Token") {
      const realId = id.replace(/^c:[^:]+:/, "");
      const rel = relations.find((r) => r.otherId === realId);
      const a = rel?.edge.attrs;
      setPicked(a ? { protocol: rel!.otherLabel, market: rel!.otherLabel, sizeUsd: a.core?.amountUsd, utilization: a.lendingRisk?.utilization, lltv: null } : null);
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

      {/* ── 컨트롤 레일 (직교 손잡이: 깊이·형태) — 스코프는 체인 수로 자동 합침, 렌즈는 제거 ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 lg:px-5">
        <ControlGroup label="깊이">
          <Seg active={depth === "protocol"} onClick={() => setDepth("protocol")}>프로토콜</Seg>
          <Seg active={depth === "market"} onClick={() => setDepth("market")}>+마켓</Seg>
          <Seg active={depth === "curator"} onClick={() => setDepth("curator")}>+큐레이터</Seg>
        </ControlGroup>
        {(visibleChainCount > 1 || chains.length > 1) ? <span className="text-[10px] text-[var(--color-text-muted)]">{bridgeHub ? "매크로: 체인+브릿지" : "마이크로: 단일 체인"}</span> : null}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase text-[var(--color-text-muted)]">체인</span>
          <button onClick={() => { userToggledChains.current = true; setHiddenChains((prev) => prev.size > 0 ? new Set() : new Set(chainOpts.map((c) => c.key))); setPicked(null); setSelNode(null); }}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--color-accent)] hover:underline">전체</button>
          {chainOpts.map((c) => {
            const ch = c.key;
            const on = !hiddenChains.has(ch);
            return (
              <button key={ch}
                onClick={() => { userToggledChains.current = true; setHiddenChains((prev) => { const n = new Set(prev); if (n.has(ch)) n.delete(ch); else n.add(ch); return n; }); setPicked(null); setSelNode(null); }}
                className={"flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors " + (on ? "text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)]" : "text-[var(--color-text-muted)] opacity-55 hover:opacity-90")}>
                <span className={"inline-block size-2.5 rounded-[3px] border transition-colors " + (on ? "border-[var(--color-accent)] bg-[var(--color-accent)]" : "border-[var(--color-border-subtle)] bg-transparent")} />
                {c.label}
              </button>
            );
          })}
        </div>
        <Link href={`/flow?token=${encodeURIComponent(sym)}`}
          className="ml-auto flex items-center gap-1 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-raised)]">
          <Activity size={12} /> 흐름맵에서 보기
        </Link>
        <button onClick={() => setPanelOpen((o) => !o)} title="상세 패널 토글"
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
          {panelOpen ? "상세 패널 ▸" : "◂ 상세 패널"}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 좌: 그래프 */}
        <div className="relative h-[560px] min-h-[560px] flex-none lg:h-auto lg:min-h-0 lg:flex-1">
          {breadthLoading ? (
            // 라이브 수집이 끝날 때까지 "부분 그래프"를 보여주지 않고 깔끔한 로딩만.
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-center text-[var(--color-text-secondary)]">
                <span className="size-8 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
                <span className="text-sm">{sym} 데이터 로딩 중…</span>
                <span className="max-w-[260px] text-[11px] leading-relaxed text-[var(--color-text-muted)]">전 체인 풀·마켓·큐레이터·브릿지·온체인 공급을 모으는 중입니다</span>
              </div>
            </div>
          ) : subTopology.nodes.length > 1 ? (
            <GraphCanvas graphKey={`tok-${sym}-${depth}-${bridgeHub ? "macro" : "micro"}-${[...hiddenChains].sort().join(",") || "all"}-${subTopology.nodes.length}`} topology={subTopology} nodeStates={subNodeStates} selectedNodeId={selNode} onSelectNode={onGraphSelect} staticLayout />
          ) : (
            <Empty msg={`${sym} 의 온체인 엣지가 DB 에 없음 — 스냅샷 대상 토큰이 아닐 수 있어요.`} />
          )}
          {!breadthLoading && subTopology.nodes.length > 1 && (
            <>
              <DistributionCard rows={distributionRows} />
              <GraphLegend bridge={bridgeHub} />
            </>
          )}
        </div>

        {/* 우: 상세 패널 (토글 가능) */}
        {panelOpen && (
          <aside className="w-full shrink-0 overflow-y-auto border-t border-[var(--color-border-subtle)] bg-[var(--color-surface)] lg:w-[400px] lg:border-l lg:border-t-0">
            {picked ? (
              <PickDetail d={picked} onClose={() => setPicked(null)} />
            ) : (
              <div className="px-5 py-4">
                <div className="mb-3"><div className="text-lg font-semibold text-[var(--color-text-primary)]">{sym}</div></div>
                <TokenDossier node={tokenNode} relations={relations} state={state} data={dossier} dataLoading={dossierLoading} />
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
function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
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

function GraphLegend({ bridge }: { bridge: boolean }) {
  const types = bridge
    ? (["bridge_lockmint", "bridge_burnmint", "bridge_liquidity"] as const)
    : (["collateral", "collateral_isolated", "deposit_supply", "lp_pair", "cdp_collateral", "mint_backing"] as const);
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-10 hidden max-w-[180px] space-y-0.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/85 px-2 py-1.5 text-[9px] leading-relaxed text-[var(--color-text-secondary)] shadow-sm backdrop-blur lg:block">
      <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">엣지 종류</div>
      {types.map((t) => (
        <div key={t} className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-4 border-t-2" style={{ borderColor: EDGE_TYPE_COLORS[t] }} />
          {EDGE_TYPE_LABELS[t]}
        </div>
      ))}
      <div className="mt-1 border-t border-[var(--color-border-subtle)] pt-1 text-[var(--color-text-muted)]">실선=온체인 · 점선=라이브(추정) · 원 크기=노출 비율</div>
    </div>
  );
}

function PickDetail({ d, onClose }: { d: Record<string, unknown>; onClose: () => void }) {
  const isVault = "curator" in d || "allocationUsd" in d;
  const isPool = d.kind === "pool";
  const head = isVault ? "볼트 · 큐레이터" : isPool ? "풀/마켓 · DeFiLlama" : "마켓 상세";
  const title = isVault ? String(d.curator ?? d.vault ?? "vault") : String(d.market);
  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{head}</div>
          <div className="text-lg font-semibold text-[var(--color-text-primary)]">{title}</div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"><X size={16} /></button>
      </div>
      <div className="space-y-1.5 text-[12px]">
        {isVault ? (
          <>
            {d.vault ? <Row k="볼트" v={String(d.vault)} /> : null}
            <Row k="할당" v={formatUsd((d.allocationUsd as number) ?? 0)} />
            <Row k="예치자산" v={String(d.depositAsset ?? "—")} />
            <Row k="펀딩 마켓" v={String(d.market)} />
            <p className="pt-1 text-[10px] leading-snug text-[var(--color-text-muted)]">외부 큐레이터 볼트 — 이 토큰 마켓에 다른 큐레이터가 얼마나 투자 중인지. 큐레이터 risk profile 은 추후 확장.</p>
          </>
        ) : isPool ? (
          <>
            <Row k="프로토콜" v={String(d.protocol)} />
            <Row k="유형" v={d.exposure === "multi" ? "멀티자산 (LP/DEX)" : "단일자산 (담보·예치)"} />
            {d.poolMeta ? <Row k="마켓" v={String(d.poolMeta)} /> : null}
            <Row k="규모 (TVL)" v={formatUsd((d.sizeUsd as number) ?? 0)} />
            <Row k="APY" v={apyFmt(d.apy as number)} />
            {d.apyReward != null && (d.apyReward as number) > 0 ? <Row k="└ 리워드" v={apyFmt(d.apyReward as number)} /> : null}
            <Row k="IL 위험" v={d.ilRisk === "yes" ? "있음 ⚠" : "없음"} />
            {d.stablecoin ? <Row k="스테이블풀" v="예" /> : null}
            <p className="pt-1 text-[10px] leading-snug text-[var(--color-text-muted)]">DeFiLlama 집계(breadth) — TVL·APY 기준, 온체인 미검증(엣지 점선). 마켓별 LTV·청산선·큐레이터는 정밀 어댑터(Morpho 등)에서만 제공.</p>
          </>
        ) : (
          <>
            <Row k="프로토콜" v={String(d.protocol)} />
            {d.role ? <Row k="이 토큰 역할" v={d.role === "supply" ? "공급(예치)" : "담보"} /> : null}
            <Row k="LLTV (청산선)" v={pct(d.lltv as number)} />
            {d.aggLtv != null ? <Row k="평균 LTV (aggLTV)" v={pct(d.aggLtv as number)} /> : null}
            <Row k="규모" v={formatUsd((d.sizeUsd as number) ?? 0)} />
            <Row k="가동률" v={pct(d.utilization as number)} />
          </>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-[var(--color-text-muted)]">{k}</span><span className="font-mono text-[var(--color-text-secondary)]">{v}</span></div>;
}
