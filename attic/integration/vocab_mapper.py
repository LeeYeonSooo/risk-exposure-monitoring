"""
Vocab Mapper — 본인 어휘 (31 노드 / 34 엣지) ↔ simulator 어휘 (5 노드 / 9 엣지)

기존 simulator (new-simulator/backend/api/core/graph_data.py) 는
다음 어휘만 인식:
  노드 type: chain, token, protocol, bridge, oracle
  엣지 edge_type: collateral, contagion, dex, yield, issued_by,
                  restaked, oracle, protocol, exploit, deploy
"""

from __future__ import annotations

from typing import Literal

SimulatorNodeType = Literal["chain", "token", "protocol", "bridge", "oracle"]
SimulatorEdgeType = Literal[
    "collateral", "contagion", "dex", "yield",
    "issued_by", "restaked", "oracle", "protocol", "exploit", "deploy",
]


# ─────────────────────────────────────────────────────────────────
# 노드 타입 매핑
# ─────────────────────────────────────────────────────────────────

# 명시 매핑은 *휴리스틱이 잘못 분류하는 케이스만* 남김. 일반 매핑은 휴리스틱이 처리.
# (이전에는 28개의 trivial 매핑이 있었음 — lst_token→token 같은 휴리스틱과 동일한 것들. 모두 제거.)
NODE_TYPE_MAP: dict[str, SimulatorNodeType] = {
    # 휴리스틱이 'token' 으로 잘못 분류할 수 있는 (stable_module/withdrawal_nft 등)
    "withdrawal_nft":       "token",    # 'nft' 키워드가 휴리스틱에 없어서 명시
    "stability_module":     "protocol", # 'stable' 이 token 휴리스틱에 걸리는 걸 막음
    "safety_module":        "protocol", # 'module' 매칭 전에 의도 명시
    # underlying_asset / a_token / variable_debt_token / lst_token / lrt_token / pt_token /
    # yt_token / sy_token / stable_token / governance_token / staked_governance — 휴리스틱이 'token' 으로 잘 분류
    # market_registry / protocol_pool / protocol_admin / access_control / treasury / vault —
    # 휴리스틱이 'protocol' 로 잘 분류
    # oracle / price_feed / price_adapter / lido_oracle / beacon_chain_oracle —
    # 휴리스틱이 'oracle' 로 잘 분류
}


# ─────────────────────────────────────────────────────────────────
# 엣지 타입 매핑
# ─────────────────────────────────────────────────────────────────

# 정적 그래프에 들어가는 엣지 (구조적 의존성). 휴리스틱과 다른 케이스만 명시.
EDGE_TYPE_MAP_STATIC: dict[str, SimulatorEdgeType] = {
    "price_dependency":     "oracle",        # 휴리스틱 'price' 매칭 — 명시로 더 안전
    "withdrawal_request":   "issued_by",     # 'request' 가 issued_by 휴리스틱에 있음. 명시로 보장
    "withdrawal_claim":     "issued_by",
    # 나머지 (credit_delegation/position_delegation/delegation/vault_allocation/
    # mint_wrapper/burn_wrapper/restake/withdraw_restake/split/merge/cdp_mint/cdp_burn) —
    # 모두 휴리스틱이 정확히 같은 결과로 분류함. 중복이라 제거.
}

# 동적/이벤트 기반 엣지 — 정적 그래프엔 안 들어감, Phase 3 동적 레이어에서 처리
EDGE_TYPE_DYNAMIC = {
    "supply", "withdraw", "borrow", "repay", "atoken_transfer",
    "flashloan", "treasury_accrual", "swap",
    "gsm_swap", "psm_swap",
    "supply_on_behalf", "debt_to", "debt_reduced_for",
    "liquidation", "repay_via_liquidation", "collateral_seized",
    "gho_facilitator_mint", "gho_facilitator_burn",
    "safety_module_stake", "safety_module_slash",
}


# ─────────────────────────────────────────────────────────────────
# 자동 분류 (Heuristic Fallback)
# ─────────────────────────────────────────────────────────────────
# 명시 매핑(NODE_TYPE_MAP / EDGE_TYPE_MAP_STATIC) 에 없는 *새* 타입을
# 이름 substring 으로 추론해 simulator vocab 에 자동 분류.
# 새 모듈이 자기 어휘를 들고 와도 사람 개입 없이 그래프에 들어감.

# 노드: substring → simulator type (앞쪽일수록 우선)
_NODE_HEURISTICS: tuple[tuple[tuple[str, ...], SimulatorNodeType], ...] = (
    # 오라클/피드 계열 먼저 (oracle_token 같은 경우 token 보다 oracle 이 더 명확)
    (("oracle", "feed", "price_adapter", "capo", "beacon"), "oracle"),
    # 체인/L2
    (("chain", "rollup", "_l1", "_l2"), "chain"),
    # 브리지
    (("bridge", "ccip", "lz_", "wormhole"), "bridge"),
    # 토큰 계열 — _token / _asset / share / stable / lst/lrt/sy/pt/yt
    (("_token", "token_", "asset", "stable", "share",
      "lst", "lrt", "_pt", "_yt", "_sy", "wrapper"), "token"),
    # 프로토콜 인프라 — pool/vault/registry/admin/treasury/burner/...
    (("pool", "vault", "registry", "admin", "treasury", "burner",
      "facilitator", "module", "access", "controller", "router",
      "factory", "adapter", "gateway"), "protocol"),
)

# 엣지: substring → simulator edge type
_EDGE_HEURISTICS: tuple[tuple[tuple[str, ...], SimulatorEdgeType], ...] = (
    (("price", "oracle", "feed"), "oracle"),
    (("exploit", "hack", "vuln"), "exploit"),
    (("deploy",), "deploy"),
    (("restake", "stake_"), "restaked"),
    (("collateral", "supply", "deposit"), "collateral"),
    (("dex", "swap", "amm", "pool_"), "dex"),
    (("yield", "interest", "rate", "split", "merge", "_pt", "_yt"), "yield"),
    (("mint", "burn", "wrap", "issued", "claim", "request",
      "cdp", "psm", "gsm"), "issued_by"),
    (("delegation", "delegate", "permission", "auth", "approve",
      "allocation", "vault_alloc", "config"), "protocol"),
    (("contagion", "cascade"), "contagion"),
)

# 자동 분류 통계 — 사람이 나중에 명시 매핑으로 승격할 후보 목록
_AUTO_MAPPED_NODE_TYPES: dict[str, SimulatorNodeType] = {}
_AUTO_MAPPED_EDGE_TYPES: dict[str, SimulatorEdgeType] = {}


def _heuristic_node_type(my_type: str) -> SimulatorNodeType:
    """이름에서 simulator node type 추론. 못 찾으면 'protocol' (가장 안전한 기본값)."""
    t = (my_type or "").lower()
    for keywords, sim_type in _NODE_HEURISTICS:
        if any(k in t for k in keywords):
            return sim_type
    return "protocol"  # 안전한 기본값 — 컨트랙트 인프라로 가정


def _heuristic_edge_type(my_type: str) -> SimulatorEdgeType:
    """이름에서 simulator edge type 추론. 못 찾으면 'protocol'."""
    t = (my_type or "").lower()
    for keywords, sim_etype in _EDGE_HEURISTICS:
        if any(k in t for k in keywords):
            return sim_etype
    return "protocol"


def get_auto_mapping_report() -> dict:
    """자동 분류된 타입 목록 반환. 사람이 명시 매핑으로 승격할 후보."""
    return {
        "nodes": dict(_AUTO_MAPPED_NODE_TYPES),
        "edges": dict(_AUTO_MAPPED_EDGE_TYPES),
        "summary": {
            "auto_mapped_node_types": len(_AUTO_MAPPED_NODE_TYPES),
            "auto_mapped_edge_types": len(_AUTO_MAPPED_EDGE_TYPES),
        },
    }


# ─────────────────────────────────────────────────────────────────
# Korean labels (simulator 가 한국어 라벨 사용)
# ─────────────────────────────────────────────────────────────────

SIM_EDGE_LABEL_KR: dict[SimulatorEdgeType, str] = {
    "collateral": "담보",
    "contagion":  "전염",
    "dex":        "DEX 유동성",
    "yield":      "Yield",
    "issued_by":  "발행",
    "restaked":   "리스테이킹",
    "oracle":     "오라클 의존",
    "protocol":   "프로토콜 관계",
    "exploit":    "해킹 경로",
    "deploy":     "배포",
}


# ─────────────────────────────────────────────────────────────────
# 변환 함수
# ─────────────────────────────────────────────────────────────────

def node_type_to_simulator(my_type: str) -> SimulatorNodeType | None:
    """
    단일 노드 타입 변환.

    우선순위:
    1) NODE_TYPE_MAP 명시 매핑 (사람이 검증한 정확한 매핑)
    2) 이름 substring 휴리스틱 (자동 분류, '_AUTO_MAPPED_NODE_TYPES' 에 기록)
    3) 'protocol' fallback (drop 안 함 — 그래프에 항상 들어감)

    None 을 반환하지 않음 → 새 모듈이 자기 어휘를 들고 와도 침묵 drop 없음.
    """
    explicit = NODE_TYPE_MAP.get(my_type)
    if explicit is not None:
        return explicit
    inferred = _heuristic_node_type(my_type)
    if my_type:
        _AUTO_MAPPED_NODE_TYPES[my_type] = inferred
    return inferred


def edge_type_to_simulator(my_type: str) -> SimulatorEdgeType | None:
    """
    단일 엣지 타입 변환.

    동적 엣지 (EDGE_TYPE_DYNAMIC) 만 None 으로 정적 그래프 제외.
    그 외엔 명시 → 휴리스틱 → 'protocol' fallback 순.
    """
    if my_type in EDGE_TYPE_DYNAMIC:
        return None
    explicit = EDGE_TYPE_MAP_STATIC.get(my_type)
    if explicit is not None:
        return explicit
    inferred = _heuristic_edge_type(my_type)
    if my_type:
        _AUTO_MAPPED_EDGE_TYPES[my_type] = inferred
    return inferred


def map_to_simulator(combined: dict) -> dict:
    """
    본인 어휘로 정규화된 그래프 → simulator graph_data 형식.

    simulator NODES 형식:
        {"id": "...", "type": "...", "label": "...",
         "data": {"description": "...", "category": "...", ...}}

    simulator EDGES 형식:
        {"id": "...", "source": "...", "target": "...",
         "label": "...", "edge_type": "..."}
    """
    sim_nodes: list[dict] = []
    sim_edges: list[dict] = []

    # 노드 변환
    for n in combined.get("nodes", []):
        sim_type = node_type_to_simulator(n.get("type", ""))
        if sim_type is None:
            continue  # 동적 노드(user, bot 등)는 정적 그래프 제외

        md = dict(n.get("metadata") or {})
        sim_nodes.append({
            "id": n["address"],
            "type": sim_type,
            "label": n.get("label") or n["address"][:10],
            "data": {
                "description": _make_description(n),
                "category": n.get("type"),           # 원래 타입을 카테고리로 보존
                "protocol": n.get("protocol"),
                "symbol": md.get("symbol"),
                "market_id": n.get("market_id"),
                **{k: v for k, v in md.items()
                   if k not in ("symbol",) and not isinstance(v, (dict, list))},
            },
        })

    # 엣지 변환
    for e in combined.get("edges", []):
        etype = e.get("edge_type", "")
        if etype in EDGE_TYPE_DYNAMIC:
            continue  # 동적 엣지 skip

        sim_etype = edge_type_to_simulator(etype)
        if sim_etype is None:
            continue

        md = e.get("metadata") or {}
        sim_edge = {
            "id": e.get("edge_id") or f"{e['from']}->{e['to']}:{etype}",
            "source": e["from"],
            "target": e["to"],
            "label": SIM_EDGE_LABEL_KR.get(sim_etype, sim_etype),
            "edge_type": sim_etype,
        }
        # cross-protocol bridge 메타 보존 (UI tier 시각화용)
        layer = md.get("layer", "")
        if layer in ("position_copresence", "eoa_bridge", "cross_protocol_flow") or md.get("tier"):
            sim_edge["tier"] = md.get("tier", "potential")
            sim_edge["bridge"] = True
            if md.get("shared_whales") is not None:
                sim_edge["shared_whales"] = md["shared_whales"]
            if md.get("realized_amount") is not None:
                sim_edge["realized_amount"] = md["realized_amount"]
            if md.get("combined_usd") is not None:
                sim_edge["combined_usd"] = md["combined_usd"]
        sim_edges.append(sim_edge)

    return {"nodes": sim_nodes, "edges": sim_edges}


def _make_description(node: dict) -> str:
    """노드 설명 자동 생성."""
    role = (node.get("metadata") or {}).get("role")
    label = node.get("label", "")
    protocol = node.get("protocol") or ""
    parts = [f"[{node.get('type')}]"]
    if role:
        parts.append(role)
    elif protocol and protocol != "external":
        parts.append(f"{protocol} 컴포넌트")
    return " ".join(parts) or label
