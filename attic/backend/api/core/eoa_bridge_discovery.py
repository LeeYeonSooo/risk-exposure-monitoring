"""
eoa_bridge_discovery.py — 고래(EOA) 행동 기반 cross-protocol 의존성 발견.

문제: 프로토콜 간 자본은 직접 transfer 안 됨 — 항상 고래 EOA 가 중간에 낌.
      Aave Pool → 고래 EOA → Morpho Blue
해법: event_store 의 프로토콜별 EOA 활동을 join 해서 cross-protocol 다리(bridge) 탐지.

3-tier 신뢰도 모델 (기존 구조적 엣지는 지우지 않고 등급만 부여):
  - potential : 공유 토큰만 (기존 구조적 엣지 — 본 모듈 밖)
  - latent    : 같은 고래가 양쪽 프로토콜에 포지션 (co-presence)
  - realized  : 고래가 실제 자본 이동 A→B (temporal flow)

edge weight (DebtRank 가중치 후보):
  latent   = 공유 고래 수
  realized = 실측 이동 자본량 (USD 근사) + 이동 횟수

mock 데이터 (rate-limit fallback) 는 제외 — 가짜 bridge 방지.
출력: integration/output/discovered_eoa_bridges.json → module_loader 자동 머지.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent.parent
# NB: ROOT already resolves to the new-simulator repo root (core→api→backend→new-simulator),
# so the db lives at <ROOT>/backend/data/events.db. (Was doubled "new-simulator" → not found.)
EVENTS_DB = ROOT / "backend" / "data" / "events.db"
COMBINED_GRAPH = ROOT / "integration" / "output" / "combined_graph.json"

ZERO = "0x0000000000000000000000000000000000000000"

# 각 프로토콜의 그래프상 anchor 노드 (bridge 엣지의 끝점)
PROTOCOL_ANCHORS = {
    "aave-v3": "aave_v3",
    "morpho": "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
    "lido": "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    "sky": "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
    "pendle": "0x888888888889758f76e7103c6cbf23abbf58f946",
}

# active-flow 판정 시간 window (초) — 인출 후 이 시간 내 재예치면 realized
FLOW_WINDOW_SEC = 7 * 24 * 3600  # 7일

# 의미 있는 고래 최소 자본 (amount_decimal 기준, token 단위 근사)
MIN_WHALE_AMOUNT = 1.0


def _load_known_contracts() -> set[str]:
    if not COMBINED_GRAPH.exists():
        return set()
    g = json.loads(COMBINED_GRAPH.read_text(encoding="utf-8"))
    return {n["address"].lower() for n in g.get("nodes", []) if n["address"].startswith("0x")}


def discover_eoa_bridges() -> dict:
    """
    event_store 의 EOA 활동을 join → cross-protocol bridge 발견.
    """
    started = time.time()
    out: dict = {"discovered_at": started, "bridges": [], "error": None}

    if not EVENTS_DB.exists():
        out["error"] = "events.db not found"
        return out

    contracts = _load_known_contracts()

    conn = sqlite3.connect(str(EVENTS_DB))
    conn.row_factory = sqlite3.Row
    # mock 제외 (edge_id 에 'mock' 포함된 것)
    rows = conn.execute(
        "SELECT protocol, edge_type, from_address, to_address, amount_decimal, "
        "timestamp, block_number, edge_id FROM edges WHERE edge_id NOT LIKE '%mock%'"
    ).fetchall()
    conn.close()

    # eoa → protocol → list of activity {ts, dir, amount}
    # dir: 'in' = EOA → protocol (예치), 'out' = protocol → EOA (인출)
    eoa_activity: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))

    def is_eoa(a: str) -> bool:
        a = (a or "").lower()
        return (a.startswith("0x") and a not in contracts
                and a != ZERO and a != "external")

    for r in rows:
        proto = r["protocol"]
        frm = (r["from_address"] or "").lower()
        to = (r["to_address"] or "").lower()
        ts = r["timestamp"] or (r["block_number"] or 0) * 12  # ts 없으면 block 근사
        amt = r["amount_decimal"] or 0.0

        if is_eoa(frm) and not is_eoa(to):
            # EOA → 프로토콜 (예치/공급)
            eoa_activity[frm][proto].append({"ts": ts, "dir": "in", "amount": amt})
        elif is_eoa(to) and not is_eoa(frm):
            # 프로토콜 → EOA (인출/차입)
            eoa_activity[to][proto].append({"ts": ts, "dir": "out", "amount": amt})

    # 프로토콜 쌍별 집계
    # pair → {latent_whales: set, realized_flows: int, realized_amount: float}
    pair_stats: dict[tuple, dict] = defaultdict(
        lambda: {"latent_whales": set(), "realized_flows": 0, "realized_amount": 0.0}
    )

    for eoa, protos in eoa_activity.items():
        active = [p for p in protos if p in PROTOCOL_ANCHORS]
        if len(active) < 2:
            continue
        # 이 고래가 의미있는 규모인지 (어느 프로토콜에서든 MIN_WHALE 이상)
        max_amt = max((a["amount"] for p in active for a in protos[p]), default=0)
        if max_amt < MIN_WHALE_AMOUNT:
            continue

        active.sort()
        for i in range(len(active)):
            for j in range(i + 1, len(active)):
                pa, pb = active[i], active[j]
                key = (pa, pb)
                pair_stats[key]["latent_whales"].add(eoa)

                # active-flow: pa 에서 out → pb 에 in (window 내), 또는 반대
                outs_a = [a for a in protos[pa] if a["dir"] == "out"]
                ins_b = [a for a in protos[pb] if a["dir"] == "in"]
                outs_b = [a for a in protos[pb] if a["dir"] == "out"]
                ins_a = [a for a in protos[pa] if a["dir"] == "in"]
                for o in outs_a:
                    for n in ins_b:
                        if 0 <= n["ts"] - o["ts"] <= FLOW_WINDOW_SEC:
                            pair_stats[key]["realized_flows"] += 1
                            pair_stats[key]["realized_amount"] += min(o["amount"], n["amount"])
                for o in outs_b:
                    for n in ins_a:
                        if 0 <= n["ts"] - o["ts"] <= FLOW_WINDOW_SEC:
                            pair_stats[key]["realized_flows"] += 1
                            pair_stats[key]["realized_amount"] += min(o["amount"], n["amount"])

    for (pa, pb), st in pair_stats.items():
        out["bridges"].append({
            "protocol_a": pa, "protocol_b": pb,
            "shared_whales": len(st["latent_whales"]),
            "realized_flows": st["realized_flows"],
            "realized_amount": round(st["realized_amount"], 2),
            "tier": "realized" if st["realized_flows"] > 0 else "latent",
        })

    out["bridges_count"] = len(out["bridges"])
    out["total_real_edges_scanned"] = len(rows)
    return out


def discovery_to_module_nodes(discovery: dict) -> list[dict]:
    """bridge 는 기존 anchor 노드 사이 엣지 — 새 노드 없음."""
    return []


def discovery_to_module_edges(discovery: dict) -> list[dict]:
    edges: list[dict] = []
    for b in discovery.get("bridges", []):
        a = PROTOCOL_ANCHORS.get(b["protocol_a"])
        bb = PROTOCOL_ANCHORS.get(b["protocol_b"])
        if not a or not bb or a == bb:
            continue
        tier = b["tier"]
        edges.append({
            "edge_id": f"eoa-bridge:{b['protocol_a']}<->{b['protocol_b']}",
            # realized = contagion (강한 전파 경로), latent = protocol (약한 관계)
            "edge_type": "contagion" if tier == "realized" else "protocol",
            "from": a, "to": bb,
            "protocol": "cross-protocol", "chain_id": 1,
            "metadata": {
                "discovered": True,
                "layer": "eoa_bridge",
                "tier": tier,
                "shared_whales": b["shared_whales"],
                "realized_flows": b["realized_flows"],
                "realized_amount": b["realized_amount"],
                "weight_hint": b["realized_amount"] if tier == "realized" else b["shared_whales"],
            },
        })
    return edges
