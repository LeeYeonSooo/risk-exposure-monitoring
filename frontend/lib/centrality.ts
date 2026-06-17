// C1: 연결성 중요도 = 진짜 PageRank (방향·가중) — page.tsx 의 connImportance 계산이 사용.
// 순수 함수만 — React/DOM 의존 없음(테스트가 직접 임포트). 결정론: 입력 순서와 무관하게 같은 결과.

export interface CentralityNode {
  id: string;
}
export interface CentralityEdge {
  source: string;
  target: string;
  /** 최종 엣지 가중(호출부가 usdLogWeight 등으로 만들어 전달). 없으면 1, 0 이하·비정상은 무시. */
  weight?: number | null;
}

export interface PageRankOpts {
  /** 텔레포트 감쇠 (기본 0.85) */
  damping?: number;
  /** 최대 반복 (기본 50) */
  maxIter?: number;
  /** L1 수렴 허용오차 (기본 1e-8) */
  tol?: number;
}

/** USD → 엣지 가중. log1p 로 스케일 압축, USD 가 없거나 0 이하면 중립 1. */
export function usdLogWeight(usd: number | null | undefined): number {
  return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? Math.log1p(usd) : 1;
}

/**
 * 가중·방향 PageRank.
 * - 엣지 방향 그대로 따라 rank 가 흐름 (source → target).
 * - dangling(나가는 엣지 없는) 노드의 질량은 전체 노드에 균등 재분배 → 점수 합 ≈ 1 유지.
 * - 결정론: 노드 id 정렬로 인덱스 고정 + 엣지 (src,tgt,w) 정렬 후 합산 → 부동소수 합 순서까지 입력 순서 무관.
 * - 양 끝이 노드 목록에 없는 엣지는 무시. 노드 0개면 빈 Map.
 */
export function pageRank(
  nodes: ReadonlyArray<CentralityNode>,
  edges: ReadonlyArray<CentralityEdge>,
  opts: PageRankOpts = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-8;

  // id 정렬로 결정적 인덱스 부여 (중복 id 는 1개로 합침)
  const ids = [...new Set(nodes.map((n) => n.id))].sort();
  const n = ids.length;
  if (!n) return new Map();
  const idx = new Map(ids.map((id, i) => [id, i] as const));

  // 유효 엣지만 평탄화 → 정렬(결정론) → out-인접 리스트 구성
  const flat: Array<[number, number, number]> = [];
  for (const e of edges) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    const w = e.weight == null ? 1 : e.weight;
    if (!Number.isFinite(w) || w <= 0) continue;
    flat.push([s, t, w]);
  }
  flat.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const outW = new Float64Array(n); // 노드별 나가는 가중 합
  const outAdj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (const [s, t, w] of flat) {
    outAdj[s].push([t, w]);
    outW[s] += w;
  }

  // 멱반복: PR' = (1-d)/N + d·(Σ 유입 + dangling/N)
  let pr = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  const teleport = (1 - damping) / n;
  for (let iter = 0; iter < maxIter; iter++) {
    next.fill(0);
    let dangling = 0;
    for (let s = 0; s < n; s++) {
      if (outW[s] <= 0) {
        dangling += pr[s];
        continue;
      }
      const share = pr[s] / outW[s];
      for (const [t, w] of outAdj[s]) next[t] += share * w;
    }
    const add = teleport + (damping * dangling) / n;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const v = damping * next[i] + add;
      delta += Math.abs(v - pr[i]);
      next[i] = v;
    }
    const swap = pr;
    pr = next;
    next = swap;
    if (delta < tol) break;
  }
  return new Map(ids.map((id, i) => [id, pr[i]]));
}

/**
 * 점수 → [lo, hi] 선형 정규화 (최저=lo, 최고=hi). 전부 같은 값이면 모두 lo(중립).
 * page.tsx 가 boost 대상(제외 규칙 통과 노드)의 PR 점수를 connImportance [1.0, 1.7] 로 바꿀 때 사용.
 */
export function normalizeToBoost(scores: ReadonlyMap<string, number>, lo = 1, hi = 1.7): Map<string, number> {
  const out = new Map<string, number>();
  if (!scores.size) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const v of scores.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  for (const [id, v] of scores) out.set(id, span > 0 ? lo + ((v - min) / span) * (hi - lo) : lo);
  return out;
}
