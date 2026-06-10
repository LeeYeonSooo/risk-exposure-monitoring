"""
morpho_discovery.py — Morpho Blue 의 마켓 + VaultV2 를 GraphQL API 로 자동 발견.

Morpho 의 공개 API (https://blue-api.morpho.org/graphql) 사용 — API key 불필요.

각 market 마다:
  - collateralAsset, loanAsset 노드 (주소 같은 Aave underlying 과 자동 머지)
  - collateralAsset → MorphoBlue (collateral 엣지)
  - loanAsset      → MorphoBlue (lending 엣지)
  - lltv, supplyAssetsUsd, borrowAssetsUsd 를 metadata 로

각 vault 마다:
  - vault 노드 (protocol=morpho, type=vault)
  - vault → asset (mint_wrapper — share 가 asset 청구권)
  - vault → MorphoBlue (vault_allocation — 자금이 결국 Blue 로 흐름)
  - allocations 가 있으면: vault → market.collateralAsset (allocation 의 실 노출 자산)

본 모듈의 출력은 integration/output/discovered_morpho.json 에 저장.
module_loader 가 discovered_*.json 글롭으로 자동 로드.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

MORPHO_API = "https://blue-api.morpho.org/graphql"
MORPHO_BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"  # singleton, lowercase

# 마켓 가져오는 개수 — top supplyAssetsUsd 기준 N 개
TOP_MARKETS = 50
TOP_VAULTS = 30

# ─────────────────────────────────────────────────────────────────
# GraphQL 쿼리
# ─────────────────────────────────────────────────────────────────

_QUERY_MARKETS = """
query Markets($first: Int!) {
  markets(
    first: $first,
    orderBy: SupplyAssetsUsd,
    orderDirection: Desc,
    where: {chainId_in: [1]}
  ) {
    items {
      marketId
      lltv
      collateralAsset { address symbol decimals }
      loanAsset      { address symbol decimals }
      state {
        supplyAssetsUsd
        borrowAssetsUsd
      }
    }
  }
}
"""

_QUERY_VAULTS = """
query Vaults($first: Int!) {
  vaults(
    first: $first,
    orderBy: TotalAssetsUsd,
    orderDirection: Desc,
    where: {chainId_in: [1]}
  ) {
    items {
      address
      name
      symbol
      asset { address symbol decimals }
      state {
        totalAssetsUsd
        allocation {
          supplyAssetsUsd
          market {
            marketId
            collateralAsset { address symbol }
            loanAsset { address symbol }
          }
        }
      }
    }
  }
}
"""


async def _gql(client: httpx.AsyncClient, query: str, variables: dict) -> Optional[dict]:
    try:
        r = await client.post(
            MORPHO_API,
            json={"query": query, "variables": variables},
            headers={"Content-Type": "application/json"},
        )
        r.raise_for_status()
        d = r.json()
        if "errors" in d:
            logger.warning(f"Morpho GraphQL errors: {d['errors']}")
            return None
        return d.get("data")
    except Exception as e:
        logger.warning(f"Morpho GraphQL failed: {e}")
        return None


# ─────────────────────────────────────────────────────────────────
# Discovery
# ─────────────────────────────────────────────────────────────────

async def discover_morpho() -> dict:
    """
    Morpho Blue 의 top markets + top vaults 발견.

    Returns:
        {
          "discovered_at": float,
          "markets": [...],
          "vaults": [...],
          "error": str | None,
        }
    """
    started = time.time()
    out: dict = {
        "discovered_at": started,
        "markets": [],
        "vaults": [],
        "error": None,
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # markets + vaults 병렬 호출
            markets_task = _gql(client, _QUERY_MARKETS, {"first": TOP_MARKETS})
            vaults_task = _gql(client, _QUERY_VAULTS, {"first": TOP_VAULTS})
            markets_data, vaults_data = await asyncio.gather(markets_task, vaults_task)

        if markets_data and "markets" in markets_data:
            out["markets"] = markets_data["markets"].get("items", []) or []
        if vaults_data and "vaults" in vaults_data:
            out["vaults"] = vaults_data["vaults"].get("items", []) or []

        out["markets_count"] = len(out["markets"])
        out["vaults_count"] = len(out["vaults"])
        return out

    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        return out


# ─────────────────────────────────────────────────────────────────
# discovery → graph 변환
# ─────────────────────────────────────────────────────────────────

def discovery_to_module_nodes(discovery: dict) -> list[dict]:
    """
    discovery 결과 → integration 그래프 노드.

    중복 자산은 address 기준 1개만 생성 (Aave underlying 과도 머지됨).
    """
    nodes: list[dict] = []
    seen_assets: set[str] = set()

    def _add_asset(asset: dict | None):
        if not asset:
            return
        addr = (asset.get("address") or "").lower()
        if not addr or not addr.startswith("0x") or addr in seen_assets:
            return
        seen_assets.add(addr)
        sym = asset.get("symbol") or ""
        nodes.append({
            "address": addr,
            "chain_id": 1,
            "type": "underlying_asset",
            "protocol": "external",
            "label": sym or f"asset {addr[:8]}",
            "metadata": {
                "symbol": sym,
                "decimals": asset.get("decimals"),
                "discovered_by": "morpho",
            },
        })

    # markets 의 토큰들
    for m in discovery.get("markets", []):
        _add_asset(m.get("collateralAsset"))
        _add_asset(m.get("loanAsset"))

    # vaults 자체 + vault 의 asset
    for v in discovery.get("vaults", []):
        v_addr = (v.get("address") or "").lower()
        if v_addr and v_addr.startswith("0x"):
            v_sym = v.get("symbol") or ""
            v_name = v.get("name") or v_sym or f"Vault {v_addr[:6]}"
            nodes.append({
                "address": v_addr,
                "chain_id": 1,
                "type": "vault",
                "protocol": "morpho",
                "label": v_name if len(v_name) < 30 else f"MetaMorpho {v_sym}",
                "metadata": {
                    "symbol": v_sym,
                    "total_assets_usd": (v.get("state") or {}).get("totalAssetsUsd"),
                    "discovered_by": "morpho",
                    "kind": "metamorpho_vault",
                },
            })
        _add_asset(v.get("asset"))

    return nodes


def discovery_to_module_edges(discovery: dict) -> list[dict]:
    """
    discovery 결과 → integration 그래프 엣지.

    Market 마다:
      - collateralAsset → MorphoBlue  (collateral 의미. edge_type=mint_wrapper for now)
      - loanAsset       → MorphoBlue  (lending)
    Vault 마다:
      - vault → asset           (mint_wrapper)
      - vault → MorphoBlue      (vault_allocation)
    """
    edges: list[dict] = []
    seen_market_pairs: set[tuple[str, str, str]] = set()

    def _market_edge(token_addr: str, role: str, m: dict):
        token_addr = token_addr.lower()
        key = (token_addr, MORPHO_BLUE, role)
        if key in seen_market_pairs:
            return
        seen_market_pairs.add(key)

        # collateral 은 vault_allocation, loan 은 mint_wrapper 로 매핑
        # (vocab_mapper 의 휴리스틱이 둘 다 'protocol' / 'issued_by' 로 자동 분류)
        etype = "vault_allocation" if role == "collateral" else "mint_wrapper"
        edges.append({
            "edge_id": f"morpho-discovered:{token_addr[:10]}->blue:{role}",
            "edge_type": etype,
            "from": token_addr,
            "to": MORPHO_BLUE,
            "protocol": "morpho",
            "chain_id": 1,
            "metadata": {
                "discovered": True,
                "layer": f"market_{role}",
                "market_id": m.get("marketId"),
                "lltv": m.get("lltv"),
                "supply_usd": (m.get("state") or {}).get("supplyAssetsUsd"),
                "borrow_usd": (m.get("state") or {}).get("borrowAssetsUsd"),
            },
        })

    for m in discovery.get("markets", []):
        c = (m.get("collateralAsset") or {}).get("address")
        l = (m.get("loanAsset") or {}).get("address")
        if c:
            _market_edge(c, "collateral", m)
        if l:
            _market_edge(l, "loan", m)

    # vaults
    for v in discovery.get("vaults", []):
        v_addr = (v.get("address") or "").lower()
        asset_addr = ((v.get("asset") or {}).get("address") or "").lower()
        if not (v_addr and v_addr.startswith("0x")):
            continue

        # vault → asset (mint_wrapper)
        if asset_addr.startswith("0x"):
            edges.append({
                "edge_id": f"morpho-discovered:vault{v_addr[:10]}->{asset_addr[:10]}",
                "edge_type": "mint_wrapper",
                "from": v_addr,
                "to": asset_addr,
                "protocol": "morpho",
                "chain_id": 1,
                "metadata": {"discovered": True, "layer": "vault_to_asset"},
            })
        # vault → MorphoBlue (vault_allocation)
        edges.append({
            "edge_id": f"morpho-discovered:vault{v_addr[:10]}->blue",
            "edge_type": "vault_allocation",
            "from": v_addr,
            "to": MORPHO_BLUE,
            "protocol": "morpho",
            "chain_id": 1,
            "metadata": {"discovered": True, "layer": "vault_to_blue"},
        })

    return edges
