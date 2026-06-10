"""
flow_discovery.py — Cross-protocol 간접 연결 자동 발견.

사용자 요구: "다른 프로토콜들도 이벤트 모니터링으로 간접적인 연결이 있다면 그 연결까지."

핵심 아이디어:
    LST/LRT 토큰 (wstETH, weETH 등) 이 *알려진 프로토콜 주소들 사이*를 이동하는
    ERC20 Transfer 이벤트를 모니터링 → 그 흐름이 곧 프로토콜 간 간접 의존.

    예: wstETH 가 Aave Pool → EigenLayer Strategy 로 이동
        = "Aave 예치자가 인출해서 EigenLayer 에 재예치" 같은 cross-protocol 흐름.

작동:
    1) 알려진 주소 맵 구축 (address_book + consumer_registry + 핵심 컨트랙트)
    2) wstETH/weETH ERC20 Transfer 모니터링 (RPC eth_getLogs, 10블록 chunk)
    3) from·to 가 *둘 다* 알려진 주소인 transfer 만 → cross-protocol 엣지
    4) (from, to, token) 으로 집계해서 그래프 엣지 생성

출력은 integration/output/discovered_flows.json → module_loader 가 자동 머지.
즉 간접 연결이 *정적 그래프에 직접 표시*됨 (focus/search 가 아니라).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Optional

import httpx

try:
    from Crypto.Hash import keccak
    _HAS_KECCAK = True
except Exception:
    _HAS_KECCAK = False

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent.parent
ADDRESS_BOOK = ROOT / "shared" / "address_book.json"
CONSUMER_REGISTRY = ROOT / "shared" / "consumer_registry.json"
DISCOVERED_AAVE = ROOT / "integration" / "output" / "discovered_nodes_edges.json"
DISCOVERED_MORPHO = ROOT / "integration" / "output" / "discovered_morpho.json"

ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
ETH_RPC = (
    f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
    if ALCHEMY_KEY else "https://eth.llamarpc.com"
)

# 모니터링할 LST/LRT 토큰 (가장 통합도 높은 것 위주)
MONITORED_TOKENS = {
    "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
    "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee": "weETH",
}

# 핵심 프로토콜 컨트랙트 (알려진 주소 맵의 baseline)
_CORE_ADDRESSES = {
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "Aave V3 Pool",
    "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb": "Morpho Blue",
    "0x889edc2edab5f40e902b864ad4d7ade8e412f9b1": "Lido Withdrawal Queue",
}

ZERO = "0x0000000000000000000000000000000000000000"
_MAX_LOG_RANGE = 10
MIN_FLOW_RAW = 10 * 10**18  # 10 토큰 이상만 (dust 제외)


def _topic0(sig: str) -> str:
    if not _HAS_KECCAK:
        return ""
    k = keccak.new(digest_bits=256)
    k.update(sig.encode())
    return "0x" + k.hexdigest()


TOPIC_TRANSFER = _topic0("Transfer(address,address,uint256)")


def _topic_to_addr(topic: str) -> str:
    return "0x" + topic[-40:].lower()


def _load_known_addresses() -> dict[str, dict]:
    """
    알려진 주소 맵 구축: address_book + consumer_registry + core + discovered.
    Returns: address(lower) → {"label": str, "protocol": str}
    """
    known: dict[str, dict] = {}

    # core
    for addr, label in _CORE_ADDRESSES.items():
        known[addr.lower()] = {"label": label, "protocol": label.split()[0].lower()}

    # consumer_registry
    if CONSUMER_REGISTRY.exists():
        data = json.loads(CONSUMER_REGISTRY.read_text(encoding="utf-8"))
        for addr, meta in data.get("consumers", {}).items():
            if addr.startswith("0x") and not meta.get("_skip"):
                known[addr.lower()] = {
                    "label": meta.get("label", addr[:10]),
                    "protocol": meta.get("protocol", "external"),
                }

    # discovered Aave/Morpho (aToken/debt/vault 주소들도 알려진 주소)
    for f in (DISCOVERED_AAVE, DISCOVERED_MORPHO):
        if not f.exists():
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            for n in d.get("nodes", []):
                a = (n.get("address") or "").lower()
                if a.startswith("0x"):
                    known.setdefault(a, {
                        "label": n.get("label", a[:10]),
                        "protocol": n.get("protocol", "external"),
                    })
        except Exception:
            pass

    return known


async def _get_logs(client, token, lo, hi) -> list[dict]:
    if not TOPIC_TRANSFER:
        return []
    r = await client.post(ETH_RPC, json={
        "jsonrpc": "2.0", "method": "eth_getLogs", "id": 1,
        "params": [{
            "address": token, "topics": [TOPIC_TRANSFER],
            "fromBlock": hex(lo), "toBlock": hex(hi),
        }],
    })
    r.raise_for_status()
    return r.json().get("result", []) or []


async def discover_flows(from_block: int, to_block: int) -> dict:
    """
    모니터링 토큰들의 transfer 중 known→known 흐름만 집계.

    Returns:
        {
          "discovered_at": float,
          "flows": [{"from": addr, "to": addr, "token": sym, "total_raw": int, "count": int}],
          "error": str | None,
        }
    """
    started = time.time()
    out: dict = {
        "discovered_at": started,
        "from_block": from_block, "to_block": to_block,
        "flows": [], "error": None,
    }

    if not ALCHEMY_KEY or not _HAS_KECCAK:
        out["error"] = "no_alchemy_key_or_keccak"
        return out

    known = _load_known_addresses()
    # (from, to, token_sym) → [total, count]
    agg: dict[tuple, list] = defaultdict(lambda: [0, 0])

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            for token_addr, token_sym in MONITORED_TOKENS.items():
                lo = from_block
                while lo <= to_block:
                    hi = min(lo + _MAX_LOG_RANGE - 1, to_block)
                    logs = await _get_logs(client, token_addr, lo, hi)
                    for log in logs:
                        topics = log.get("topics", [])
                        if len(topics) < 3:
                            continue
                        frm = _topic_to_addr(topics[1])
                        to = _topic_to_addr(topics[2])
                        if frm == ZERO or to == ZERO or frm == to:
                            continue
                        # *둘 다* 알려진 주소여야 cross-protocol 의미
                        if frm not in known or to not in known:
                            continue
                        data = log.get("data", "0x")
                        amt = int(data[2:66], 16) if len(data) >= 66 else 0
                        if amt < MIN_FLOW_RAW:
                            continue
                        key = (frm, to, token_sym)
                        agg[key][0] += amt
                        agg[key][1] += 1
                    lo = hi + 1

        for (frm, to, sym), (total, cnt) in agg.items():
            out["flows"].append({
                "from": frm, "to": to, "token": sym,
                "total_raw": total, "count": cnt,
                "from_label": known.get(frm, {}).get("label"),
                "to_label": known.get(to, {}).get("label"),
            })
        out["flows_count"] = len(out["flows"])
        return out

    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        return out


def discovery_to_module_nodes(discovery: dict) -> list[dict]:
    """flow 는 기존 알려진 노드들 사이의 엣지라서 새 노드 거의 없음 — 빈 리스트."""
    return []


def discovery_to_module_edges(discovery: dict) -> list[dict]:
    """known→known flow → cross-protocol 간접 의존 엣지."""
    edges: list[dict] = []
    for fl in discovery.get("flows", []):
        frm = fl["from"]; to = fl["to"]; sym = fl["token"]
        edges.append({
            "edge_id": f"flow-discovered:{frm[:10]}->{to[:10]}:{sym}",
            "edge_type": "contagion",  # 프로토콜 간 자금 흐름 = 전염 경로
            "from": frm,
            "to": to,
            "protocol": "cross-protocol",
            "chain_id": 1,
            "metadata": {
                "discovered": True,
                "layer": "cross_protocol_flow",
                "token": sym,
                "transfer_count": fl["count"],
                "total_raw": str(fl["total_raw"]),
                "from_label": fl.get("from_label"),
                "to_label": fl.get("to_label"),
            },
        })
    return edges
