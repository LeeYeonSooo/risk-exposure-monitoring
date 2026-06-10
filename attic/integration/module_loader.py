"""
Module Loader — 5개 프로토콜 모듈 JSON을 읽어서 simulator 형식으로 통합.

흐름:
1. modules/{protocol}/instances.json 에서 실제 노드/엣지 인스턴스 로드
2. 주소 소문자 정규화
3. 같은 주소 중복 노드 머지 (예: wstETH가 aave + lido 양쪽에 등장)
4. vocab_mapper.py 로 simulator 형식 변환
5. integration/output/combined_graph.json 출력

사용:
    python integration/module_loader.py
또는 import:
    from integration.module_loader import load_combined_graph
    graph = load_combined_graph()
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TypedDict

# Make vocab_mapper importable both as script (`python module_loader.py`)
# and as a package member (`from integration.module_loader import ...`).
_THIS_DIR = Path(__file__).parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from vocab_mapper import map_to_simulator, get_auto_mapping_report  # noqa: E402


# ─────────────────────────────────────────────────────────────────
# 경로 상수
# ─────────────────────────────────────────────────────────────────

ROOT = _THIS_DIR.parent
MODULES_DIR = ROOT / "modules"
OUTPUT_DIR = _THIS_DIR / "output"

# 현재 활성화된 모듈 (instances.json 이 채워진 것만)
ACTIVE_MODULES = ["aave", "lido", "morpho", "sky", "pendle"]


class CombinedGraph(TypedDict):
    nodes: list[dict]
    edges: list[dict]
    metadata: dict


# ─────────────────────────────────────────────────────────────────
# 단계 1: 모듈 로드 + 정규화
# ─────────────────────────────────────────────────────────────────

def _normalize_address(addr: str | None) -> str | None:
    """주소를 소문자로 통일. 논리 ID(0x로 시작 안 함)는 그대로."""
    if not addr:
        return addr
    return addr.lower() if addr.startswith("0x") else addr


def _normalize_node(node: dict) -> dict:
    """노드의 주소 필드들을 소문자 통일."""
    out = dict(node)
    out["address"] = _normalize_address(out["address"])
    md = dict(out.get("metadata") or {})
    for key in ("underlying", "for_asset"):
        if key in md and isinstance(md[key], str):
            md[key] = _normalize_address(md[key])
    out["metadata"] = md
    return out


def _normalize_edge(edge: dict) -> dict:
    """엣지의 from/to/asset 을 소문자 통일."""
    out = dict(edge)
    out["from"] = _normalize_address(out["from"])
    out["to"] = _normalize_address(out["to"])
    if out.get("asset"):
        out["asset"] = _normalize_address(out["asset"])
    return out


def load_module_instances(protocol: str) -> tuple[list[dict], list[dict]]:
    """
    modules/{protocol}/instances.json 에서 노드/엣지 인스턴스 로드.

    Returns:
        (nodes, edges) — 정규화된 dict 리스트
    """
    instances_path = MODULES_DIR / protocol / "instances.json"
    if not instances_path.exists():
        print(f"[WARN] {instances_path} not found — skipping {protocol}")
        return [], []

    data = json.loads(instances_path.read_text(encoding="utf-8"))
    raw_nodes = data.get("nodes", []) or []
    raw_edges = data.get("static_edges", []) or []

    nodes = [_normalize_node(n) for n in raw_nodes]
    edges = [_normalize_edge(e) for e in raw_edges]
    return nodes, edges


# ─────────────────────────────────────────────────────────────────
# 단계 2: 중복 노드 머지
# ─────────────────────────────────────────────────────────────────

def merge_duplicate_nodes(nodes: list[dict]) -> list[dict]:
    """
    같은 주소 노드를 하나로 머지. metadata 는 union.

    Label 우선순위:
    1. 사람이 작성한 모듈 노드 (metadata.discovered != true) > 자동 발견 노드
    2. 같은 카테고리 내에서는 더 자세한 label 유지

    이렇게 해야 RPC 자동 발견 노드가 사람이 깔끔하게 쓴 'WETH', 'USDC' 같은
    label 을 'asset 0xc02a...' 같은 placeholder 로 덮어쓰는 일을 방지.
    """
    by_addr: dict[str, dict] = {}
    for n in nodes:
        addr = n["address"]
        if addr not in by_addr:
            by_addr[addr] = n
            continue
        existing = by_addr[addr]

        # 출처 판정 — metadata 머지 전에 평가해야 정확함
        # (머지 후 평가하면 둘 다 discovered=True 가 되어 구별 불가)
        existing_discovered = bool((existing.get("metadata") or {}).get("discovered"))
        incoming_discovered = bool((n.get("metadata") or {}).get("discovered"))

        # metadata union (later wins for scalar keys)
        merged_md = {**(existing.get("metadata") or {}), **(n.get("metadata") or {})}
        existing["metadata"] = merged_md

        if existing_discovered and not incoming_discovered:
            # 사람이 쓴 label 이 들어옴 — 덮어쓰기
            existing["label"] = n.get("label", existing.get("label", ""))
            # type 도 사람이 쓴 게 우선 (예: underlying_asset 으로 specific 분류)
            if n.get("type") and n.get("type") != existing.get("type"):
                existing["type"] = n["type"]
            if n.get("protocol") and n.get("protocol") != "external":
                existing["protocol"] = n["protocol"]
        elif not existing_discovered and incoming_discovered:
            # 자동 발견은 사람 label 못 덮어씀 — pass
            pass
        else:
            # 둘 다 같은 출처 — 더 자세한 (긴) label 유지
            if len(n.get("label", "")) > len(existing.get("label", "")):
                existing["label"] = n["label"]

    return list(by_addr.values())


# ─────────────────────────────────────────────────────────────────
# 공개 API
# ─────────────────────────────────────────────────────────────────

def load_discovered_data() -> tuple[list[dict], list[dict]]:
    """
    선택적 자동 발견 결과 로드.

    `integration/output/` 의 다음 패턴 파일을 모두 읽어 머지:
      - discovered_nodes_edges.json  (Aave V3 RPC discovery)
      - discovered_morpho.json       (Morpho Blue GraphQL discovery)
      - discovered_*.json            (향후 추가될 다른 프로토콜)

    각 파일은 백엔드의 `/api/discovery/<proto>/run` 호출로 생성됨.
    """
    nodes: list[dict] = []
    edges: list[dict] = []

    # 옛 단일 파일 + 새 *_morpho.json 등 모두 글롭
    patterns = ["discovered_nodes_edges.json", "discovered_*.json"]
    seen_paths: set[Path] = set()
    for pat in patterns:
        for p in OUTPUT_DIR.glob(pat):
            if p in seen_paths or not p.exists():
                continue
            seen_paths.add(p)
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                nodes.extend(_normalize_node(n) for n in data.get("nodes", []))
                edges.extend(_normalize_edge(e) for e in data.get("edges", []))
            except Exception as e:
                print(f"[WARN] failed to load {p.name}: {e}")
    return nodes, edges


def load_combined_graph() -> CombinedGraph:
    """활성 모듈 모두 읽어서 통합 그래프 반환 (표준 어휘 기준)."""
    all_nodes: list[dict] = []
    all_edges: list[dict] = []

    for protocol in ACTIVE_MODULES:
        nodes, edges = load_module_instances(protocol)
        all_nodes.extend(nodes)
        all_edges.extend(edges)

    # On-chain discovered data 머지 (선택, 없으면 skip)
    disc_nodes, disc_edges = load_discovered_data()
    all_nodes.extend(disc_nodes)
    all_edges.extend(disc_edges)

    all_nodes = merge_duplicate_nodes(all_nodes)

    return CombinedGraph(
        nodes=all_nodes,
        edges=all_edges,
        metadata={
            "active_modules": ACTIVE_MODULES,
            "node_count": len(all_nodes),
            "edge_count": len(all_edges),
            "discovered_nodes": len(disc_nodes),
            "discovered_edges": len(disc_edges),
        },
    )


def save_combined_graph(graph: CombinedGraph, path: Path | None = None) -> Path:
    path = path or (OUTPUT_DIR / "combined_graph.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(graph, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def export_simulator_graph(path: Path | None = None) -> Path:
    """본인 어휘 그래프 → simulator 형식 변환 후 저장."""
    combined = load_combined_graph()
    simulator_graph = map_to_simulator(combined)
    simulator_graph["metadata"] = combined["metadata"]

    path = path or (OUTPUT_DIR / "simulator_graph.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(simulator_graph, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


# ─────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Loading modules: {ACTIVE_MODULES}")
    combined = load_combined_graph()
    combined_path = save_combined_graph(combined)
    print(f"  combined  → {combined_path.relative_to(ROOT)}")
    print(f"            nodes: {len(combined['nodes'])}, edges: {len(combined['edges'])}")

    sim_path = export_simulator_graph()
    sim = json.loads(sim_path.read_text())
    print(f"  simulator → {sim_path.relative_to(ROOT)}")
    print(f"            nodes: {len(sim['nodes'])}, edges: {len(sim['edges'])}")

    # 자동 매핑된 타입 리포트 — 사람이 검토 후 명시 매핑으로 승격할 후보
    report = get_auto_mapping_report()
    report_path = OUTPUT_DIR / "auto_mapping_report.json"
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"  report    → {report_path.relative_to(ROOT)}")

    if report["summary"]["auto_mapped_node_types"] or report["summary"]["auto_mapped_edge_types"]:
        print("\n[auto-mapped types] 명시 매핑 없어 휴리스틱으로 자동 분류됨:")
        if report["nodes"]:
            print("  nodes:")
            for k, v in sorted(report["nodes"].items()):
                print(f"    '{k}' → {v}")
        if report["edges"]:
            print("  edges:")
            for k, v in sorted(report["edges"].items()):
                print(f"    '{k}' → {v}")
        print("  ※ 검토 후 vocab_mapper.NODE_TYPE_MAP / EDGE_TYPE_MAP_STATIC 에 추가하면 명시 매핑으로 승격됨.")
    else:
        print("\n[auto-mapped types] 모두 명시 매핑됨 — 자동 분류 없음")


if __name__ == "__main__":
    main()
