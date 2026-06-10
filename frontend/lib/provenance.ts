/**
 * 데이터 출처 신뢰도 3단계 — 정직성 인코딩(설계 차별점).
 *   verified  — 온체인 검증(정밀 어댑터): 실선
 *   estimated — DeFiLlama 등 미검증 집계(breadth)/dl 풀: 점선
 *   opaque    — 정체불명(UNKNOWN·이름없는 큐레이터/볼트) = DD 불가: 점점선
 * 엣지·노드·범례가 이 한 분류기를 공유한다.
 */
import type { GraphEdge, GraphNode } from "@/lib/api";

export type Provenance = "verified" | "estimated" | "opaque";

// breadth(미검증 집계) 출처 마킹
const BREADTH_RE = /^(defillama|morpho-api|euler-api)/i;
const RANK: Record<Provenance, number> = { verified: 0, estimated: 1, opaque: 2 };

/** 노드 출처. opaque > estimated > verified. */
export function nodeProvenance(n: GraphNode | undefined | null): Provenance {
  if (!n) return "verified";
  const md = n.metadata ?? {};
  const label = (n.label ?? "").trim().toLowerCase();
  // opaque — 정체불명 컨트랙트 / 이름없는 볼트 / UNKNOWN 토큰
  const v = md._vault as { curator?: string | null; vault?: string | null } | null | undefined;
  if (label === "unknown" || label === "" || label === "vault") return "opaque";
  if (v && !v.curator && !v.vault) return "opaque";
  // estimated — breadth(미검증) 노드 / DeFiLlama 풀 마켓
  const ds = String(md.dataSource ?? "");
  const mk = md._market as { kind?: string } | null | undefined;
  if (BREADTH_RE.test(ds) || md.category === "breadth" || mk?.kind === "pool") return "estimated";
  return "verified";
}

/** 엣지 출처 = max(엣지 dataSource, 양 끝 노드 출처). 더 낮은 신뢰가 이긴다. */
export function edgeProvenance(edge: GraphEdge, src?: GraphNode | null, tgt?: GraphNode | null): Provenance {
  const ds = String(edge.attrs?.meta?.dataSource ?? "");
  let worst: Provenance = BREADTH_RE.test(ds) ? "estimated" : "verified";
  for (const n of [src, tgt]) {
    const p = nodeProvenance(n ?? undefined);
    if (RANK[p] > RANK[worst]) worst = p;
  }
  return worst;
}

/** 사람용 라벨. */
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  verified: "온체인 검증",
  estimated: "DeFiLlama 추정 (미검증)",
  opaque: "검증불가 (정체불명 · DD 불가)",
};
