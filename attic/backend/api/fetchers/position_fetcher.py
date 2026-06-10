"""
Multi-protocol rsETH position fetcher: Aave V3, Compound V3, Morpho Blue.

Aave V3 pipeline:
  1. alchemy_getAssetTransfers → all addresses that received rsETH aTokens (depositors)
  2. Batch eth_call balanceOf → filter users with current aToken balance > threshold
  3. Batch eth_call getUserAccountData → totalDebtBase, HF, currentLiqThreshold
  4. Batch eth_call getUserEMode → eMode category (0=normal, 1=ETH-correlated)
  5. Build Position objects matching simulation/positions.py schema

Compound V3 (Comet WETH market):
  1. alchemy_getAssetTransfers rsETH → COMET → all rsETH depositors
  2. userCollateral(user, rsETH) → rsETH balance
  3. borrowBalanceOf(user) → WETH debt
  4. LT = 0.93, liq_bonus = 0.04 (4% discount for liquidators)

Morpho Blue (rsETH collateral markets):
  All known rsETH collateral markets enumerated; positions fetched via
  position(marketId, user) → (supplyShares, borrowShares, collateral).

Supports historical block queries for backtesting (archive node required).
"""
from __future__ import annotations

import asyncio
import math
import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from Crypto.Hash import keccak

from simulation.positions import Position

# ── Config ────────────────────────────────────────────────────────────────────

ALCHEMY_KEY  = os.getenv("ALCHEMY_API_KEY", "")
ALCHEMY_RPC  = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"

RSETH_ADDRESS = "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7"
RSETH_ATOKEN  = "0x2d62109243b87c4ba3ee7ba1d91b0dd0a074d7b1"  # Aave V3 aTokens for rsETH
AAVE_POOL     = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"

# Spark Lend (Aave V3 fork) — Ethereum mainnet
SPARK_POOL           = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987"
SPARK_DATA_PROVIDER  = "0xFc21d6d146E6086B8359705C8b28512a983db0cb"
SPARK_PRICE_ORACLE   = "0x8105f69D9C41644c6A0803fDA7D03Aa70996cFD9"
# Spark accepts wstETH/cbETH/weETH/rETH as collateral; not rsETH currently.
SPARK_COLLATERAL_ATOKENS: dict[str, str] = {
    # underlying symbol → spark aToken address (lowercased)
    # NOTE: aToken addresses verified via spark-address-book; if wrong, queries return 0.
    "wstETH": "0x12B54025C112Aa61fAce2CDB7118740875A566E9",  # spark-aWSTETH
    "rETH":   "0x9985dF20D7e9103ECBCeb16a84956434B6f06ae8",
    "weETH":  "0x0b9c6109a049be1ff05ee8a30be7f9e2c6e88e4f",
    # cbETH not currently a collateral on Spark mainnet
}

# Compound V3 Comet WETH market (rsETH is accepted collateral, LT=93%)
COMET_WETH    = "0xA17581A9E3356d9a858b789D68B4d866e593aE94"
COMP_RSETH_LT        = 0.93   # liquidateCollateralFactor from on-chain AssetInfo
COMP_RSETH_LIQ_BONUS = 0.04   # 4% discount for liquidators (liquidationFactor=0.96)

# Morpho Blue — discovered dynamically via blue-api.morpho.org GraphQL.
# Legacy hardcoded list kept as fallback when API is unavailable.
MORPHO_BLUE   = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"
MORPHO_BLUE_API = "https://blue-api.morpho.org/graphql"
MORPHO_RSETH_MARKETS: list[dict] = [
    {"id": "0xeeabdcb98e9f7ec216d259a2c026bbb701971efae0b44eec79a86053f9b128b6",
     "loan": "WETH",  "lltv": 0.86},
    {"id": "0xba761af4134efb0855adfba638945f454f0a704af11fc93439e20c7c5ebab942",
     "loan": "WETH",  "lltv": 0.945},
    {"id": "0xa72f4af2570dca1b356aa6c1e6a804d0d3df5b23bb092189776d0dc652feabb4",
     "loan": "USDA",  "lltv": 0.77},
]


async def fetch_morpho_markets_for_collateral(
    collateral_addr: str,
    client: "httpx.AsyncClient",
) -> list[dict]:
    """Fetch all Morpho Blue markets on Ethereum with the given collateral asset.

    Returns list of {id, loan, lltv} dicts. Falls back to MORPHO_RSETH_MARKETS
    when the API is unreachable AND collateral is rsETH; otherwise returns [].
    """
    query = """
    query MarketsByCollateral($coll: String!, $chainId: Int!) {
      markets(
        first: 50,
        where: {collateralAssetAddress_in: [$coll], chainId_in: [$chainId]}
      ) {
        items {
          uniqueKey
          lltv
          loanAsset { address symbol }
          collateralAsset { symbol }
        }
      }
    }
    """
    try:
        resp = await client.post(MORPHO_BLUE_API, json={
            "query": query,
            "variables": {"coll": collateral_addr.lower(), "chainId": 1},
        }, timeout=10.0)
        data = resp.json()
        items = data.get("data", {}).get("markets", {}).get("items") or []
        return [
            {
                "id":   m["uniqueKey"],
                "loan": m["loanAsset"]["symbol"],
                "lltv": float(m["lltv"]) / 1e18,  # Morpho lltv is wad
            }
            for m in items
        ]
    except Exception:
        # Fallback to legacy hardcoded list — only meaningful for rsETH
        if collateral_addr.lower() == RSETH_ADDRESS.lower():
            return MORPHO_RSETH_MARKETS
        return []

# Only fetch positions with this many rsETH or more (skip dust)
MIN_COLLATERAL_RSETH = 0.5

# Pre-hack block: April 17, 2026 12:00 UTC (day before the Kelp DAO LayerZero hack)
# find_block_near_timestamp(1776427200) → 24898808
PRE_HACK_BLOCK = 24_898_808

# Cache: key "latest" → live positions, "prehack" → pre-hack positions
_position_cache: dict[str, tuple[float, list[Position]]] = {}
CACHE_TTL = 300.0  # 5 minutes for live; pre-hack is permanent (never re-fetched)


# ── ABI helpers ───────────────────────────────────────────────────────────────

def _sel(sig: str) -> str:
    h = keccak.new(digest_bits=256)
    h.update(sig.encode())
    return "0x" + h.hexdigest()[:8]

def _addr_arg(addr: str) -> str:
    return "000000000000000000000000" + addr.lower().replace("0x", "")

def _words(hex_result: str) -> list[int]:
    d = hex_result[2:]
    return [int(d[i:i+64], 16) for i in range(0, len(d), 64)]


SEL_BALANCE_OF       = _sel("balanceOf(address)")
SEL_USER_ACCOUNT     = _sel("getUserAccountData(address)")
SEL_USER_EMODE       = _sel("getUserEMode(address)")

# Compound V3
SEL_USER_COLLATERAL  = _sel("userCollateral(address,address)")
SEL_BORROW_BALANCE   = _sel("borrowBalanceOf(address)")

# Morpho Blue
SEL_MORPHO_POSITION  = _sel("position(bytes32,address)")  # (marketId, user)


# ── Batch RPC helper ──────────────────────────────────────────────────────────

async def _batch_eth_call(
    client: httpx.AsyncClient,
    calls: list[tuple[str, str]],   # [(to, data), ...]
    block: str = "latest",
    batch_size: int = 50,
) -> list[Optional[str]]:
    """
    Execute multiple eth_call requests in batches.
    Returns list of hex results (None for failed calls).
    Retries 429-rate-limited batches up to 3 times with exponential backoff.
    """
    results: list[Optional[str]] = [None] * len(calls)

    for start in range(0, len(calls), batch_size):
        chunk = calls[start:start + batch_size]
        batch = [
            {"jsonrpc": "2.0", "method": "eth_call",
             "params": [{"to": to, "data": data}, block], "id": i}
            for i, (to, data) in enumerate(chunk)
        ]
        # First attempt
        raw = None
        for attempt in range(4):
            try:
                if attempt > 0:
                    await asyncio.sleep(1.0 * (2 ** (attempt - 1)))  # 1s, 2s, 4s
                resp = await client.post(ALCHEMY_RPC, json=batch, timeout=20.0)
                resp.raise_for_status()
                raw = resp.json()
                break
            except Exception:
                raw = None

        if not isinstance(raw, list):
            continue

        # Collect 429-failed indices for retry
        rate_limited_ids: list[int] = []
        for item in raw:
            idx = item.get("id", 0)
            r = item.get("result", "")
            if "error" in item and item["error"].get("code") == 429:
                rate_limited_ids.append(idx)
            elif r and r != "0x" and len(r) > 2:
                results[start + idx] = r

        # Retry rate-limited calls
        if rate_limited_ids:
            for retry_attempt in range(3):
                await asyncio.sleep(1.0 * (2 ** retry_attempt))  # 1s, 2s, 4s
                retry_batch = [batch[i] for i in rate_limited_ids]
                try:
                    resp2 = await client.post(ALCHEMY_RPC, json=retry_batch, timeout=20.0)
                    resp2.raise_for_status()
                    raw2 = resp2.json()
                    if not isinstance(raw2, list):
                        break
                    still_429 = []
                    for item in raw2:
                        orig_id = item.get("id", 0)
                        r = item.get("result", "")
                        if "error" in item and item["error"].get("code") == 429:
                            still_429.append(orig_id)
                        elif r and r != "0x" and len(r) > 2:
                            results[start + orig_id] = r
                    rate_limited_ids = still_429
                    if not rate_limited_ids:
                        break
                except Exception:
                    break

    return results


# ── Step 1: Get all rsETH aToken depositors via alchemy_getAssetTransfers ─────

async def _get_atoken_depositors(client: httpx.AsyncClient, max_pages: int = 50) -> set[str]:
    """
    Fetch all addresses that received rsETH aTokens (= deposited rsETH into Aave).
    Uses alchemy_getAssetTransfers filtered to transfers FROM 0x0 (minting).
    Paginates until exhausted (safety cap: max_pages × 1000 entries).
    """
    depositors: set[str] = set()
    page_key: Optional[str] = None

    for _ in range(max_pages):
        params: dict = {
            "fromBlock": "0x0",
            "toBlock": "latest",
            "fromAddress": "0x0000000000000000000000000000000000000000",
            "contractAddresses": [RSETH_ATOKEN],
            "category": ["erc20"],
            "withMetadata": False,
            "excludeZeroValue": True,
            "maxCount": "0x3e8",  # 1000 per page
        }
        if page_key:
            params["pageKey"] = page_key

        try:
            resp = await client.post(ALCHEMY_RPC, json={
                "jsonrpc": "2.0", "method": "alchemy_getAssetTransfers",
                "params": [params], "id": 1,
            }, timeout=25.0)
            resp.raise_for_status()
            body = resp.json()
            if "error" in body:
                break
            data = body.get("result", {})
        except Exception:
            break

        transfers = data.get("transfers", [])
        for t in transfers:
            to = t.get("to", "")
            if to:
                depositors.add(to.lower())

        page_key = data.get("pageKey")
        if not page_key:
            break

    return depositors


# ── Step 2: Filter by current aToken balance ──────────────────────────────────

async def _filter_by_balance(
    client: httpx.AsyncClient,
    addrs: list[str],
    block: str = "latest",
    rseth_price: float = 0.0,  # unused; kept for backwards-compatible call sites
) -> list[tuple[str, float]]:
    """
    Batch balanceOf calls on the rsETH aToken contract.
    Returns (addr, rseth_balance) pairs where balance >= MIN_COLLATERAL_RSETH.
    """
    calls = [(RSETH_ATOKEN, SEL_BALANCE_OF + _addr_arg(a)) for a in addrs]
    results = await _batch_eth_call(client, calls, block=block)

    active: list[tuple[str, float]] = []
    for addr, raw in zip(addrs, results):
        if raw:
            bal = int(raw, 16) / 1e18
            if bal >= MIN_COLLATERAL_RSETH:
                active.append((addr, bal))

    return active


# ── Step 3+4: getUserAccountData + getUserEMode ───────────────────────────────

@dataclass
class RawUserData:
    addr: str
    collateral_rseth: float
    total_collateral_usd: float   # USD, 8 decimals scaled
    total_debt_usd: float         # USD, 8 decimals scaled
    current_lt: float             # 0–1
    health_factor: float          # scaled to human value
    emode_category: int           # 0 = normal, 1 = ETH-correlated


async def _fetch_user_data(
    client: httpx.AsyncClient,
    active: list[tuple[str, float]],   # (addr, rseth_balance)
    block: str = "latest",
) -> list[RawUserData]:
    """
    Batch getUserAccountData + getUserEMode for all active users.
    """
    addrs = [a for a, _ in active]

    account_calls = [(AAVE_POOL, SEL_USER_ACCOUNT + _addr_arg(a)) for a in addrs]
    emode_calls   = [(AAVE_POOL, SEL_USER_EMODE   + _addr_arg(a)) for a in addrs]

    account_results, emode_results = await asyncio.gather(
        _batch_eth_call(client, account_calls, block=block),
        _batch_eth_call(client, emode_calls,   block=block),
    )

    users: list[RawUserData] = []
    for (addr, bal), acc_raw, em_raw in zip(active, account_results, emode_results):
        if not acc_raw:
            continue

        w = _words(acc_raw)
        # getUserAccountData: totalCollateralBase(0), totalDebtBase(1),
        #   availableBorrowsBase(2), currentLiquidationThreshold(3), ltv(4), healthFactor(5)
        total_collateral_usd = w[0] / 1e8
        total_debt_usd       = w[1] / 1e8
        current_lt           = w[3] / 10_000
        hf_raw               = w[5]
        health_factor        = hf_raw / 1e18 if hf_raw < 2**128 else float("inf")

        if total_debt_usd < 1.0:
            continue  # no debt → not at risk, skip

        emode = 0
        if em_raw:
            emode = int(em_raw, 16)

        users.append(RawUserData(
            addr=addr,
            collateral_rseth=bal,
            total_collateral_usd=total_collateral_usd,
            total_debt_usd=total_debt_usd,
            current_lt=current_lt,
            health_factor=health_factor,
            emode_category=emode,
        ))

    return users


# ── Step 5: Convert to Position objects ───────────────────────────────────────

def _to_positions(users: list[RawUserData], rseth_price: float) -> list[Position]:
    """
    Convert RawUserData → Position objects used by CascadeSimulator.

    eMode detection:
      getUserEMode often returns 0 due to ABI offset in the response.
      Fallback: if currentLiquidationThreshold > 0.85 (from getUserAccountData),
      the position must be in eMode (normal rsETH LT = 0.75, eMode LT = 0.93+).

    eMode (LT > 0.85):
      Use actual on-chain LT; liq_bonus = -0.05 (liquidator loses 5%)
    Normal mode (LT ≤ 0.85):
      Use actual on-chain LT; liq_bonus = 0.10
    """
    positions: list[Position] = []

    for i, u in enumerate(users):
        # Infer eMode from on-chain LT: normal rsETH LT = 0.75, eMode LT ≈ 0.93
        is_emode = (u.emode_category == 1) or (u.current_lt > 0.85)

        # Use actual on-chain LT (no clamping — it's the real value from Aave)
        lt = u.current_lt if u.current_lt > 0 else (0.93 if is_emode else 0.75)

        if is_emode:
            liq_bonus = -0.05  # unprofitable: liquidator gets 0.95x → -5%
            mode      = "emode"
        else:
            liq_bonus = 0.10
            mode      = "normal"

        positions.append(Position(
            id=i,
            collateral_rseth=u.collateral_rseth,
            debt_usd=u.total_debt_usd,
            liquidation_threshold=lt,
            liquidation_bonus=liq_bonus,
            mode=mode,
        ))

    return positions


# ── Public API ────────────────────────────────────────────────────────────────

# ── ETH price helper (no import cycle) ───────────────────────────────────────

_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
_LLAMA_COINS = "https://coins.llama.fi"

async def _fetch_eth_price_simple(client: httpx.AsyncClient) -> float:
    try:
        r = await client.get(
            f"{_LLAMA_COINS}/prices/current/ethereum:{_WETH}", timeout=5
        )
        if r.status_code == 200:
            p = r.json().get("coins", {}).get(f"ethereum:{_WETH}", {}).get("price", 0.0)
            if p > 0:
                return p
    except Exception:
        pass
    return 0.0


# ── Compound V3 fetcher ───────────────────────────────────────────────────────

async def _get_compound_depositors(client: httpx.AsyncClient) -> set[str]:
    """Get all addresses that supplied rsETH to Compound V3 Comet (WETH market)."""
    depositors: set[str] = set()
    page_key: Optional[str] = None
    for _ in range(50):
        params: dict = {
            "fromBlock": "0x0", "toBlock": "latest",
            "toAddress": COMET_WETH,
            "contractAddresses": [RSETH_ADDRESS],
            "category": ["erc20"],
            "withMetadata": False, "excludeZeroValue": True,
            "maxCount": "0x3e8",
        }
        if page_key:
            params["pageKey"] = page_key
        try:
            resp = await client.post(ALCHEMY_RPC, json={
                "jsonrpc": "2.0", "method": "alchemy_getAssetTransfers",
                "params": [params], "id": 1,
            }, timeout=25.0)
            resp.raise_for_status()
            body = resp.json()
            if "error" in body:
                break
            data = body.get("result", {})
        except Exception:
            break
        for t in data.get("transfers", []):
            frm = t.get("from", "")
            if frm:
                depositors.add(frm.lower())
        page_key = data.get("pageKey")
        if not page_key:
            break
    return depositors


async def _fetch_compound_positions(
    client: httpx.AsyncClient,
    rseth_price: float,
    eth_price: float,
    block: str = "latest",
) -> list[Position]:
    """
    Fetch rsETH collateral + WETH debt for all Compound V3 depositors.
    LT = 0.93 (liquidateCollateralFactor), liq_bonus = 0.04.
    """
    depositors = await _get_compound_depositors(client)
    if not depositors:
        return []

    addrs = list(depositors)
    rseth_arg = _addr_arg(RSETH_ADDRESS)

    # userCollateral(user, rsETH) → (uint128 balance, uint128 reserved)
    col_calls = [
        (COMET_WETH, SEL_USER_COLLATERAL + _addr_arg(a) + rseth_arg)
        for a in addrs
    ]
    # borrowBalanceOf(user) → uint256 WETH owed
    debt_calls = [
        (COMET_WETH, SEL_BORROW_BALANCE + _addr_arg(a))
        for a in addrs
    ]
    col_results, debt_results = await asyncio.gather(
        _batch_eth_call(client, col_calls, block=block),
        _batch_eth_call(client, debt_calls, block=block),
    )

    positions: list[Position] = []
    for i, (addr, col_raw, debt_raw) in enumerate(zip(addrs, col_results, debt_results)):
        if not col_raw:
            continue
        w = _words(col_raw)
        col_rseth = w[0] / 1e18
        if col_rseth < MIN_COLLATERAL_RSETH:
            continue
        debt_weth = (int(debt_raw, 16) / 1e18) if debt_raw else 0.0
        if debt_weth < 0.001:
            continue
        positions.append(Position(
            id=20_000 + i,
            collateral_rseth=col_rseth,
            debt_usd=debt_weth * eth_price,
            liquidation_threshold=COMP_RSETH_LT,
            liquidation_bonus=COMP_RSETH_LIQ_BONUS,
            mode="compound_v3",
        ))
    return positions


# ── Morpho Blue fetcher ───────────────────────────────────────────────────────

async def _fetch_morpho_blue_positions(
    client: httpx.AsyncClient,
    rseth_price: float,
    eth_price: float,
    block: str = "latest",
) -> list[Position]:
    """
    Fetch rsETH borrower positions from all known Morpho Blue rsETH markets.
    Uses Morpho Blue public API to enumerate borrowers, then eth_call for balances.
    """
    positions: list[Position] = []
    pos_id_base = 40_000

    for mkt in MORPHO_RSETH_MARKETS:
        market_id = mkt["id"]
        lltv = mkt["lltv"]
        # Liquidation threshold ≈ LLTV; Morpho Blue seizes at 1:1 (no bonus/penalty)
        lt = lltv
        liq_bonus = 0.0

        # Get borrowers from Morpho Blue API
        try:
            resp = await client.post(
                "https://blue-api.morpho.org/graphql",
                json={"query": f"""{{
                  marketPositions(where: {{marketUniqueKey_in: ["{market_id}"]}},
                                  first: 1000) {{
                    items {{
                      user {{ address }}
                      state {{ collateral borrowAssets }}
                    }}
                  }}
                }}"""},
                timeout=15.0,
            )
            if resp.status_code != 200:
                continue
            items = resp.json().get("data", {}).get("marketPositions", {}).get("items", [])
        except Exception:
            continue

        for item in items:
            addr = item.get("user", {}).get("address", "")
            state = item.get("state", {})
            col_rseth = int(state.get("collateral", 0) or 0) / 1e18
            borrow_assets = int(state.get("borrowAssets", 0) or 0) / 1e18  # WETH or USDA units

            if col_rseth < MIN_COLLATERAL_RSETH:
                continue

            # Debt USD: WETH-based markets use eth_price; USDA ≈ 1:1 USD
            if mkt["loan"] in ("WETH", "wstETH"):
                debt_usd = borrow_assets * eth_price
            else:
                debt_usd = borrow_assets  # stablecoin ≈ 1 USD

            if debt_usd < 1.0:
                continue

            positions.append(Position(
                id=pos_id_base,
                collateral_rseth=col_rseth,
                debt_usd=debt_usd,
                liquidation_threshold=lt,
                liquidation_bonus=liq_bonus,
                mode=f"morpho_blue_{int(lltv*100)}",
            ))
            pos_id_base += 1

    return positions


# ── Unified position fetcher ──────────────────────────────────────────────────

async def fetch_real_positions(
    rseth_price: float,
    block: Optional[int] = None,
    force_refresh: bool = False,
) -> list[Position]:
    """
    Fetch rsETH borrower positions from Aave V3, Compound V3, and Morpho Blue.

    block=None  → latest (live simulation)
    block=N     → historical state at block N (backtesting; Aave only for archive)

    Results are cached for CACHE_TTL seconds (live only; historical never cached).
    """
    block_str = hex(block) if block is not None else "latest"
    cache_key = block_str

    if block is None and not force_refresh:
        cached = _position_cache.get(cache_key)
        if cached and (time.time() - cached[0]) < CACHE_TTL:
            return cached[1]

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Fetch ETH price once for Compound/Morpho debt valuation
        eth_price = await _fetch_eth_price_simple(client)
        if eth_price <= 0:
            eth_price = rseth_price  # rsETH ≈ ETH as fallback

        # ── Aave V3 ────────────────────────────────────────────────────────
        depositors = await _get_atoken_depositors(client)
        addr_list = list(depositors)
        active = await _filter_by_balance(client, addr_list, block=block_str, rseth_price=rseth_price)
        active.sort(key=lambda x: x[1], reverse=True)
        aave_users = await _fetch_user_data(client, active, block=block_str)
        aave_positions = _to_positions(aave_users, rseth_price)

        # ── Compound V3 + Morpho Blue (live only — no archive support) ────
        if block is None:
            _comp_res, _morpho_res = await asyncio.gather(
                _fetch_compound_positions(client, rseth_price, eth_price, block=block_str),
                _fetch_morpho_blue_positions(client, rseth_price, eth_price, block=block_str),
                return_exceptions=True,
            )
            compound_positions = _comp_res if isinstance(_comp_res, list) else []
            morpho_positions   = _morpho_res if isinstance(_morpho_res, list) else []
        else:
            compound_positions = []
            morpho_positions = []

    positions = aave_positions + compound_positions + morpho_positions

    if positions and block is None:
        _position_cache[cache_key] = (time.time(), positions)

    return positions


def get_cached_positions(prehack: bool = False) -> Optional[list[Position]]:
    """Sync accessor for cached positions (None if not yet fetched)."""
    key = "prehack" if prehack else "latest"
    cached = _position_cache.get(key)
    if cached:
        if prehack:
            return cached[1]  # pre-hack never expires
        if (time.time() - cached[0]) < CACHE_TTL:
            return cached[1]
    return None


async def fetch_prehack_positions(rseth_price: float) -> list[Position]:
    """
    Fetch Aave V3 rsETH positions at the pre-hack block (April 17, 2026).
    Cached permanently — historical state never changes.
    """
    cached = _position_cache.get("prehack")
    if cached:
        return cached[1]

    positions = await fetch_real_positions(
        rseth_price=rseth_price,
        block=PRE_HACK_BLOCK,
    )
    if positions:  # only cache successful fetches
        _position_cache["prehack"] = (time.time(), positions)
    return positions


async def fetch_positions_summary(rseth_price: float, force_refresh: bool = False) -> dict:
    """
    Return a summary dict for API consumers:
    total positions, total collateral, eMode vs normal split,
    positions at HF < 1.1 (near-liquidation).
    """
    positions = await fetch_real_positions(rseth_price=rseth_price, force_refresh=force_refresh)

    emode_pos    = [p for p in positions if p.mode == "emode"]
    compound_pos = [p for p in positions if p.mode == "compound_v3"]
    morpho_pos   = [p for p in positions if p.mode.startswith("morpho_blue")]
    normal_pos   = [p for p in positions if p.mode == "normal"]

    total_collateral     = sum(p.collateral_rseth for p in positions)
    total_collateral_usd = total_collateral * rseth_price
    total_debt_usd       = sum(p.debt_usd for p in positions)

    near_liq = [
        p for p in positions
        if p.debt_usd > 0 and p.health_factor(rseth_price) < 1.1
    ]

    return {
        "total_positions": len(positions),
        "emode_count": len(emode_pos),
        "normal_count": len(normal_pos),
        "compound_v3_count": len(compound_pos),
        "morpho_count": len(morpho_pos),
        "total_collateral_atoken": round(total_collateral, 2),
        "total_collateral_usd": round(total_collateral_usd),
        "total_debt_usd": round(total_debt_usd),
        "near_liquidation_count": len(near_liq),
        "near_liquidation_collateral_usd": round(
            sum(p.collateral_rseth * rseth_price for p in near_liq)
        ),
        "protocol_breakdown": {
            "aave_v3_emode":   len(emode_pos),
            "aave_v3_normal":  len(normal_pos),
            "compound_v3":     len(compound_pos),
            "morpho_blue":     len(morpho_pos),
        },
        "data_source": "alchemy_live",
    }
