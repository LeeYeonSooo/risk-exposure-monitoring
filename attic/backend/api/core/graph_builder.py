"""
Dynamic graph builder for the LST/LRT dependency map.

Builds on top of graph_data.py (which provides the known base),
then enriches with live on-chain + DeFiLlama discoveries:
  - Aave V3 getReservesList() → confirm/add collateral edges
  - EigenLayer strategy underlyingToken() → confirm restaking edges
  - DeFiLlama /protocols (Liquid Staking, Restaking) → new protocol nodes

Results are cached in-memory for CACHE_TTL_SECONDS (24h).
Falls back to graph_data.py if discovery fails.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import time
from typing import Optional

import httpx
from Crypto.Hash import keccak

logger = logging.getLogger(__name__)

ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
ALCHEMY_RPC = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
LLAMA_API = "https://api.llama.fi"
CACHE_TTL_SECONDS = 24 * 3600

_cache: dict = {}  # {"graph": {...}, "ts": float}

# ── Known token contract addresses → our node IDs ─────────────────────────
TOKEN_ADDRESS_TO_NODE: dict[str, str] = {
    "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7": "rseth",
    "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wsteth",
    "0xbe9895146f7af43049ca1c1ae358b0541ea49704": "cbeth",
    "0x2416092f143378750bb29b79ed961ab195cceea5": "ezeth",
    "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee": "weeth",
    "0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa": "meth",
    "0xac3e018457b222d93114458476f3e3416abbe38f": "sfrxeth",
    "0xe95a203b1a91a908f9b9ce46459d101078c2c3cb": "ankreth",
    "0xf951e335afb289353dc249e82926178eac7ded78": "sweth",
    "0xa35b1b31ce002fbf2058d22f30f95d405200a15b": "ethx",
    "0x9d39a5de30e57443bff2a8307a4256c8797a3497": "susde",
}

# ── Known EigenLayer strategy addresses ──────────────────────────────────
EIGENLAYER_STRATEGIES: dict[str, str] = {
    "0x93c4b944D05dfe6df7645A86cd2206016c51564D": "stETH",
    "0x54945180dB7943c0ed0FEE7EdaB2Bd24620256bc": "cbETH",
    "0x1BeE69b7dFFfA4E2d53C2a2Df135C388AD25dCD2": "rETH",
    "0x9d7eD45EE2E8FC5482fa2428f15C971e6369011d": "ETHx",
    "0x7CA911E83dabf90C90dD3De5411a10F1A6112184": "wBETH",
    "0x13760F50a9d7377e4F20CB8CF9e4c26586c658ff": "ankrETH",
    "0x57ba429517c3473B6d34CA9aCd56c0e735b94c02": "osETH",
    "0x0Fe4F44beE93503346A3Ac9EE5A26b130a5796d3": "swETH",
    "0x298aFB19A105D59E74658C4C334Ff360BadE6dd2": "mETH",
    "0x8CA7A5d6f3acd3CCe06bB1f271992D1d425ef02d": "sfrxETH",
    "0xa4C637e0F704745D182e4D38cAb7E7485321d059": "OETH",
    "0xAe60d8180437b5C34bB956822ac2710972584473": "lsETH",
}

AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
AAVE_PRICE_ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2"

UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
UNISWAP_FEES = [500, 3000, 10000]  # 0.05%, 0.30%, 1.00%

# Compound V3 Comet contracts on Ethereum mainnet
COMPOUND_V3_COMETS: dict[str, str] = {
    "cWETHv3":  "0xA17581A9E3356d9a858b789D68B4d866E593Ae94",
    "cUSDCv3":  "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
    "cUSDTv3":  "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840",
}

# TVL threshold below which a protocol is marked inactive in the dynamic graph
DEAD_PROTOCOL_TVL_USD = 5_000_000  # $5M

# ── Row y-positions for auto-layout (matches graph_data.py layout) ──────
CATEGORY_Y = {
    "lrt_issuer": 520,
    "lst_issuer": 400,
    "lrt": 800,
    "lst": 680,
    "lending": 960,
    "dex": 960,
    "yield": 960,
    "chain": 240,
}

# ── DeFiLlama chain name → our node ID mapping ──────────────────────────
CHAIN_NAME_TO_NODE: dict[str, str] = {
    "Ethereum": "eth_mainnet",
    "Arbitrum": "arbitrum",
    "Base": "base",
    "Optimism": "optimism",
    "Polygon": "polygon",
    "BSC": "bsc",
    "Scroll": "scroll",
    "zkSync Era": "zksync_era",
    "Linea": "linea",
    "Mantle": "mantle",
}

# Chain display labels + positions
CHAIN_NODE_DEFS: dict[str, dict] = {
    "base":       {"label": "Base",        "x": 1200, "y": 240},
    "optimism":   {"label": "Optimism",    "x": 1400, "y": 240},
    "polygon":    {"label": "Polygon",     "x": 1600, "y": 240},
    "bsc":        {"label": "BNB Chain",   "x": 1800, "y": 240},
    "scroll":     {"label": "Scroll",      "x": 2000, "y": 240},
    "zksync_era": {"label": "zkSync Era",  "x": 2200, "y": 240},
    "linea":      {"label": "Linea",       "x": 2400, "y": 240},
    "mantle":     {"label": "Mantle",      "x": 2600, "y": 240},
}


# ── Helper functions ──────────────────────────────────────────────────────

def _sel(sig: str) -> str:
    h = keccak.new(digest_bits=256)
    h.update(sig.encode())
    return "0x" + h.hexdigest()[:8]


def _addr_arg(addr: str) -> str:
    return "000000000000000000000000" + addr[2:].lower()


async def _eth_call(client: httpx.AsyncClient, to: str, data: str) -> Optional[str]:
    try:
        resp = await client.post(ALCHEMY_RPC, json={
            "jsonrpc": "2.0", "method": "eth_call",
            "params": [{"to": to, "data": data}, "latest"],
            "id": 1,
        }, timeout=10.0)
        r = resp.json().get("result", "")
        return r if r and r != "0x" else None
    except Exception:
        return None


def _decode_address_array(hex_result: str) -> list[str]:
    """Decode ABI-encoded address[] return value."""
    if not hex_result or hex_result == "0x":
        return []
    data = hex_result[2:]
    if len(data) < 128:
        return []
    # offset at word 0, length at word 1 (or offset)
    offset = int(data[0:64], 16) * 2  # in hex chars
    length = int(data[offset:offset + 64], 16)
    addrs = []
    for i in range(length):
        start = offset + 64 + i * 64
        addr_hex = data[start + 24:start + 64]  # last 20 bytes (40 hex chars)
        if len(addr_hex) == 40:
            addrs.append("0x" + addr_hex.lower())
    return addrs


def _decode_address(hex_result: str) -> Optional[str]:
    """Decode single address return value."""
    if not hex_result or len(hex_result) < 42:
        return None
    return "0x" + hex_result[-40:].lower()


# ── Discovery functions ───────────────────────────────────────────────────

async def _discover_aave_reserves() -> dict[str, dict]:
    """
    Calls getReservesList() on Aave V3 Pool.
    Returns dict: {address_lower: {"in_aave": True}} for each reserve.
    Also checks oracle source for each.
    """
    sel_list = _sel("getReservesList()")
    sel_oracle = _sel("getAssetPrice(address)")

    async with httpx.AsyncClient(timeout=15.0) as client:
        raw = await _eth_call(client, AAVE_POOL, sel_list)
        if not raw:
            return {}
        addresses = _decode_address_array(raw)

        # For each address, check oracle source
        oracle_tasks = [
            _eth_call(client, AAVE_PRICE_ORACLE, sel_oracle + _addr_arg(a))
            for a in addresses
        ]
        oracle_results = await asyncio.gather(*oracle_tasks, return_exceptions=True)

    result = {}
    for addr, oracle_raw in zip(addresses, oracle_results):
        result[addr] = {
            "in_aave": True,
            "has_oracle": bool(oracle_raw and not isinstance(oracle_raw, Exception)),
        }
    return result


async def _discover_eigenlayer_underlying() -> dict[str, str]:
    """
    For each known EigenLayer strategy, fetch underlyingToken().
    Returns dict: {strategy_addr: underlying_token_addr}
    """
    sel = _sel("underlyingToken()")
    async with httpx.AsyncClient(timeout=15.0) as client:
        tasks = [
            _eth_call(client, strategy, sel)
            for strategy in EIGENLAYER_STRATEGIES
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    out = {}
    for strategy, raw in zip(EIGENLAYER_STRATEGIES, results):
        if raw and not isinstance(raw, Exception):
            addr = _decode_address(raw)
            if addr:
                out[strategy] = addr
    return out


async def _discover_uniswap_v3_pools(token_address: str) -> list[str]:
    """
    Check Uniswap V3 Factory getPool(token, WETH, fee) for each fee tier.
    Returns list of non-zero pool addresses found.
    """
    sel = _sel("getPool(address,address,uint24)")

    def _pool_calldata(token: str, fee: int) -> str:
        return sel + _addr_arg(token) + _addr_arg(WETH) + fee.to_bytes(32, "big").hex()

    async with httpx.AsyncClient(timeout=10.0) as client:
        tasks = [
            _eth_call(client, UNISWAP_V3_FACTORY, _pool_calldata(token_address, fee))
            for fee in UNISWAP_FEES
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    pools = []
    for raw in results:
        if raw and not isinstance(raw, Exception):
            addr = _decode_address(raw)
            if addr and addr != "0x" + "0" * 40:
                pools.append(addr)
    return pools


async def _discover_compound_v3_assets() -> dict[str, list[str]]:
    """
    For each Compound V3 Comet, call numAssets() then getAssetInfo(i).asset
    to enumerate collateral token addresses.
    Returns {comet_name: [token_addr, ...]}
    """
    sel_num = _sel("numAssets()")
    sel_info = _sel("getAssetInfo(uint8)")

    async with httpx.AsyncClient(timeout=12.0) as client:
        result: dict[str, list[str]] = {}
        for name, comet in COMPOUND_V3_COMETS.items():
            raw_num = await _eth_call(client, comet, sel_num)
            if not raw_num:
                continue
            num = int(raw_num, 16)
            tasks = [
                _eth_call(client, comet, sel_info + i.to_bytes(32, "big").hex())
                for i in range(num)
            ]
            asset_raws = await asyncio.gather(*tasks, return_exceptions=True)
            addrs = []
            for ar in asset_raws:
                if ar and not isinstance(ar, Exception):
                    # getAssetInfo returns a struct; asset address is first word
                    addr = _decode_address("0x" + ar[2:66])
                    if addr:
                        addrs.append(addr.lower())
            result[name] = addrs
    return result


async def _discover_defillama_protocols() -> list[dict]:
    """
    Fetch protocols from DeFiLlama with LST/LRT/Restaking categories.
    Returns list of {name, slug, tvl, category, chain, url}
    """
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(f"{LLAMA_API}/protocols")
            if resp.status_code != 200:
                return []
            all_protocols = resp.json()
        target_categories = {"Liquid Staking", "Restaking", "LRT"}
        return [
            {
                "name": p.get("name", ""),
                "slug": p.get("slug", ""),
                "tvl": p.get("tvl", 0),
                "category": p.get("category", ""),
                "chain": p.get("chain", ""),
                "symbol": p.get("symbol", ""),
            }
            for p in all_protocols
            if p.get("category") in target_categories
            and p.get("tvl", 0) > 10_000_000  # > $10M TVL only
            and p.get("chain") in ("Ethereum", "Multi-Chain", None, "")
        ]
    except Exception:
        return []


async def _discover_multichain_tvl(protocols_with_slug: list[tuple[str, str]]) -> dict[str, dict]:
    """
    For each (node_id, tvl_slug) pair, fetch /protocol/{slug} from DeFiLlama.
    Returns dict: {node_id: {"chain_tvls": {"Ethereum": 1.2e9, ...}}}

    Limits to 8 concurrent requests.
    """
    semaphore = asyncio.Semaphore(8)

    async def fetch_one(node_id: str, slug: str) -> tuple[str, dict]:
        async with semaphore:
            try:
                async with httpx.AsyncClient(timeout=12.0) as client:
                    resp = await client.get(f"{LLAMA_API}/protocol/{slug}")
                    if resp.status_code != 200:
                        return node_id, {}
                    data = resp.json()
                    raw = data.get("currentChainTvls", {})
                    # Filter small chains (< $1M) and normalise numbers
                    chain_tvls = {
                        chain: float(tvl)
                        for chain, tvl in raw.items()
                        if float(tvl) >= 1_000_000
                    }
                    return node_id, {"chain_tvls": chain_tvls} if chain_tvls else {}
            except Exception:
                return node_id, {}

    tasks = [fetch_one(nid, slug) for nid, slug in protocols_with_slug]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    out: dict[str, dict] = {}
    for r in results:
        if isinstance(r, tuple):
            nid, data = r
            if data:
                out[nid] = data
    return out


# ── Main build function ───────────────────────────────────────────────────

def _auto_position(category: str, existing_nodes: list[dict]) -> dict:
    """Assign position for a new node based on category row."""
    y = CATEGORY_Y.get(category, 960)
    # Find rightmost x at this y level
    same_row = [
        n["position"]["x"] for n in existing_nodes
        if abs(n["position"].get("y", 0) - y) < 80
    ]
    x = (max(same_row) + 200) if same_row else 1400
    return {"x": x, "y": y}


async def build_dynamic_graph(use_cache: bool = True) -> dict:
    """
    Build the dependency graph with on-chain enrichment.

    Strategy:
    1. Start from static graph_data.py (known nodes + edges + positions)
    2. Run on-chain discovery in parallel
    3. For each Aave reserve:
       - If address maps to known node → confirm existing collateral edge (or add if missing)
       - If unknown address → create new token node + collateral edge
    4. For each EigenLayer strategy:
       - If underlying token maps to known node → confirm existing restaked edge
       - If unknown → create new token node + restaked edge
    5. For each DeFiLlama protocol:
       - If name/slug matches existing node → update tvl_slug
       - If new → create new protocol node
    6. Return enriched nodes + edges
    """
    global _cache
    if use_cache and _cache.get("graph") and (time.time() - _cache.get("ts", 0)) < CACHE_TTL_SECONDS:
        return _cache["graph"]

    try:
        import sys
        import os as _os
        # Insert backend root so `api.core.graph_data` resolves under both
        # `python -m api.main` and `uvicorn api.main:app` invocations.
        sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.dirname(__file__))))
        from api.core.graph_data import NODES, EDGES, NODE_POSITIONS
    except ImportError:
        from .graph_data import NODES, EDGES, NODE_POSITIONS

    # Deep-copy base
    nodes = copy.deepcopy(NODES)
    edges = copy.deepcopy(EDGES)

    # Attach known positions
    for n in nodes:
        n["position"] = NODE_POSITIONS.get(n["id"], {"x": 0, "y": 0})

    # Quick lookup helpers
    node_ids = {n["id"] for n in nodes}
    edge_ids = {e["id"] for e in edges}

    def _add_node(node_def: dict) -> None:
        if node_def["id"] not in node_ids:
            node_ids.add(node_def["id"])
            nodes.append(node_def)

    def _add_edge(edge_def: dict) -> None:
        if edge_def["id"] not in edge_ids:
            edge_ids.add(edge_def["id"])
            edges.append(edge_def)

    try:
        # Run all discovery in parallel
        aave_task   = _discover_aave_reserves()
        eigen_task  = _discover_eigenlayer_underlying()
        llama_task  = _discover_defillama_protocols()
        uni_task    = _discover_uniswap_v3_pools(
            next(
                (addr for addr, nid in TOKEN_ADDRESS_TO_NODE.items() if nid == "rseth"),
                "0xA1290d69c65A6Fe4DF752f95823fAE25cB99e5A7",
            )
        )
        comp_task   = _discover_compound_v3_assets()

        (
            aave_reserves,
            eigen_underlying,
            llama_protocols,
            uniswap_pools,
            compound_assets,
        ) = await asyncio.gather(
            aave_task, eigen_task, llama_task, uni_task, comp_task,
            return_exceptions=True,
        )

        # ── Process Aave reserves ─────────────────────────────────────────
        if isinstance(aave_reserves, dict):
            for addr, info in aave_reserves.items():
                node_id = TOKEN_ADDRESS_TO_NODE.get(addr)
                if node_id and node_id in node_ids:
                    # Confirm/add collateral edge
                    edge_id = f"e_{node_id}_aave_discovered"
                    # Check if a collateral edge already exists
                    has_edge = any(
                        e["source"] == node_id and e["target"] == "aave_v3"
                        and e["edge_type"] == "collateral"
                        for e in edges
                    )
                    if not has_edge:
                        _add_edge({
                            "id": edge_id,
                            "source": node_id,
                            "target": "aave_v3",
                            "label": "담보(온체인)",
                            "edge_type": "collateral",
                        })
                # Unknown address (WETH, WBTC, USDC 등 비LST 토큰) → skip

        # ── Process EigenLayer strategies ────────────────────────────────
        if isinstance(eigen_underlying, dict):
            for strategy_addr, underlying_addr in eigen_underlying.items():
                node_id = TOKEN_ADDRESS_TO_NODE.get(underlying_addr.lower())
                if node_id and node_id in node_ids:
                    has_edge = any(
                        e["source"] == node_id and e["target"] == "eigenlayer"
                        and e["edge_type"] == "restaked"
                        for e in edges
                    )
                    if not has_edge:
                        _add_edge({
                            "id": f"e_{node_id}_eigen_discovered",
                            "source": node_id,
                            "target": "eigenlayer",
                            "label": "리스테이킹(온체인)",
                            "edge_type": "restaked",
                        })

        # ── Process Uniswap V3 pools ─────────────────────────────────────
        # For each token that maps to a known node, confirm/add a dex edge
        # to uniswap_v3 when at least one live pool exists.
        if isinstance(uniswap_pools, list) and uniswap_pools:
            for token_addr, node_id in TOKEN_ADDRESS_TO_NODE.items():
                if node_id not in node_ids:
                    continue
                has_dex_edge = any(
                    e["source"] == node_id and e["target"] == "uniswap_v3"
                    and e["edge_type"] == "dex"
                    for e in edges
                )
                if not has_dex_edge:
                    pools_for_token = await _discover_uniswap_v3_pools(token_addr)
                    if pools_for_token:
                        _add_edge({
                            "id": f"e_{node_id}_uniswap_discovered",
                            "source": node_id,
                            "target": "uniswap_v3",
                            "label": "DEX 유동성(온체인)",
                            "edge_type": "dex",
                        })

        # ── Process Compound V3 assets ───────────────────────────────────
        if isinstance(compound_assets, dict):
            for comet_name, token_addrs in compound_assets.items():
                for addr in token_addrs:
                    node_id = TOKEN_ADDRESS_TO_NODE.get(addr)
                    if not node_id or node_id not in node_ids:
                        continue
                    has_edge = any(
                        e["source"] == node_id and e["target"] == "compound_v3"
                        and e["edge_type"] == "collateral"
                        for e in edges
                    )
                    if not has_edge:
                        _add_edge({
                            "id": f"e_{node_id}_compound_discovered",
                            "source": node_id,
                            "target": "compound_v3",
                            "label": f"담보(온체인·{comet_name})",
                            "edge_type": "collateral",
                        })

        # ── Process DeFiLlama protocols ──────────────────────────────────
        if isinstance(llama_protocols, list):
            # Build name→slug lookup for existing nodes
            existing_slugs = {
                n["data"].get("tvl_slug"): n["id"]
                for n in nodes if n["data"].get("tvl_slug")
            }
            for proto in llama_protocols:
                slug = proto["slug"]
                name = proto["name"]
                # Skip if already in our graph
                if slug in existing_slugs:
                    continue
                # Skip very small or irrelevant
                if proto["tvl"] < 50_000_000:  # < $50M
                    continue
                # Check if name partially matches an existing node label
                name_lower = name.lower()
                matched = next(
                    (n["id"] for n in nodes
                     if name_lower in n["label"].lower() or n["label"].lower() in name_lower),
                    None
                )
                if matched:
                    # Update existing node's tvl_slug if missing
                    for n in nodes:
                        if n["id"] == matched and not n["data"].get("tvl_slug"):
                            n["data"]["tvl_slug"] = slug
                else:
                    # New protocol — add node
                    new_id = slug.replace("-", "_")[:20]
                    if new_id not in node_ids:
                        cat = "lrt_issuer" if proto["category"] == "Restaking" else "lst_issuer"
                        pos = _auto_position(cat, nodes)
                        _add_node({
                            "id": new_id,
                            "type": "protocol",
                            "label": name,
                            "data": {
                                "description": f"{proto['category']} 프로토콜 (DeFiLlama 자동 발견, TVL ${proto['tvl'] / 1e9:.1f}B)",
                                "risk_level": "medium",
                                "category": cat,
                                "tvl_slug": slug,
                            },
                            "position": pos,
                        })

        # ── Multichain TVL discovery ─────────────────────────────────────
        # Fetch per-chain TVL for protocols that have a DeFiLlama slug.
        # Also adds new chain nodes when significant TVL is found on unknown chains.
        protocols_with_slug = [
            (n["id"], n["data"]["tvl_slug"])
            for n in nodes
            if n["data"].get("tvl_slug") and n["type"] == "protocol"
        ]
        if protocols_with_slug:
            chain_tvl_map = await _discover_multichain_tvl(protocols_with_slug)
            for node_id, chain_data in chain_tvl_map.items():
                # Attach chain_tvls to the node
                for n in nodes:
                    if n["id"] == node_id:
                        n["data"]["chain_tvls"] = chain_data.get("chain_tvls", {})
                        break

                # For each significant chain, add chain node + bridge edge if missing
                for chain_name, chain_tvl in chain_data.get("chain_tvls", {}).items():
                    if chain_tvl < 5_000_000:  # skip tiny TVL
                        continue
                    chain_node_id = CHAIN_NAME_TO_NODE.get(chain_name)
                    if not chain_node_id:
                        continue
                    if chain_node_id not in node_ids:
                        # Add the chain node
                        chain_def = CHAIN_NODE_DEFS.get(chain_node_id, {})
                        _add_node({
                            "id": chain_node_id,
                            "type": "chain",
                            "label": chain_def.get("label", chain_name),
                            "data": {
                                "description": f"{chain_name} L2/sidechain (멀티체인 TVL 자동 발견)",
                                "risk_level": "low",
                                "category": "chain",
                            },
                            "position": {"x": chain_def.get("x", 2000), "y": chain_def.get("y", 240)},
                        })
                    # Add bridge edge: protocol → chain (if missing)
                    bridge_edge_id = f"e_{node_id}_{chain_node_id}_deploy"
                    if bridge_edge_id not in edge_ids:
                        _add_edge({
                            "id": bridge_edge_id,
                            "source": node_id,
                            "target": chain_node_id,
                            "label": f"배포 (${chain_tvl/1e6:.0f}M)",
                            "edge_type": "deploy",
                        })

        # ── Mark low-TVL protocols as inactive ───────────────────────────
        # Fetch individual TVL for nodes that have a tvl_slug but no chain_tvls yet.
        for n in nodes:
            if n.get("type") != "protocol":
                continue
            slug = n["data"].get("tvl_slug")
            if not slug or n["data"].get("chain_tvls"):
                continue
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    resp = await client.get(f"{LLAMA_API}/protocol/{slug}")
                    if resp.status_code == 200:
                        tvl = resp.json().get("tvl", [])
                        latest = tvl[-1]["totalLiquidityUSD"] if tvl else 0
                        if latest < DEAD_PROTOCOL_TVL_USD:
                            n["data"]["status"] = "inactive"
                            n["data"]["tvl_usd"] = round(latest)
            except Exception:
                pass

    except Exception as e:
        logger.warning(f"Graph enrichment failed (using base graph): {e}")

    result = {"nodes": nodes, "edges": edges}
    _cache = {"graph": result, "ts": time.time()}
    return result


def get_cached_graph() -> Optional[dict]:
    """Return cached graph if fresh, else None."""
    if _cache.get("graph") and (time.time() - _cache.get("ts", 0)) < CACHE_TTL_SECONDS:
        return _cache["graph"]
    return None
