"""
Focus API — Phase 4: 토큰/주소/tx 통합 검색 + 그래프 포커스 모드.

입력 자동 감지:
  '0x' + 64자 hex  → tx_hash 모드
  '0x' + 40자 hex  → address 모드
  그 외 짧은 문자열 → token 심볼/id 검색

각 모드는 다음을 반환:
  - center_node_ids: 그래프 포커스의 중심 노드들 (frontend highlight 용)
  - related_node_ids: 함께 강조할 인접 노드들 (1-hop)
  - 정적 그래프 메타데이터 (label, type, connected protocols 등)
  - 동적 이벤트 (Phase 3 SQLite 에서 최근 이벤트들)

호출자 (main.py 의 /api/focus*) 는 이 결과를 JSON 으로 반환.
"""

from __future__ import annotations

import re
from typing import Optional

from .graph_data import NODES, EDGES, NODE_POSITIONS
from .module_bridge import merge_module_graph, normalize_id
from ..event_collectors import event_store as _event_store


# ─────────────────────────────────────────────────────────────────
# 통합 그래프 캐시 (모듈 머지 결과)
# ─────────────────────────────────────────────────────────────────

_graph_cache: Optional[dict] = None


def _get_full_graph() -> dict:
    """매번 머지하지 않도록 캐시 (서버 시작 후 1회만 계산)."""
    global _graph_cache
    if _graph_cache is None:
        nodes = [{**n, "position": NODE_POSITIONS.get(n["id"], {"x": 0, "y": 0})} for n in NODES]
        merged_nodes, merged_edges, _ = merge_module_graph(nodes, EDGES, NODE_POSITIONS)
        _graph_cache = {"nodes": merged_nodes, "edges": merged_edges}
    return _graph_cache


def invalidate_graph_cache() -> None:
    global _graph_cache
    _graph_cache = None


# ─────────────────────────────────────────────────────────────────
# 입력 자동 감지
# ─────────────────────────────────────────────────────────────────

_HEX_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_HEX_TX_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


def detect_query_kind(query: str) -> str:
    """
    Returns one of:
      'address'   : 0x... 40자
      'tx'        : 0x... 64자
      'token'     : 그 외 짧은 텍스트 (심볼/id)
      'empty'     : 빈 입력
    """
    if not query:
        return "empty"
    q = query.strip()
    if _HEX_TX_RE.match(q):
        return "tx"
    if _HEX_ADDR_RE.match(q):
        return "address"
    return "token"


# ─────────────────────────────────────────────────────────────────
# 그래프 헬퍼
# ─────────────────────────────────────────────────────────────────

def _find_node(node_id: str) -> Optional[dict]:
    g = _get_full_graph()
    for n in g["nodes"]:
        if n["id"] == node_id:
            return n
    return None


def _neighbors(node_id: str, depth: int = 1) -> tuple[set[str], list[dict]]:
    """BFS depth-first up to `depth`. Returns (visited_ids, edges_along_path)."""
    g = _get_full_graph()
    visited = {node_id}
    frontier = {node_id}
    edges_collected: list[dict] = []
    edges_seen = set()

    for _ in range(depth):
        next_frontier: set[str] = set()
        for e in g["edges"]:
            if e["source"] in frontier or e["target"] in frontier:
                key = e.get("id") or f"{e['source']}->{e['target']}:{e.get('edge_type','')}"
                if key in edges_seen:
                    continue
                edges_seen.add(key)
                edges_collected.append(e)
                if e["source"] in frontier and e["target"] not in visited:
                    next_frontier.add(e["target"])
                if e["target"] in frontier and e["source"] not in visited:
                    next_frontier.add(e["source"])
        visited |= next_frontier
        frontier = next_frontier
        if not frontier:
            break
    return visited, edges_collected


def _find_token_by_query(query: str) -> Optional[dict]:
    """
    심볼 / id / label substring 으로 token 노드 검색.
    매칭 우선순위: 1) 정확 id, 2) 정확 symbol (case-insensitive),
                  3) 부분 label 매치 (token 타입만)
    """
    q = (query or "").lower()
    if not q:
        return None

    g = _get_full_graph()
    tokens = [n for n in g["nodes"] if n.get("type") == "token"]

    # 1) 정확 id
    for n in tokens:
        if n["id"].lower() == q:
            return n
    # 2) 정확 symbol
    for n in tokens:
        sym = (n.get("data") or {}).get("symbol", "")
        if sym and sym.lower() == q:
            return n
    # 3) 부분 label
    for n in tokens:
        if q in n.get("label", "").lower():
            return n
    return None


# ─────────────────────────────────────────────────────────────────
# Focus 핸들러들
# ─────────────────────────────────────────────────────────────────

def focus_address(address: str, event_limit: int = 100) -> dict:
    """
    주소 분석: 정적 그래프에서 노드 찾기 + 동적 이벤트 조회.
    address_book 의 매핑이 있으면 그쪽 id 도 함께 찾음.
    """
    addr_lower = (address or "").lower()
    canonical = normalize_id(addr_lower)

    # 그래프에서 두 가지 id 다 시도
    candidates = {addr_lower, canonical}
    found_node = None
    for cid in candidates:
        node = _find_node(cid)
        if node:
            found_node = node
            break

    # 동적 이벤트는 항상 원래 주소(lower)로 조회
    events = _event_store.get_edges_by_address(addr_lower, limit=event_limit)

    # 이벤트에 등장한 다른 주소들을 related 로
    event_related = set()
    for e in events:
        for endpoint in (e.get("from_address"), e.get("to_address")):
            if endpoint and endpoint != addr_lower:
                event_related.add(endpoint)

    center_ids: list[str] = []
    related_ids: set[str] = set()
    static_neighbors: list[dict] = []

    if found_node:
        center_ids.append(found_node["id"])
        visited, edges = _neighbors(found_node["id"], depth=1)
        related_ids.update(visited - {found_node["id"]})
        static_neighbors = edges

    # 이벤트로 발견된 related 도 가능하면 그래프 노드와 매칭
    for ev_addr in event_related:
        cid = normalize_id(ev_addr)
        if _find_node(cid):
            related_ids.add(cid)

    return {
        "kind": "address",
        "query": address,
        "canonical_id": canonical,
        "graph_node": found_node,
        "center_node_ids": center_ids,
        "related_node_ids": sorted(related_ids),
        "static_neighbor_edges": static_neighbors,
        "recent_events": events,
        "event_count": len(events),
        "event_counterparties": sorted(event_related),
    }


def focus_token(query: str, event_limit: int = 100) -> dict:
    """
    토큰 분석: symbol/id/label 로 토큰 노드 찾기 + 연결된 프로토콜 + 동적 이벤트.
    """
    node = _find_token_by_query(query)
    if node is None:
        return {
            "kind": "token",
            "query": query,
            "graph_node": None,
            "center_node_ids": [],
            "related_node_ids": [],
            "static_neighbor_edges": [],
            "recent_events": [],
            "event_count": 0,
        }

    visited, edges = _neighbors(node["id"], depth=1)
    related = sorted(visited - {node["id"]})

    # 이 토큰 주소(metadata.address 또는 id가 0x...) 로 동적 이벤트 조회
    asset_addr = (node.get("data") or {}).get("address") or (
        node["id"] if node["id"].startswith("0x") else None
    )
    events: list[dict] = []
    if asset_addr:
        events = _event_store.get_edges_by_asset(asset_addr, limit=event_limit)

    # 1-hop 이웃을 종류별로 분류
    g = _get_full_graph()
    node_by_id = {n["id"]: n for n in g["nodes"]}
    by_type: dict[str, list[dict]] = {}
    for rid in related:
        rn = node_by_id.get(rid)
        if rn:
            by_type.setdefault(rn["type"], []).append(
                {"id": rid, "label": rn.get("label"), "category": (rn.get("data") or {}).get("category")}
            )

    return {
        "kind": "token",
        "query": query,
        "graph_node": node,
        "center_node_ids": [node["id"]],
        "related_node_ids": related,
        "related_by_type": by_type,
        "static_neighbor_edges": edges,
        "recent_events": events,
        "event_count": len(events),
        "asset_address": asset_addr,
    }


def focus_tx(tx_hash: str) -> dict:
    """
    트랜잭션 분해: Phase 3 SQLite 에서 같은 tx_hash 의 모든 엣지 조회.
    한 트랜잭션이 여러 엣지를 만드는 경우 모두 표시 (청산 1건 → 3개 등).
    """
    tx_lower = (tx_hash or "").lower()
    if not _HEX_TX_RE.match(tx_lower):
        return {"kind": "tx", "query": tx_hash, "error": "invalid tx hash format"}

    # tx_hash 로 직접 쿼리 (event_store 의 비공개 헬퍼 활용)
    import sqlite3
    conn = sqlite3.connect(str(_event_store._DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT * FROM edges WHERE tx_hash = ? ORDER BY log_index", (tx_lower,)
        ).fetchall()
        edges = [_event_store._row_to_dict(r) for r in rows]
    finally:
        conn.close()

    # 등장한 주소들을 center+related 로
    addresses = set()
    for e in edges:
        addresses.add(e.get("from_address"))
        addresses.add(e.get("to_address"))
    addresses.discard(None)

    # 그래프 노드와 매칭
    matched_ids = []
    for addr in addresses:
        cid = normalize_id(addr)
        if _find_node(cid):
            matched_ids.append(cid)

    return {
        "kind": "tx",
        "query": tx_hash,
        "edges_count": len(edges),
        "edges": edges,
        "involved_addresses": sorted(addresses),
        "center_node_ids": matched_ids,
        "related_node_ids": [],
    }


def auto_focus(query: str) -> dict:
    """입력 자동 감지 후 알맞은 핸들러 호출."""
    kind = detect_query_kind(query)
    if kind == "empty":
        return {"kind": "empty", "query": query}
    if kind == "tx":
        return focus_tx(query)
    if kind == "address":
        return focus_address(query)
    return focus_token(query)
