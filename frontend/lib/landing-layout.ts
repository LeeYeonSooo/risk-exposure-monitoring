import type { GraphEdge, GraphNode } from "./api";
import { protoDiameterPx, tokenDiameterPx } from "./node-size";

/**
 * 메인화면 이중 동심원 레이아웃 — 안쪽 링 = 토큰 전체, 바깥 링 = 프로토콜 전체,
 * 토큰→프로토콜 노출 엣지가 실타래처럼 가로지른다 (dark-spiral-graph 의 그래프를
 * 배경 없이 라이트 테마로 가져온 것). 데이터 = /api/graph (토큰별 최신 DB 스냅샷).
 *
 * 배치 규칙(전부 실데이터 기반):
 *  · 노드 크기 = 그 노드의 총 노출 USD (Σ attrs.core.amountUsd)
 *  · 링 반지름 = 노드 수 × 간격 / 2π (겹침 없는 최소 원주)
 *  · 프로토콜 각도 = 연결된 토큰들의 평균 각도(원형 평균) 순 정렬 — 실타래는 유지하되
 *    완전 무작위 교차보다 읽기 쉬움
 */

interface ApiNode { id: string; type: string; label: string; metadata: Record<string, unknown> | null; address: string | null; chain: string }
interface ApiEdge { source: string; target: string; edge_type: string; weight: number; attrs: GraphEdge["attrs"] }

export interface LandingTopology {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** token node id → {symbol, chain, address} — 입자 레이어의 전송 조회용 */
  tokenInfo: Map<string, { symbol: string; chain: string; address: string | null }>;
}

const TOKEN_SPACING = 150;   // 안쪽 링 노드 간 호 길이(px)
const PROTO_SPACING = 195;   // 바깥 링
const MIN_GAP = 420;         // 두 링 사이 최소 간격

const usdOf = (e: ApiEdge) => e.attrs?.core?.amountUsd ?? e.weight ?? 0;

export function buildLandingTopology(apiNodes: ApiNode[], apiEdges: ApiEdge[]): LandingTopology {
  const byId = new Map(apiNodes.map((n) => [n.id, n] as const));
  const tokenIds = new Set<string>();
  const protoIds = new Set<string>();
  const sizeUsd = new Map<string, number>();
  for (const e of apiEdges) {
    tokenIds.add(e.source);
    protoIds.add(e.target);
    const v = usdOf(e);
    sizeUsd.set(e.source, (sizeUsd.get(e.source) ?? 0) + v);
    sizeUsd.set(e.target, (sizeUsd.get(e.target) ?? 0) + v);
  }
  // 같은 id 가 토큰이면서 타겟이기도 하면(드묾) 토큰으로 취급
  for (const id of tokenIds) protoIds.delete(id);

  // 안쪽 링: 토큰 — 노출 큰 순으로 시계방향
  const tokens = [...tokenIds].sort((a, b) => (sizeUsd.get(b) ?? 0) - (sizeUsd.get(a) ?? 0));
  const Ri = Math.max(380, (tokens.length * TOKEN_SPACING) / (2 * Math.PI));
  const tokenAngle = new Map<string, number>();
  tokens.forEach((id, i) => tokenAngle.set(id, -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, tokens.length)));

  // 바깥 링: 프로토콜 — 연결된 토큰들의 원형 평균 각도로 정렬해 같은 간격으로 배치
  const protoTokAngles = new Map<string, { sx: number; sy: number }>();
  for (const e of apiEdges) {
    const a = tokenAngle.get(e.source);
    if (a == null || !protoIds.has(e.target)) continue;
    const cur = protoTokAngles.get(e.target) ?? { sx: 0, sy: 0 };
    cur.sx += Math.cos(a); cur.sy += Math.sin(a);
    protoTokAngles.set(e.target, cur);
  }
  const protos = [...protoIds].sort((a, b) => {
    const pa = protoTokAngles.get(a), pb = protoTokAngles.get(b);
    const aa = pa ? Math.atan2(pa.sy, pa.sx) : 0;
    const ab = pb ? Math.atan2(pb.sy, pb.sx) : 0;
    return aa - ab;
  });
  const Ro = Math.max(Ri + MIN_GAP, (protos.length * PROTO_SPACING) / (2 * Math.PI));

  const nodes: GraphNode[] = [];
  const tokenInfo: LandingTopology["tokenInfo"] = new Map();

  tokens.forEach((id) => {
    const src = byId.get(id);
    const a = tokenAngle.get(id)!;
    const usd = sizeUsd.get(id) ?? 0;
    const symbol = (src?.metadata?.symbol as string | undefined) ?? src?.label ?? id.replace(/^token:/, "");
    nodes.push({
      id, type: "Token", label: src?.label ?? symbol, active: true,
      position: { x: Math.cos(a) * Ri, y: Math.sin(a) * Ri },
      metadata: { ...(src?.metadata ?? {}), symbol, chain: src?.chain ?? "ethereum", sizeUsd: usd, diameterPx: tokenDiameterPx(usd), tokenAddr: src?.address ?? null },
    } as GraphNode);
    tokenInfo.set(id, { symbol, chain: src?.chain ?? "ethereum", address: src?.address ?? null });
  });
  protos.forEach((id, i) => {
    const src = byId.get(id);
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, protos.length);
    const usd = sizeUsd.get(id) ?? 0;
    nodes.push({
      id, type: (src?.type as GraphNode["type"]) ?? "LendingProtocol", label: src?.label ?? id.replace(/^protocol:(dl:)?/, ""), active: true,
      position: { x: Math.cos(a) * Ro, y: Math.sin(a) * Ro },
      metadata: { ...(src?.metadata ?? {}), chain: src?.chain ?? "ethereum", sizeUsd: usd, diameterPx: protoDiameterPx(usd) },
    } as GraphNode);
  });

  const edges: GraphEdge[] = apiEdges
    .filter((e) => tokenAngle.has(e.source) && protoIds.has(e.target))
    .map((e) => ({
      id: `${e.source}__${e.target}`, source: e.source, target: e.target,
      type: e.edge_type, weight: e.weight, attrs: e.attrs,
    } as GraphEdge));

  return { nodes, edges, tokenInfo };
}
