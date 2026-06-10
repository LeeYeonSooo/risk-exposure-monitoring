"""
Alchemy archive node wrapper.

Fetches historical Aave V3 state at specific past blocks.
Requires ALCHEMY_API_KEY environment variable (or passed directly).

All eth_call invocations use the block parameter to query any historical state.
DeFiLlama historical price/TVL APIs are used for DEX liquidity (no archive needed).
"""

from __future__ import annotations

import os
import asyncio
import socket
import subprocess
import time as _time
import httpx
from typing import List, Optional, Tuple
from Crypto.Hash import keccak

def _alchemy_rpc() -> str:
    """Resolve ALCHEMY_API_KEY lazily so module import succeeds without it
    (e.g. in CI/test collection); fail loud at the first request site."""
    key = os.getenv("ALCHEMY_API_KEY")
    if not key:
        raise RuntimeError(
            "ALCHEMY_API_KEY environment variable is required. "
            "Set it in backend/.env or your shell."
        )
    return f"https://eth-mainnet.g.alchemy.com/v2/{key}"


# Module-level constants preserved for compatibility; consumers should use _alchemy_rpc()
ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY") or ""
ALCHEMY_RPC = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}" if ALCHEMY_KEY else ""

LLAMA_COINS = "https://coins.llama.fi"
LLAMA_YIELDS = "https://yields.llama.fi"

# ── CAPO Oracle (Aave rsETH/USD capped oracle) ───────────────────────────────
CAPO_ADDRESS       = "0x7292C95A5f6A501a9c4B34f6393e221F2A0139c3"
SEL_LATEST_ANSWER  = "0x50d25bcd"   # latestAnswer() → int256

# ── Fluid DEX (main rsETH/ETH pool, pre-hack $8.5M TVL) ─────────────────────
FLUID_DEX_POOL     = "0x276084527B801e00Db8E4410504F9BaF93f72C67"
FLUID_DEX_RESOLVER = "0x05Bd8269A20C472b148246De20E6852091BF16Ff"
# estimateSwapIn(address dex_, bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_)
SEL_ESTIMATE_SWAP_IN = "0xbb39e3a1"

RSETH_ADDRESS      = "0xA1290d69c65A6Fe4DF752f95823fAE25cB99e5A7"
RSETH_ATOKEN       = "0x2d62109243b87c4ba3ee7ba1d91b0dd0a074d7b1"
EZETH_ADDRESS      = "0x2416092f143378750bb29b79eD961ab195CcEea5"
AAVE_DATA_PROVIDER = "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3"
AAVE_PRICE_ORACLE  = "0x54586bE62E3c3580375aE3723C145253060Ca0C2"
AAVE_POOL          = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"

# Aave V2 stETH (for 2022 backtest)
STETH_ADDRESS         = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"
STETH_ATOKEN_V2       = "0x1982b2F5814301d4e9a8b0201555376e62F82428"
AAVE_V2_LENDING_POOL  = "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9"
AAVE_V2_DATA_PROVIDER = "0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d"
AAVE_V2_PRICE_ORACLE  = "0xA50ba011c48153De246E5192C8f9258A2ba79Ca9"

# Known DeFiLlama pool IDs per asset (for fast historical TVL lookup)
DEX_POOL_HISTORIES: dict[str, dict[str, str]] = {
    "rseth": {
        "fluid_rseth_eth":    "acbd8c1e-4dcc-4297-9ef1-b7cb9c5e421f",
        "balancer_rseth_weth": "35b11a4c-149e-44e5-b0e4-b092abddde64",
    },
    # ezETH pools discovered dynamically via DeFiLlama /pools search
    "ezeth": {},
}


def _sel(sig: str) -> str:
    h = keccak.new(digest_bits=256)
    h.update(sig.encode())
    return "0x" + h.hexdigest()[:8]

def _addr_arg(addr: str) -> str:
    return "000000000000000000000000" + addr[2:].lower()

def _words(hex_result: str) -> list:
    d = hex_result[2:]
    return [int(d[i:i+64], 16) for i in range(0, len(d), 64)]

SEL_TOTAL_SUPPLY   = "0x18160ddd"
SEL_ASSET_PRICE    = _sel("getAssetPrice(address)")
SEL_CONFIG_DATA    = _sel("getReserveConfigurationData(address)")
SEL_RESERVE_DATA   = _sel("getReserveData(address)")
SEL_EMODE_DATA     = _sel("getEModeCategoryData(uint8)")


async def _eth_call_at(client: httpx.AsyncClient, to: str, data: str, block: int) -> Optional[str]:
    """eth_call at a specific historical block via Alchemy archive."""
    try:
        resp = await client.post(_alchemy_rpc(), json={
            "jsonrpc": "2.0", "method": "eth_call",
            "params": [{"to": to, "data": data}, hex(block)],
            "id": 1,
        })
        result = resp.json().get("result", "")
        return result if (result and result != "0x") else None
    except Exception:
        return None


async def fetch_aave_state_at_block(block: int) -> dict:
    """
    Fetch Aave V3 rsETH reserve state at a specific historical block.

    Returns:
        atoken_supply   : total rsETH deposited in Aave V3 (rsETH)
        oracle_price    : Chainlink rsETH price via Aave oracle (USD)
        lt_normal       : liquidation threshold, normal mode
        lt_emode        : liquidation threshold, eMode cat1
        liq_bonus_emode : eMode liquidation bonus (0.95 = -5% for liquidator)
        market_frozen   : True if rsETH market was frozen at that block
    """
    arg = _addr_arg(RSETH_ADDRESS)
    emode_arg = "0000000000000000000000000000000000000000000000000000000000000001"

    async with httpx.AsyncClient(timeout=15.0) as client:
        tasks = [
            _eth_call_at(client, RSETH_ATOKEN,       SEL_TOTAL_SUPPLY,         block),
            _eth_call_at(client, AAVE_PRICE_ORACLE,  SEL_ASSET_PRICE + arg,    block),
            _eth_call_at(client, AAVE_DATA_PROVIDER, SEL_CONFIG_DATA + arg,    block),
            _eth_call_at(client, AAVE_POOL,          SEL_EMODE_DATA + emode_arg, block),
        ]
        supply_raw, price_raw, cfg_raw, emode_raw = await asyncio.gather(*tasks)

    result = {}

    if supply_raw:
        result["atoken_supply"] = int(supply_raw, 16) / 1e18

    if price_raw:
        result["oracle_price"] = int(price_raw, 16) / 1e8

    if cfg_raw:
        cfg = _words(cfg_raw)
        result["lt_normal"]      = cfg[2] / 10_000
        result["market_frozen"]  = bool(cfg[9])

    if emode_raw:
        # ABI layout: w[0]=offset_ptr(32), w[1]=ltv, w[2]=liquidationThreshold,
        # w[3]=liquidationBonus, w[4]=priceSource, w[5]=label_offset, w[6]=label_len
        w = _words(emode_raw)
        result["ltv_emode"]       = w[1] / 10_000  # max borrowing capacity (LTV)
        result["lt_emode"]        = w[2] / 10_000  # liquidation threshold
        result["liq_bonus_emode"] = w[3] / 10_000  # liquidation bonus

    return result


async def fetch_aave_v2_steth_state_at_block(block: int) -> dict:
    """
    Fetch Aave V2 stETH reserve state at a specific historical block.
    Returns atoken_supply (stETH), oracle_price (USD), lt_normal, market_frozen.
    Aave V2 has no eMode — lt_emode and liq_bonus_emode are not returned.
    """
    arg = _addr_arg(STETH_ADDRESS)

    async with httpx.AsyncClient(timeout=15.0) as client:
        tasks = [
            _eth_call_at(client, STETH_ATOKEN_V2,      SEL_TOTAL_SUPPLY,      block),
            _eth_call_at(client, AAVE_V2_PRICE_ORACLE,  SEL_ASSET_PRICE + arg, block),
            _eth_call_at(client, AAVE_V2_DATA_PROVIDER, SEL_CONFIG_DATA + arg, block),
        ]
        supply_raw, price_raw, cfg_raw = await asyncio.gather(*tasks)

    result = {}
    if supply_raw:
        result["atoken_supply"] = int(supply_raw, 16) / 1e18
    if price_raw:
        result["oracle_price"] = int(price_raw, 16) / 1e8
    if cfg_raw:
        cfg = _words(cfg_raw)
        # Aave V2 getReserveConfigurationData: decimals(0), ltv(1), lt(2), bonus(3), ..., isFrozen(9)
        result["lt_normal"]     = cfg[2] / 10_000
        result["market_frozen"] = bool(cfg[9])

    return result


async def fetch_token_price_at_timestamp(token_addr: str, timestamp: int) -> Optional[float]:
    """Fetch historical token price from DeFiLlama coins API (no archive needed)."""
    coin = f"ethereum:{token_addr}"
    url = f"{LLAMA_COINS}/prices/historical/{timestamp}/{coin}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                return resp.json().get("coins", {}).get(coin, {}).get("price")
    except Exception:
        pass
    return None


async def _fetch_pool_tvl_at_date(client: httpx.AsyncClient, pool_id: str, date_prefix: str) -> float:
    """Fetch historical TVL for a single DeFiLlama pool on a given date."""
    try:
        resp = await client.get(f"{LLAMA_YIELDS}/chart/{pool_id}")
        if resp.status_code != 200:
            return 0.0
        data = resp.json().get("data", [])
        matches = [d for d in data if d.get("timestamp", "").startswith(date_prefix)]
        if matches:
            return matches[-1].get("tvlUsd", 0.0)
        # fallback: nearest date entry
        dated = [(d.get("timestamp", "")[:10], d.get("tvlUsd", 0.0)) for d in data if d.get("timestamp")]
        if dated:
            dated.sort(key=lambda x: x[0])
            return dated[-1][1]
    except Exception:
        pass
    return 0.0


async def _search_dex_liquidity(symbol: str, date_prefix: str) -> float:
    """
    Dynamically discover DeFiLlama Ethereum pools containing a symbol
    and sum their historical TVL at the given date.
    """
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(f"{LLAMA_YIELDS}/pools")
        if resp.status_code != 200:
            return 0.0
        all_pools = resp.json().get("data", [])

    sym_lower = symbol.lower()
    eth_pools = [
        p for p in all_pools
        if sym_lower in p.get("symbol", "").lower()
        and p.get("chain", "") == "Ethereum"
        and p.get("tvlUsd", 0) > 50_000
    ]
    eth_pools.sort(key=lambda p: p.get("tvlUsd", 0), reverse=True)

    total = 0.0
    async with httpx.AsyncClient(timeout=15.0) as client:
        tasks = [
            _fetch_pool_tvl_at_date(client, p["pool"], date_prefix)
            for p in eth_pools[:5] if p.get("pool")
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results:
            if isinstance(r, (int, float)):
                total += r
    return total


async def fetch_dex_liquidity_at_date(date_prefix: str, asset: str = "rseth") -> float:
    """
    Fetch total DEX liquidity for an asset at a given date from DeFiLlama.
    date_prefix: e.g. "2026-04-17"
    asset: "rseth" or "ezeth"
    Returns total TVL in USD.
    """
    pool_map = DEX_POOL_HISTORIES.get(asset.lower(), {})
    if pool_map:
        total = 0.0
        async with httpx.AsyncClient(timeout=12.0) as client:
            tasks = [
                _fetch_pool_tvl_at_date(client, pool_id, date_prefix)
                for pool_id in pool_map.values()
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for r in results:
                if isinstance(r, (int, float)):
                    total += r
        return total
    # Dynamic discovery for assets without hardcoded pool IDs
    return await _search_dex_liquidity(asset.upper(), date_prefix)


async def find_block_near_timestamp(timestamp: int) -> int:
    """
    Estimate block number near a given Unix timestamp using current block rate.
    ~7,200 blocks/day on Ethereum mainnet post-merge.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(_alchemy_rpc(), json={
            "jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1,
        })
        current_block = int(resp.json()["result"], 16)

    import time
    now = int(time.time())
    delta_seconds = now - timestamp
    delta_blocks = int(delta_seconds / 12)  # ~12s per block post-merge
    return max(current_block - delta_blocks, 0)


async def fetch_capo_oracle_sequence(
    start_block: int,
    num_blocks: int = 160,
    batch_size: int = 40,
) -> List[float]:
    """
    Query CAPO latestAnswer() for each block in [start_block, start_block + num_blocks).

    Returns a list of rsETH/USD prices (float, 8-decimal scaled).
    Used to inject real on-chain oracle values into the backtest simulation tick-by-tick,
    replacing the ChainlinkOracleModel formula with actual historical data.

    Fetches in batches of batch_size to respect Alchemy rate limits.
    Missing/failed blocks are forward-filled from the last valid price.
    """
    prices: List[Optional[float]] = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        for batch_start in range(0, num_blocks, batch_size):
            batch_end = min(batch_start + batch_size, num_blocks)
            tasks = [
                _eth_call_at(client, CAPO_ADDRESS, SEL_LATEST_ANSWER, start_block + i)
                for i in range(batch_start, batch_end)
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for r in results:
                if r and not isinstance(r, Exception):
                    try:
                        prices.append(int(r, 16) / 1e8)
                    except (ValueError, TypeError):
                        prices.append(None)
                else:
                    prices.append(None)
            # Brief pause between batches to avoid rate limiting
            if batch_end < num_blocks:
                await asyncio.sleep(0.5)

    # Forward-fill None entries from last valid price
    last_valid: Optional[float] = None
    filled: List[float] = []
    for p in prices:
        if p is not None:
            last_valid = p
        if last_valid is not None:
            filled.append(last_valid)
    return filled


def _find_free_port() -> int:
    """Find an available TCP port for Anvil."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


async def _wait_for_anvil(rpc_url: str, timeout_s: float = 15.0) -> bool:
    """Poll Anvil RPC until it responds or timeout."""
    deadline = _time.monotonic() + timeout_s
    async with httpx.AsyncClient(timeout=2.0) as client:
        while _time.monotonic() < deadline:
            try:
                resp = await client.post(rpc_url, json={
                    "jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1,
                })
                if resp.status_code == 200:
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.5)
    return False


async def _eth_call_local(
    client: httpx.AsyncClient, rpc_url: str, to: str, data: str
) -> Optional[str]:
    """eth_call against a local Anvil fork (no block tag — uses latest = forked block)."""
    try:
        resp = await client.post(rpc_url, json={
            "jsonrpc": "2.0", "method": "eth_call",
            "params": [{"to": to, "data": data}, "latest"],
            "id": 1,
        })
        result = resp.json().get("result", "")
        return result if (result and result != "0x") else None
    except Exception:
        return None


async def fetch_fluid_impact_curve_at_block(
    block: int,
    rseth_price_usd: float,
    eth_price_usd: Optional[float] = None,
) -> List[Tuple[float, float]]:
    """
    Fork Ethereum at `block` via Anvil and query Fluid DEX estimateSwapIn
    for multiple rsETH sell sizes to build a real price-impact curve.

    The pool at the pre-hack block was active (not paused), so estimateSwapIn
    returns real ETH output — unlike the current paused state.

    Args:
        block:           Block to fork at (e.g. 24_895_000 for kelp_2026 pre-hack).
        rseth_price_usd: rsETH oracle price at that block (for USD → rsETH conversion).
        eth_price_usd:   ETH/USD at that block. If None, derived as rseth_price_usd / rseth_eth_ratio
                         using rsETH/ETH ≈ 1.0718 (KelpDAO LRTOracle at pre-hack).

    Returns:
        List of (sell_usd, impact_fraction) tuples sorted by sell_usd.
        impact_fraction is in [0, 0.99].
        Returns [] on failure (caller should fall back to formula model).
    """
    if eth_price_usd is None:
        # rsETH/ETH ratio ≈ 1.0718 at pre-hack block
        eth_price_usd = rseth_price_usd / 1.0718

    # eth_per_rseth: how many ETH you receive for 1 rsETH at fair value (~1.0718)
    # = rseth_price_usd / eth_price_usd  (e.g. 2509.97 / 2342 ≈ 1.0718)
    eth_per_rseth = rseth_price_usd / eth_price_usd

    port = _find_free_port()
    rpc_url = f"http://127.0.0.1:{port}"

    proc = subprocess.Popen(
        [
            "anvil",
            "--fork-url", _alchemy_rpc(),
            "--fork-block-number", str(block),
            "--port", str(port),
            "--silent",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ready = await _wait_for_anvil(rpc_url, timeout_s=20.0)
        if not ready:
            return []

        # Sample sell amounts in USD
        sell_amounts_usd = [
            100_000, 300_000, 500_000, 1_000_000,
            2_000_000, 3_000_000, 5_000_000, 8_500_000, 15_000_000,
        ]

        curve: List[Tuple[float, float]] = []

        async with httpx.AsyncClient(timeout=10.0) as client:
            for sell_usd in sell_amounts_usd:
                sell_rseth = sell_usd / rseth_price_usd
                sell_wei = int(sell_rseth * 1e18)

                # ABI-encode: estimateSwapIn(address, bool, uint256, uint256)
                # pool address (padded to 32 bytes)
                pool_arg = "000000000000000000000000" + FLUID_DEX_POOL[2:].lower()
                # swap0to1 = True (rsETH=token0 → ETH=token1)
                bool_arg = "0000000000000000000000000000000000000000000000000000000000000001"
                # amountIn (uint256)
                amount_arg = hex(sell_wei)[2:].zfill(64)
                # amountOutMin = 0
                min_arg = "0" * 64

                data = SEL_ESTIMATE_SWAP_IN + pool_arg + bool_arg + amount_arg + min_arg

                result = await _eth_call_local(client, rpc_url, FLUID_DEX_RESOLVER, data)
                if not result:
                    continue
                try:
                    eth_out = int(result, 16) / 1e18
                except (ValueError, TypeError):
                    continue

                if eth_out <= 0:
                    continue  # pool returned 0 → likely still paused at this block, skip

                # Expected ETH at current DEX price (zero slippage):
                # sell X rsETH → expect X * eth_per_rseth ETH (e.g. X * 1.0718 ETH)
                expected_eth = sell_rseth * eth_per_rseth
                impact = max(0.0, 1.0 - eth_out / expected_eth) if expected_eth > 0 else 0.0
                curve.append((sell_usd, min(impact, 0.99)))

        return curve

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


async def _eth_get_logs(
    client: httpx.AsyncClient,
    from_block: int,
    to_block: int,
    address: str,
    topics: list,
) -> Optional[list]:
    """eth_getLogs for a block range via Alchemy."""
    try:
        resp = await client.post(_alchemy_rpc(), json={
            "jsonrpc": "2.0",
            "method": "eth_getLogs",
            "params": [{
                "fromBlock": hex(from_block),
                "toBlock": hex(to_block),
                "address": address,
                "topics": topics,
            }],
            "id": 1,
        })
        data = resp.json()
        if "error" in data:
            return None
        return data.get("result", [])
    except Exception:
        return None


# ── Aave V3 LiquidationCall event ────────────────────────────────────────────
# LiquidationCall(address indexed collateralAsset, address indexed debtAsset,
#                 address indexed user, uint256 debtToCover,
#                 uint256 liquidatedCollateralAmount, address liquidator,
#                 bool receiveAToken)
LIQUIDATION_CALL_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"

# Chunk size for eth_getLogs (Alchemy caps at 10_000 logs per request; 2_000-block
# chunks are conservative enough to stay under that limit even in high-activity periods)
_LOG_CHUNK_BLOCKS = 2_000


async def fetch_aave_liquidation_events(
    start_block: int,
    end_block: int,
    rseth_price_usd: float,
    eth_price_usd: float,
    *,
    pool_addr: str = None,
    collateral_addr: str = None,
    collateral_decimals: int = 18,
) -> dict:
    """
    Query real LiquidationCall events for a given collateral asset on Aave V2 or V3.

    Both V2 (LendingPool) and V3 (Pool) emit the same event topic, so this
    function works for either by passing the right `pool_addr`. Defaults to
    Aave V3 Pool + rsETH for backwards compatibility.

    Args:
        start_block:         First block to scan (inclusive).
        end_block:           Last block to scan (inclusive).
        rseth_price_usd:     Collateral asset USD price for valuation.
        eth_price_usd:       ETH/USD for converting WETH-denominated debt.
        pool_addr:           Lending pool contract (default: AAVE_V3 Pool).
        collateral_addr:     Collateral token address (default: RSETH).
        collateral_decimals: ERC-20 decimals of the collateral (default: 18).

    Returns dict with:
        total_liquidations               : count of LiquidationCall events
        total_liquidated_collateral_rseth: sum of liquidated collateral (in token units)
        total_debt_covered_eth           : sum of debt covered (in debt token / 1e18)
        estimated_bad_debt_usd           : debt_usd - collateral_usd (positive = bad debt)
        raw_events                       : list of parsed per-event dicts
    """
    pool_addr       = pool_addr       or AAVE_POOL
    collateral_addr = collateral_addr or RSETH_ADDRESS
    # topic[1] = collateralAsset (padded to 32 bytes, lowercase)
    rseth_topic = "0x000000000000000000000000" + collateral_addr[2:].lower()
    _decimals_div = 10 ** collateral_decimals

    raw_events: list[dict] = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        block = start_block
        while block <= end_block:
            chunk_end = min(block + _LOG_CHUNK_BLOCKS - 1, end_block)
            logs = await _eth_get_logs(
                client,
                from_block=block,
                to_block=chunk_end,
                address=pool_addr,
                topics=[LIQUIDATION_CALL_TOPIC, rseth_topic],
            )
            if logs:
                for log in logs:
                    data_hex = log.get("data", "0x")[2:]
                    if len(data_hex) < 128:
                        continue  # malformed — skip
                    try:
                        debt_to_cover_raw = int(data_hex[0:64], 16)
                        liquidated_collateral_raw = int(data_hex[64:128], 16)
                    except ValueError:
                        continue
                    raw_events.append({
                        "block_number": int(log.get("blockNumber", "0x0"), 16),
                        "tx_hash": log.get("transactionHash", ""),
                        "debt_to_cover_raw": debt_to_cover_raw,
                        "liquidated_collateral_raw": liquidated_collateral_raw,
                        # topics[2] = debtAsset (indexed), topics[3] = user (indexed)
                        "debt_asset": log.get("topics", [None, None, None])[2] if len(log.get("topics", [])) > 2 else None,
                        "user": log.get("topics", [None, None, None, None])[3] if len(log.get("topics", [])) > 3 else None,
                    })
            # Rate-limit guard between chunks
            if chunk_end < end_block:
                await asyncio.sleep(0.25)
            block = chunk_end + 1

    # Aggregate totals
    total_liquidated_collateral_rseth = sum(
        e["liquidated_collateral_raw"] / _decimals_div for e in raw_events
    )
    # debtToCover is denominated in the debt asset (usually WETH = 18 decimals).
    # We assume WETH here; if the debt asset is USDC (6 decimals) the caller
    # should override eth_price_usd=1.0 and pass the raw amount / 1e6.
    total_debt_covered_eth = sum(
        e["debt_to_cover_raw"] / 1e18 for e in raw_events
    )

    collateral_seized_usd = total_liquidated_collateral_rseth * rseth_price_usd
    debt_covered_usd = total_debt_covered_eth * eth_price_usd
    # Positive estimated_bad_debt_usd → Aave absorbed losses (debt > collateral value)
    estimated_bad_debt_usd = debt_covered_usd - collateral_seized_usd

    return {
        "total_liquidations": len(raw_events),
        "total_liquidated_collateral_rseth": round(total_liquidated_collateral_rseth, 4),
        "total_debt_covered_eth": round(total_debt_covered_eth, 4),
        "collateral_seized_usd": round(collateral_seized_usd, 2),
        "debt_covered_usd": round(debt_covered_usd, 2),
        "estimated_bad_debt_usd": round(estimated_bad_debt_usd, 2),
        "raw_events": raw_events,
    }


async def fetch_aave_weth_bad_debt(measure_block: int) -> dict:
    """
    Measure actual Aave V3 bad debt using getReserveDeficit(WETH) at a specific block.

    getReserveDeficit is an Aave V3.1 function that accumulates each time a liquidation
    results in bad debt (i.e. collateral seized < debt repaid). For the KelpDAO 2026
    incident, the WETH deficit appeared at block 25,040,000 after forced governance
    liquidation of the 8 attacker positions.

    This is INDEPENDENT from the simulation engine formula
    (engine: minted_rseth × oracle_price × ltv; this function: on-chain deficit counter).

    Args:
        measure_block: block at which to read the deficit (≥ 25_040_000 for kelp_2026)

    Returns dict with:
        weth_deficit:    WETH amount written off as bad debt
        eth_price_usd:   ETH/USD from Aave oracle at measure_block
        bad_debt_usd:    weth_deficit × eth_price_usd
        block:           measure_block used
        method:          "getReserveDeficit(WETH)"
    """
    WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
    sel_deficit = _sel("getReserveDeficit(address)")
    sel_price   = _sel("getAssetPrice(address)")

    async with httpx.AsyncClient(timeout=15.0) as client:
        r_deficit, r_price = await asyncio.gather(
            _eth_call_at(client, AAVE_POOL,          sel_deficit + _addr_arg(WETH), measure_block),
            _eth_call_at(client, AAVE_PRICE_ORACLE,  sel_price   + _addr_arg(WETH), measure_block),
        )

    # Fail loud on RPC failure — silently coercing missing data to 0 produces
    # misleading "bad_debt=$0" results that look like "no event happened".
    if not r_deficit or r_deficit == "0x":
        raise RuntimeError(
            f"getReserveDeficit(WETH) returned empty at block {measure_block}. "
            "Check ALCHEMY_API_KEY is set and the block is reachable via archive."
        )
    if not r_price or r_price == "0x":
        raise RuntimeError(
            f"getAssetPrice(WETH) returned empty at block {measure_block}."
        )

    weth_deficit  = int(r_deficit, 16) / 1e18
    eth_price_usd = int(r_price,   16) / 1e8
    bad_debt_usd  = weth_deficit * eth_price_usd

    return {
        "weth_deficit":  round(weth_deficit,  4),
        "eth_price_usd": round(eth_price_usd, 2),
        "bad_debt_usd":  round(bad_debt_usd,  0),
        "block":         measure_block,
        "method":        "getReserveDeficit(WETH)",
    }


async def get_latest_block() -> int:
    """Get the current Ethereum block number from Alchemy."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(_alchemy_rpc(), json={
            "jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1,
        })
        return int(resp.json()["result"], 16)


async def fetch_live_impact_curve(
    rseth_price_usd: float,
    eth_price_usd: Optional[float] = None,
) -> List[Tuple[float, float]]:
    """
    Build rsETH price impact curve from current on-chain DEX state.
    Same mechanism as the backtest Anvil fork, but targeting the current (latest) block.

    Pool priority:
    1. Fluid DEX (0x276084...) — main pool but currently paused; returns [] if still paused.
    2. If Fluid returns no points, returns [] so the caller can use the formula fallback.

    Args:
        rseth_price_usd: Current rsETH oracle price in USD.
        eth_price_usd:   Current ETH/USD price. If None, derived from rseth_price_usd
                         using the rsETH/ETH ratio of ~1.0718.

    Returns:
        List of (sell_usd, impact_fraction) tuples, or [] if all on-chain queries fail.
        On [] the caller should fall back to the formula model.
    """
    try:
        latest = await get_latest_block()
    except Exception:
        return []

    try:
        curve = await fetch_fluid_impact_curve_at_block(latest, rseth_price_usd, eth_price_usd)
    except Exception:
        curve = []

    if curve:
        return curve

    # Fluid DEX is paused at the current block — no points returned.
    # Return [] so simulation_runner uses the formula fallback.
    return []
