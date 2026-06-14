// C2: centrality 순수 함수 단위 테스트 (vitest).
// 토이 그래프로 PageRank 의 순위·합·결정론, boost 정규화 경계, usdLogWeight 중립 처리 검증.
// page.tsx 결합은 스코프 밖 — 여기선 lib/centrality.ts 만 직접 임포트.
import { describe, it, expect } from "vitest";
import { pageRank, normalizeToBoost, usdLogWeight, type CentralityNode, type CentralityEdge } from "./centrality";

// 점수 합이 1 인지 (dangling 재분배가 질량을 보존하므로 ≈ 1).
function sum(m: ReadonlyMap<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
// 점수 내림차순 id 목록 (순위 비교용).
function ranked(m: ReadonlyMap<string, number>): string[] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

describe("pageRank", () => {
  it("체인 A→B→C: rank 가 하류로 흐르고 sink(C) 가 최상위, 합≈1", () => {
    const nodes: CentralityNode[] = [{ id: "A" }, { id: "B" }, { id: "C" }];
    const edges: CentralityEdge[] = [
      { source: "A", target: "B" },
      { source: "B", target: "C" },
    ];
    const pr = pageRank(nodes, edges);
    expect(sum(pr)).toBeCloseTo(1, 6);
    // 하류일수록 유입이 누적 → C > B > A
    expect(ranked(pr)).toEqual(["C", "B", "A"]);
    expect(pr.get("C")!).toBeGreaterThan(pr.get("B")!);
    expect(pr.get("B")!).toBeGreaterThan(pr.get("A")!);
  });

  it("스타(스포크→허브): 허브가 최상위, 스포크 3개는 정확히 동점, 합≈1", () => {
    const nodes: CentralityNode[] = [{ id: "hub" }, { id: "s1" }, { id: "s2" }, { id: "s3" }];
    const edges: CentralityEdge[] = [
      { source: "s1", target: "hub" },
      { source: "s2", target: "hub" },
      { source: "s3", target: "hub" },
    ];
    const pr = pageRank(nodes, edges);
    expect(sum(pr)).toBeCloseTo(1, 6);
    expect(ranked(pr)[0]).toBe("hub");
    expect(pr.get("hub")!).toBeGreaterThan(pr.get("s1")!);
    // 대칭 스포크는 동일 점수 (결정론적 합산 순서 보장)
    expect(pr.get("s1")!).toBe(pr.get("s2")!);
    expect(pr.get("s2")!).toBe(pr.get("s3")!);
  });

  it("가중 분배 S→P(3)/Q(1): 가중이 큰 쪽(P)이 더 높고, 동일 가중이면 동점", () => {
    const nodes: CentralityNode[] = [{ id: "S" }, { id: "P" }, { id: "Q" }];
    const weighted = pageRank(nodes, [
      { source: "S", target: "P", weight: 3 },
      { source: "S", target: "Q", weight: 1 },
    ]);
    expect(sum(weighted)).toBeCloseTo(1, 6);
    // 가중이 순위를 직접 결정: P > Q > S
    expect(ranked(weighted)).toEqual(["P", "Q", "S"]);
    expect(weighted.get("P")!).toBeGreaterThan(weighted.get("Q")!);

    // 동일 가중이면 P, Q 는 정확히 동점
    const equal = pageRank(nodes, [
      { source: "S", target: "P", weight: 2 },
      { source: "S", target: "Q", weight: 2 },
    ]);
    expect(equal.get("P")!).toBe(equal.get("Q")!);
  });

  it("결정론: 노드·엣지 입력 순서를 섞어도 동일 결과", () => {
    const a = pageRank(
      [{ id: "A" }, { id: "B" }, { id: "C" }],
      [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ],
    );
    // 같은 그래프, 입력 순서만 뒤집음
    const b = pageRank(
      [{ id: "C" }, { id: "A" }, { id: "B" }],
      [
        { source: "B", target: "C" },
        { source: "A", target: "B" },
      ],
    );
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
    // 같은 입력 두 번 호출 → 비트 단위 동일
    const c = pageRank(
      [{ id: "A" }, { id: "B" }, { id: "C" }],
      [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ],
    );
    expect([...c.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it("무효 엣지(0·음수·NaN 가중, 미지 노드)는 무시 → 엣지 없는 균등 분포", () => {
    const nodes: CentralityNode[] = [{ id: "S" }, { id: "P" }, { id: "Q" }];
    const pr = pageRank(nodes, [
      { source: "S", target: "P", weight: 0 },
      { source: "S", target: "Q", weight: -1 },
      { source: "P", target: "Q", weight: NaN },
      { source: "S", target: "ZZZ", weight: 5 }, // 노드 목록 밖 타깃
    ]);
    expect(sum(pr)).toBeCloseTo(1, 6);
    // 유효 엣지 0개 → 전부 1/N 균등
    for (const v of pr.values()) expect(v).toBeCloseTo(1 / 3, 12);
  });

  it("weight 미지정은 1 로 취급 — 명시 weight:1 과 동일 결과", () => {
    const nodes: CentralityNode[] = [{ id: "A" }, { id: "B" }, { id: "C" }];
    const implicit = pageRank(nodes, [
      { source: "A", target: "B" },
      { source: "B", target: "C" },
    ]);
    const explicit = pageRank(nodes, [
      { source: "A", target: "B", weight: 1 },
      { source: "B", target: "C", weight: 1 },
    ]);
    expect([...implicit.entries()].sort()).toEqual([...explicit.entries()].sort());
  });

  it("노드 0개면 빈 Map", () => {
    expect(pageRank([], [{ source: "A", target: "B" }]).size).toBe(0);
  });
});

describe("normalizeToBoost", () => {
  it("[1.0, 1.7] 경계: 최저=1.0, 최고=1.7, 중간은 선형 보간", () => {
    const out = normalizeToBoost(new Map([["x", 1], ["y", 3], ["z", 5]]));
    expect(out.get("x")).toBeCloseTo(1.0, 12); // 최저
    expect(out.get("z")).toBeCloseTo(1.7, 12); // 최고
    expect(out.get("y")).toBeCloseTo(1.35, 12); // 정중앙 → (1.0+1.7)/2
    // 모든 값이 경계 안
    for (const v of out.values()) {
      expect(v).toBeGreaterThanOrEqual(1.0);
      expect(v).toBeLessThanOrEqual(1.7);
    }
  });

  it("단일 노드는 중립 lo(1.0) — span 0", () => {
    const out = normalizeToBoost(new Map([["only", 42]]));
    expect(out.get("only")).toBe(1.0);
  });

  it("전부 동점이면 모두 중립 lo(1.0)", () => {
    const out = normalizeToBoost(new Map([["p", 2], ["q", 2], ["r", 2]]));
    expect([...out.values()]).toEqual([1.0, 1.0, 1.0]);
  });

  it("빈 입력은 빈 Map", () => {
    expect(normalizeToBoost(new Map()).size).toBe(0);
  });

  it("커스텀 [lo, hi] 경계도 동작", () => {
    const out = normalizeToBoost(new Map([["a", 0], ["b", 10]]), 2, 5);
    expect(out.get("a")).toBeCloseTo(2, 12);
    expect(out.get("b")).toBeCloseTo(5, 12);
  });
});

describe("usdLogWeight", () => {
  it("양수 USD 는 log1p(USD)", () => {
    expect(usdLogWeight(Math.E - 1)).toBeCloseTo(1, 12); // log1p(e-1) = 1
    expect(usdLogWeight(0)).toBe(1); // 경계: 0 은 중립
  });

  it("없음·0 이하·비정상은 중립 1", () => {
    expect(usdLogWeight(0)).toBe(1);
    expect(usdLogWeight(-100)).toBe(1);
    expect(usdLogWeight(null)).toBe(1);
    expect(usdLogWeight(undefined)).toBe(1);
    expect(usdLogWeight(NaN)).toBe(1);
    expect(usdLogWeight(Infinity)).toBe(1);
  });

  it("USD 가 클수록 가중이 단조 증가", () => {
    expect(usdLogWeight(1_000_000)).toBeGreaterThan(usdLogWeight(1_000));
    expect(usdLogWeight(1_000)).toBeGreaterThan(usdLogWeight(1));
  });
});
