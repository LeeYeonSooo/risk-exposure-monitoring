import os as _os
"""
DeBank-style LST/LRT portfolio scanner.

Priority:
  1. DeBank Cloud API  (DEBANK_ACCESS_KEY env var set)
  2. Batch eth_call balanceOf  ← always free, no auth

For each token found:
  - balance, USD value (DeFiLlama price)
  - category: lst | lrt | aave_collateral
  - graph_nodes: which dependency-graph node IDs are "touched"
  - source: wallet | aave_v3
"""

import os
import asyncio
import httpx
from Crypto.Hash import keccak

RPC_ENDPOINTS = (
    [f"https://eth-mainnet.g.alchemy.com/v2/{_os.getenv('ALCHEMY_API_KEY', '')}"]
    if _os.getenv("ALCHEMY_API_KEY") else []
) + [
    "https://eth-pokt.nodies.app",
    "https://virginia.rpc.blxrbdn.com",
    "https://uk.rpc.blxrbdn.com",
]

DEBANK_BASE = "https://pro-openapi.debank.com/v1"
LLAMA_COINS = "https://coins.llama.fi"


# ── Known LST/LRT tokens on Ethereum mainnet ─────────────────────────────────

LST_LRT_TOKENS: dict[str, dict] = {
    "rsETH":   {"addr": "0xA1290d69c65A6Fe4DF752f95823fAE25cB99e5A7", "decimals": 18, "category": "lrt"},
    "wstETH":  {"addr": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "decimals": 18, "category": "lst"},
    "stETH":   {"addr": "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", "decimals": 18, "category": "lst"},
    "cbETH":   {"addr": "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", "decimals": 18, "category": "lst"},
    "weETH":   {"addr": "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", "decimals": 18, "category": "lrt"},
    "ezETH":   {"addr": "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110", "decimals": 18, "category": "lrt"},
    "rswETH":  {"addr": "0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0", "decimals": 18, "category": "lrt"},
    "mETH":    {"addr": "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa", "decimals": 18, "category": "lst"},
    "sfrxETH": {"addr": "0xac3E018457B222d93114458476f3E3416Abbe38F", "decimals": 18, "category": "lst"},
    "agETH":   {"addr": "0xe1B4d34E8754600962Cd944b535180Bd758E6c2e", "decimals": 18, "category": "lrt"},
    "ankrETH": {"addr": "0xE95A203B1a91a908F9B9CE46459d101078c2c3cb", "decimals": 18, "category": "lst"},
    "swETH":   {"addr": "0xf951E335afb289353dc249e82926178EaC7DEd78", "decimals": 18, "category": "lrt"},
    "ETHx":    {"addr": "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b", "decimals": 18, "category": "lst"},
}

# Aave V3 aToken → underlying symbol mapping
# aToken balance = user's Aave V3 deposit of that underlying
AAVE_ATOKENS: dict[str, dict] = {
    "a_rsETH":  {"addr": "0x2d62109243b87c4ba3ee7ba1d91b0dd0a074d7b1", "underlying": "rsETH",  "decimals": 18},
    "a_wstETH": {"addr": "0x0B925eD163218f6662a35e0f0371Ac234f9E9371", "underlying": "wstETH", "decimals": 18},
    "a_cbETH":  {"addr": "0x977b6fc5dE62598B08C85AC8Cf2b745874E8b78c", "underlying": "cbETH",  "decimals": 18},
    "a_weETH":  {"addr": "0xbdfa7b7893081b35fb54027489e2bc7a38275129", "underlying": "weETH",  "decimals": 18},
}

# Which dependency-graph node IDs a token "touches"
TOKEN_TO_NODES: dict[str, list[str]] = {
    "rsETH":   ["rseth",   "kelp_dao",    "eigenlayer", "layerzero"],
    "agETH":   ["ageth",   "kelp_dao",    "eigenlayer", "penpie"],
    "wstETH":  ["wsteth",  "lido"],
    "stETH":   ["wsteth",  "lido"],
    "cbETH":   ["cbeth",   "coinbase_lst","raft"],
    "weETH":   ["weeth",   "etherfi",     "eigenlayer"],
    "ezETH":   ["ezeth",   "renzo",       "eigenlayer"],
    "rswETH":  ["rsweth",  "swell",       "eigenlayer"],
    "mETH":    ["meth",    "mantle"],
    "sfrxETH": ["sfrxeth", "frax"],
    "ankrETH": ["ankreth", "ankr"],
    "swETH":   ["sweth",   "swell"],
    "ETHx":    [],
}

AAVE_PROTOCOL_NODES = ["aave_v3", "lrt_oracle", "chainlink"]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sel(sig: str) -> str:
    h = keccak.new(digest_bits=256)
    h.update(sig.encode())
    return "0x" + h.hexdigest()[:8]

SEL_BALANCE_OF = _sel("balanceOf(address)")


def _addr_arg(addr: str) -> str:
    return "000000000000000000000000" + addr[2:].lower()


async def _balance_of(wallet: str, token_addr: str, decimals: int,
                      client: httpx.AsyncClient) -> float:
    user_arg = _addr_arg(wallet)
    for rpc in RPC_ENDPOINTS:
        try:
            r = await client.post(rpc, json={
                "jsonrpc": "2.0", "method": "eth_call",
                "params": [{"to": token_addr, "data": SEL_BALANCE_OF + user_arg}, "latest"],
                "id": 1,
            })
            result = r.json().get("result", "0x")
            if result and result != "0x":
                return int(result, 16) / (10 ** decimals)
            return 0.0
        except Exception:
            continue
    return 0.0


async def _batch_balances(wallet: str, token_map: dict,
                          client: httpx.AsyncClient) -> dict[str, float]:
    """Fire all balanceOf calls concurrently."""
    tasks = [
        _balance_of(wallet, info["addr"], info["decimals"], client)
        for info in token_map.values()
    ]
    results = await asyncio.gather(*tasks)
    return dict(zip(token_map.keys(), results))


WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"

async def _fetch_eth_price(client: httpx.AsyncClient) -> float:
    """Fetch current ETH/USD price from DeFiLlama as fallback reference."""
    try:
        r = await client.get(
            f"{LLAMA_COINS}/prices/current/ethereum:{WETH_ADDRESS}",
            timeout=5,
        )
        if r.status_code == 200:
            coins = r.json().get("coins", {})
            price = coins.get(f"ethereum:{WETH_ADDRESS}", {}).get("price", 0.0)
            if price > 0:
                return price
    except Exception:
        pass
    return 0.0


async def _fetch_prices(symbols: list[str], client: httpx.AsyncClient) -> dict[str, float]:
    """Fetch USD prices from DeFiLlama for the given token symbols."""
    all_tokens = {**LST_LRT_TOKENS}
    coins_param = ",".join(
        f"ethereum:{all_tokens[s]['addr']}"
        for s in symbols if s in all_tokens
    )
    if not coins_param:
        return {}
    try:
        r = await client.get(f"{LLAMA_COINS}/prices/current/{coins_param}", timeout=8)
        if r.status_code == 200:
            coins = r.json().get("coins", {})
            out = {}
            for s in symbols:
                if s not in all_tokens:
                    continue
                key = f"ethereum:{all_tokens[s]['addr']}"
                out[s] = coins.get(key, {}).get("price", 0.0)
            return out
    except Exception:
        pass
    return {}


# ── DeBank path ───────────────────────────────────────────────────────────────

async def _fetch_debank(wallet: str, api_key: str,
                        client: httpx.AsyncClient) -> list[dict]:
    """
    DeBank Cloud API: GET /v1/user/token_list
    Returns raw list of token objects (id, symbol, amount, price, ...).
    """
    try:
        r = await client.get(
            f"{DEBANK_BASE}/user/token_list",
            params={"id": wallet.lower(), "chain_id": "eth", "is_all": "false"},
            headers={"AccessKey": api_key},
            timeout=15.0,
        )
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return []


# ── Main entry ────────────────────────────────────────────────────────────────

async def fetch_wallet_portfolio(wallet: str) -> dict:
    """
    Returns full LST/LRT portfolio for an Ethereum wallet.

    Uses DeBank API when DEBANK_ACCESS_KEY env var is set;
    otherwise falls back to batch eth_call balanceOf (free, no auth).
    """
    debank_key = os.getenv("DEBANK_ACCESS_KEY", "").strip()
    holdings: list[dict] = []
    data_source = "onchain"

    async with httpx.AsyncClient(timeout=15.0) as client:

        # Fetch live ETH price once — used as fallback for ETH-correlated aTokens
        eth_price = await _fetch_eth_price(client)

        # ── DeBank path ────────────────────────────────────────────────────
        if debank_key:
            data_source = "debank"
            tokens = await _fetch_debank(wallet, debank_key, client)
            known_by_addr = {
                info["addr"].lower(): sym
                for sym, info in LST_LRT_TOKENS.items()
            }
            for t in tokens:
                addr = (t.get("id") or "").lower()
                sym = known_by_addr.get(addr)
                if not sym:
                    continue
                bal   = float(t.get("amount", 0) or 0)
                price = float(t.get("price",  0) or 0)
                if bal < 1e-6:
                    continue
                holdings.append({
                    "symbol":      sym,
                    "balance":     round(bal, 4),
                    "price_usd":   round(price, 2),
                    "value_usd":   round(bal * price, 2),
                    "category":    LST_LRT_TOKENS[sym]["category"],
                    "graph_nodes": TOKEN_TO_NODES.get(sym, []),
                    "source":      "wallet",
                })

            # DeBank doesn't expose Aave aToken directly; supplement with eth_call
            atoken_bals = await _batch_balances(wallet, AAVE_ATOKENS, client)
            _enrich_aave(atoken_bals, holdings, {}, default_price=eth_price)

        # ── eth_call fallback ──────────────────────────────────────────────
        else:
            raw_bals   = await _batch_balances(wallet, LST_LRT_TOKENS, client)
            atoken_bals = await _batch_balances(wallet, AAVE_ATOKENS, client)

            # Symbols actually held (dust filter: > 0.001)
            held = [s for s, b in raw_bals.items() if b > 0.001]
            # Always fetch prices for Aave underlying tokens too,
            # so _enrich_aave doesn't fall back to the stale default_price.
            aave_underlyings = list({v["underlying"] for v in AAVE_ATOKENS.values()})
            price_symbols = list(set(held + aave_underlyings))
            prices = await _fetch_prices(price_symbols, client) if price_symbols else {}

            for sym in held:
                bal   = raw_bals[sym]
                price = prices.get(sym, 0.0)
                holdings.append({
                    "symbol":      sym,
                    "balance":     round(bal, 4),
                    "price_usd":   round(price, 2),
                    "value_usd":   round(bal * price, 2),
                    "category":    LST_LRT_TOKENS[sym]["category"],
                    "graph_nodes": TOKEN_TO_NODES.get(sym, []),
                    "source":      "wallet",
                })

            _enrich_aave(atoken_bals, holdings, prices, default_price=eth_price)

    # Aggregate exposed graph nodes
    exposed: set[str] = set()
    for h in holdings:
        exposed.update(h.get("graph_nodes") or [])

    total_value = sum(h["value_usd"] for h in holdings)

    return {
        "address":             wallet,
        "holdings":            sorted(holdings, key=lambda x: x["value_usd"], reverse=True),
        "total_lst_lrt_usd":   round(total_value, 2),
        "exposed_graph_nodes": sorted(exposed),
        "data_source":         data_source,
    }


def _enrich_aave(atoken_bals: dict[str, float],
                 holdings: list[dict],
                 prices: dict[str, float],
                 default_price: float) -> None:
    """Append Aave V3 deposit entries from aToken balances."""
    for akey, bal in atoken_bals.items():
        if bal < 0.001:
            continue
        underlying = AAVE_ATOKENS[akey]["underlying"]
        price = prices.get(underlying, default_price)
        holdings.append({
            "symbol":      f"{underlying} (Aave V3)",
            "balance":     round(bal, 4),
            "price_usd":   round(price, 2),
            "value_usd":   round(bal * price, 2),
            "category":    "aave_collateral",
            "graph_nodes": (TOKEN_TO_NODES.get(underlying, []) + AAVE_PROTOCOL_NODES),
            "source":      "aave_v3",
        })
