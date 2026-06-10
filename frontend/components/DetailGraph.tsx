"use client";

/**
 * 상세그래프 — 위→아래 다계층: 토큰 → 체인 → 프로토콜(TVL순) → 핵심마켓 → 큐레이터.
 *   · 토큰→체인 엣지 위 ◆ = 그 체인으로 가는 브릿지(CCIP·LayerZero 등, bridge-authority). 클릭=상세.
 *   · 체인→프로토콜 / 프로토콜→마켓 엣지 위 ◉/⚠ = 그 오라클의 위험 분류(oracle.ts). 클릭=상세.
 *       시장가=초록 · 환율(LST)=파랑 · 풀현물가=노랑 · 하드코딩/NAV=빨강 ⚠(청산 지연→bad debt).
 *   · 토큰 노드 = kuromi reflexivity 사기 판정(grade·자기참조 오라클·self-deal 루핑). 정적 reflexivity.json.
 *   · kuromi 가 HIGH+ ∧ 자기참조(bespoke/NAV) 로 본 토큰의 Morpho 마켓 오라클은 ⚠ 빨강으로 승격.
 *   · 공유 큐레이터(fan-in) 하이라이트. 엣지 클릭 → 우측 패널.
 */

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { formatUsd, type TopologyResponse } from "@/lib/api";
import { EDGE_TYPE_COLORS } from "@/lib/edge-colors";
import { ORACLE_COLORS, oracleClassOf, oracleNote, type OracleClass } from "@/lib/oracle";

// ── 색 ─────────────────────────────────────────────────────────
const C_LOOP = "#dc2626";
const C_SHARED = "#d97706";
const C_TOKEN = "#4f46e5";
const C_BRIDGE = "#0d9488";
const C_DANGER = "#dc2626"; // 하드코딩/자기참조 오라클 = 위험
const EDGE_C2P = EDGE_TYPE_COLORS.collateral; // 체인→프로토콜
const EDGE_P2M = EDGE_TYPE_COLORS.collateral_isolated;
const EDGE_M2C = EDGE_TYPE_COLORS.deposit_supply;

const MAX_PROTOS = 12;
const MAX_MARKETS = 14;
const MAX_CURATORS = 9;

const LAYER_Y = { token: 0, chain: 190, proto: 410, market: 660, curator: 910 };
const STEP_X = 222;

// ── 체인 ───────────────────────────────────────────────────────
const CHAIN_COLOR: Record<string, string> = { ethereum: "#627eea", base: "#0052ff", arbitrum: "#28a0f0", optimism: "#ff0420", polygon: "#8247e5", gnosis: "#04795b", linea: "#1f8fff", scroll: "#c4853a", sonic: "#1e90ff", unichain: "#ff007a" };
const CHAIN_ORDER = ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis", "linea", "scroll"];
const chainPretty = (c: string) => (c ? c.charAt(0).toUpperCase() + c.slice(1) : "?");
const chainColor = (c: string) => CHAIN_COLOR[c] ?? "#64748b";
const chainRank = (c: string) => { const i = CHAIN_ORDER.indexOf(c); return i === -1 ? 99 : i; };

// ── kuromi reflexivity 사기 판정 (정적 reflexivity.json) ─────────
const GRADE_COLOR: Record<string, string> = { CRITICAL: "#dc2626", DISTRESSED: "#b91c1c", HIGH: "#ea580c", MED: "#d97706", CHECK: "#ca8a04", ok: "#16a34a" };
const gradeColor = (g?: string | null) => GRADE_COLOR[g ?? ""] ?? "#64748b";
const isHighGrade = (g?: string | null) => !!g && /HIGH|CRITICAL|DISTRESSED/i.test(g);
// kuromi oracle_class 중 자기참조(reflexive) 계열 — bespoke/NAV·self-NAV
const isReflexiveKuromi = (s?: string | null) => !!s && /bespoke|nav/i.test(s);
export interface ReflexEntry { grade?: string | null; oracle_class?: string | null; oracle_name?: string | null; sees?: string | null; looping?: boolean; sole_borrower?: boolean; concentration?: number | null; n_borrowers?: number; n_markets?: number }

// bridge-authority authType → 사람이 읽는 브릿지명
const AUTH_LABEL: Record<string, { name: string; tag: string; mech: string }> = {
  ccip_pool: { name: "Chainlink CCIP", tag: "CCIP", mech: "번&민트" },
  ccip_remote: { name: "Chainlink CCIP (원격풀)", tag: "CCIP↗", mech: "번&민트" },
  oft_peer: { name: "LayerZero OFT", tag: "LZ", mech: "번&민트" },
  xerc20: { name: "xERC20", tag: "xERC20", mech: "번&민트" },
  xerc20_lockbox: { name: "xERC20 Lockbox", tag: "xERC20-LB", mech: "락&민트" },
  minter_role: { name: "MINTER_ROLE", tag: "MINTER", mech: "번&민트" },
  cctp: { name: "Circle CCTP", tag: "CCTP", mech: "번&민트" },
  wormhole_ntt: { name: "Wormhole NTT", tag: "NTT", mech: "번&민트" },
  axelar_its: { name: "Axelar ITS", tag: "AXL", mech: "번&민트" },
  hyperlane: { name: "Hyperlane", tag: "HYP", mech: "번&민트" },
  op_bridge: { name: "OP Bridge", tag: "OP", mech: "락&민트" },
  l2_canonical: { name: "L2 Canonical", tag: "L2", mech: "락&민트" },
  polygon_pos: { name: "Polygon PoS", tag: "POS", mech: "락&민트" },
  mint_event: { name: "민트 이벤트(추정)", tag: "mint?", mech: "추정" },
};
const authLabel = (t: string) => AUTH_LABEL[t] ?? { name: t, tag: t, mech: "?" };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const asNum = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pctText = (v: number) => (!(v > 0) ? "—" : v * 100 < 0.01 ? "<0.01%" : v * 100 < 10 ? `${(v * 100).toFixed(2)}%` : `${(v * 100).toFixed(1)}%`);
const pctOf = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);
const shortAddr = (a: string | null | undefined) => (a && /^0x[0-9a-fA-F]{6,}/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : null);

// ── 파싱 모델 ──────────────────────────────────────────────────
interface OracleInfo { type?: string | null; provider?: string | null; address?: string | null; depegSensitive?: boolean; description?: string | null; verified?: boolean }
interface DMarket { id: string; label: string; usd: number; pct: number; lltv: number | null; util: number | null; ouroboros: boolean; aggLtv: number | null; category: string; oracle: OracleInfo | null; payload: Record<string, unknown> }
interface DProto { id: string; label: string; usd: number; pct: number; category: string; chain: string; markets: DMarket[]; oracle?: OracleInfo }
interface DCurator { id: string; label: string; usd: number; marketIds: string[] }
interface AuthEntry { authType: string; mintLimit?: number | null; note?: string | null }
interface DBridge { chain: string; auths: Array<{ name: string; tag: string; mech: string }>; mintLimit: number | null }

function parse(topo: TopologyResponse) {
  const protos = new Map<string, DProto>();
  for (const n of topo.nodes) {
    if (!n.id.startsWith("c:")) continue;
    if (n.type === "Token" || n.type === "Bridge" || n.type === "IslandHandle") continue;
    if (n.metadata._market || n.metadata._vault) continue;
    protos.set(n.id, { id: n.id, label: n.label, usd: num(n.metadata.sizeUsd), pct: num(n.metadata.distributionPct), category: String(n.metadata.category ?? ""), chain: String(n.metadata.chain ?? "ethereum"), markets: [] });
  }
  for (const n of topo.nodes) {
    if (!n.metadata._market) continue;
    const p = n.metadata._market as Record<string, unknown>;
    const mOracle: OracleInfo | null =
      (p.oracle && typeof p.oracle === "object" ? (p.oracle as OracleInfo) : null) ??
      (typeof p.oracleAddress === "string" ? { type: null, provider: null, address: p.oracleAddress, depegSensitive: true, verified: false } : null);
    const m: DMarket = { id: n.id, label: n.label, usd: num(n.metadata.sizeUsd), pct: num(n.metadata.distributionPct), lltv: asNum(p.lltv), util: asNum(p.utilization), ouroboros: !!p.ouroboros, aggLtv: asNum(p.aggLtv), category: String(n.metadata.category ?? ""), oracle: mOracle, payload: { ...p, market: n.label } };
    protos.get(n.id.replace(/:m\d+$/, ""))?.markets.push(m);
  }
  for (const e of topo.edges) {
    const o = e.attrs?.oracle as OracleInfo | undefined;
    const p = protos.get(e.target);
    if (o && p && !p.oracle && (o.type || o.provider || o.address)) p.oracle = o;
  }
  const curators = new Map<string, DCurator>();
  for (const n of topo.nodes) {
    if (!n.metadata._vault) continue;
    const v = n.metadata._vault as Record<string, unknown>;
    const name = String(v.curator ?? v.vault ?? n.label ?? "vault");
    const mid = n.id.replace(/:v\d+$/, "");
    const cur = curators.get(name) ?? { id: `cur:${name}`, label: name, usd: 0, marketIds: [] };
    cur.usd += num(v.allocationUsd);
    if (!cur.marketIds.includes(mid)) cur.marketIds.push(mid);
    curators.set(name, cur);
  }
  return { protos, curators };
}

function spreadX<T extends { x: number }>(items: T[], gap: number): T[] {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let prev = -Infinity;
  for (const it of sorted) { if (it.x < prev + gap) it.x = prev + gap; prev = it.x; }
  return sorted;
}

// ── 노드/엣지 데이터 ───────────────────────────────────────────
type Kind = "token" | "chain" | "proto" | "market" | "curator";
interface DetailData extends Record<string, unknown> {
  kind: Kind; label: string; usd?: number; pct?: number; sub?: string;
  badge?: string | null; flag?: "loop" | "shared" | null; more?: string | null; chain?: string;
  fraudBadge?: string | null; fraudDanger?: boolean; grade?: string | null;  // kuromi 사기 판정(토큰 노드)
}
type DetailRFNode = Node<DetailData, "detail">;

interface Circle { color: string; glyph: string; title: string; onClick: () => void }
interface EdgeExtra extends Record<string, unknown> { rel?: Record<string, unknown>; circle?: Circle }

type PopupState =
  | { kind: "oracle"; label: string; oracle: OracleInfo; cls: OracleClass; note: string; kuromi?: string | null }
  | { kind: "bridge"; label: string; bridge: DBridge }
  | null;

export function DetailGraph({
  sym,
  topology,
  bridgeAuth,
  reflex,
  onSelect,
}: {
  sym: string;
  topology: TopologyResponse;
  bridgeAuth?: Record<string, AuthEntry[]>;
  /** kuromi reflexivity 사기 판정 — page 가 dossier.loops(reflexivity-v1)에서 라이브로 내려줌(정적 JSON 대체). */
  reflex?: ReflexEntry | null;
  onSelect?: (payload: Record<string, unknown> | null) => void;
}) {
  const [popup, setPopup] = useState<PopupState>(null);
  const fraud = reflex ?? null;

  const { nodes, edges, stats } = useMemo(() => {
    const { protos, curators } = parse(topology);

    // 오라클 위험 분류 ◉/⚠ — oracle.ts(시장가/환율/풀현물/하드코딩) 색·위험. forceDanger=kuromi 자기참조 승격.
    const oracleCircle = (o: OracleInfo, label: string, forceDanger: boolean): Circle => {
      const cls: OracleClass = forceDanger ? "하드코딩·고정" : oracleClassOf(o.type, o.provider, sym);
      const meta = oracleNote(cls);
      const danger = meta.danger || forceDanger;
      return {
        color: danger ? C_DANGER : ORACLE_COLORS[cls],
        glyph: danger ? "⚠" : "◉",
        title: `오라클: ${cls}${danger ? " ⚠ 위험" : ""} (클릭=상세)`,
        onClick: () => setPopup({ kind: "oracle", label, oracle: o, cls, note: meta.note, kuromi: forceDanger ? fraud?.oracle_class ?? null : null }),
      };
    };

    // 1) 프로토콜 — (1)큐레이터(볼트) 보유 프로토콜 최우선 → (2)체인별 top → (3)규모순 (MAX_PROTOS 까지).
    const allProtos = [...protos.values()].sort((a, b) => b.usd - a.usd);
    const curatorProtoIds = new Set([...curators.values()].flatMap((c) => c.marketIds).map((id) => id.replace(/:m\d+$/, "")));
    const byChainList = new Map<string, DProto[]>();
    for (const p of allProtos) { const l = byChainList.get(p.chain); if (l) l.push(p); else byChainList.set(p.chain, [p]); }
    const chainsByUsd = [...byChainList.values()].sort((a, b) => b.reduce((s, p) => s + p.usd, 0) - a.reduce((s, p) => s + p.usd, 0));
    const PER_CHAIN_MIN = 2;
    const vizProtos: DProto[] = [];
    const addP = (p?: DProto) => { if (p && vizProtos.length < MAX_PROTOS && !vizProtos.some((x) => x.id === p.id)) vizProtos.push(p); };
    allProtos.filter((p) => curatorProtoIds.has(p.id)).forEach(addP);    // (1) 큐레이터 보유 프로토콜 먼저
    chainsByUsd.forEach((l) => l.slice(0, PER_CHAIN_MIN).forEach(addP));  // (2) 체인별 top (L2 가시성)
    allProtos.forEach(addP);                                             // (3) 규모순 채움
    vizProtos.sort((a, b) => chainRank(a.chain) - chainRank(b.chain) || b.usd - a.usd);
    const hiddenProtoN = allProtos.length - vizProtos.length;

    // 2) 마켓 — 프로토콜당 대표 1개 우선 채운 뒤 큐레이터 마켓 우선으로 MAX_MARKETS 까지.
    const curMktIds = new Set([...curators.values()].flatMap((c) => c.marketIds));
    const prio = (a: DMarket, b: DMarket) => ((curMktIds.has(b.id) ? 1 : 0) - (curMktIds.has(a.id) ? 1 : 0)) || (b.usd - a.usd);
    const perProto = vizProtos.map((p) => ({ p, ms: [...p.markets].sort(prio) }));
    const vizMarkets: DMarket[] = [];
    for (const { ms } of perProto) if (ms[0]) vizMarkets.push(ms[0]);
    for (const m of perProto.flatMap(({ ms }) => ms.slice(1)).sort(prio)) { if (vizMarkets.length >= MAX_MARKETS) break; vizMarkets.push(m); }
    const protoIdx = new Map(vizProtos.map((p, i) => [p.id, i] as const));
    vizMarkets.sort((a, b) => ((protoIdx.get(a.id.replace(/:m\d+$/, "")) ?? 99) - (protoIdx.get(b.id.replace(/:m\d+$/, "")) ?? 99)) || (b.usd - a.usd));
    const vizMarketIds = new Set(vizMarkets.map((m) => m.id));
    const protoHiddenMkt = new Map<string, number>();
    for (const p of vizProtos) { const shown = p.markets.filter((m) => vizMarketIds.has(m.id)).length; if (p.markets.length > shown) protoHiddenMkt.set(p.id, p.markets.length - shown); }

    // 3) 큐레이터 — 보이는 마켓에 연결된 큐레이터 상위 MAX_CURATORS.
    const vizCurators = [...curators.values()]
      .map((c) => ({ ...c, marketIds: c.marketIds.filter((id) => vizMarketIds.has(id)) }))
      .filter((c) => c.marketIds.length > 0)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, MAX_CURATORS);
    const hiddenCurN = [...curators.values()].filter((c) => c.marketIds.some((id) => vizMarketIds.has(id))).length - vizCurators.length;
    const sharedCount = vizCurators.filter((c) => c.marketIds.length >= 2).length;
    // 마켓별 오라클이 보이는 프로토콜 — 이 경우 프로토콜 엣지의 ◉(대표값)는 숨기고 마켓 엣지에 per-market 으로 표시.
    const hasMktOracle = (m: DMarket) => !!(m.oracle && (m.oracle.type || m.oracle.address));
    // kuromi 가 HIGH+ ∧ 자기참조로 본 토큰 → Morpho 마켓 오라클을 ⚠ 빨강으로 승격(멘토 #8: 엣지에서 경고).
    const fraudHigh = !!fraud && isHighGrade(fraud.grade) && isReflexiveKuromi(fraud.oracle_class);
    const isMorphoId = (id: string, label: string) => /morpho/i.test(id) || /morpho/i.test(label);
    const escalateMkt = (m: DMarket) => fraudHigh && isMorphoId(m.id, vizProtos.find((p) => p.id === m.id.replace(/:m\d+$/, ""))?.label ?? "");
    // ◉ 가 마켓 엣지에 뜨는(또는 승격된) 마켓 — 프로토콜 대표 ◉ 는 숨김.
    const protoHasMktOracle = new Set(vizMarkets.filter((m) => hasMktOracle(m) || escalateMkt(m)).map((m) => m.id.replace(/:m\d+$/, "")));
    const loopCount = vizMarkets.filter(escalateMkt).length;

    // 4) 체인 — 보이는 프로토콜의 체인 ∪ bridge-authority 체인
    const chainSet = new Set<string>(vizProtos.map((p) => p.chain));
    for (const ch of Object.keys(bridgeAuth ?? {})) if ((bridgeAuth![ch] ?? []).length) chainSet.add(ch);
    const chains = [...chainSet].sort((a, b) => chainRank(a) - chainRank(b));

    // 체인별 브릿지(bridge-authority) 정리
    const bridgeForChain = (ch: string): DBridge | null => {
      const list = (bridgeAuth?.[ch] ?? []).filter((x) => x.authType);
      if (!list.length) return null;
      const seen = new Set<string>();
      const auths = list.filter((x) => !seen.has(x.authType) && seen.add(x.authType)).map((x) => authLabel(x.authType));
      const mintLimit = list.map((x) => x.mintLimit).filter((v): v is number => v != null).sort((a, b) => b - a)[0] ?? null;
      return { chain: ch, auths, mintLimit };
    };

    const N: DetailRFNode[] = [];
    const E: Edge[] = [];
    const maxUsd = Math.max(1, ...vizMarkets.map((m) => m.usd), ...vizProtos.map((p) => p.usd), ...vizCurators.map((c) => c.usd));
    const sw = (usd: number) => 1.3 + 3.0 * Math.sqrt(Math.min(1, usd / maxUsd));

    // ── 레이아웃: 마켓 슬롯 → 부모는 자식 평균 x (타이디 트리) ──
    const marketX = new Map<string, number>();
    vizMarkets.forEach((m, i) => marketX.set(m.id, i * STEP_X));
    const protoPos = vizProtos.map((p, i) => {
      const own = p.markets.filter((m) => vizMarketIds.has(m.id));
      const x = own.length ? own.reduce((s, m) => s + (marketX.get(m.id) ?? 0), 0) / own.length : i * STEP_X;
      return { p, x };
    });
    spreadX(protoPos, STEP_X);
    const protoX = new Map(protoPos.map((v) => [v.p.id, v.x] as const));
    // 체인 x = 그 체인 프로토콜 평균
    const chainPos = chains.map((ch) => {
      const own = protoPos.filter((v) => v.p.chain === ch);
      const x = own.length ? own.reduce((s, v) => s + v.x, 0) / own.length : (chains.indexOf(ch)) * STEP_X * 2;
      return { ch, x };
    });
    spreadX(chainPos, STEP_X * 1.4);
    const chainX = new Map(chainPos.map((v) => [v.ch, v.x] as const));
    const curPos = vizCurators.map((c) => ({ c, x: c.marketIds.reduce((s, id) => s + (marketX.get(id) ?? 0), 0) / c.marketIds.length }));
    spreadX(curPos, STEP_X);
    const curX = new Map(curPos.map((v) => [v.c.id, v.x] as const));
    const tokenX = chainPos.length ? chainPos.reduce((s, v) => s + v.x, 0) / chainPos.length : 0;

    // 토큰 (+ kuromi 사기 판정 뱃지)
    const totalUsd = vizProtos.reduce((s, p) => s + p.usd, 0);
    const fraudBadge = fraud
      ? `사기판정 ${fraud.grade ?? "?"}${fraud.oracle_class ? ` · ${fraud.oracle_class}` : ""}${fraud.looping ? " · ♻ self-deal" : ""}`
      : null;
    N.push({ id: "detail:token", type: "detail", position: { x: tokenX, y: LAYER_Y.token }, data: { kind: "token", label: sym, usd: totalUsd, sub: `${chains.length}개 체인 · 전체 노출`, fraudBadge, fraudDanger: isHighGrade(fraud?.grade), grade: fraud?.grade ?? null }, draggable: true });

    // 체인 노드 + 토큰→체인 엣지(브릿지 ◆)
    for (const { ch, x } of chainPos) {
      const protoCount = vizProtos.filter((p) => p.chain === ch).length;
      const chUsd = vizProtos.filter((p) => p.chain === ch).reduce((s, p) => s + p.usd, 0);
      N.push({ id: `chain:${ch}`, type: "detail", position: { x, y: LAYER_Y.chain }, data: { kind: "chain", label: chainPretty(ch), chain: ch, usd: chUsd, sub: `프로토콜 ${protoCount}개` }, draggable: true });
      const br = bridgeForChain(ch);
      const rel = { _rel: true, title: `${sym} → ${chainPretty(ch)}`, accent: chainColor(ch), rows: [{ k: "체인", v: chainPretty(ch) }, { k: "프로토콜", v: `${protoCount}개` }, { k: "노출", v: formatUsd(chUsd) }, ...(br ? [{ k: "브릿지", v: br.auths.map((a) => a.name).join(", ") }] : [{ k: "브릿지", v: "검증된 권한 없음(원본체인 가능)" }])] };
      const circle: Circle | undefined = br ? { color: C_BRIDGE, glyph: "◆", title: `브릿지: ${br.auths.map((a) => a.tag).join("+")} → ${chainPretty(ch)} (클릭=상세)`, onClick: () => setPopup({ kind: "bridge", label: chainPretty(ch), bridge: br }) } : undefined;
      E.push({ id: `e:tok:chain:${ch}`, source: "detail:token", target: `chain:${ch}`, sourceHandle: "b", targetHandle: "t", type: circle ? "circle" : "default", data: { rel, circle } as EdgeExtra, style: { stroke: chainColor(ch), strokeWidth: 2, strokeDasharray: circle ? "5 3" : undefined }, markerEnd: { type: MarkerType.ArrowClosed, color: chainColor(ch), width: 12, height: 12 } });
    }

    // 프로토콜 + 체인→프로토콜(오라클 ◉)
    for (const { p } of protoPos) {
      N.push({ id: p.id, type: "detail", position: { x: protoX.get(p.id) ?? 0, y: LAYER_Y.proto }, data: { kind: "proto", label: p.label, usd: p.usd, pct: p.pct, sub: p.category || `마켓 ${p.markets.length}개`, more: protoHiddenMkt.has(p.id) ? `마켓 +${protoHiddenMkt.get(p.id)} 외` : null }, draggable: true });
      const o = p.oracle;
      const perMkt = protoHasMktOracle.has(p.id); // 마켓별 오라클이 따로 보임 → 프로토콜 대표 ◉ 숨김
      const showProtoO = o && !perMkt;
      const cls = o ? oracleClassOf(o.type, o.provider, sym) : null;
      const oracleRows = perMkt
        ? [{ k: "오라클", v: "마켓별 상이 — 마켓 엣지의 ◉ 참조" }]
        : o ? [{ k: "오라클", v: cls ?? o.type ?? "—" }, { k: "└ 피드", v: o.description ?? o.provider ?? "—" }] : [];
      const rel: Record<string, unknown> = { _rel: true, title: `${chainPretty(p.chain)} · ${p.label}`, accent: EDGE_C2P, rows: [{ k: "체인", v: chainPretty(p.chain) }, { k: "규모", v: formatUsd(p.usd) }, { k: "비중", v: pctText(p.pct) }, ...oracleRows] };
      const circle = showProtoO ? oracleCircle(o!, p.label, false) : undefined;
      E.push({ id: `e:chain:${p.chain}:${p.id}`, source: `chain:${p.chain}`, target: p.id, sourceHandle: "b", targetHandle: "t", type: circle ? "circle" : "default", data: { rel, circle } as EdgeExtra, style: { stroke: EDGE_C2P, strokeWidth: sw(p.usd) }, markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_C2P, width: 11, height: 11 } });
    }

    // 마켓 + 프로토콜→마켓 (+ 자기참조 사기 마켓 빨강)
    for (const m of vizMarkets) {
      const pid = m.id.replace(/:m\d+$/, "");
      const proto = vizProtos.find((p) => p.id === pid);
      const danger = escalateMkt(m);
      const lev = m.aggLtv != null && m.aggLtv > 0 ? `${m.aggLtv.toFixed(1)}x` : m.lltv != null ? `LLTV ${pctOf(m.lltv)}` : null;
      N.push({ id: m.id, type: "detail", position: { x: marketX.get(m.id) ?? 0, y: LAYER_Y.market }, data: { kind: "market", label: m.label, usd: m.usd, pct: m.pct, sub: `${m.lltv != null ? `LLTV ${pctOf(m.lltv)}` : m.category}${m.util != null ? ` · 가동률 ${pctOf(m.util)}` : ""}`, flag: danger ? "loop" : null, badge: danger ? `⚠ 자기참조 오라클${lev ? ` · ${lev}` : ""}` : null }, draggable: true });
      // 이 마켓의 오라클 — 자체 오라클(Morpho 마켓별 상이) 또는 kuromi 승격 시 합성.
      const mo: OracleInfo | null = hasMktOracle(m)
        ? m.oracle!
        : danger ? { type: fraud?.oracle_class ?? null, provider: fraud?.oracle_name ?? null, address: null, depegSensitive: true, description: fraud?.sees ?? null, verified: false } : null;
      const cls = mo ? (danger ? "하드코딩·고정" : oracleClassOf(mo.type, mo.provider, sym)) : null;
      const oRows = mo ? [{ k: "오라클", v: cls ?? mo.type ?? "—" }, { k: "└ 피드", v: mo.description ?? mo.provider ?? "—" }, { k: "└ 검증", v: mo.verified ? "온체인 ✓" : "분류추정" }] : [];
      const rel = { _rel: true, title: `${proto?.label ?? "프로토콜"} → ${m.label}`, accent: danger ? C_LOOP : EDGE_P2M, rows: [{ k: "관계", v: "마켓" }, { k: "규모", v: formatUsd(m.usd) }, { k: "LLTV(청산선)", v: pctOf(m.lltv) }, { k: "평균 LTV", v: pctOf(m.aggLtv) }, { k: "가동률", v: pctOf(m.util) }, ...oRows], note: danger ? "⚠ 자기참조(NAV) 오라클 — 시장 디페그가 가격에 안 잡혀 청산 지연 → bad debt. kuromi 사기 판정 토큰." : undefined };
      const moCircle = mo ? oracleCircle(mo, m.label, danger) : undefined;
      E.push({ id: `e:${pid}:${m.id}`, source: pid, target: m.id, sourceHandle: "b", targetHandle: "t", type: moCircle ? "circle" : "default", data: { rel, circle: moCircle } as EdgeExtra, style: { stroke: danger ? C_LOOP : EDGE_P2M, strokeWidth: sw(m.usd) }, markerEnd: { type: MarkerType.ArrowClosed, color: danger ? C_LOOP : EDGE_P2M, width: 12, height: 12 } });
      if (danger) {
        E.push({ id: `loop:${m.id}`, source: m.id, target: "detail:token", sourceHandle: "loop", targetHandle: "loop", type: "default", label: "♻ self-deal", labelBgPadding: [4, 2], labelBgBorderRadius: 4, labelStyle: { fill: C_LOOP, fontSize: 10, fontWeight: 700 }, labelBgStyle: { fill: "#fff", stroke: C_LOOP, strokeWidth: 0.5 }, style: { stroke: C_LOOP, strokeWidth: 1.8, strokeDasharray: "5 3" }, markerEnd: { type: MarkerType.ArrowClosed, color: C_LOOP, width: 13, height: 13 }, zIndex: 5 });
      }
    }

    // 큐레이터 + 마켓→큐레이터
    for (const { c } of curPos) {
      const shared = c.marketIds.length >= 2;
      N.push({ id: c.id, type: "detail", position: { x: curX.get(c.id) ?? 0, y: LAYER_Y.curator }, data: { kind: "curator", label: c.label, usd: c.usd, sub: shared ? `${c.marketIds.length}개 마켓 펀딩` : "큐레이터 볼트", flag: shared ? "shared" : null, badge: shared ? `공유 큐레이터 · ${c.marketIds.length}마켓` : null }, draggable: true });
      for (const mid of c.marketIds) {
        const mk = vizMarkets.find((m) => m.id === mid);
        const rel = { _rel: true, title: `${mk?.label ?? "마켓"} → ${c.label}`, accent: shared ? C_SHARED : EDGE_M2C, rows: [{ k: "관계", v: "큐레이터 펀딩" }, { k: "큐레이터", v: c.label }, { k: "총 할당", v: formatUsd(c.usd) }, { k: "펀딩 마켓", v: `${c.marketIds.length}개` }], note: shared ? "여러 마켓 동시 펀딩 — 전염 가능." : undefined };
        E.push({ id: `e:${mid}:${c.id}`, source: mid, target: c.id, sourceHandle: "b", targetHandle: "t", type: "default", data: { rel } as EdgeExtra, style: { stroke: shared ? C_SHARED : EDGE_M2C, strokeWidth: shared ? 2.2 : 1.6, strokeDasharray: shared ? undefined : "4 3" }, markerEnd: { type: MarkerType.ArrowClosed, color: shared ? C_SHARED : EDGE_M2C, width: 11, height: 11 } });
      }
    }

    return { nodes: N, edges: E, stats: { chainN: chains.length, protoN: vizProtos.length, marketN: vizMarkets.length, curatorN: vizCurators.length, loopCount, sharedCount, hiddenProtoN, hiddenCurN } };
  }, [topology, sym, bridgeAuth, fraud]);

  const onNodeClick = useMemo(
    () => (_: React.MouseEvent, node: DetailRFNode) => {
      if (!onSelect) return;
      setPopup(null);
      const topoNode = topology.nodes.find((n) => n.id === node.id);
      if (topoNode?.metadata._market) onSelect({ ...(topoNode.metadata._market as Record<string, unknown>), market: topoNode.label });
      else if (node.data.kind === "token" && fraud) {
        onSelect({ _rel: true, title: `${sym} · kuromi 사기 판정`, accent: gradeColor(fraud.grade), rows: [{ k: "등급(grade)", v: fraud.grade ?? "—" }, { k: "오라클", v: fraud.oracle_class ?? "—" }, { k: "자기루핑", v: fraud.looping ? "true ♻" : "false" }, { k: "단일차입(sole)", v: fraud.sole_borrower ? "true ⚠" : "false" }, { k: "집중도", v: fraud.concentration != null ? `${Math.round(fraud.concentration * 100)}%` : "—" }, { k: "차입자", v: fraud.n_borrowers != null ? `${fraud.n_borrowers}명` : "—" }], note: "kuromi reflexivity_scan 이 과거 블록에서 자동 추출(정적 스냅샷). bespoke/NAV=자기참조 오라클 → 청산 미발동·무담보 발행 위험." });
      }
      else if (node.data.kind === "curator") {
        const v = topology.nodes.find((n) => n.metadata._vault && String((n.metadata._vault as Record<string, unknown>).curator ?? (n.metadata._vault as Record<string, unknown>).vault ?? n.label) === node.data.label);
        onSelect(v ? (v.metadata._vault as Record<string, unknown>) : null);
      } else onSelect(null);
    },
    [onSelect, topology, fraud, sym],
  );

  const onEdgeClick = useMemo(
    () => (_: React.MouseEvent, edge: Edge) => {
      const rel = (edge.data as EdgeExtra | undefined)?.rel;
      if (rel && onSelect) { setPopup(null); onSelect(rel); }
    },
    [onSelect],
  );

  if (nodes.length <= 1) {
    return <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--color-text-muted)]">{sym} 의 상세그래프를 그릴 데이터가 아직 없습니다.</div>;
  }

  return (
    <div className="relative h-full w-full bg-[var(--color-bg)]">
      <ReactFlowProvider>
        <ReactFlow<DetailRFNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={() => { onSelect?.(null); setPopup(null); }}
          colorMode="light"
          fitView
          fitViewOptions={{ padding: 0.16 }}
          minZoom={0.1}
          maxZoom={1.6}
          nodesDraggable
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d1d9e6" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>

      {/* 상단 요약 */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/92 px-3 py-2 text-[11px] shadow-sm backdrop-blur">
        <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">상세그래프 · 토큰▾체인▾프로토콜▾마켓▾큐레이터</div>
        {fraud && (
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="rounded px-1.5 py-0.5 font-bold" style={{ color: "#fff", background: gradeColor(fraud.grade) }}>사기판정 {fraud.grade}</span>
            <span className="text-[var(--color-text-secondary)]">{fraud.oracle_class}{fraud.looping ? " · ♻ self-deal" : ""}{fraud.concentration != null ? ` · 집중 ${Math.round(fraud.concentration * 100)}%` : ""}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[var(--color-text-secondary)]">
          <span>체인 <b className="font-mono text-[var(--color-text-primary)]">{stats.chainN}</b></span>
          <span>프로토콜 <b className="font-mono text-[var(--color-text-primary)]">{stats.protoN}{stats.hiddenProtoN > 0 ? `+${stats.hiddenProtoN}` : ""}</b></span>
          <span>마켓 <b className="font-mono text-[var(--color-text-primary)]">{stats.marketN}</b></span>
          <span>큐레이터 <b className="font-mono text-[var(--color-text-primary)]">{stats.curatorN}{stats.hiddenCurN > 0 ? `+${stats.hiddenCurN}` : ""}</b></span>
          {stats.loopCount > 0 && <span style={{ color: C_LOOP }}>⚠ 자기참조 마켓 <b className="font-mono">{stats.loopCount}</b></span>}
          {stats.sharedCount > 0 && <span style={{ color: C_SHARED }}>공유 큐레이터 <b className="font-mono">{stats.sharedCount}</b></span>}
        </div>
      </div>

      {/* 범례 */}
      <div className="pointer-events-none absolute right-3 top-3 z-10 hidden max-w-[240px] space-y-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/90 px-2.5 py-2 text-[9px] leading-relaxed text-[var(--color-text-secondary)] shadow-sm backdrop-blur lg:block">
        <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">읽는 법</div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex size-3 shrink-0 items-center justify-center rounded-full border-2 bg-white text-[6px] font-bold" style={{ borderColor: C_BRIDGE, color: C_BRIDGE }}>◆</span>
          <span>토큰→체인 = 브릿지(클릭=CCIP·LZ 등)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex size-3 shrink-0 items-center justify-center rounded-full border-2 bg-white text-[6px] font-bold" style={{ borderColor: C_DANGER, color: C_DANGER }}>⚠</span>
          <span>오라클 ◉ = 위험분류 · <b style={{ color: C_DANGER }}>⚠빨강</b>=하드코딩/자기참조</span>
        </div>
        <div className="flex items-center gap-2">
          <OracleChip cls="시장가" /><OracleChip cls="환율(LST)" /><OracleChip cls="하드코딩·고정" />
        </div>
        <Legend color={C_LOOP} label="♻ 자기참조 사기 마켓(kuromi)" />
        <Legend color={C_SHARED} label="공유 큐레이터" />
        <div className="mt-1 border-t border-[var(--color-border-subtle)] pt-1 text-[var(--color-text-muted)]">엣지/토큰 클릭=우측 상세 · 프로토콜 TVL순 · 체인별 분리</div>
      </div>

      {/* 팝오버 */}
      {popup && (
        <div className="absolute bottom-3 left-3 z-20 w-[278px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 text-[11px] shadow-lg">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: popup.kind === "oracle" ? (oracleNote(popup.cls).danger ? C_DANGER : ORACLE_COLORS[popup.cls]) : C_BRIDGE }}>
                {popup.kind === "oracle" ? "오라클" : "브릿지"} · {popup.label}
              </div>
              {popup.kind === "oracle" ? (
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{popup.cls}</span>
                  <span className="rounded px-1 py-0.5 text-[8.5px] font-bold" style={oracleNote(popup.cls).danger ? { color: "#fff", background: C_DANGER } : popup.oracle.verified ? { color: "#16a34a", background: "#16a34a18" } : { color: "#d97706", background: "#d9770618" }}>{oracleNote(popup.cls).danger ? "⚠ 위험" : popup.oracle.verified ? "✓ 온체인" : "분류추정"}</span>
                </div>
              ) : (
                <div className="mt-0.5 text-[13px] font-semibold text-[var(--color-text-primary)]">{popup.bridge.auths.map((a) => a.name).join(" + ")}</div>
              )}
            </div>
            <button onClick={() => setPopup(null)} className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"><X size={14} /></button>
          </div>
          {popup.kind === "oracle" ? (
            <>
              <div className="space-y-1">
                {popup.kuromi && <ORow k="kuromi 등급" v={popup.kuromi} />}
                {popup.oracle.description && <ORow k="피드" v={popup.oracle.description} />}
                {popup.oracle.type && <ORow k="타입" v={popup.oracle.type} />}
                <ORow k="제공자" v={popup.oracle.provider ?? "—"} />
                <ORow k="주소" v={shortAddr(popup.oracle.address) ?? "마켓별 상이/미수집"} mono />
              </div>
              <p className="mt-2 border-t border-[var(--color-border-subtle)] pt-1.5 text-[9.5px] leading-snug" style={{ color: oracleNote(popup.cls).danger ? C_DANGER : "var(--color-text-muted)" }}>{popup.note}</p>
            </>
          ) : (
            <>
              <div className="space-y-1">
                {popup.bridge.auths.map((a, i) => <ORow key={i} k={a.tag} v={`${a.name} · ${a.mech}`} />)}
                {popup.bridge.mintLimit != null && <ORow k="민트 한도" v={formatUsd(popup.bridge.mintLimit)} />}
              </div>
              <p className="mt-2 border-t border-[var(--color-border-subtle)] pt-1.5 text-[9.5px] leading-snug text-[var(--color-text-muted)]">온체인 검증된 민트 권한 — 이 경로로 토큰이 {popup.label} 체인에 발행/이동됨. 번&민트는 메시지층 침해 시 무담보 민팅 위험.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ORow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (<div className="flex items-center justify-between gap-3"><span className="shrink-0 text-[var(--color-text-muted)]">{k}</span><span className={"text-right text-[var(--color-text-secondary)] " + (mono ? "font-mono text-[10px]" : "")}>{v}</span></div>);
}
function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (<div className="flex items-center gap-1.5"><span className="inline-block h-0 w-4 shrink-0 border-t-2" style={{ borderColor: color, borderStyle: dashed ? "dashed" : "solid" }} /><span>{label}</span></div>);
}
function OracleChip({ cls }: { cls: OracleClass }) {
  const danger = oracleNote(cls).danger;
  return <span className="rounded px-1 py-0.5 text-[8px] font-semibold" style={{ color: danger ? "#fff" : "#0f172a", background: danger ? C_DANGER : ORACLE_COLORS[cls] }}>{cls}</span>;
}

// ── 커스텀 엣지: 위에 동그라미(오라클 ◉/⚠ / 브릿지 ◆) ─────────────
function CircleEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const c = (data as EdgeExtra | undefined)?.circle;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {c && (
        <EdgeLabelRenderer>
          <button onClick={(e) => { e.stopPropagation(); c.onClick(); }} title={c.title} className="nodrag nopan"
            style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, pointerEvents: "all", width: 18, height: 18, borderRadius: 9999, border: `2px solid ${c.color}`, background: "#fff", color: c.color, fontSize: 9, fontWeight: 700, lineHeight: "14px", cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.18)" }}>{c.glyph}</button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── 커스텀 노드 ────────────────────────────────────────────────
function DetailNodeView({ data, selected }: NodeProps<DetailRFNode>) {
  const { kind, label, usd, pct, sub, badge, flag, more, chain, fraudBadge, fraudDanger } = data;

  if (kind === "token") {
    const fc = fraudDanger ? C_DANGER : gradeColor(data.grade);
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border-2 px-4 py-2.5 text-center shadow-md" style={{ width: 168, borderColor: fraudBadge ? fc : C_TOKEN, background: "color-mix(in srgb, var(--color-accent) 8%, white)" }}>
        <Handle id="b" type="source" position={Position.Bottom} isConnectable={false} style={HANDLE} />
        <Handle id="loop" type="target" position={Position.Top} isConnectable={false} style={HANDLE} />
        <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: C_TOKEN }}>토큰</div>
        <div className="mt-0.5 text-[16px] font-extrabold text-[var(--color-text-primary)]">{label}</div>
        <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-secondary)]">{formatUsd(usd ?? 0)}</div>
        {fraudBadge && <div className="mt-1.5 inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ color: "#fff", background: fc }}>{fraudBadge}</div>}
      </div>
    );
  }

  if (kind === "chain") {
    const c = chainColor(chain ?? "");
    return (
      <div className="rounded-xl px-3 py-2 text-center shadow-sm" style={{ width: 150, border: `2px solid ${c}`, background: `color-mix(in srgb, ${c} 8%, white)`, outline: selected ? "2px solid var(--color-accent)" : "none", outlineOffset: 1 }}>
        <Handle id="t" type="target" position={Position.Top} isConnectable={false} style={HANDLE} />
        <Handle id="b" type="source" position={Position.Bottom} isConnectable={false} style={HANDLE} />
        <div className="flex items-center justify-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: c }} />
          <span className="text-[13px] font-bold" style={{ color: c }}>{label}</span>
        </div>
        <div className="mt-0.5 text-[9.5px] text-[var(--color-text-muted)]">{sub} · {formatUsd(usd ?? 0)}</div>
      </div>
    );
  }

  const accent = flag === "loop" ? C_LOOP : flag === "shared" ? C_SHARED : "var(--color-border-subtle)";
  return (
    <div className={"rounded-xl bg-white px-3 py-2 shadow-sm " + (selected ? "shadow-md" : "")} style={{ width: 198, border: `${flag ? 2 : 1}px solid ${accent}`, outline: selected ? "2px solid var(--color-accent)" : "none", outlineOffset: 1 }}>
      <Handle id="t" type="target" position={Position.Top} isConnectable={false} style={HANDLE} />
      {kind !== "curator" && <Handle id="b" type="source" position={Position.Bottom} isConnectable={false} style={HANDLE} />}
      {kind === "market" && <Handle id="loop" type="source" position={Position.Left} isConnectable={false} style={HANDLE} />}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold text-[var(--color-text-primary)]" title={label}>{label}</div>
          {sub && <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]" title={sub}>{sub}</div>}
        </div>
        <div className="shrink-0 text-right">
          {pct != null && pct > 0 && <div className="font-mono text-[11px] font-semibold text-[var(--color-text-primary)]">{pctText(pct)}</div>}
          <div className="font-mono text-[9.5px] text-[var(--color-text-muted)]">{formatUsd(usd ?? 0)}</div>
        </div>
      </div>
      {badge && <div className="mt-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[9.5px] font-bold" style={{ color: flag === "loop" ? C_LOOP : C_SHARED, background: `color-mix(in srgb, ${flag === "loop" ? C_LOOP : C_SHARED} 12%, white)` }}>{badge}</div>}
      {more && <div className="mt-1 text-[9.5px] text-[var(--color-text-muted)]">{more}</div>}
    </div>
  );
}

const HANDLE = { width: 1, height: 1, minWidth: 1, minHeight: 1, background: "transparent", border: "none" } as const;
const NODE_TYPES = { detail: DetailNodeView };
const EDGE_TYPES = { circle: CircleEdge };
