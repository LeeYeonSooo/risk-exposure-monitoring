"""
engine.py — 구조적 전염 전파 엔진 (DebtRank transmit-once).

설계 원칙 (docs/sim_spec.md):
  - 그래프-독립 순수 함수. live graph 든 historical snapshot 이든 동일하게 작동.
  - 입력 그래프는 노드 + 가중 엣지만 있으면 됨 (가중치 출처는 호출자 책임).

핵심 알고리즘:
  h_i(t+1) = min(1, h_i(t) + Σ_{i∈Distressed} w_{i→j}·h_i(t))
  transmit-once 상태머신 (U→D→I) → 유한 라운드 수렴.

입력:
  graph = {
    "nodes": [{"id": str, "type": str, "tvl"?: float, ...}],
    "edges": [{"from": str, "to": str, "w": float}],   # w ∈ [0,1]
  }
  shock = {"node": str, "delta": float}                # delta = 디페그 심각도 ∈ [0,1]
  scenario = {...}                                       # 옵션 (현재 미사용)

출력:
  {
    "h": {node: 손상비율 ∈ [0,1]},
    "ranking": [(node, h)],                  # h 내림차순 (h>0 만)
    "ranking_usd": [(node, h·tvl)],          # 달러 영향 추정 (tvl 있을 때)
    "distress_round": {node: 진입 라운드},   # 전파 순서/경로
    "rounds": [{round, transmitted, newly_distressed}],
  }
"""

from __future__ import annotations

from collections import defaultdict
from typing import Optional


def propagate(graph: dict, shock: dict, scenario: Optional[dict] = None) -> dict:
    nodes = {n["id"] for n in graph.get("nodes", [])}
    tvl = {n["id"]: n.get("tvl", 0.0) or 0.0 for n in graph.get("nodes", [])}

    shock_node = shock["node"]
    delta = float(shock["delta"])
    if shock_node not in nodes:
        raise ValueError(f"shock node {shock_node!r} not in graph")
    if not (0.0 <= delta <= 1.0):
        raise ValueError(f"delta must be in [0,1], got {delta}")

    # 인접: from → [(to, w)]
    out_edges: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for e in graph.get("edges", []):
        w = float(e.get("w", 0.0))
        if w <= 0:
            continue
        out_edges[e["from"]].append((e["to"], min(1.0, w)))

    # 초기화
    h: dict[str, float] = {n: 0.0 for n in nodes}
    state: dict[str, str] = {n: "U" for n in nodes}  # U / D / I
    h[shock_node] = delta
    state[shock_node] = "D"
    distress_round: dict[str, int] = {shock_node: 0}
    rounds: list[dict] = []

    t = 0
    max_rounds = len(nodes) + 2  # 안전장치 (transmit-once 면 ≤ N 라운드)
    while t <= max_rounds:
        distressed = [n for n in nodes if state[n] == "D"]
        if not distressed:
            break

        # 1) 방출: 현재 Distressed 들이 이웃에 충격 전달
        incoming: dict[str, float] = defaultdict(float)
        for i in distressed:
            hi = h[i]
            for (j, w) in out_edges.get(i, ()):
                if state[j] == "I":
                    continue  # 이미 방출 끝난 노드엔 안 보냄
                incoming[j] += w * hi

        # 2) 적용 + 새로 충격받은 U 노드 식별
        newly: list[str] = []
        for j, add in incoming.items():
            before = h[j]
            h[j] = min(1.0, h[j] + add)
            if before == 0.0 and h[j] > 0.0 and state[j] == "U":
                newly.append(j)

        # 3) 상태 전이: 방출한 D → I, 새 충격 U → D
        for i in distressed:
            state[i] = "I"
        for j in newly:
            state[j] = "D"
            distress_round[j] = t + 1

        rounds.append({
            "round": t,
            "transmitted": sorted(distressed),
            "newly_distressed": sorted(newly),
        })
        t += 1

    # 출력 정리
    ranking = sorted(
        ((n, h[n]) for n in nodes if h[n] > 0.0),
        key=lambda x: -x[1],
    )
    ranking_usd = sorted(
        ((n, h[n] * tvl[n]) for n in nodes if h[n] > 0.0 and tvl[n] > 0.0),
        key=lambda x: -x[1],
    )

    return {
        "h": h,
        "ranking": ranking,
        "ranking_usd": ranking_usd,
        "distress_round": distress_round,
        "rounds": rounds,
        "shock": {"node": shock_node, "delta": delta},
    }


# ─────────────────────────────────────────────────────────────────────────────
# Bardoscia et al. (2015) "DebtRank: A microscopic foundation for shock propagation"
# Dynamical DebtRank: propagate the INCREMENT every round (not the level, once).
#   h_i(t+1) = min(1, h_i(t) + Σ_j Λ_ij · [h_j(t) − h_j(t−1)])
#   Λ_ij = (i's exposure to j) / (i's equity)   ← our edge weight w(from=j → to=i)
# Correct on loopy graphs (original/transmit-once underestimates; it is a lower bound).
# On trees the two coincide. Stability is governed by λ_max(Λ):
#   λ_max < 1 → shock damped, converges;  λ_max > 1 → amplifying regime (≥1 default).
# Edge convention here: edge {from→to} means "loss flows from→to", w = Λ_{to,from}.
# A node flagged `frozen` (governance freeze) absorbs but does NOT transmit (blocker).
# ─────────────────────────────────────────────────────────────────────────────

def _lambda_max(in_edges: dict, nodes: list, frozen: set, iters: int = 60) -> float:
    """Modulus of the largest eigenvalue of Λ via power iteration (non-negative matrix)."""
    if not nodes:
        return 0.0
    idx = {n: k for k, n in enumerate(nodes)}
    v = [1.0] * len(nodes)
    lam = 0.0
    for _ in range(iters):
        nv = [0.0] * len(nodes)
        for i in nodes:
            s = 0.0
            for (j, w) in in_edges.get(i, ()):
                if j in frozen:
                    continue
                s += w * v[idx[j]]
            nv[idx[i]] = s
        norm = max(abs(x) for x in nv) if nv else 0.0
        if norm <= 1e-12:
            return 0.0
        nv = [x / norm for x in nv]
        lam = norm
        v = nv
    return round(lam, 4)


def propagate_dynamic(graph: dict, shock: dict, scenario: Optional[dict] = None) -> dict:
    """Dynamical (Bardoscia) DebtRank. Drop-in replacement for propagate() — same output
    shape, plus `lambda_max` and `stable`. Respects per-node `frozen` (no outgoing shock)."""
    nodes = [n["id"] for n in graph.get("nodes", [])]
    node_set = set(nodes)
    tvl = {n["id"]: n.get("tvl", 0.0) or 0.0 for n in graph.get("nodes", [])}
    frozen = {n["id"] for n in graph.get("nodes", []) if n.get("frozen")}

    shock_node = shock["node"]
    delta = float(shock["delta"])
    if shock_node not in node_set:
        raise ValueError(f"shock node {shock_node!r} not in graph")
    if not (0.0 <= delta <= 1.0):
        raise ValueError(f"delta must be in [0,1], got {delta}")

    # in-edges: to ← [(from, w)]   (w = Λ_{to,from})
    in_edges: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for e in graph.get("edges", []):
        w = float(e.get("w", 0.0))
        if w > 0:
            in_edges[e["to"]].append((e["from"], min(1.0, w)))

    h = {n: 0.0 for n in nodes}
    h_prev = {n: 0.0 for n in nodes}
    h[shock_node] = delta
    distress_round = {shock_node: 0}
    rounds: list[dict] = []

    max_rounds = len(nodes) + 5
    EPS = 1e-6
    t = 0
    while t <= max_rounds:
        dh = {j: h[j] - h_prev[j] for j in nodes}
        if t > 0 and max((abs(x) for x in dh.values()), default=0.0) < EPS:
            break
        h_prev = dict(h)
        newly: list[str] = []
        for i in nodes:
            inc = 0.0
            for (j, w) in in_edges.get(i, ()):
                if j in frozen:       # frozen nodes absorb but don't transmit
                    continue
                dj = dh[j]
                if dj > 0:
                    inc += w * dj
            if inc > 0:
                before = h[i]
                h[i] = min(1.0, h[i] + inc)
                if before == 0.0 and h[i] > 0.0:
                    newly.append(i)
        for n in newly:
            distress_round[n] = t + 1
        rounds.append({"round": t, "newly_distressed": sorted(newly),
                       "transmitted": sorted(j for j in nodes if dh[j] > EPS)})
        if not newly and t > 0:
            break
        t += 1

    lam = _lambda_max(in_edges, nodes, frozen)
    ranking = sorted(((n, h[n]) for n in nodes if h[n] > 0.0), key=lambda x: -x[1])
    ranking_usd = sorted(((n, h[n] * tvl[n]) for n in nodes if h[n] > 0.0 and tvl[n] > 0.0),
                         key=lambda x: -x[1])
    return {
        "h": h, "ranking": ranking, "ranking_usd": ranking_usd,
        "distress_round": distress_round, "rounds": rounds,
        "shock": {"node": shock_node, "delta": delta},
        "lambda_max": lam, "stable": lam < 1.0,
    }
