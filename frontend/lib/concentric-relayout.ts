/**
 * 동심원 재배치 (역할 기반) — 토큰(중심) → 프로토콜 링1 → 마켓 링2(동심 arc) → 볼트 링3.
 *
 * 왜 필요: concentric-layout 은 DB/breadth 노드를 링에 잘 놓지만, overlayLego 가 나중에 더하는
 *   합성 프로토콜(lego-acc/lego-src)과 그 마켓은 링 밖(파생 옆)에 떨궈져, 마켓 많은 합성 프로토콜
 *   (예: Euler 수용처 36개)이 한쪽으로 방사형 부챗살을 만든다 → "프로토콜을 둘러싸는" 모양(사용자 지적).
 *   이 post-pass 는 overlayLego 까지 끝난 최종 노드 집합을 받아, 출처에 상관없이 **역할만 보고**
 *   토큰 중심 동심원으로 다시 깐다 → 합성 프로토콜도 링1에, 그 마켓도 자기 wedge 안 동심 arc 로.
 *
 * deOverlapConcentric 앞에서 돌려 링 구조를 만들고, 잔여 겹침은 deOverlap 이 미세 조정한다.
 * 멀티체인: 각 체인의 토큰을 중심으로(기존 position 재사용 → 체인 간 가로 간격 보존) 따로 재배치.
 */
import type { GraphNode, TopologyResponse } from "./api";

const R_PROTO = 470;      // 링1 프로토콜 반경
const R_DERIV = 300;      // 파생 반경(프로토콜보다 안쪽 — 토큰↔프로토콜 사이, 발행 관계)
const RING_M = 250;       // 프로토콜 → 마켓 링2 간격 (R2 = 720)
const SUBRING = 150;      // 한 wedge arc 에 마켓이 다 안 들어가면 다음 동심 sub-ring
const RING_V = 132;       // 마켓 → 볼트 간격
const NODE_ARC = 60;      // arc 위 노드 1개가 차지하는 길이(px) — 한 arc 수용 개수 산정
const TOKEN_DIA = 235;
// 프로토콜당 마켓 표시 상한 — 한 프로토콜이 마켓 수십 개(예: Euler 가 rsETH 를 42개 볼트에 담보가능으로
//   올려 "금액 미상"으로 통째 수집된 스팸)를 가지면 그 wedge 가 폭증해 동심원이 한쪽으로 쏠린다.
//   금액(노출 USD) 큰 순 상위 N 개만 표시 → 동심원 가독성 유지. 드롭된 마켓·볼트·엣지는 토폴로지에서 제외.
const CAP_MKT_PER_PROTO = 8;

function chainOf(n: GraphNode): string {
  const c = n.metadata?.chain as string | undefined;
  if (c) return c;
  const m = /^c:([^:]+):/.exec(n.id);
  return m ? m[1] : "ethereum";
}

type Role = "token" | "island" | "protocol" | "market" | "vault" | "deriv" | "bridge" | "other";
function roleOf(n: GraphNode): Role {
  if (n.type === "Token" || /^c:[^:]+:token$/.test(n.id)) return "token";
  if (n.type === "IslandHandle") return "island";
  if (n.metadata?._vault) return "vault";
  if (n.metadata?._market) return "market";
  if (n.type === "DerivativeToken") return "deriv";
  if (n.type === "Bridge") return "bridge";
  return "protocol"; // DefiProtocol(합성 lego-acc/lego-src 포함)
}
function diaOf(n: GraphNode, role: Role): number {
  const d = n.metadata?.diameterPx as number | undefined;
  if (d) return d;
  return role === "token" ? TOKEN_DIA : role === "market" || role === "vault" ? 48 : role === "deriv" ? 40 : 96;
}

export function relayoutConcentric(topology: TopologyResponse, hiddenChains: Set<string>): TopologyResponse {
  const nodes = topology.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const role = new Map(nodes.map((n) => [n.id, roleOf(n)] as const));

  // 들어오는 엣지 (target → [source]) — 부모 추적용
  const inE = new Map<string, string[]>();
  for (const e of topology.edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    (inE.get(e.target) ?? inE.set(e.target, []).get(e.target)!).push(e.source);
  }

  // 노드의 부모 프로토콜 — 엣지를 거슬러 올라가 가장 가까운 protocol 을 찾는다.
  //   market 의 부모 = protocol(직접) 또는 deriv 를 통해(deriv→market) 그 deriv 의 프로토콜.
  //   vault 의 부모 = market 을 통해 그 market 의 프로토콜.
  const protoCache = new Map<string, string | null>();
  function parentProto(id: string, depth = 0): string | null {
    if (protoCache.has(id)) return protoCache.get(id)!;
    if (depth > 7) return null;
    protoCache.set(id, null); // 사이클 가드
    const srcs = inE.get(id) ?? [];
    let res: string | null = null;
    for (const s of srcs) if (role.get(s) === "protocol") { res = s; break; }
    if (!res) for (const s of srcs) {
      const r = role.get(s);
      if (r === "deriv" || r === "market" || r === "vault") { const p = parentProto(s, depth + 1); if (p) { res = p; break; } }
    }
    protoCache.set(id, res);
    return res;
  }
  // 노드의 부모 마켓(볼트용)
  function parentMarket(id: string): string | null {
    for (const s of inE.get(id) ?? []) if (role.get(s) === "market") return s;
    return null;
  }

  const pos = new Map<string, { x: number; y: number }>(); // 중심좌표
  const hidden = new Set<string>(); // 프로토콜당 캡 초과로 드롭된 마켓·볼트
  const setCenter = (n: GraphNode, x: number, y: number) => pos.set(n.id, { x, y });

  // wedge 안 여러 동심 arc 로 배치 — 한 arc 가 차면 바깥 sub-ring 으로(나선 아니라 동심 arc 누적).
  function placeInWedge(items: GraphNode[], cx: number, cy: number, baseAng: number, halfWedge: number, baseR: number, ringGap: number) {
    let idx = 0, ring = 0;
    while (idx < items.length) {
      const R = baseR + ring * ringGap;
      const arcLen = 2 * halfWedge * R;
      const perArc = Math.max(1, Math.floor(arcLen / NODE_ARC));
      const row = items.slice(idx, idx + perArc);
      const m = row.length;
      row.forEach((n, j) => {
        const a = m <= 1 ? baseAng : baseAng - halfWedge + 2 * halfWedge * (j / (m - 1));
        setCenter(n, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      });
      idx += perArc; ring++;
    }
  }

  const chains = [...new Set(nodes.filter((n) => !hiddenChains.has(chainOf(n))).map(chainOf))];
  for (const chain of chains) {
    const cn = nodes.filter((n) => chainOf(n) === chain && !hiddenChains.has(chain));
    const tok = cn.find((n) => role.get(n.id) === "token");
    if (!tok || !tok.position) continue;
    const cx = tok.position.x + diaOf(tok, "token") / 2;
    const cy = tok.position.y + diaOf(tok, "token") / 2;
    setCenter(tok, cx, cy);
    const island = cn.find((n) => role.get(n.id) === "island");
    if (island) setCenter(island, cx, cy - R_PROTO * 0.5);

    // 링1: 프로토콜 — 노출(sizeUsd) 내림차순, 360°/N 균등.
    const exp = (n: GraphNode) => (n.metadata?.sizeUsd as number | undefined) ?? 0;
    const protos = cn.filter((n) => role.get(n.id) === "protocol").sort((a, b) => exp(b) - exp(a));
    const N = Math.max(1, protos.length);
    const angOf = new Map<string, number>();
    protos.forEach((p, i) => {
      const ang = -Math.PI / 2 + (2 * Math.PI / N) * i;
      angOf.set(p.id, ang);
      setCenter(p, cx + Math.cos(ang) * R_PROTO, cy + Math.sin(ang) * R_PROTO);
    });
    const halfWedge = (2 * Math.PI / N) * 0.44; // 인접 wedge 와 안 겹치게 약간 여유

    // 마켓·파생을 부모 프로토콜별로 그룹
    const mByProto = new Map<string, GraphNode[]>();
    const dByProto = new Map<string, GraphNode[]>();
    const orphans: GraphNode[] = [];
    for (const n of cn) {
      const r = role.get(n.id);
      if (r !== "market" && r !== "deriv") continue;
      const pp = parentProto(n.id);
      if (pp && angOf.has(pp)) {
        const map = r === "deriv" ? dByProto : mByProto;
        (map.get(pp) ?? map.set(pp, []).get(pp)!).push(n);
      } else orphans.push(n);
    }

    // 파생은 안쪽(R_DERIV) wedge, 마켓은 링2(R_PROTO+RING_M) wedge 동심 arc.
    for (const p of protos) {
      const ang = angOf.get(p.id)!;
      const ds = dByProto.get(p.id) ?? [];
      if (ds.length) placeInWedge(ds, cx, cy, ang, halfWedge, R_DERIV, SUBRING);
      const sorted = (mByProto.get(p.id) ?? []).sort((a, b) => exp(b) - exp(a));
      const ms = sorted.slice(0, CAP_MKT_PER_PROTO);
      for (const drop of sorted.slice(CAP_MKT_PER_PROTO)) hidden.add(drop.id); // 캡 초과 마켓 드롭
      if (ms.length) placeInWedge(ms, cx, cy, ang, halfWedge, R_PROTO + RING_M, SUBRING);
    }

    // 볼트: 부모 마켓 바깥(반경 +RING_V), 같은 각도. 부모 마켓이 배치된 뒤라야 함.
    const vaultsByMkt = new Map<string, GraphNode[]>();
    for (const n of cn) {
      if (role.get(n.id) !== "vault") continue;
      const pm = parentMarket(n.id);
      if (pm && hidden.has(pm)) { hidden.add(n.id); continue; } // 드롭된 마켓의 볼트도 드롭
      if (pm && pos.has(pm)) (vaultsByMkt.get(pm) ?? vaultsByMkt.set(pm, []).get(pm)!).push(n);
      else orphans.push(n);
    }
    for (const [mid, vs] of vaultsByMkt) {
      const mc = pos.get(mid)!;
      const baseAng = Math.atan2(mc.y - cy, mc.x - cx);
      const baseR = Math.hypot(mc.x - cx, mc.y - cy) + RING_V;
      vs.forEach((v, k) => {
        const a = baseAng + (vs.length <= 1 ? 0 : (k - (vs.length - 1) / 2) * 0.06);
        setCenter(v, cx + Math.cos(a) * (baseR + k * 30), cy + Math.sin(a) * (baseR + k * 30));
      });
    }

    // 고아(부모 못 찾음): 가장 바깥 링에 전 둘레 균등 — 한쪽 쏠림 방지.
    if (orphans.length) {
      const R = R_PROTO + RING_M + 4 * SUBRING;
      orphans.forEach((n, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI / orphans.length) * i;
        setCenter(n, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      });
    }
  }

  // 좌표 출력 — 프로토콜은 "링 위 중심점"을 그대로 position 으로(deOverlap 의 isRingProto 분기가 부스트로 커진
  //   박스를 그 점에 센터링). 그 외(마켓·볼트·파생·토큰)는 좌상단 관례(중심 - 지름/2). 위치 못 받은 노드는 원본 유지.
  const laidOut = nodes.filter((n) => !hidden.has(n.id)).map((n) => {
    const c = pos.get(n.id);
    if (!c) return n;
    const r = role.get(n.id)!;
    if (r === "protocol") return { ...n, position: { x: c.x, y: c.y } };
    const d = diaOf(n, r);
    return { ...n, position: { x: c.x - d / 2, y: c.y - d / 2 } };
  });
  const keptEdges = topology.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target));
  return { ...topology, nodes: laidOut, edges: keptEdges };
}
