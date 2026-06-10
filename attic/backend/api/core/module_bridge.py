"""
Module Bridge — integration/output/simulator_graph.json 을 읽어서
graph_data.py 의 NODES/EDGES 와 머지.

Phase 2 의 핵심: 본인 Aave 분석 모듈의 노드/엣지를 simulator 그래프에 자동 주입.

주소 id 통일 (shared/address_book.json):
- 본인 모듈은 컨트랙트 주소(0x...) 를 id 로 씀.
- 기존 simulator graph 는 논리 id ('wsteth', 'aave_v3' 등) 를 씀.
- 같은 자산/프로토콜이 두 개의 다른 id 로 들어오는 걸 막기 위해 address_book.json
  매핑을 통과시켜 통일.

좌표:
- 새 노드는 (0, 0) 으로 두고 d3-force 시뮬레이션에 맡김.
- 인접 노드와 자연스럽게 가까이 끌어와짐.
- 원본 graph_data.py 의 NODES/EDGES 는 건드리지 않음.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────
# 경로
# ─────────────────────────────────────────────────────────────────

_HERE = Path(__file__).resolve().parent
PROJECT_ROOT = _HERE.parent.parent.parent  # core → api → backend → new-simulator (repo root)
MODULE_GRAPH_PATH = PROJECT_ROOT / "integration" / "output" / "simulator_graph.json"
ADDRESS_BOOK_PATH = PROJECT_ROOT / "shared" / "address_book.json"


# ─────────────────────────────────────────────────────────────────
# Address Book — id 정규화 매핑
# ─────────────────────────────────────────────────────────────────

_address_to_id_cache: Optional[dict[str, str]] = None
_address_book_validation: dict = {}


def _load_address_to_id() -> dict[str, str]:
    """shared/address_book.json 의 모든 (chain, section) 매핑을 평탄화해서
    lower-case address → 기존 그래프 id 단일 딕셔너리로 반환.

    같은 주소가 두 개의 서로 다른 id 에 매핑되면 경고 (충돌 검출).
    """
    global _address_to_id_cache, _address_book_validation
    if _address_to_id_cache is not None:
        return _address_to_id_cache

    validation: dict = {"loaded": False, "mappings": 0, "conflicts": [], "duplicates_same_id": 0}

    if not ADDRESS_BOOK_PATH.exists():
        logger.warning(f"address_book not found: {ADDRESS_BOOK_PATH}")
        validation["error"] = "file not found"
        _address_to_id_cache = {}
        _address_book_validation = validation
        return _address_to_id_cache

    try:
        data = json.loads(ADDRESS_BOOK_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"Failed to parse address_book: {e}")
        validation["error"] = f"parse error: {e}"
        _address_to_id_cache = {}
        _address_book_validation = validation
        return _address_to_id_cache

    flat: dict[str, str] = {}
    sources: dict[str, str] = {}  # addr → "chain.section" 출처 (디버깅용)
    for chain_key, chain_block in data.items():
        if chain_key.startswith("_") or not isinstance(chain_block, dict):
            continue
        for section_key, section in chain_block.items():
            if section_key.startswith("_") or not isinstance(section, dict):
                continue
            for addr, legacy_id in section.items():
                if not (isinstance(addr, str) and isinstance(legacy_id, str)):
                    continue
                addr_low = addr.lower()
                if addr_low in flat:
                    if flat[addr_low] != legacy_id:
                        validation["conflicts"].append({
                            "address": addr_low,
                            "first_id": flat[addr_low],
                            "first_source": sources.get(addr_low),
                            "second_id": legacy_id,
                            "second_source": f"{chain_key}.{section_key}",
                        })
                        # 첫 번째 정의 유지 (deterministic)
                        continue
                    else:
                        validation["duplicates_same_id"] += 1
                flat[addr_low] = legacy_id
                sources[addr_low] = f"{chain_key}.{section_key}"

    validation["loaded"] = True
    validation["mappings"] = len(flat)

    if validation["conflicts"]:
        logger.warning(
            f"address_book has {len(validation['conflicts'])} conflicting mappings — "
            f"first definition wins. Inspect /api/graph/module-status for details."
        )

    _address_to_id_cache = flat
    _address_book_validation = validation
    logger.info(f"address_book loaded: {len(flat)} mappings, {len(validation['conflicts'])} conflicts")
    return flat


def get_address_book_validation() -> dict:
    """address_book 로딩 검증 결과 (충돌 검출 등). get_module_summary 에서 노출."""
    _load_address_to_id()  # 캐시 채움 보장
    return dict(_address_book_validation)


def normalize_id(addr_or_id: str) -> str:
    """
    주소(또는 논리 id)를 받아 기존 그래프 id 가 있으면 그걸, 없으면 원본을 반환.
    - lower-case 주소가 매핑에 있으면 매핑된 legacy id
    - 그 외엔 lower-case 그대로
    """
    if not addr_or_id:
        return addr_or_id
    key = addr_or_id.lower()
    return _load_address_to_id().get(key, key)


# ─────────────────────────────────────────────────────────────────
# 메인 함수
# ─────────────────────────────────────────────────────────────────

def load_module_graph() -> Optional[dict]:
    """integration/output/simulator_graph.json 로드. 파일 없으면 None."""
    if not MODULE_GRAPH_PATH.exists():
        logger.info(f"module_graph not found: {MODULE_GRAPH_PATH}")
        return None
    try:
        return json.loads(MODULE_GRAPH_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"Failed to load module graph: {e}")
        return None


def _merge_node_metadata(existing: dict, incoming: dict) -> None:
    """기존 노드와 새로 들어온 노드의 metadata 를 머지 (in-place)."""
    existing_data = existing.get("data") or {}
    incoming_data = incoming.get("data") or {}

    merged = dict(existing_data)
    for k, v in incoming_data.items():
        # 기존 값이 비어있을 때만 새 값으로 채움 (legacy 우선)
        if k not in merged or merged[k] in (None, "", []):
            merged[k] = v
        elif k == "description" and v and v not in merged[k]:
            merged[k] = f"{merged[k]} | {v}"

    # 모듈에서 가져온 address/protocol 같은 새 필드는 항상 추가
    for k in ("address", "protocol", "market_id", "symbol"):
        if k in incoming_data and k not in merged:
            merged[k] = incoming_data[k]

    existing["data"] = merged


def _compute_anchor_positions(
    module_nodes: list[dict],
    module_edges: list[dict],
    base_positions: dict[str, dict],
) -> dict[str, dict]:
    """
    각 새 노드의 시작 좌표를 "연결된 기존 노드들의 평균 좌표" 로 계산.

    여러 패스로 점진적 확정:
    - 패스 1: 새 노드 중 기존 노드와 직접 연결된 것 → 그 평균
    - 패스 2~3: 패스 1 에서 위치 잡힌 새 노드도 앵커로 활용
    - 최종 fallback: (0, 0) — d3-force 가 처리

    같은 앵커에 여러 노드 붙으면 랜덤 오프셋 (±100 px) 으로 분산.
    """
    import math
    import random

    # canonical id 집합 (새 노드 후보)
    candidate_ids = {normalize_id(n["id"]) for n in module_nodes}
    new_ids = candidate_ids - set(base_positions.keys())

    # node_id → 인접 node_ids (canonical)
    adjacency: dict[str, set[str]] = {nid: set() for nid in new_ids}
    for e in module_edges:
        src = normalize_id(e["source"])
        tgt = normalize_id(e["target"])
        if src in adjacency:
            adjacency[src].add(tgt)
        if tgt in adjacency:
            adjacency[tgt].add(src)

    # 점진적으로 위치 확정
    positions: dict[str, dict] = {}
    remaining = set(new_ids)

    for _pass in range(4):
        if not remaining:
            break
        # 이번 패스에서 위치를 결정할 수 있는 anchor 집합
        anchor_pool: dict[str, dict] = {**base_positions, **positions}

        progress = False
        for nid in list(remaining):
            anchors = [
                anchor_pool[neighbor]
                for neighbor in adjacency[nid]
                if neighbor in anchor_pool
            ]
            if not anchors:
                continue
            avg_x = sum(p["x"] for p in anchors) / len(anchors)
            avg_y = sum(p["y"] for p in anchors) / len(anchors)
            # 작은 랜덤 오프셋 (deterministic seed for reproducibility)
            rng = random.Random(nid)
            positions[nid] = {
                "x": avg_x + rng.uniform(-90, 90),
                "y": avg_y + rng.uniform(-80, 80),
            }
            remaining.remove(nid)
            progress = True

        if not progress:
            break

    # 마지막 fallback: protocol 기반 클러스터링
    # 같은 protocol 의 다른 새 노드들과 이미 매핑된 기존 protocol 노드 좌표로
    # 묶어서 배치 (예: Aave V3 Main 컴포넌트들 → 기존 aave_v3 노드 근처)
    if remaining:
        def _proto_key(s: str) -> str:
            # 'aave-v3' / 'aave_v3' / 'AaveV3' 같은 변형을 한 키로 통일
            return (s or "").lower().replace("-", "_")

        # node_id → protocol key (정규화)
        node_protocol: dict[str, str] = {}
        for n in module_nodes:
            canonical = normalize_id(n["id"])
            proto = (n.get("data") or {}).get("protocol")
            if proto:
                node_protocol[canonical] = _proto_key(proto)

        anchor_pool = {**base_positions, **positions}

        # protocol → 평균 좌표 (이미 좌표 있는 노드들 + 기존 그래프 same-name 노드)
        protocol_avg: dict[str, dict] = {}
        for proto in set(node_protocol.values()):
            same_proto_positions = [
                anchor_pool[other]
                for other in node_protocol
                if node_protocol[other] == proto and other in anchor_pool
            ]
            # 기존 그래프에 같은 protocol 식별자(예: 'aave_v3')가 노드로 있으면
            # 그 좌표를 anchor 로 추가
            if proto in base_positions:
                same_proto_positions.append(base_positions[proto])
            if same_proto_positions:
                protocol_avg[proto] = {
                    "x": sum(p["x"] for p in same_proto_positions) / len(same_proto_positions),
                    "y": sum(p["y"] for p in same_proto_positions) / len(same_proto_positions),
                }

        for nid in list(remaining):
            proto = node_protocol.get(nid)
            if proto and proto in protocol_avg:
                rng = random.Random(nid)
                positions[nid] = {
                    "x": protocol_avg[proto]["x"] + rng.uniform(-120, 120),
                    "y": protocol_avg[proto]["y"] + rng.uniform(-100, 100),
                }
                remaining.remove(nid)

    # 정말 끝까지 못 찾은 노드는 (0,0) — d3-force fallback
    for nid in remaining:
        positions[nid] = {"x": 0, "y": 0}

    return positions


def merge_module_graph(
    base_nodes: list[dict],
    base_edges: list[dict],
    base_positions: dict[str, dict],
) -> tuple[list[dict], list[dict], dict[str, dict]]:
    """
    base (graph_data.py 의 NODES/EDGES/NODE_POSITIONS) 에 모듈 그래프를 머지.

    중복 처리:
    - 같은 id (address_book 매핑 후) 노드 → 메타데이터만 머지, 새 노드 X
    - 같은 edge_id → skip

    좌표:
    - 새 노드는 연결된 기존 노드의 평균 좌표 + 작은 랜덤 오프셋.
    - 앵커 없으면 (0, 0) — d3-force 가 처리.

    Returns:
        (merged_nodes, merged_edges, merged_positions)
    """
    module = load_module_graph()
    if module is None:
        return list(base_nodes), list(base_edges), dict(base_positions)

    out_nodes = list(base_nodes)
    out_edges = list(base_edges)
    out_positions = dict(base_positions)

    # 기존 노드 인덱스 — id → node ref
    node_by_id: dict[str, dict] = {n["id"]: n for n in out_nodes}
    existing_edge_ids = {e["id"] for e in out_edges}

    # 앵커 좌표 미리 계산 (모든 새 노드에 대해)
    anchor_positions = _compute_anchor_positions(
        module.get("nodes", []),
        module.get("edges", []),
        base_positions,
    )

    added_nodes = 0
    merged_nodes = 0
    added_edges = 0
    skipped_edges = 0

    # ── 노드 처리 ─────────────────────────────────────────────────
    for n in module.get("nodes", []):
        canonical_id = normalize_id(n["id"])
        if canonical_id in node_by_id:
            # 기존 노드와 같음 → 메타데이터만 머지
            _merge_node_metadata(node_by_id[canonical_id], n)
            merged_nodes += 1
        else:
            # 새 노드 — 앵커 좌표로 시작 (없으면 0,0)
            pos = anchor_positions.get(canonical_id, {"x": 0, "y": 0})
            new_node = {**n, "id": canonical_id, "position": pos}
            out_nodes.append(new_node)
            node_by_id[canonical_id] = new_node
            out_positions[canonical_id] = pos
            added_nodes += 1

    # ── 엣지 처리 ─────────────────────────────────────────────────
    for e in module.get("edges", []):
        src = normalize_id(e["source"])
        tgt = normalize_id(e["target"])
        # self-loop 방지 (mint_wrapper aToken → underlying 같은 경우
        # 양쪽이 같은 id 로 정규화되면 의미 없음)
        if src == tgt:
            skipped_edges += 1
            continue
        if src not in node_by_id or tgt not in node_by_id:
            skipped_edges += 1
            continue
        edge_id = e.get("id") or f"{src}->{tgt}:{e.get('edge_type', '')}"
        if edge_id in existing_edge_ids:
            skipped_edges += 1
            continue
        new_edge = {**e, "id": edge_id, "source": src, "target": tgt}
        out_edges.append(new_edge)
        existing_edge_ids.add(edge_id)
        added_edges += 1

    # ── Post-processor: 모든 oracle 노드를 chainlink_provider 로 자동 연결 ──
    # 수동 정의 피드 + CAPO adapter + 자동 발견 피드 무관하게 일관 클러스터링.
    # CAPO adapter (price_adapter) 도 연결 → "간접 의존" 시각화.
    added_oracle_links = _link_oracles_to_provider(out_nodes, out_edges, existing_edge_ids)

    logger.info(
        f"module_bridge: +{added_nodes} new nodes, {merged_nodes} merged into existing, "
        f"+{added_edges} edges (skip {skipped_edges}), +{added_oracle_links} oracle→provider links"
    )
    return out_nodes, out_edges, out_positions


def _link_oracles_to_provider(
    nodes: list[dict],
    edges: list[dict],
    existing_edge_ids: set[str],
) -> int:
    """
    price_feed / price_adapter 타입 노드를 모두 chainlink_provider 로 연결.

    - price_feed (Chainlink ETH/USD 등): 직접 의존
    - price_adapter (CAPO): 간접 의존 (CAPO 가 내부에서 Chainlink 참조)

    chainlink_provider seed 노드가 없으면 skip (graph_data.py 에 정의돼 있어야 함).
    이미 같은 엣지가 있으면 skip.
    """
    PROVIDER = "chainlink_provider"
    node_ids = {n["id"] for n in nodes}
    if PROVIDER not in node_ids:
        return 0

    added = 0
    for n in nodes:
        nid = n.get("id", "")
        if nid == PROVIDER:
            continue
        # 노드 타입 판별 — type 또는 data.category 둘 다 확인
        ntype = n.get("type", "")
        cat = (n.get("data") or {}).get("category", "")
        is_feed = ntype == "oracle" and (
            cat in ("price_feed", "price_adapter", "oracle_provider") or "chainlink" in nid.lower()
        )
        # oracle 노드 중 provider 자신 제외, 이미 provider 로 가는 엣지 없는 것만
        if not is_feed:
            continue
        # oracle_provider 카테고리(=provider 자신 같은 메타노드)는 skip
        if cat == "oracle_provider":
            continue
        edge_id = f"oracle-link:{nid[:16]}->provider"
        if edge_id in existing_edge_ids:
            continue
        # 이미 이 노드 → provider 엣지가 (다른 id 로) 있으면 skip
        if any(e["source"] == nid and e["target"] == PROVIDER for e in edges):
            continue
        # CAPO adapter 면 간접 의존, 일반 feed 면 직접
        layer = "capo_indirect" if cat == "price_adapter" else "feed_to_provider"
        edges.append({
            "id": edge_id,
            "source": nid,
            "target": PROVIDER,
            "label": "오라클 의존",
            "edge_type": "oracle",
            "metadata": {"layer": layer, "auto_linked": True},
        })
        existing_edge_ids.add(edge_id)
        added += 1
    return added


def refresh_module_graph() -> dict:
    """
    integration/module_loader 호출 → modules/*/instances.json 재로드 →
    integration/output/simulator_graph.json 갱신 + 본 모듈의 캐시 비움.

    백엔드 startup 또는 /api/focus/cache/invalidate 호출 시 자동 실행됨.
    새 팀원 모듈 JSON 추가 시 백엔드 재시작 없이도 반영 가능.
    """
    global _address_to_id_cache
    import sys
    sys.path.insert(0, str(PROJECT_ROOT))
    try:
        # integration 패키지 import (PROJECT_ROOT 가 sys.path 에 들어있음)
        from integration import module_loader  # type: ignore
        combined = module_loader.load_combined_graph()
        module_loader.save_combined_graph(combined)
        sim_path = module_loader.export_simulator_graph()

        # 캐시 무효화 (다음 /api/graph 호출 시 새 데이터 로드)
        _address_to_id_cache = None  # address_book 도 다시 읽음

        return {
            "ok": True,
            "modules": module_loader.ACTIVE_MODULES,
            "node_count": combined["metadata"]["node_count"],
            "edge_count": combined["metadata"]["edge_count"],
            "simulator_graph_path": str(sim_path),
        }
    except Exception as e:
        logger.warning(f"refresh_module_graph failed: {e}")
        return {"ok": False, "error": str(e)}


def get_module_summary() -> dict:
    """디버깅용 요약 정보."""
    module = load_module_graph()
    addr_map = _load_address_to_id()
    validation = get_address_book_validation()
    base = {
        "address_book_path": str(ADDRESS_BOOK_PATH),
        "address_book_mappings": len(addr_map),
        "address_book_validation": validation,
    }
    if module is None:
        return {**base, "loaded": False, "path": str(MODULE_GRAPH_PATH)}

    # 머지 시뮬레이션
    sample_mapped = []
    for n in module.get("nodes", [])[:5]:
        nid = n["id"]
        canonical = normalize_id(nid)
        sample_mapped.append({
            "original": nid[:42] + ("..." if len(nid) > 42 else ""),
            "canonical": canonical,
            "merged_with_existing": canonical != nid.lower(),
        })

    return {
        **base,
        "loaded": True,
        "path": str(MODULE_GRAPH_PATH),
        "nodes": len(module.get("nodes", [])),
        "edges": len(module.get("edges", [])),
        "metadata": module.get("metadata", {}),
        "sample_id_normalization": sample_mapped,
    }
