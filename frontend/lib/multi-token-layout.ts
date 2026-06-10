import type { GraphEdge, GraphNode, TopologyResponse } from "@/lib/api";
import { formatUsd } from "@/lib/api";
import { tokenDiameterPx } from "@/lib/node-size";

/**
 * 멀티 토큰 뷰 — 브릿지 중심 방사형 구조.
 *
 *   ┌─ 가장 안쪽(중앙): 브릿지 허브 — 토큰이 여러 체인에 있으면 그 체인 인스턴스끼리 연결.
 *   └─ 바깥: 체인별 동심원들을 큰 원 둘레에 방사 배치.
 *        한 체인 동심원 = 안쪽부터  토큰 → 프로토콜 → 마켓/풀 → 큐레이터 볼트.
 *
 * 토큰 간 익스포저 = 같은 프로토콜/마켓 공유. ≥2 선택토큰이 쓰는 프로토콜은 "공유 노드" 1개로
 * 그 체인 동심원 안에서 토큰들 사이(원형평균 방향)에 둬서 상관 위험을 한눈에. 담보·대출이 둘 다
 * 선택토큰인 마켓은 "↔ 토큰간"(주황)으로 강조.
 */

interface TokSel { sym: string; tokenIds: string[] }

interface MktLite {
  collateral: string; loan: string; sizeUsd: number; lltv: number | null;
  ouroboros: boolean; cross: boolean;
  vaults: { curator: string | null; vault: string | null; allocationUsd: number | null }[];
}

const canonProto = (id: string) => id.replace(/^protocol:/, "").replace(/^dl:/, "").split("@")[0].replace(/_/g, "-").toLowerCase();
const CHAIN_ORDER = ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis", "linea", "scroll"];
const usdOf = (e: GraphEdge) => e.attrs?.core?.amountUsd ?? e.weight ?? 0;

// 한 체인 동심원 내부 반경 (체인 원 중심 기준) — 안쪽부터 토큰 → 프로토콜(R1) → 마켓 → 큐레이터
const RT = 110;       // 링0 토큰 (여러 토큰이면 안쪽 작은 원)
const R1_MIN = 190;   // 링1 프로토콜 최소 반경(프로토콜 적으면 타이트하게 → 브릿지 가까이)
const R1_MAX = 370;   // 링1 프로토콜 최대 반경
const NODE_ARC = 108; // 프로토콜 1개가 차지하는 호 길이(px) → R1 산정
const RING_M = 165;   // 프로토콜 → 마켓
const RING_V = 120;   // 마켓 → 큐레이터
const CAP_PROTO = 18;     // 체인당 프로토콜
const CAP_MKT_SHARED = 3; // 공유 프로토콜당 마켓
const CAP_MKT_UNIQUE = 2; // 단독 프로토콜당 마켓
const CAP_VAULT = 2;      // 마켓당 큐레이터

const fmtPct = (x: number | null) => (x == null ? "" : ` · LLTV ${(x * 100).toFixed(0)}%`);

export function applyMultiTokenLayout(opts: {
  tokens: TokSel[];
  dbNodes: Map<string, GraphNode>;
  dbEdges: GraphEdge[];
  hiddenChains?: Set<string>;
  /** 토큰 심볼 → 체인 → 주소 (breadth API). 토큰 로고 + OFT(동일주소) 브릿지 탐지용. */
  addrBySym?: Record<string, Record<string, string>>;
  /** 토큰 심볼 → 체인 → 온체인 공급 (breadth API). 브릿지 양 표기용. */
  supplyBySym?: Record<string, Record<string, { supply: number; supplyUsd: number }>>;
  /** 마켓·큐레이터 링 표시 여부(밀도 조절). 끄면 토큰→프로토콜까지만. */
  includeMarkets?: boolean;
}): { topology: TopologyResponse; sharedCount: number } {
  const { tokens, dbNodes, dbEdges, hiddenChains, addrBySym = {}, supplyBySym = {}, includeMarkets = true } = opts;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const symById = new Map<string, string>();
  tokens.forEach((t) => t.tokenIds.forEach((id) => symById.set(id, t.sym)));
  const tokenIdSet = new Set(symById.keys());
  const selectedSyms = new Set(tokens.map((t) => t.sym.toLowerCase()));
  const addrFor = (sym: string, chain: string) => addrBySym[sym]?.[chain] ?? addrBySym[sym.toLowerCase()]?.[chain] ?? null;
  const supplyUsdFor = (sym: string, chain: string) => supplyBySym[sym]?.[chain]?.supplyUsd ?? supplyBySym[sym.toLowerCase()]?.[chain]?.supplyUsd ?? 0;
  // 토큰별 체인 인스턴스 추적 — 중앙 브릿지 허브 연결용.
  const tokChains = new Map<string, { chain: string; addr: string | null; instId: string }[]>();

  // (chain, sym) → 프로토콜 관계 + 그 토큰의 마켓들
  type Rel = { sym: string; chain: string; protoId: string; protoLabel: string; usd: number; crossLoan: string | null; markets: MktLite[] };
  const rels: Rel[] = [];
  for (const e of dbEdges) {
    const tokId = tokenIdSet.has(e.source) ? e.source : tokenIdSet.has(e.target) ? e.target : null;
    if (!tokId) continue;
    const protoId = tokId === e.source ? e.target : e.source;
    if (!protoId.startsWith("protocol:")) continue;
    const usd = usdOf(e);
    if (usd <= 0) continue;
    const chain = (dbNodes.get(protoId)?.metadata.chain as string) ?? "ethereum";
    if (hiddenChains?.has(chain)) continue;
    const thisSym = symById.get(tokId)!.toLowerCase();

    const markets: MktLite[] = includeMarkets
      ? (e.attrs?.topMarkets ?? [])
          .filter((m) => (m.marketSizeUsd ?? 0) > 0)
          .map((m) => {
            const loan = (m.loanAsset ?? "").toLowerCase();
            const coll = (m.collateralAsset ?? "").toLowerCase();
            const cross = (!!loan && loan !== thisSym && selectedSyms.has(loan)) || (!!coll && coll !== thisSym && selectedSyms.has(coll));
            return {
              collateral: m.collateralAsset ?? "?", loan: m.loanAsset ?? "?", sizeUsd: m.marketSizeUsd ?? 0,
              lltv: m.lltv ?? null, ouroboros: !!m.ouroborosRisk, cross,
              vaults: (m.fundingVaults ?? []).filter((v) => v.curator || v.vaultName)
                .sort((a, b) => (b.allocationUsd ?? 0) - (a.allocationUsd ?? 0)).slice(0, CAP_VAULT)
                .map((v) => ({ curator: v.curator ?? null, vault: v.vaultName ?? null, allocationUsd: v.allocationUsd ?? null })),
            };
          })
      : [];

    let crossLoan: string | null = null;
    for (const m of markets) { if (m.cross) { crossLoan = m.loan; break; } }
    rels.push({ sym: symById.get(tokId)!, chain, protoId, protoLabel: dbNodes.get(protoId)?.label ?? protoId, usd, crossLoan, markets });
  }

  const byChain = new Map<string, Rel[]>();
  for (const r of rels) { if (!byChain.has(r.chain)) byChain.set(r.chain, []); byChain.get(r.chain)!.push(r); }
  const chains = [...byChain.keys()].sort((a, b) => {
    const ra = CHAIN_ORDER.indexOf(a), rb = CHAIN_ORDER.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
  const NC = chains.length;

  // 사전계산: 체인별 프로토콜 수 → R1(반경). 프로토콜 적은 체인은 작게 → 브릿지 가까이 타이트하게.
  const chainR1 = new Map<string, number>();
  let maxOuter = 0;
  for (const chain of chains) {
    const protoKeys = new Set(byChain.get(chain)!.map((r) => canonProto(r.protoId)));
    const N = Math.min(CAP_PROTO, protoKeys.size) || 1;
    const R1 = Math.min(R1_MAX, Math.max(R1_MIN, (N * NODE_ARC) / (2 * Math.PI)));
    chainR1.set(chain, R1);
    const outer = R1 + (includeMarkets ? RING_M + RING_V : 0) + 110;
    if (outer > maxOuter) maxOuter = outer;
  }

  // 방사 배치 (중앙 = 브릿지 허브). META_R = 인접 체인 비겹침 + 최소 중앙 클리어런스 중 큰 값.
  // 과거엔 chainOuter 전체를 중앙 밖으로 밀어 빈공간이 컸음 → 실제 체인 크기(maxOuter)에 맞춰 타이트하게.
  const hubR = Math.min(maxOuter * 0.26, 170);
  const centers = new Map<string, { cx: number; cy: number; outward: number }>();
  let META_R = 0;
  if (NC === 1) {
    centers.set(chains[0], { cx: 0, cy: 0, outward: -Math.PI / 2 });
  } else if (NC === 2) {
    // 2체인은 방사형이면 세로로 길쭉해서 못생김 → 좌우로 (사이에 브릿지 허브).
    META_R = maxOuter + 230;
    centers.set(chains[0], { cx: -META_R, cy: 0, outward: Math.PI });
    centers.set(chains[1], { cx: META_R, cy: 0, outward: 0 });
  } else if (NC >= 2) {
    // 비겹침(외곽 sparse 링 살짝 겹침 허용 0.84) vs 중앙 클리어런스(안쪽 sparse 링은 허브 근처까지 OK) 중 큰 값.
    // → 체인들을 브릿지 가까이 타이트하게. (full circle 의 기하 한계 안에서 최대 압축)
    META_R = Math.max((maxOuter / Math.sin(Math.PI / NC)) * 0.84, hubR + maxOuter * 0.56 + 50);
    chains.forEach((ch, i) => {
      const th = -Math.PI / 2 + (2 * Math.PI * i) / NC;
      centers.set(ch, { cx: META_R * Math.cos(th), cy: META_R * Math.sin(th), outward: th });
    });
  }

  // 한 프로토콜의 마켓(링2) + 큐레이터(링3) 를 ang 방향 바깥(체인 원 중심 cx,cy 기준)에 배치.
  // wedge 는 그 프로토콜의 각도 슬롯(slot) 안으로 제한 → 마켓/볼트가 옆 궤도로 새지 않음(깔끔한 동심원).
  const emitMarkets = (pid: string, ang: number, baseR: number, cx: number, cy: number, chain: string, markets: MktLite[], cap: number, slot: number) => {
    if (!includeMarkets || markets.length === 0) return;
    const top = markets.slice().sort((a, b) => b.sizeUsd - a.sizeUsd).slice(0, cap);
    const wedge = top.length <= 1 ? 0 : Math.min(top.length * 0.11, slot * 0.55);
    top.forEach((m, j) => {
      const angM = top.length <= 1 ? ang : ang - wedge / 2 + (wedge * j) / (top.length - 1);
      const rM = baseR + RING_M;
      const mid = `${pid}:m${j}`;
      nodes.push({
        id: mid, type: "DefiProtocol", label: `${m.collateral}/${m.loan}`,
        metadata: { chain, sizeUsd: m.sizeUsd, category: `${m.cross ? "↔ 토큰간 · " : ""}Market${fmtPct(m.lltv)}`, _market: { kind: "lending", sizeUsd: m.sizeUsd, lltv: m.lltv, ouroboros: m.ouroboros, cross: m.cross } },
        active: true, position: { x: cx + Math.cos(angM) * rM, y: cy + Math.sin(angM) * rM },
      } as GraphNode);
      edges.push({ id: `mme:${mid}`, source: pid, target: mid, type: m.cross ? "loan_asset" : "collateral_isolated", weight: m.sizeUsd } as GraphEdge);
      const vw = m.vaults.length <= 1 ? 0 : Math.min(0.1, (slot * 0.5) / Math.max(1, top.length));
      m.vaults.forEach((v, k) => {
        const angV = m.vaults.length <= 1 ? angM : angM - vw / 2 + (vw * k) / (m.vaults.length - 1);
        const vid = `${mid}:v${k}`;
        nodes.push({
          id: vid, type: "DefiProtocol", label: v.curator || v.vault || "vault",
          metadata: { chain, sizeUsd: v.allocationUsd ?? 0, category: "Vault · 큐레이터", _vault: { curator: v.curator, vault: v.vault, allocationUsd: v.allocationUsd, market: `${m.collateral}/${m.loan}` } },
          active: true, position: { x: cx + Math.cos(angV) * (rM + RING_V), y: cy + Math.sin(angV) * (rM + RING_V) },
        } as GraphNode);
        edges.push({ id: `mve:${vid}`, source: mid, target: vid, type: "deposit_supply", weight: v.allocationUsd ?? 0 } as GraphEdge);
      });
    });
  };

  let sharedCount = 0;
  chains.forEach((chain) => {
    const c = centers.get(chain);
    if (!c) return;
    const { cx, cy, outward } = c;
    const R1 = chainR1.get(chain)!;
    const labelR = R1 + (includeMarkets ? RING_M + RING_V : 0) + 130; // 라벨은 최외곽 링 바깥
    const chainRels = byChain.get(chain)!;
    const symsHere = [...new Set(chainRels.map((r) => r.sym))];
    const nT = symsHere.length || 1;
    symsHere.forEach((s, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / nT;
      const tUsd = chainRels.filter((r) => r.sym === s).reduce((x, r) => x + r.usd, 0);
      const tid = `mt:${chain}:tok:${s}`;
      // 토큰 노드 = 노출 규모 기반 자연 크기(40~92px) — 멀티에선 프로토콜·마켓에 안 묻히게 작게.
      const dia = Math.round(tokenDiameterPx(tUsd));
      const addr = addrFor(s, chain);
      nodes.push({ id: tid, type: "Token", label: s, metadata: { symbol: s, chain, sizeUsd: tUsd, diameterPx: dia, tokenAddr: addr }, active: true, position: { x: cx + Math.cos(a) * (nT > 1 ? RT : 0) - dia / 2, y: cy + Math.sin(a) * (nT > 1 ? RT : 0) - dia / 2 } } as GraphNode);
      if (!tokChains.has(s)) tokChains.set(s, []);
      tokChains.get(s)!.push({ chain, addr, instId: tid });
    });
    // 체인 라벨 — 원 바깥(중앙 반대 방향)
    nodes.push({ id: `island:${chain}`, type: "IslandHandle", label: chain, metadata: { chain, category: `${nT}개 토큰` }, active: true, position: { x: cx + Math.cos(outward) * labelR, y: cy + Math.sin(outward) * labelR } } as GraphNode);

    // 프로토콜 canon 그룹 + 어느 토큰들이 쓰나 + 마켓 합집합(중복 dedup)
    const pmap = new Map<string, { label: string; syms: Set<string>; usd: number; protoId: string; cross: boolean; markets: Map<string, MktLite> }>();
    for (const r of chainRels) {
      const k = canonProto(r.protoId);
      const cur = pmap.get(k) ?? { label: r.protoLabel, syms: new Set<string>(), usd: 0, protoId: r.protoId, cross: false, markets: new Map<string, MktLite>() };
      cur.syms.add(r.sym); cur.usd += r.usd; if (r.crossLoan) cur.cross = true;
      for (const m of r.markets) {
        const mk = `${m.collateral}/${m.loan}`.toLowerCase();
        const ex = cur.markets.get(mk);
        if (!ex) cur.markets.set(mk, m);
        else { ex.sizeUsd = Math.max(ex.sizeUsd, m.sizeUsd); ex.cross = ex.cross || m.cross; ex.ouroboros = ex.ouroboros || m.ouroboros; if (!ex.vaults.length) ex.vaults = m.vaults; }
      }
      pmap.set(k, cur);
    }
    // 링1 프로토콜 — 공유·단독 합쳐 USD 내림차순으로 360° 균등 배치(= 깔끔한 동심원).
    // 공유(≥2 토큰)는 category 표시 + 양쪽 토큰에서 엣지 → 토큰 간 상관 익스포저가 한눈에.
    const protoList = [...pmap.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, CAP_PROTO);
    sharedCount += protoList.filter(([, p]) => p.syms.size >= 2).length;
    const N = protoList.length || 1;
    const slot = (2 * Math.PI) / N; // 프로토콜 1개의 각도 슬롯 → 마켓/볼트가 이 안에 머물게
    protoList.forEach(([k, p], i) => {
      const ang = -Math.PI / 2 + (2 * Math.PI * i) / N;
      const isShared = p.syms.size >= 2;
      const pid = `mt:${chain}:p:${k}`;
      nodes.push({ id: pid, type: (dbNodes.get(p.protoId)?.type ?? "DefiProtocol") as GraphNode["type"], label: p.label,
        metadata: { chain, sizeUsd: p.usd, venue: dbNodes.get(p.protoId)?.metadata.venue, brandSlug: k, category: isShared ? `공유 · ${[...p.syms].join("·")}` : undefined },
        active: true, position: { x: cx + Math.cos(ang) * R1, y: cy + Math.sin(ang) * R1 } } as GraphNode);
      for (const sym of p.syms) edges.push({ id: `mte:${pid}:${sym}`, source: `mt:${chain}:tok:${sym}`, target: pid, type: p.cross ? "loan_asset" : isShared ? "collateral" : "deposit_supply", weight: p.usd } as GraphEdge);
      emitMarkets(pid, ang, R1, cx, cy, chain, [...p.markets.values()], isShared ? CAP_MKT_SHARED : CAP_MKT_UNIQUE, slot);
    });
  });

  // 중앙 브릿지 허브 — 토큰이 ≥2 체인에 있으면 그 인스턴스끼리 연결(가장 안쪽).
  // 동일주소 ≥2체인 = OFT 메시 / 아니면 canonical(추정). 소스(이더리움)=bridge_in(앰버 잠김), 도착=bridge_out(초록 민팅).
  if (NC >= 2) {
    const bridging = [...tokChains].filter(([, list]) => list.length >= 2);
    bridging.forEach(([sym, list], bi) => {
      const addrGroups = new Map<string, number>();
      for (const c of list) { const a = (c.addr || "").toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(a)) addrGroups.set(a, (addrGroups.get(a) ?? 0) + 1); }
      const isOft = [...addrGroups.values()].some((n) => n >= 2);
      const src = list.find((c) => c.chain === "ethereum") ?? list[0];
      const dests = list.filter((c) => c.instId !== src.instId);
      const totalUsd = list.reduce((s, c) => s + supplyUsdFor(sym, c.chain), 0);
      const ang = -Math.PI / 2 + (2 * Math.PI * bi) / Math.max(1, bridging.length);
      const r = bridging.length === 1 ? 0 : hubR * 0.5;
      const bid = `mt:bridge:${sym}`;
      nodes.push({
        id: bid, type: "Bridge", label: isOft ? `${sym} · LayerZero OFT` : `${sym} 브릿지`,
        metadata: { chain: src.chain, category: `${isOft ? "동일주소 멀티체인 메시" : "canonical(추정)"} · ${list.length}체인${totalUsd > 0 ? ` · 공급 ${formatUsd(totalUsd)}` : ""}` },
        active: true, position: { x: Math.cos(ang) * r, y: Math.sin(ang) * r },
      } as GraphNode);
      edges.push({ id: `mtb:${bid}:in`, source: src.instId, target: bid, type: "bridge_in", weight: supplyUsdFor(sym, src.chain) || 1 } as GraphEdge);
      for (const d of dests) edges.push({ id: `mtb:${bid}:out:${d.chain}`, source: bid, target: d.instId, type: "bridge_out", weight: supplyUsdFor(sym, d.chain) || 1 } as GraphEdge);
    });
  }

  return { topology: { nodes, edges }, sharedCount };
}
