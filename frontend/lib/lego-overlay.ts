/**
 * 머니레고 오버레이 — 동심원 위에 파생토큰을 "출처 프로토콜에서 뻗어나오게" 얹고,
 * 그 파생을 "받아주는 개별 마켓"으로 의존 엣지를 잇는다. (사용자 설계 2026-06-12)
 *
 *   토큰 → 프로토콜 → (파생 풀/마켓) → (파생토큰) → 수용처 마켓
 *   예) sUSDe → Pendle → PT-sUSDE → [Morpho 담보마켓 PYUSD·RLUSD]
 *       sUSDe → Curve → steCRV(LP) → [Convex 풀 #25]
 *
 * 핵심 원칙:
 *  · 발행 쪽 = 프로토콜에 앵커(Pendle 이 PT 를 발행 → Pendle 노드에서 뻗음).
 *  · 수용 쪽 = "프로토콜이 아니라 그 파생을 받아주는 개별 마켓"에 연결(사용자: "프로토콜로 가지말고").
 *  · 토큰별 하드코딩 0 — 동심원 좌표/프로토콜 매칭만 보고 임의 토큰에 동일 동작.
 *
 * 동심원 id 체계(concentric-layout.ts): 토큰 = `c:{chain}:token`, 프로토콜(링1) = `c:{chain}:{protocol:* id}`,
 * 마켓(링2) = `{pid}:m{j}`, 볼트(링3) = `{pid}:m{j}:v{k}`. position = 좌상단(중심 = +diameterPx/2).
 */
import type { GraphEdge, GraphNode, TopologyResponse } from "./api";

export interface LegoApiNode {
  id: string; chain: string; address: string | null; kind: string; role: string | null;
  label: string; symbol: string | null; protocol: string | null; parent_token: string | null;
  meta: Record<string, unknown>;
}
export interface LegoApiEdge {
  src: string; dst: string; relation: string; chain: string;
  weight_usd: number | null; evidence: Record<string, unknown>;
}

// 레고 프로토콜 슬러그 → 동심원 canon 슬러그 후보 (DeFiLlama 표기차 흡수)
const LEGO_PROTO_ALIAS: Record<string, string[]> = {
  curve: ["curve-dex", "curve"],
  convex: ["convex-finance", "convex"],
  aave_v3: ["aave-v3", "aave"],
  aave_v2: ["aave-v2"],
  morpho_blue: ["morpho-blue", "morpho"],
  pendle: ["pendle"],
};
const PRETTY_PROTO: Record<string, string> = {
  convex: "Convex", "convex-finance": "Convex", morpho_blue: "Morpho Blue", pendle: "Pendle", curve: "Curve", aave_v3: "Aave V3",
  bridge: "브릿지", // 브릿지 래핑본 파생의 합성 출처 노드(동심원에 브릿지 프로토콜 앵커 없음)
  eigenlayer: "EigenLayer", ethena: "Ethena", veda: "Veda", // 상류 배킹·yield 재예치
};
function canonCandidates(slug: string | null): string[] {
  if (!slug) return [];
  const base = slug.replace(/_/g, "-").toLowerCase();
  return [...new Set([...(LEGO_PROTO_ALIAS[slug] ?? []), base])];
}
function canonOfConId(id: string): string {
  const rest = id.replace(/^c:[^:]+:/, "");
  const base = rest.replace(/^protocol:/, "").replace(/^dl:/, "").split("@")[0].replace(/_/g, "-").toLowerCase();
  return base === "sparklend" ? "spark" : base === "morphoblue" ? "morpho-blue" : base;
}

// 마켓/풀 라벨의 "의미있는" 토큰 집합 — 보는 토큰 자신·일반어 제거. 수용처를 기존 마켓에 매칭하는 데 씀.
const TOK_STOP = new Set(["lp", "pool", "crv", "vault", "market", "ng", "gauge", "cvx", "pt", "yt"]);
function sigTokens(label: string, viewed: string): Set<string> {
  return new Set(
    (label || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && t !== viewed && !TOK_STOP.has(t)),
  );
}
// 두 토큰집합이 의미있게 겹치나 (정확일치 또는 4자+ 접두 일치 — crvU↔crvUSD). "susde"만 겹치는 오탐은 viewed 제거로 차단.
function tokOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) for (const y of b) {
    if (x === y) return true;
    if (x.length >= 4 && y.startsWith(x)) return true;
    if (y.length >= 4 && x.startsWith(y)) return true;
  }
  return false;
}

const DERIV_PX = 40;
const MARKET_PX = 44;
const VAULT_PX = 36;
const NEW_PROTO_PX = 56;
const RING_STEP = 200;   // 프로토콜 → 파생 반경 간격
const ROW_STEP = 120;    // 같은 프로토콜 파생이 많으면 줄 바꿈(반경)
const MKT_STEP = 190;    // 파생 → 수용처 마켓 반경 간격
const VAULT_STEP = 124;  // 수용처 마켓 → 큐레이터 볼트 반경 간격 (한 홉 더)
const CAP_PER_PROTO = 24; // 출처 프로토콜당 파생 상한(사실상 전부 — 사용자: "6개보다 많아도 돼")

export function overlayLego(
  topology: TopologyResponse,
  lego: { nodes: LegoApiNode[]; edges: LegoApiEdge[] },
  hiddenChains: Set<string>,
): TopologyResponse {
  if (!lego.nodes.length) return topology;
  let nodes = [...topology.nodes];
  const edges = [...topology.edges];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  // 토큰은 프로토콜과만 직접 연결한다(사용자 2026-06-13: "토큰과의 연결은 프로토콜끼리만").
  //   마켓/파생/큐레이터는 토큰 직결이 아니라 프로토콜 경유. concentric 이 이미 만든 토큰→프로토콜 엣지의
  //   대상 pid 를 모아두고, 베이스 수용처가 "동심원에 없던 프로토콜"(lego-acc 등)을 끌어올 때만 토큰→프로토콜
  //   엣지를 1회 보강한다(이미 링크된 프로토콜엔 중복 추가 안 함).
  const tokenLinkedProtos = new Set<string>();
  for (const e of topology.edges) {
    if (/^c:[^:]+:token$/.test(e.source)) tokenLinkedProtos.add(e.target);
  }
  const ensureTokenProtoEdge = (chain: string, pid: string) => {
    if (tokenLinkedProtos.has(pid)) return;
    tokenLinkedProtos.add(pid);
    edges.push({ id: `lego-tp:c:${chain}:token→${pid}`, source: `c:${chain}:token`, target: pid, type: "collateral_at",
      weight: 0.3, attrs: { meta: { dataSource: "lego" } } as unknown as GraphEdge["attrs"] } as GraphEdge);
  };

  const centerOf = (n: GraphNode): { x: number; y: number } | null => {
    if (!n.position) return null;
    const d = (n.metadata.diameterPx as number | undefined) ?? 0;
    return { x: n.position.x + d / 2, y: n.position.y + d / 2 };
  };

  // 체인별 토큰 중심 + 링1 프로토콜 인덱스
  const tokenCenter = new Map<string, { x: number; y: number }>();
  interface ProtoSlot { pid: string; c: { x: number; y: number }; ang: number; r: number }
  const protoByChain = new Map<string, Map<string, ProtoSlot>>();
  const protoCountByChain = new Map<string, number>();
  for (const n of nodes) {
    const m = /^c:([^:]+):(.+)$/.exec(n.id);
    if (!m) continue;
    const [, chain, rest] = m;
    if (rest === "token") { const c = centerOf(n); if (c) tokenCenter.set(chain, c); }
    else if (rest.startsWith("protocol:") && !/:m\d+/.test(rest)) {
      protoCountByChain.set(chain, (protoCountByChain.get(chain) ?? 0) + 1);
    }
  }
  for (const n of nodes) {
    const m = /^c:([^:]+):(protocol:.+)$/.exec(n.id);
    if (!m || /:m\d+/.test(m[2])) continue;
    const [, chain] = m;
    const tc = tokenCenter.get(chain); const c = centerOf(n);
    if (!tc || !c) continue;
    const ang = Math.atan2(c.y - tc.y, c.x - tc.x);
    const r = Math.hypot(c.x - tc.x, c.y - tc.y);
    if (!protoByChain.has(chain)) protoByChain.set(chain, new Map());
    protoByChain.get(chain)!.set(canonOfConId(n.id), { pid: n.id, c, ang, r });
  }

  const derivs = lego.nodes.filter((n) => n.kind === "derivative" && !hiddenChains.has(n.chain) && tokenCenter.has(n.chain));
  if (!derivs.length) return topology;
  const derivById = new Map(derivs.map((d) => [d.id, d] as const));
  // 발행/구성(issues·lp_of) 엣지의 evidence+금액 — 렌더 엣지에 실어 검증·사이징을 보존한다.
  //   evidence 가 있으면 "검증된 관계"(금액 null → (b), 금액>0 → 관측색, 측정0 → (a)). dst(파생) 기준 매핑.
  const legoEdgeByDeriv = new Map<string, { evidence?: Record<string, unknown>; weightUsd: number | null }>();
  for (const e of lego.edges) {
    if ((e.relation === "issues" || e.relation === "lp_of") && e.evidence && (e.evidence as { source?: string }).source) legoEdgeByDeriv.set(e.dst, { evidence: e.evidence, weightUsd: e.weight_usd });
  }
  const viewedSym = (derivs[0]?.parent_token ?? "").replace(/^token:/, "").split("@")[0].toLowerCase();

  // B8 레벨2 재귀: 토큰이 아니라 "다른 파생/마켓이 낳은" 파생(Convex 영수증·LP→PT)을 식별 → producer 발(發) id.
  //   출처 프로토콜 그룹에서 빼고(안 그러면 Convex 를 출처로 오해해 기존 풀 숨김) producer 바깥에 따로 배치.
  const producerOf = new Map<string, string>(); // level2 derivId → producer(원본 src) node/market id
  for (const e of lego.edges) {
    if (e.relation !== "issues" && e.relation !== "lp_of") continue;
    if (e.src.startsWith("token:") || e.src.startsWith("c:")) continue; // 토큰발 = 레벨1
    if (derivById.has(e.dst)) producerOf.set(e.dst, e.src);
  }

  // 파생은 "다른 풀/마켓에 연결될 때만" 표시 (사용자 2026-06-12) — 발행(프로토콜→파생)만 있고
  // 수용처(collateral_at/staked_in)도 없고 연결된 다른 파생을 낳지도(issues/lp_of) 않으면 고아 → 숨김.
  const acceptMktIds = new Set(lego.nodes.filter((n) => n.kind === "market" && !hiddenChains.has(n.chain)).map((n) => n.id));
  const connected = new Set<string>();
  for (const e of lego.edges) {
    if ((e.relation === "collateral_at" || e.relation === "staked_in") && derivById.has(e.src) && acceptMktIds.has(e.dst)) connected.add(e.src);
  }
  // (2026-06-17 사용자) 종착·고아 파생 숨김 — "프로토콜에서 나왔지만 어디에도 안 들어가는" 파생은 보여주지 않는다.
  //   이전엔 종착(YT·영수증)을 meta.terminal 로 보존했으나, 이제 수용처(collateral_at/staked_in)나 연결된
  //   하위 파생 생산이 없으면 숨긴다. connected 에 안 들어가면 아래 step1(bySource)에서 제외 → 파생토큰 켜짐·
  //   파생자산 포함만 양쪽 모두에서 사라진다. (단, 연결된 파생을 낳는 상위 파생은 아래 루프가 보존)
  // 연결된 파생을 낳는 상위 파생도 보존: LP→cvxLP→Morpho 에서 LP, LP→PT→Morpho 에서 LP 도 표시.
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of lego.edges) {
      if (e.relation !== "issues" && e.relation !== "lp_of") continue;
      if (derivById.has(e.src) && derivById.has(e.dst) && connected.has(e.dst) && !connected.has(e.src)) { connected.add(e.src); grew = true; }
    }
  }

  const matchProto = (chain: string, slug: string | null): ProtoSlot | null => {
    const idx = protoByChain.get(chain); if (!idx) return null;
    for (const cand of canonCandidates(slug)) { const hit = idx.get(cand); if (hit) return hit; }
    return null;
  };
  const synthProtoCount = new Map<string, number>();
  const ensureSourceProto = (chain: string, slug: string): ProtoSlot => {
    const existing = matchProto(chain, slug);
    if (existing) return existing;
    const tc = tokenCenter.get(chain)!;
    const made = synthProtoCount.get(chain) ?? 0;
    synthProtoCount.set(chain, made + 1);
    const ang = Math.PI / 2 + (made - 1) * 0.5;
    const r = 360;
    const c = { x: tc.x + Math.cos(ang) * r, y: tc.y + Math.sin(ang) * r };
    const pid = `lego-src:${chain}:${slug}`;
    const gn = {
      id: pid, type: "DefiProtocol", label: PRETTY_PROTO[slug] ?? slug, active: true,
      position: { x: c.x - NEW_PROTO_PX / 2, y: c.y - NEW_PROTO_PX / 2 },
      metadata: { chain, brandSlug: slug, dataSource: "lego", venue: slug, diameterPx: NEW_PROTO_PX },
    } as GraphNode;
    nodes.push(gn); byId.set(pid, gn);
    const slot: ProtoSlot = { pid, c, ang, r };
    protoByChain.get(chain)!.set(slug.replace(/_/g, "-"), slot);
    edges.push({ id: `lego-srcedge:${pid}`, source: `c:${chain}:token`, target: pid, type: "issues", weight: 0.2,
      attrs: { meta: { dataSource: "lego" } } as unknown as GraphEdge["attrs"] } as GraphEdge);
    tokenLinkedProtos.add(pid); // 출처 프로토콜도 이미 토큰 링크 보유 → 베이스 블록이 중복 안 만들게
    return slot;
  };

  // 1) 파생을 출처 프로토콜별로 그룹 (레벨2 파생은 제외 — 아래 step 6 에서 producer 바깥에 배치)
  const bySource = new Map<string, { chain: string; slug: string; list: LegoApiNode[] }>();
  for (const d of derivs) {
    if (producerOf.has(d.id)) continue; // 레벨2 — producer 가 따로 배치
    if (!connected.has(d.id)) continue; // 다른 풀/마켓 연결 없는 고아 파생은 숨김
    const slug = d.protocol ?? "unknown";
    const key = `${d.chain}|${slug}`;
    if (!bySource.has(key)) bySource.set(key, { chain: d.chain, slug, list: [] });
    bySource.get(key)!.list.push(d);
  }

  // 2) 출처 프로토콜의 breadth 마켓 노드 숨김(레고 파생으로 대체)
  const suppressPids = new Set<string>();
  for (const { chain, slug } of bySource.values()) {
    const slot = matchProto(chain, slug);
    if (slot && !slot.pid.startsWith("lego-src:")) suppressPids.add(slot.pid);
  }
  if (suppressPids.size) {
    const drop = (id: string) => [...suppressPids].some((pid) => id.startsWith(`${pid}:m`));
    nodes = nodes.filter((n) => !drop(n.id));
  }
  const liveIds = new Set(nodes.map((n) => n.id));

  // 3) 파생 배치 (출처 프로토콜 wedge 바깥, 많으면 줄 바꿈) + 발행 엣지
  const derivCenter = new Map<string, { x: number; y: number }>();
  const placeDeriv = (d: LegoApiNode, c: { x: number; y: number }) => {
    const m = (d.meta ?? {}) as Record<string, unknown>;
    const gn = {
      id: d.id, type: "DerivativeToken", label: d.label, active: true,
      position: { x: c.x - DERIV_PX / 2, y: c.y - DERIV_PX / 2 },
      metadata: { chain: d.chain, derivRole: d.role, parentTokenId: d.parent_token, address: d.address,
        symbol: d.symbol, venue: d.protocol, dataSource: "lego", legoEvidence: d.meta, diameterPx: DERIV_PX,
        // 종착 표식 전파(snapshot-lego ⑦) — 노드가 "끝"인지 hover/배지로 읽히게.
        terminal: m.terminal === true, terminalKind: m.terminalKind, terminalReason: m.terminalReason, rewardSource: m.rewardSource },
    } as GraphNode;
    nodes.push(gn); byId.set(d.id, gn); liveIds.add(d.id); derivCenter.set(d.id, c);
  };
  for (const { chain, slug, list } of bySource.values()) {
    const slot = ensureSourceProto(chain, slug);
    const tc = tokenCenter.get(chain)!;
    const ordered = [...list].sort((a, b) => roleRank(a.role) - roleRank(b.role)).slice(0, CAP_PER_PROTO);
    const N = Math.max(1, protoCountByChain.get(chain) ?? 1);
    const halfWedge = Math.min(0.4, (Math.PI * 1.9) / N * 0.46);
    const perRow = Math.max(1, Math.min(4, ordered.length));
    ordered.forEach((d, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, ordered.length - row * perRow);
      const col = i % perRow;
      const isToken = roleRank(d.role) >= 2; // pt/yt/receipt = 토큰류(더 바깥, 링3)
      const r = slot.r + RING_STEP + row * ROW_STEP + (isToken ? RING_STEP * 0.5 : 0);
      const off = inRow <= 1 ? 0 : (col / (inRow - 1) - 0.5) * 2 * halfWedge;
      const ang = slot.ang + off;
      placeDeriv(d, { x: tc.x + Math.cos(ang) * r, y: tc.y + Math.sin(ang) * r });
      const rel = d.role === "lp" ? "lp_of" : "issues";
      const le = legoEdgeByDeriv.get(d.id);
      const usd = typeof le?.weightUsd === "number" ? le.weightUsd : undefined; // 0=측정된 0, undefined=미측정
      edges.push({ id: `lego:${slot.pid}→${d.id}`, source: slot.pid, target: d.id, type: rel, weight: usd ?? 0.3,
        attrs: { core: { amountUsd: usd ?? null }, meta: { dataSource: "lego" }, legoEvidence: le?.evidence } as unknown as GraphEdge["attrs"] } as GraphEdge);
    });
  }

  // 4) 수용처 — 파생을 받아주는 마켓에 연결. 우선순위(사용자 지시 2026-06-12):
  //    (a) "이미 있는 동심원 마켓 노드"에 매칭되면 그 노드에 연결(새 노드 X) — Curve LP → 기존 Convex 풀 노드.
  //    (b) 없으면 그 수용처 프로토콜의 기존 클러스터(wedge ring2) 안에 마켓을 만들어 붙임 + 프로토콜→마켓 구조 엣지
  //        — PT-collateral Morpho 마켓처럼 동심원이 원래 안 보여주던 마켓은 Morpho 클러스터 안에 들어감.
  //    (c) 수용처 프로토콜이 그래프에 없을 때만 파생 바깥에 새로(폴백). 파생 옆에 브랜드 노드를 띄우지 않는다.
  const marketLego = new Map(lego.nodes.filter((n) => n.kind === "market").map((n) => [n.id, n] as const));
  // 기존 동심원 마켓 노드 인덱스 (프로토콜 pid → [{id, 의미토큰}]) — 마켓 id = `{pid}:m{j}`(볼트 `:v` 제외)
  const existingMktByPid = new Map<string, { id: string; tokens: Set<string> }[]>();
  for (const n of nodes) {
    if (!/:m\d+$/.test(n.id)) continue;
    const pid = n.id.replace(/:m\d+$/, "");
    (existingMktByPid.get(pid) ?? existingMktByPid.set(pid, []).get(pid)!).push({ id: n.id, tokens: sigTokens(n.label, viewedSym) });
  }
  const addMarketNode = (mkt: LegoApiNode, c: { x: number; y: number }) => {
    if (byId.has(mkt.id)) return;
    const meta = mkt.meta ?? {};
    const term = meta as { terminal?: boolean; terminalKind?: string; terminalReason?: string; rewardSource?: string };
    // sizeUsd 무결성: 무료 소스로 금액을 못 구한 마켓(Euler·Convex 등)은 0 으로 뭉개지 말고 null 로 명시한다.
    //   0 으로 두면 "진짜 작은 마켓"과 "금액 미상"이 구분 안 돼 크기·PageRank·집중허브 인코딩이 왜곡됨.
    //   null → RiskNode/HoverTooltip 이 "금액 미상" 배지로 표기, node-size 는 최소 크기(추측 아님)로 처리.
    const rawSize = meta.sizeUsd;
    const sizeUsd = typeof rawSize === "number" && rawSize > 0 ? rawSize : null;
    const gn = {
      id: mkt.id, type: "DefiProtocol", label: mkt.label, active: true,
      position: { x: c.x - MARKET_PX / 2, y: c.y - MARKET_PX / 2 },
      metadata: { chain: mkt.chain, category: (meta.category as string) ?? "", sizeUsd, sizeUnknown: sizeUsd == null,
        venue: mkt.protocol, brandSlug: (meta.brandSlug as string | undefined), dataSource: "lego", diameterPx: MARKET_PX,
        // 종착 표식 전파(snapshot-lego ⑦) — 렌딩 마켓 담보 종착을 hover/배지로 "끝"이라 읽히게.
        terminal: term.terminal === true, terminalKind: term.terminalKind, terminalReason: term.terminalReason, rewardSource: term.rewardSource,
        _market: { ...meta, label: mkt.label, chain: mkt.chain, protocol: PRETTY_PROTO[mkt.protocol ?? ""] ?? mkt.protocol } },
    } as GraphNode;
    nodes.push(gn); byId.set(mkt.id, gn); liveIds.add(mkt.id);
    // 큐레이터 볼트(연쇄청산 책임자) 한 홉 더 — 마켓 바깥(토큰→마켓 방향)에 부채꼴 (멘토 §3·§6)
    //   snapshot-lego ⑥' 가 vault_allocations 조인으로 meta.curatorAllocs([{curator,vault,supplyUsd}]) 를 채움.
    //   per-curator supply_usd 를 curator_funding 엣지 weight 로 실어 종착에서 "X 큐레이터 볼트가 이 마켓에 $N" 가 읽히게.
    //   조인 실패(구 스냅샷)는 meta.curators(이름만)로 폴백 — supply 미상이면 엣지 weight=구조상수.
    const allocs = (meta.curatorAllocs as { curator: string; vault: string; supplyUsd: number | null }[] | undefined);
    const vaultList = (allocs && allocs.length)
      ? allocs.slice(0, 4)
      : ((meta.curators as string[] | undefined) ?? []).slice(0, 4).map((c) => ({ curator: c, vault: c, supplyUsd: null as number | null }));
    if (vaultList.length) {
      const tc = tokenCenter.get(mkt.chain)!;
      const dir = Math.atan2(c.y - tc.y, c.x - tc.x);
      const baseR = Math.hypot(c.x - tc.x, c.y - tc.y);
      // 볼트 보상 재원 = 이 담보 마켓의 대출 이자(snapshot-lego ⑦ rewardSource). 볼트를 클릭하면 재원이 읽히게.
      const rewardSrc = term.rewardSource ?? `${mkt.label} 마켓의 대출 이자가 이 볼트 보상의 재원.`;
      vaultList.forEach((v, i) => {
        const vid = `${mkt.id}:v${i}`;
        const fan = vaultList.length <= 1 ? 0 : (i / (vaultList.length - 1) - 0.5) * 0.34;
        const vc = { x: tc.x + Math.cos(dir + fan) * (baseR + VAULT_STEP), y: tc.y + Math.sin(dir + fan) * (baseR + VAULT_STEP) };
        const supplyUsd = typeof v.supplyUsd === "number" && v.supplyUsd > 0 ? v.supplyUsd : null;
        const vn = {
          id: vid, type: "DefiProtocol", label: v.vault, active: true,
          position: { x: vc.x - VAULT_PX / 2, y: vc.y - VAULT_PX / 2 },
          metadata: { chain: mkt.chain, category: "Vault · 큐레이터", dataSource: "lego", diameterPx: VAULT_PX,
            sizeUsd: supplyUsd ?? 0,
            _vault: { curator: v.curator, vault: v.vault, market: mkt.label, rewardSource: rewardSrc, supplyUsd } },
        } as GraphNode;
        nodes.push(vn); byId.set(vid, vn); liveIds.add(vid);
        // 엣지 타입 = curator_funding(보상 재원): "이 담보 마켓의 대출 이자가 이 큐레이터 볼트 보상의 재원"임을
        //   엣지 자체로 표기(감사관 [고정2]). 볼트의 유일한 부모 엣지가 곧 보상 출처 마켓 → 트리 토폴로지만으로
        //   "보상이 어느 마켓에서 나오는가"가 읽힌다(볼트의 한 홉 위 = 재원 마켓). deposit_supply 와 구분.
        //   weight = 그 큐레이터 볼트가 이 마켓에 공급한 USD(있으면) → 엣지 굵기/툴팁으로 쏠림이 읽힌다.
        edges.push({ id: `lego-vault:${mkt.id}→${vid}`, source: mkt.id, target: vid, type: "curator_funding",
          weight: supplyUsd ?? 0.2,
          attrs: { core: { amountUsd: supplyUsd }, meta: { dataSource: "lego" } } as unknown as GraphEdge["attrs"] } as GraphEdge);
      });
    }
  };
  // 수용처 프로토콜 1급화 — 동심원에 없는 무명 수용처(Euler·Yield Basis 등)를 "마켓"이 아니라 "프로토콜" 노드로.
  //   여러 파생(유명 프로토콜의 LP/PT)이 파생→이 프로토콜로 직결되면 in-degree↑ → PageRank↑ → 맵에서 크게.
  //   (사용자 2026-06-13: "yield basis 같은 애들이 유명 프로토콜 lp 받아주면 중요한 프로토콜이 되도록 보여줘".)
  const acceptorSlots = new Map<string, ProtoSlot>();
  let accMade = 0;
  const ensureAcceptorProto = (chain: string, slug: string, nearDerivId: string | null, mktLabel: string): ProtoSlot => {
    const key = `${chain}|${slug}`;
    const cached = acceptorSlots.get(key);
    if (cached) {
      const gn = byId.get(cached.pid);
      const arr = (gn?.metadata as Record<string, unknown> | undefined)?.acceptedMarkets as string[] | undefined;
      if (arr && mktLabel && !arr.includes(mktLabel)) arr.push(mktLabel);
      return cached;
    }
    const tc = tokenCenter.get(chain)!;
    const dc = (nearDerivId ? derivCenter.get(nearDerivId) : undefined) ?? tc;
    const dir = Math.atan2(dc.y - tc.y, dc.x - tc.x);
    const rr = Math.hypot(dc.x - tc.x, dc.y - tc.y) + MKT_STEP + 40;
    const ang = dir + (((accMade++ % 3) - 1) * 0.22);
    const c = { x: tc.x + Math.cos(ang) * rr, y: tc.y + Math.sin(ang) * rr };
    const pid = `lego-acc:${chain}:${slug}`;
    const gn = {
      id: pid, type: "DefiProtocol", label: PRETTY_PROTO[slug] ?? slug, active: true,
      position: { x: c.x - NEW_PROTO_PX / 2, y: c.y - NEW_PROTO_PX / 2 },
      metadata: { chain, brandSlug: slug, dataSource: "lego", venue: slug, diameterPx: NEW_PROTO_PX,
        // 카테고리 — 상류 배킹(EigenLayer·Ethena)·일드볼트(Veda)는 "담보 받음"이 아니라 정확한 성격으로 표기.
        category: (slug === "eigenlayer" || slug === "ethena") ? "상류 배킹 · 공유 기반"
          : slug === "veda" ? "일드 볼트 · 배킹 재예치"
          : "수용처 · 담보 받음",
        acceptedMarkets: mktLabel ? [mktLabel] : [] },
    } as GraphNode;
    nodes.push(gn); byId.set(pid, gn); liveIds.add(pid);
    const slot: ProtoSlot = { pid, c, ang, r: rr };
    acceptorSlots.set(key, slot);
    return slot;
  };
  const STRUCT_EDGE: Record<string, string> = { lending: "collateral_isolated", pool: "deposit_supply" };
  // 엣지 attrs.oracle — snapshot-lego ⑥'' 가 마켓 노드 meta 에 채운 per-market 오라클(종류/제공자/설명)을
  //   그 마켓으로 가는 collateral_at 엣지에 실어 HoverTooltip 의 "Oracle" 행(provider/description)이 뜨게 한다.
  //   엣지 위 오라클 원은 GraphCanvas 가 omkt.oracle 폴백으로 이미 그렸고, 여기로 attrs.oracle 까지 채우면 원+툴팁 일치.
  const oracleAttr = (mkt: LegoApiNode): { type: string; provider: string | null; description: string | null; verified: boolean } | undefined => {
    const m = mkt.meta as Record<string, unknown> | undefined;
    const t = m?.oracle as string | undefined;
    if (!t) return undefined;
    return { type: t, provider: (m?.oracleProvider as string | null) ?? null, description: (m?.oracleDescription as string | null) ?? null, verified: m?.oracleVerified === true };
  };
  const mktTarget = new Map<string, string>(); // legoMktId → 실제 연결 대상 노드 id
  const clusterCount = new Map<string, number>();
  const baseClusterCount = new Map<string, number>(); // 베이스 수용처 마켓을 프로토콜 슬롯 둘레에 부채꼴 배치할 인덱스
  for (const e of lego.edges) {
    if (e.relation !== "collateral_at" && e.relation !== "staked_in") continue;
    const mkt = marketLego.get(e.dst);
    if (!mkt || hiddenChains.has(mkt.chain)) continue;
    // A5++(2026-06-13 회장 blocker 재수정): 베이스 토큰 수용처 — src 가 동심원 토큰(token:sym, 파생 아님).
    //   그 토큰을 담보로 받는 수용처를 항상 "고유 마켓 노드"로 만든다(addMarketNode, id=mkt.id).
    //   ★왜 동심원 마켓에 매칭(hit)하던 옛 로직을 버리나★ — 동심원 morpho 마켓은 담보=USDe(부모) 등 "다른 마켓"인데
    //     loan 심볼 겹침(tokOverlap)으로 base(담보=sUSDe) 마켓을 그 위에 잘못 얹었다. 게다가 접두 겹침이
    //     "usdtb".startsWith("usdt") 를 참으로 만들어 $92.9M USDtb base 마켓이 $215K USDe/USDT 동심원 노드(m3)에
    //     통째로 빨려들어가 "USDe/USDT"로 오기·은폐됐다(자금추적 끊김). lego base 마켓은 검증된 주소·loan·USD 를
    //     가진 별개 마켓이므로 동심원 노드에 절대 합치지 않고 자기 노드로 렌더한다(thesis: 정확한 매핑).
    //   각 마켓은 부모 프로토콜 슬롯(동심원 슬롯/무명 수용처 lego-acc) 둘레에 부채꼴 배치 + 프로토콜→마켓 구조엣지.
    //   토큰→마켓 직결 엣지 id 에 mkt.id 포함 → 마켓별 weight_usd 가 dedup 에서 전부 보존(자금추적 정본).
    if (e.src.startsWith("token:")) {
      const tokId = `c:${mkt.chain}:token`;
      if (!byId.has(tokId)) continue;
      // 토큰은 프로토콜과만 직접 연결한다(사용자 2026-06-13). 베이스 토큰이 담보로 쓰이는 마켓도 토큰→마켓 직결이
      //   아니라 토큰→(수용처)프로토콜→마켓으로 잇는다:
      //     ① ensureTokenProtoEdge — 수용처 프로토콜에 토큰 링크 보장(동심원에 이미 있으면 no-op).
      //     ② lego-bmkt(프로토콜→마켓) 엣지에 마켓별 담보 USD(weight_usd)를 실어 자금추적 정본 보존
      //        — 엣지 id 에 mkt.id 포함 → 같은 토큰의 여러 마켓 금액이 dedup 에서 전부 보존(예: USDtb $92.9M).
      if (!mktTarget.has(mkt.id)) {
        const slot = matchProto(mkt.chain, mkt.protocol) ?? ensureAcceptorProto(mkt.chain, mkt.protocol ?? "unknown", null, mkt.label);
        const k = baseClusterCount.get(slot.pid) ?? 0; baseClusterCount.set(slot.pid, k + 1);
        const tc = tokenCenter.get(mkt.chain)!;
        // 동심원 유지(사용자 2026-06-13): 마켓을 프로토콜 wedge 안에서 4개씩 줄(동심 arc)로 배치 — 각도가
        //   한 바퀴 돌며 나선(암모나이트)이 되지 않게 wedge 안으로 가둔다. 줄이 늘면 반경만 바깥으로(동심원 링).
        const Nproto = Math.max(1, protoCountByChain.get(mkt.chain) ?? 1);
        const wedge = Math.min(0.6, (2 * Math.PI / Nproto) * 0.66);
        const row = Math.floor(k / 4), col = k % 4;
        const ang = slot.ang + (col / 3 - 0.5) * wedge;
        const rr = slot.r + 176 + row * 120;
        addMarketNode(mkt, { x: tc.x + Math.cos(ang) * rr, y: tc.y + Math.sin(ang) * rr });
        ensureTokenProtoEdge(mkt.chain, slot.pid);                       // ① 토큰→프로토콜(없으면 보강)
        const usd = e.weight_usd ?? undefined;                            // ② 프로토콜→마켓(담보 USD 정본)
        edges.push({ id: `lego-bmkt:${slot.pid}→${mkt.id}`, source: slot.pid, target: mkt.id, type: e.relation,
          weight: usd ?? (mkt.meta?.sizeUsd as number) ?? 0.3,
          attrs: { core: { amountUsd: usd ?? null }, meta: { dataSource: "lego" }, legoEvidence: e.evidence, oracle: oracleAttr(mkt) } as unknown as GraphEdge["attrs"] } as GraphEdge);
        mktTarget.set(mkt.id, mkt.id);
      }
      continue;
    }
    if (!liveIds.has(e.src)) continue;            // src = 배치된 파생
    const d = derivById.get(e.src);
    if (!d) continue;
    let targetId = mktTarget.get(mkt.id) ?? null;
    if (!targetId) {
      const protoSlot = matchProto(mkt.chain, mkt.protocol);
      if (protoSlot) {
        const dTok = sigTokens(d.symbol ?? d.label, viewedSym);
        const hit = (existingMktByPid.get(protoSlot.pid) ?? []).find((c) => tokOverlap(dTok, c.tokens));
        if (hit) {
          targetId = hit.id;                                   // (a) 기존 동심원 마켓에 연결
        } else {
          const k = clusterCount.get(protoSlot.pid) ?? 0; clusterCount.set(protoSlot.pid, k + 1);
          const tc = tokenCenter.get(mkt.chain)!;
          // 동심원 유지 — 수용처 마켓도 프로토콜 wedge 안에서 4개씩 줄로(나선 방지, 줄=동심 arc).
          const Nproto = Math.max(1, protoCountByChain.get(mkt.chain) ?? 1);
          const wedge = Math.min(0.6, (2 * Math.PI / Nproto) * 0.66);
          const row = Math.floor(k / 4), col = k % 4;
          const ang = protoSlot.ang + (col / 3 - 0.5) * wedge;
          const rr = protoSlot.r + 176 + row * 120;
          addMarketNode(mkt, { x: tc.x + Math.cos(ang) * rr, y: tc.y + Math.sin(ang) * rr }); // (b) 프로토콜 클러스터 안
          edges.push({ id: `lego-mkt:${protoSlot.pid}→${mkt.id}`, source: protoSlot.pid, target: mkt.id,
            type: STRUCT_EDGE[(mkt.meta?.kind as string) ?? "pool"] ?? "deposit_supply", weight: (mkt.meta?.sizeUsd as number) ?? 0.3,
            attrs: { meta: { dataSource: "lego" }, oracle: oracleAttr(mkt) } as unknown as GraphEdge["attrs"] } as GraphEdge);
          targetId = mkt.id;
        }
      } else {
        // (c) 수용처 프로토콜이 동심원에 없음(Euler·Yield Basis 등 무명 수용처) → "프로토콜"로 1급화하고
        //     파생→프로토콜 직결(아래 collateral_at 엣지). 같은 프로토콜의 여러 마켓은 한 노드로 집약 →
        //     유명 프로토콜의 파생을 많이 받을수록 그 수용처가 크게 보인다(사용자 지시). 마켓 라벨은 노드 meta 에 누적.
        targetId = ensureAcceptorProto(mkt.chain, mkt.protocol ?? "unknown", e.src, mkt.label).pid;
      }
      mktTarget.set(mkt.id, targetId);
    }
    if (!targetId || targetId === e.src) continue;
    const usd = e.weight_usd ?? undefined;
    edges.push({ id: `lego:${e.src}→${targetId}:${e.relation}`, source: e.src, target: targetId, type: e.relation,
      weight: usd ?? 0.3, attrs: { core: { amountUsd: usd ?? null }, meta: { dataSource: "lego" }, legoEvidence: e.evidence, oracle: oracleAttr(mkt) } as unknown as GraphEdge["attrs"] } as GraphEdge);
  }

  // ── 언더라잉/배킹 체인(backed_by) — "토큰이 무엇으로 구성되는가"를 언더라잉 토큰→기반→venue 단일 노드 체인으로.
  //   weETH→eETH→ETH→EigenLayer. 토큰에서 위쪽 한 줄로(수용처 부채꼴과 분리), 각 단계 단일 노드(프로토콜 껍데기 없음 → 중복 방지).
  //   기반(ETH)·venue(EigenLayer) id 가 체인 공유라 형제 토큰이 같은 노드로 모인다(상류 공동위험). cyan backed_by 엣지.
  {
    const renderId = (legoId: string, chain: string) => (legoId.startsWith("token:") ? `c:${chain}:token` : legoId);
    for (const [chain, tc] of tokenCenter) {
      if (hiddenChains.has(chain)) continue;
      const ce = lego.edges.filter((e) => e.relation === "backed_by" && e.chain === chain);
      if (!ce.length) continue;
      const nextOf = new Map(ce.map((e) => [e.src, e] as const));
      let curId: string | undefined = ce.find((e) => e.src.startsWith("token:"))?.src;
      const ang = -Math.PI / 2 - 0.22; // 토큰 위쪽(약간 좌상)
      for (let depth = 1; curId && nextOf.has(curId) && depth < 8; depth++) {
        const e = nextOf.get(curId)!;
        const dst = marketLego.get(e.dst);
        const srcR = renderId(e.src, chain);
        if (!dst || !byId.has(srcR)) break;
        const dstR = renderId(e.dst, chain);
        if (!byId.has(dstR)) addMarketNode(dst, { x: tc.x + Math.cos(ang) * (150 * depth + 80), y: tc.y + Math.sin(ang) * (150 * depth + 80) });
        edges.push({ id: `lego-back:${e.src}→${e.dst}`, source: srcR, target: dstR, type: "backed_by",
          weight: 0.3, attrs: { meta: { dataSource: "lego" }, legoEvidence: e.evidence } as unknown as GraphEdge["attrs"] } as GraphEdge);
        curId = e.dst;
      }
    }
  }

  // 6) B8 레벨2 재귀 — producer(레벨1 파생 또는 수용처 마켓) 바깥에 배치 + producer→파생 엣지.
  //    producer 마켓은 step4 에서 기존 동심원 노드에 매칭됐을 수 있어 mktTarget 으로 실제 id 해석. 멀티패스(체인).
  let pending = [...producerOf.entries()].filter(([d2id]) => connected.has(d2id));
  for (let pass = 0; pending.length && pass < 3; pass++) {
    const next: [string, string][] = [];
    for (const [d2id, prodSrc] of pending) {
      const d2 = derivById.get(d2id);
      if (!d2 || byId.has(d2id)) continue;
      const prodId = byId.has(prodSrc) ? prodSrc : (mktTarget.get(prodSrc) ?? null);
      if (!prodId || !byId.has(prodId)) { next.push([d2id, prodSrc]); continue; } // producer 미배치 → 다음 패스
      const pc = centerOf(byId.get(prodId)!);
      if (!pc) continue;
      const tc = tokenCenter.get(d2.chain)!;
      const dir = Math.atan2(pc.y - tc.y, pc.x - tc.x);
      const r = Math.hypot(pc.x - tc.x, pc.y - tc.y) + 150;
      placeDeriv(d2, { x: tc.x + Math.cos(dir) * r, y: tc.y + Math.sin(dir) * r });
      const le2 = legoEdgeByDeriv.get(d2id);
      const usd2 = typeof le2?.weightUsd === "number" ? le2.weightUsd : undefined;
      edges.push({ id: `lego-l2:${prodId}→${d2id}`, source: prodId, target: d2id, type: d2.role === "lp" ? "lp_of" : "issues",
        weight: usd2 ?? 0.3, attrs: { core: { amountUsd: usd2 ?? null }, meta: { dataSource: "lego" }, legoEvidence: le2?.evidence } as unknown as GraphEdge["attrs"] } as GraphEdge);
    }
    if (next.length === pending.length) break; // 진전 없음
    pending = next;
  }

  // ── 토큰→수용처허브 트렁크 연결선이 자식 마켓들의 합(담보볼트 중복 제거)을 물려받게 한다.
  //   오버레이가 만든 token→proto 연결선은 자체 금액이 없어 "구조상 가능(회색)"으로 보이는데, 그 아래
  //   proto→market 엣지엔 실측 금액이 있다(예: Euler 마켓 = $5.26M). 자식이 관측이면 트렁크도 관측으로 승격.
  //   ★공유풀 중복 금지★: Euler v2 처럼 여러 마켓이 한 담보볼트를 공유하면 같은 collateralVault 는 1회만 합산
  //   (안 그러면 2배 부풀려짐 — 검증: naive 합 $10.5M vs 볼트 dedup $5.27M).
  {
    const TOK_RE = /^c:[^:]+:token$/;
    const hubSum = new Map<string, number>();          // protoPid → Σ 자식 amountUsd (담보볼트 dedup)
    const hubVaults = new Map<string, Set<string>>();
    for (const e of edges) {
      if (TOK_RE.test(e.source)) continue;             // 토큰발 엣지는 자식(proto→market) 아님
      const a = e.attrs as { core?: { amountUsd?: number | null }; legoEvidence?: { collateralVault?: string } } | undefined;
      const amt = a?.core?.amountUsd;
      if (typeof amt !== "number" || amt <= 0) continue;
      const vault = a?.legoEvidence?.collateralVault;
      if (vault) {
        const seen = hubVaults.get(e.source) ?? new Set<string>();
        if (seen.has(vault)) continue;                 // 같은 담보볼트 = 공유풀 → 1회만
        seen.add(vault); hubVaults.set(e.source, seen);
      }
      hubSum.set(e.source, (hubSum.get(e.source) ?? 0) + amt);
    }
    for (const e of edges) {
      if (!TOK_RE.test(e.source)) continue;            // 토큰→프로토콜 연결선만
      const a = e.attrs as { core?: { amountUsd?: number | null } } | undefined;
      if (typeof a?.core?.amountUsd === "number" && a.core.amountUsd > 0) continue; // 이미 금액 있으면 둠
      const sum = hubSum.get(e.target);
      if (sum && sum > 0) e.attrs = { ...(e.attrs ?? {}), core: { ...(a?.core ?? {}), amountUsd: sum } } as unknown as GraphEdge["attrs"];
    }
  }

  const finalIds = new Set(nodes.map((n) => n.id));
  // id 중복 제거 — 한 파생의 두 수용처 엣지가 같은 기존 마켓 노드로 매칭되면 동일 id 가 생겨
  // React key 충돌(엣지 누락/중복). 같은 src→target:relation 은 같은 의존이므로 하나만 유지.
  const seenEdge = new Set<string>();
  const cleanEdges = edges.filter((e) => {
    if (!finalIds.has(e.source) || !finalIds.has(e.target)) return false;
    if (seenEdge.has(e.id)) return false;
    seenEdge.add(e.id);
    return true;
  });
  return { ...topology, nodes, edges: cleanEdges };
}

// 배치 순서/링: lp(풀,링2)=1 → pt/yt/receipt(토큰,링3)=2 → 기타=3
function roleRank(role: string | null): number {
  if (role === "lp") return 1;
  if (role === "pt" || role === "yt" || role === "receipt") return 2;
  return 3;
}
