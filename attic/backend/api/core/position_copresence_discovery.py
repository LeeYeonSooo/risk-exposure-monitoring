"""
position_copresence_discovery.py — 포지션 스냅샷 기반 cross-protocol 공유 고래 발견.

이벤트 누적을 기다리지 않고, 각 프로토콜의 *현재 top holder 주소*를 subgraph/API 로
즉시 가져와 교집합 → 실제 공유 고래 (co-presence, latent tier).

데이터 소스:
  - Aave V3  : subgraph positions(orderBy: balance)
  - Morpho   : blue-api marketPositions(orderBy: SupplyShares)

eoa_bridge_discovery 의 event-flow(realized) 와 상보적:
  - 본 모듈 = latent (지금 양쪽에 포지션 보유 = 정적 공존)
  - eoa_bridge = realized (실제 A→B 자본 이동 = 동적 흐름)

출력: integration/output/discovered_copresence.json → module_loader 자동 머지.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import defaultdict
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

AAVE_SUBGRAPH = os.getenv("AAVE_V3_SUBGRAPH_URL", "").strip()
MORPHO_API = "https://blue-api.morpho.org/graphql"
ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
ETH_RPC = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}" if ALCHEMY_KEY else ""

_DISCOVERED_PENDLE = Path(__file__).resolve().parent.parent.parent.parent / "integration" / "output" / "discovered_pendle.json"

# 각 프로토콜 anchor 노드 (bridge 엣지 끝점)
PROTOCOL_ANCHORS = {
    "aave-v3": "aave_v3",
    "morpho": "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
    "lido": "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    "sky": "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
    "pendle": "0x888888888889758f76e7103c6cbf23abbf58f946",
}

# 토큰형 프로토콜 참여 판정용 토큰 (balanceOf — position subgraph 없음)
LIDO_TOKENS = ["0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",  # wstETH
               "0xae7ab96520de3a18e5e111b5eaab095312d7fe84"]  # stETH
SKY_TOKENS = ["0xdc035d45d973e3ec169d2276ddab16f1e407384f",  # USDS
              "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",  # sUSDS
              "0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9"]  # stUSDS
PENDLE_TOKEN_TOP = 90  # discovered_pendle 의 PT/SY/LP 중 liquidity 상위 N (Alchemy 100 토큰/호출 한도)

MIN_TOKEN_RAW = 10 ** 18      # 1 토큰 이상 보유해야 참여 인정
BALANCE_CHECK_CAP = 400       # balanceOf 확인 후보 상한 (rate limit 보호)
PAGE_SIZE = 1000
MAX_PAGES = 5  # 각 프로토콜 최대 5000 주소 (top-N 편향 회피 — 넓은 집단 필요)


def _load_pendle_tokens() -> list[str]:
    """discovered_pendle.json 에서 PT/SY/LP 토큰 주소 (liquidity 상위 N)."""
    if not _DISCOVERED_PENDLE.exists():
        return []
    try:
        d = json.loads(_DISCOVERED_PENDLE.read_text(encoding="utf-8"))
        toks = []
        for n in d.get("nodes", []):
            if n.get("type") in ("pt_token", "sy_token", "amm_pool"):
                liq = (n.get("metadata") or {}).get("liquidity", 0) or 0
                toks.append((n["address"].lower(), liq))
        toks.sort(key=lambda x: -x[1])
        return [a for a, _ in toks[:PENDLE_TOKEN_TOP]]
    except Exception:
        return []


async def _fetch_aave_holders(client: httpx.AsyncClient) -> dict[str, float]:
    """Aave 포지션 페이지네이션 → {address: position_count}. (top-N 만 보면 거대 스테이블 예치자에 편향)"""
    if not AAVE_SUBGRAPH:
        return {}
    holders: dict[str, float] = defaultdict(float)
    for page in range(MAX_PAGES):
        skip = page * PAGE_SIZE
        query = f"""
        {{ positions(first: {PAGE_SIZE}, skip: {skip}, orderBy: balance, orderDirection: desc) {{
            account {{ id }}
        }} }}
        """
        try:
            r = await client.post(AAVE_SUBGRAPH, json={"query": query})
            r.raise_for_status()
            ps = (r.json().get("data", {}) or {}).get("positions", []) or []
            for p in ps:
                addr = ((p.get("account") or {}).get("id") or "").lower()
                if addr.startswith("0x"):
                    holders[addr] += 1
            if len(ps) < PAGE_SIZE:
                break
        except Exception as e:
            logger.warning(f"aave holders page {page} failed: {e}")
            break
    return dict(holders)


async def _fetch_morpho_holders(client: httpx.AsyncClient) -> dict[str, float]:
    """Morpho marketPositions 페이지네이션 → {address: supplyAssetsUsd 합}."""
    holders: dict[str, float] = defaultdict(float)
    for page in range(MAX_PAGES):
        skip = page * PAGE_SIZE
        query = f"""
        {{ marketPositions(first: {PAGE_SIZE}, skip: {skip}, orderBy: SupplyShares, orderDirection: Desc, where: {{chainId_in: [1]}}) {{
            items {{ user {{ address }} state {{ supplyAssetsUsd }} }}
        }} }}
        """
        try:
            r = await client.post(MORPHO_API, json={"query": query})
            r.raise_for_status()
            its = ((r.json().get("data", {}) or {}).get("marketPositions", {}) or {}).get("items", []) or []
            for it in its:
                addr = ((it.get("user") or {}).get("address") or "").lower()
                usd = (it.get("state") or {}).get("supplyAssetsUsd") or 0
                if addr.startswith("0x"):
                    holders[addr] += usd
            if len(its) < PAGE_SIZE:
                break
        except Exception as e:
            logger.warning(f"morpho holders page {page} failed: {e}")
            break
    return dict(holders)


try:
    from Crypto.Hash import keccak
    _HAS_KECCAK = True
except Exception:
    _HAS_KECCAK = False

_TRANSFER_TOPIC = ""
if _HAS_KECCAK:
    _k = keccak.new(digest_bits=256)
    _k.update(b"Transfer(address,address,uint256)")
    _TRANSFER_TOPIC = "0x" + _k.hexdigest()

# Transfer 스캔 윈도우 (독립 holder universe 부트스트랩 — 일 폴링으로 누적 확장)
# 작게 유지: 동기 호출이라 너무 크면 timeout. 일 폴링이 누적해서 커버리지 확장.
TRANSFER_SCAN_BLOCKS = 60
_LOG_CHUNK = 10  # Alchemy 무료 티어


async def _fetch_token_holders_via_transfers(
    client: httpx.AsyncClient, tokens: list[str], max_blocks: int = TRANSFER_SCAN_BLOCKS
) -> set[str]:
    """
    최근 max_blocks 동안 토큰 Transfer 의 from/to 주소 수집 → 독립 holder universe.
    Aave/Morpho 와 무관하게 순수 Lido↔Sky 고래도 포착 가능.
    """
    if not ETH_RPC or not _TRANSFER_TOPIC:
        return set()
    holders: set[str] = set()
    try:
        # 현재 블록
        rb = await client.post(ETH_RPC, json={"jsonrpc": "2.0", "method": "eth_blockNumber", "id": 1})
        head = int(rb.json()["result"], 16)
    except Exception:
        return holders
    start = head - max_blocks
    for token in tokens:
        lo = start
        while lo <= head:
            hi = min(lo + _LOG_CHUNK - 1, head)
            try:
                r = await client.post(ETH_RPC, json={
                    "jsonrpc": "2.0", "method": "eth_getLogs", "id": 1,
                    "params": [{"address": token, "topics": [_TRANSFER_TOPIC],
                                "fromBlock": hex(lo), "toBlock": hex(hi)}],
                })
                for log in (r.json().get("result", []) or []):
                    tp = log.get("topics", [])
                    if len(tp) >= 3:
                        frm = "0x" + tp[1][-40:].lower()
                        to = "0x" + tp[2][-40:].lower()
                        if frm != "0x" + "0" * 40:
                            holders.add(frm)
                        if to != "0x" + "0" * 40:
                            holders.add(to)
            except Exception:
                pass
            lo = hi + 1
    return holders


async def _token_balances(client: httpx.AsyncClient, addr: str, tokens: list[str]) -> dict[str, int]:
    """Alchemy getTokenBalances — 한 번에 여러 토큰 잔액. {token: raw_balance}."""
    if not ETH_RPC:
        return {}
    try:
        r = await client.post(ETH_RPC, json={
            "jsonrpc": "2.0", "method": "alchemy_getTokenBalances", "id": 1,
            "params": [addr, tokens],
        })
        r.raise_for_status()
        out = {}
        for b in (r.json().get("result", {}) or {}).get("tokenBalances", []) or []:
            tb = b.get("tokenBalance")
            val = int(tb, 16) if tb and tb != "0x" else 0
            out[b.get("contractAddress", "").lower()] = val
        return out
    except Exception:
        return {}


async def _check_token_protocols(client: httpx.AsyncClient, candidates: list[str]) -> dict[str, set]:
    """후보 주소들의 Lido/Sky/Pendle 토큰 보유 여부를 한 번의 getTokenBalances 로 확인."""
    lido: set[str] = set()
    sky: set[str] = set()
    pendle: set[str] = set()
    pendle_tokens = _load_pendle_tokens()
    pendle_set = set(pendle_tokens)
    all_tokens = LIDO_TOKENS + SKY_TOKENS + pendle_tokens  # ≤ 100
    for addr in candidates[:BALANCE_CHECK_CAP]:
        bals = await _token_balances(client, addr, all_tokens)
        if not bals:
            continue
        if any(bals.get(t, 0) >= MIN_TOKEN_RAW for t in LIDO_TOKENS):
            lido.add(addr)
        if any(bals.get(t, 0) >= MIN_TOKEN_RAW for t in SKY_TOKENS):
            sky.add(addr)
        if any(v >= MIN_TOKEN_RAW for t, v in bals.items() if t in pendle_set):
            pendle.add(addr)
    return {"lido": lido, "sky": sky, "pendle": pendle}


async def discover_copresence() -> dict:
    started = time.time()
    out: dict = {"discovered_at": started, "bridges": [], "error": None}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            aave = await _fetch_aave_holders(client)
            morpho = await _fetch_morpho_holders(client)

            # 후보 universe = Aave ∪ Morpho 주소. Lido/Sky 보유는 balanceOf 로 확인.
            # 우선순위: Aave∩Morpho 먼저(가장 cross-protocol 가능성), 그다음 Morpho USD 상위.
            both = set(aave) & set(morpho)
            rest = (set(aave) | set(morpho)) - both
            ordered = sorted(both, key=lambda a: morpho.get(a, 0), reverse=True) + \
                      sorted(rest, key=lambda a: morpho.get(a, 0), reverse=True)
            tok_protocols = await _check_token_protocols(client, ordered)

            # 독립 holder universe (Aave/Morpho 와 무관) — 순수 Lido↔Sky 고래 포착
            lido_independent = await _fetch_token_holders_via_transfers(client, LIDO_TOKENS)
            sky_independent = await _fetch_token_holders_via_transfers(client, SKY_TOKENS)

        out["aave_holders"] = len(aave)
        out["morpho_holders"] = len(morpho)
        out["lido_independent"] = len(lido_independent)
        out["sky_independent"] = len(sky_independent)
        out["balance_checked"] = min(len(ordered), BALANCE_CHECK_CAP)

        # 각 프로토콜 멤버 = balanceOf 검증(Aave/Morpho 풀) ∪ 독립 Transfer-scan universe
        members = {
            "aave-v3": set(aave),
            "morpho": set(morpho),
            "lido": tok_protocols["lido"] | lido_independent,
            "sky": tok_protocols["sky"] | sky_independent,
            "pendle": tok_protocols["pendle"],
        }
        out["lido_holders_total"] = len(members["lido"])
        out["sky_holders_total"] = len(members["sky"])
        out["pendle_holders_in_pool"] = len(members["pendle"])

        # 모든 프로토콜 쌍 co-presence
        protos = ["aave-v3", "morpho", "lido", "sky", "pendle"]
        for i in range(len(protos)):
            for j in range(i + 1, len(protos)):
                pa, pb = protos[i], protos[j]
                shared = members[pa] & members[pb]
                if not shared:
                    continue
                shared_sorted = sorted(shared, key=lambda a: morpho.get(a, 0), reverse=True)
                combined_usd = sum(morpho.get(a, 0) for a in shared)
                out["bridges"].append({
                    "protocol_a": pa, "protocol_b": pb,
                    "shared_whales": len(shared),
                    "combined_morpho_usd": round(combined_usd, 2),
                    "tier": "latent",
                    "top_shared": [
                        {"address": a, "morpho_supply_usd": round(morpho.get(a, 0), 2)}
                        for a in shared_sorted[:8]
                    ],
                })
        out["bridges_count"] = len([b for b in out["bridges"] if b["shared_whales"] > 0])
        return out

    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        return out


def discovery_to_module_nodes(discovery: dict) -> list[dict]:
    return []


def discovery_to_module_edges(discovery: dict) -> list[dict]:
    edges: list[dict] = []
    for b in discovery.get("bridges", []):
        if b["shared_whales"] <= 0:
            continue
        a = PROTOCOL_ANCHORS.get(b["protocol_a"])
        bb = PROTOCOL_ANCHORS.get(b["protocol_b"])
        if not a or not bb or a == bb:
            continue
        edges.append({
            "edge_id": f"copresence:{b['protocol_a']}<->{b['protocol_b']}",
            "edge_type": "protocol",  # latent — 약한 cross-protocol 관계
            "from": a, "to": bb,
            "protocol": "cross-protocol", "chain_id": 1,
            "metadata": {
                "discovered": True,
                "layer": "position_copresence",
                "tier": "latent",
                "shared_whales": b["shared_whales"],
                "combined_usd": b.get("combined_morpho_usd", 0),
                "weight_hint": b["shared_whales"],
                "source": "position_snapshot (subgraph + API)",
            },
        })
    return edges
