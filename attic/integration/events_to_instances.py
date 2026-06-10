"""
events_to_instances.py — events.json 의 known_contracts 를 instances.json 의 nodes 로 자동 변환.

새 팀원이 자기 프로토콜의 events.json 만 가져와도, 정적 노드는 손 안 대고 자동 생성됨.
엣지는 구조적 관계라 사람 판단이 필요 → 이 스크립트는 *노드* 만 처리.
(엣지는 instances.json 에 사람이 직접 작성하거나 events.json 의 contracts/relationships 섹션을
 별도로 정의해 확장 가능)

사용:
    python integration/events_to_instances.py modules/lido/events.json modules/lido/instances.json
    python integration/events_to_instances.py modules/morpho/events.json modules/morpho/instances.json

또는 모든 모듈 일괄 변환:
    python integration/events_to_instances.py --all

스크립트가 *기존* instances.json 이 있으면 사람이 추가한 nodes/edges 를 *보존* 하고
events.json 에서 새로 발견한 노드만 추가함 (사람 작업물 덮어쓰기 방지).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
MODULES_DIR = ROOT / "modules"

# events.json 의 "type" (자유 형식) → 본인 표준 어휘 NODE_TYPE_MAP 키로 매핑.
# 매핑이 없으면 vocab_mapper.py 의 휴리스틱이 simulator type 으로 자동 분류해주므로
# 이 dict 는 *최소한* 의 명시 매핑만 — 새 타입이 들어와도 자동 처리됨.
EVENTS_TYPE_TO_VOCAB: dict[str, str] = {
    # Lido events.json 타입들
    "lst_token":       "lst_token",
    "lst_wrapper":     "lst_token",
    "withdrawal_nft":  "withdrawal_nft",
    "burner":          "protocol_admin",
    "treasury":        "treasury",
    "staking_module":  "protocol_admin",
    "operator_reward": "protocol_admin",
    "protocol_contract": "protocol_admin",
    "oracle":          "oracle",
    "bridge":          "bridge",
    "burn_sink":       None,  # 0x000 같은 sink — 노드로 안 만듦
    "eoa":             None,  # 동적, 정적 그래프 제외
    "unknown":         None,
}


def _vocab_type_for(events_type: str) -> str | None:
    """
    events.json 의 type → 본인 표준 어휘 type.
    None 반환 시 노드로 만들지 않음 (sink/eoa/unknown 등).
    명시 매핑 없으면 events_type 을 그대로 반환 (vocab_mapper 휴리스틱이 처리).
    """
    if events_type in EVENTS_TYPE_TO_VOCAB:
        return EVENTS_TYPE_TO_VOCAB[events_type]
    return events_type  # passthrough — 휴리스틱이 잡음


def convert_events_to_nodes(events_data: dict, protocol_name: str) -> list[dict]:
    """events.json 의 known_contracts → instances.json 의 nodes 리스트."""
    nodes: list[dict] = []
    known = events_data.get("known_contracts", {}) or {}
    chain_id = events_data.get("_chain_id", 1)

    for key, contract in known.items():
        if not isinstance(contract, dict):
            continue
        addr = (contract.get("address") or "").lower()
        if not addr or not addr.startswith("0x"):
            continue

        vocab_type = _vocab_type_for(contract.get("type", "unknown"))
        if vocab_type is None:
            continue  # sink/eoa skip

        nodes.append({
            "address": addr,
            "chain_id": chain_id,
            "type": vocab_type,
            "protocol": protocol_name,
            "label": contract.get("label") or key,
            "metadata": {
                "events_type":     contract.get("type"),
                "events_category": contract.get("category"),
                "events_key":      key,
                "auto_generated":  True,
            },
        })

    return nodes


def merge_with_existing(
    auto_nodes: list[dict],
    existing_instances: dict | None,
) -> dict:
    """
    기존 instances.json 의 nodes/static_edges 와 auto 생성 nodes 머지.
    사람이 직접 쓴 노드(같은 주소) 가 있으면 *그쪽이 우선* — auto 는 추가만.
    """
    out_nodes: list[dict] = []
    seen_addrs: set[str] = set()

    if existing_instances:
        for n in existing_instances.get("nodes", []):
            addr = (n.get("address") or "").lower()
            if not addr:
                continue
            out_nodes.append(n)
            seen_addrs.add(addr)

    # auto 노드 추가 (이미 사람이 정의한 주소는 skip)
    added = 0
    for n in auto_nodes:
        if n["address"] in seen_addrs:
            continue
        out_nodes.append(n)
        seen_addrs.add(n["address"])
        added += 1

    out = dict(existing_instances or {})
    out["nodes"] = out_nodes
    if "static_edges" not in out:
        out["static_edges"] = []
    out.setdefault("_protocol", "unknown")
    out.setdefault("_chain_id", 1)
    out["_auto_merge_stats"] = {
        "auto_nodes_added": added,
        "preserved_human_nodes": len(seen_addrs) - added,
        "total_nodes": len(out_nodes),
    }
    return out


def convert_file(events_path: Path, instances_path: Path, protocol_name: str) -> dict:
    """단일 모듈 변환. 기존 instances.json 이 있으면 머지, 없으면 새로 생성."""
    if not events_path.exists():
        raise FileNotFoundError(events_path)

    events_data = json.loads(events_path.read_text(encoding="utf-8"))
    auto_nodes = convert_events_to_nodes(events_data, protocol_name)

    existing = None
    if instances_path.exists():
        try:
            existing = json.loads(instances_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"[WARN] {instances_path} corrupt — 새로 생성")

    merged = merge_with_existing(auto_nodes, existing)
    if "_protocol" not in merged or merged["_protocol"] == "unknown":
        merged["_protocol"] = protocol_name
    if "_description" not in merged:
        merged["_description"] = f"{protocol_name} — events.json 으로부터 자동 생성된 노드 + 사람이 추가한 엣지."
    if "_source" not in merged:
        merged["_source"] = str(events_path.relative_to(ROOT))

    instances_path.write_text(
        json.dumps(merged, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return merged["_auto_merge_stats"]


def main() -> None:
    parser = argparse.ArgumentParser(description="events.json → instances.json 자동 변환")
    parser.add_argument("events", nargs="?", help="events.json 경로")
    parser.add_argument("instances", nargs="?", help="instances.json 경로 (없으면 events 와 같은 폴더)")
    parser.add_argument("--all", action="store_true", help="modules/ 하위 모든 events.json 일괄 변환")
    parser.add_argument("--protocol", help="protocol 이름 (생략 시 폴더명)")
    args = parser.parse_args()

    if args.all:
        any_converted = False
        for mod_dir in sorted(MODULES_DIR.iterdir()):
            if not mod_dir.is_dir():
                continue
            ev = mod_dir / "events.json"
            if not ev.exists():
                continue
            inst = mod_dir / "instances.json"
            stats = convert_file(ev, inst, mod_dir.name)
            print(f"[{mod_dir.name}] +{stats['auto_nodes_added']} auto nodes  "
                  f"({stats['preserved_human_nodes']} preserved, "
                  f"{stats['total_nodes']} total)  → {inst.relative_to(ROOT)}")
            any_converted = True
        if not any_converted:
            print("[INFO] events.json 이 있는 모듈을 못 찾음.")
        return

    if not args.events:
        parser.error("events 경로 필요 (또는 --all)")
    events_path = Path(args.events).resolve()
    instances_path = (
        Path(args.instances).resolve() if args.instances
        else events_path.with_name("instances.json")
    )
    protocol_name = args.protocol or events_path.parent.name
    stats = convert_file(events_path, instances_path, protocol_name)
    print(f"[{protocol_name}] +{stats['auto_nodes_added']} auto nodes  "
          f"({stats['preserved_human_nodes']} preserved, "
          f"{stats['total_nodes']} total)  → {instances_path}")


if __name__ == "__main__":
    main()
