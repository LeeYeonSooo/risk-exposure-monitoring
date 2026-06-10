"""
Fetches live Aave V3 rsETH aggregate stats via public Ethereum RPC.
No subgraph or API key required.

Data points fetched on-chain:
  - Total rsETH supplied as collateral (aToken.totalSupply equivalent via DataProvider)
  - Current oracle price (Aave V3 Price Oracle / Chainlink)
  - Reserve liquidation threshold and bonus
  - DEX liquidity approximation via DeFiLlama pools API

Caches results for CACHE_TTL seconds; falls back to params.py defaults on error.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from Crypto.Hash import keccak

# ── Constants ────────────────────────────────────────────────────────────────

import os as _os
_ALCHEMY_KEY = _os.getenv("ALCHEMY_API_KEY", "")
RPC_ENDPOINTS = (
    [f"https://eth-mainnet.g.alchemy.com/v2/{_ALCHEMY_KEY}"] if _ALCHEMY_KEY else []
) + [
    "https://eth-pokt.nodies.app",
    "https://virginia.rpc.blxrbdn.com",
    "https://uk.rpc.blxrbdn.com",
]

RSETH_ADDRESS       = "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7"
AAVE_POOL           = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
AAVE_DATA_PROVIDER  = "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3"
AAVE_PRICE_ORACLE   = "0x54586bE62E3c3580375aE3723C145253060Ca0C2"

# Spark Lend (Aave V3 fork) — same ABI, different addresses
SPARK_POOL          = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987"
SPARK_DATA_PROVIDER = "0xFc21d6d146E6086B8359705C8b28512a983db0cb"
SPARK_PRICE_ORACLE  = "0x8105f69D9C41644c6A0803fDA7D03Aa70996cFD9"

# CAPO Oracle: Aave's rsETH/USD capped growth oracle
# Combines LRTOracle (rsETH/ETH ratio) × Chainlink ETH/USD, caps upside growth.
CAPO_ORACLE         = "0x7292C95A5f6A501a9c4B34f6393e221F2A0139c3"

CACHE_TTL = 300  # 5 minutes


# ── Keccak helper ────────────────────────────────────────────────────────────

def _sel(sig: str) -> str:
    """Return first 4 bytes (8 hex chars) of keccak256(signature)."""
    h = keccak.new(digest_bits=256)
    h.update(sig.encode())
    return "0x" + h.hexdigest()[:8]


SEL_RESERVE_DATA    = _sel("getReserveData(address)")
SEL_ASSET_PRICE     = _sel("getAssetPrice(address)")
SEL_CONFIGURATION   = _sel("getConfiguration(address)")
SEL_CONFIG_DATA     = _sel("getReserveConfigurationData(address)")  # DataProvider
SEL_EMODE_DATA      = _sel("getEModeCategoryData(uint8)")

# CAPO function selectors (verified on-chain against 0x7292C95A)
SEL_LATEST_ANSWER   = "0x50d25bcd"              # latestAnswer()         → int256 (8 decimals)
SEL_GET_RATIO       = _sel("getRatio()")         # current rsETH/ETH ratio → uint256 (18 decimals)
SEL_SNAPSHOT_RATIO  = _sel("getSnapshotRatio()") # snapshot rsETH/ETH ratio → uint256 (18 decimals)
SEL_SNAPSHOT_TS     = _sel("getSnapshotTimestamp()")  # snapshot unix timestamp → uint256
SEL_IS_CAPPED       = _sel("isCapped()")         # is growth cap currently binding → bool

# ── Data model ───────────────────────────────────────────────────────────────

@dataclass
class MarketParams:
    """Real on-chain Aave V3 reserve parameters for a single token."""
    symbol: str
    token_addr: str
    total_collateral: float    # aToken totalSupply (deposited as collateral)
    total_variable_debt: float # variableDebt totalSupply (that token borrowed by others)
    ltv: float                 # max loan-to-value (0–1)
    lt: float                  # liquidation threshold (0–1)
    liq_bonus: float           # liquidation bonus (1.05 = 5% bonus; <1 = unprofitable)
    is_frozen: bool            # frozen = no new deposits/borrows
    is_borrowable: bool        # can this token be borrowed
    # reserve utilization = total_variable_debt / total_collateral (same-asset only)
    # NOTE: does NOT reflect leverage of users who use this token as collateral

    @property
    def reserve_utilization(self) -> float:
        return self.total_variable_debt / self.total_collateral if self.total_collateral > 0 else 0.0

    @property
    def liquidation_incentivized(self) -> bool:
        """False when liq_bonus < 1.0 (liquidators lose money → no natural liquidation)."""
        return self.liq_bonus >= 1.0


@dataclass
class OnchainStats:
    # Backwards-compatible field name (kept as `_rseth` because external callers / cache key).
    # Despite the name, this is the aToken supply of WHATEVER asset is the simulation target.
    total_collateral_atoken: float
    oracle_price_usd: float
    lt_normal: float
    lt_emode: float
    liq_bonus_emode: float
    market_frozen: bool
    dex_liquidity_usd: float
    dex_liquidity_fallback: bool = False
    block_number: int = 0
    fetched_at: float = 0.0
    data_source: str = "onchain"
    # Asset identification (new — populated by fetch_onchain_stats(symbol=...))
    asset_symbol: str = "rsETH"

    @property
    def age_seconds(self) -> float:
        return time.time() - self.fetched_at

    @property
    def emode_liquidation_active(self) -> bool:
        """eMode liquidation is only rational when bonus > 1.0."""
        return self.liq_bonus_emode >= 1.0


# ── Module-level cache ───────────────────────────────────────────────────────

_cache: Optional[OnchainStats] = None         # rsETH (legacy)
_multi_cache: dict[str, OnchainStats] = {}    # symbol → stats (rsETH and beyond)


# ── RPC helper ───────────────────────────────────────────────────────────────

async def _eth_call(client: httpx.AsyncClient, to: str, data: str, rpc: str) -> str:
    resp = await client.post(rpc, json={
        "jsonrpc": "2.0", "method": "eth_call",
        "params": [{"to": to, "data": data}, "latest"], "id": 1,
    })
    resp.raise_for_status()
    result = resp.json().get("result", "")
    if not result or result == "0x":
        raise ValueError(f"Empty eth_call result: {to} {data[:10]}")
    return result


async def _eth_block(client: httpx.AsyncClient, rpc: str) -> int:
    resp = await client.post(rpc, json={
        "jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1,
    })
    resp.raise_for_status()
    return int(resp.json()["result"], 16)


def _addr_arg(addr: str) -> str:
    """Pad address to 32-byte ABI argument."""
    return "000000000000000000000000" + addr[2:].lower()


def _words(hex_result: str) -> list:
    data = hex_result[2:]  # strip 0x
    return [int(data[i:i+64], 16) for i in range(0, len(data), 64)]


# ── DEX liquidity from DeFiLlama ─────────────────────────────────────────────

async def _fetch_dex_liquidity(
    client: httpx.AsyncClient,
    symbol_aliases: tuple[str, ...] = ("rseth",),
) -> float:
    """
    Sum TVL of DEX pools on Ethereum whose symbol contains any of `symbol_aliases`.
    Lending protocol TVL (Aave, Compound) is excluded — only AMM/DEX pools count.
    """
    DEX_PROJECTS = {"fluid-dex", "curve-dex", "uniswap-v3", "balancer-v2",
                    "camelot-v3", "pancakeswap-v3"}
    aliases = tuple(a.lower() for a in symbol_aliases)
    try:
        resp = await client.get("https://yields.llama.fi/pools", timeout=12.0)
        if resp.status_code != 200:
            return 0.0
        pools = resp.json()["data"]
        total = sum(
            p.get("tvlUsd", 0)
            for p in pools
            if any(a in p.get("symbol", "").lower() for a in aliases)
            and p.get("chain") == "Ethereum"
            and p.get("project", "") in DEX_PROJECTS
        )
        return float(total)
    except Exception:
        return 0.0


# ── Main fetch ───────────────────────────────────────────────────────────────

async def fetch_market_params(token_addr: str, symbol: str,
                              client: httpx.AsyncClient, rpc: str,
                              data_provider_addr: str = AAVE_DATA_PROVIDER) -> MarketParams:
    """
    Fetch reserve parameters for a single token from any Aave V3-compatible DataProvider.
    Default = Aave V3 mainnet; pass SPARK_DATA_PROVIDER for Spark Lend.
    """
    arg = _addr_arg(token_addr)

    # getReserveConfigurationData: decimals(0), ltv(1), lt(2), bonus(3), reserveFactor(4),
    #   usageAsCollateral(5), borrowingEnabled(6), stableRate(7), isActive(8), isFrozen(9)
    cfg_raw = await _eth_call(client, data_provider_addr, SEL_CONFIG_DATA + arg, rpc)
    cfg = _words(cfg_raw)
    ltv         = cfg[1] / 10_000
    lt          = cfg[2] / 10_000
    bonus_raw   = cfg[3]
    liq_bonus   = bonus_raw / 10_000
    is_frozen   = bool(cfg[9])
    is_borrow   = bool(cfg[6])

    rd_raw = await _eth_call(client, data_provider_addr, SEL_RESERVE_DATA + arg, rpc)
    rd = _words(rd_raw)
    total_collateral   = rd[2] / 1e18
    total_variable_debt = rd[4] / 1e18

    return MarketParams(
        symbol=symbol, token_addr=token_addr,
        total_collateral=total_collateral, total_variable_debt=total_variable_debt,
        ltv=ltv, lt=lt, liq_bonus=liq_bonus,
        is_frozen=is_frozen, is_borrowable=is_borrow,
    )


async def fetch_onchain_stats(asset_symbol: str = "rsETH", protocol: str = "aave_v3") -> OnchainStats:
    """
    Fetch live lending-protocol aggregate data for the given asset from on-chain.

    protocol: "aave_v3" (default) or "spark" — both share the Aave V3 ABI.

    Discovered per-asset parameters (so far):
      - reserve_addr     : the underlying ERC-20 address registered on the protocol
      - atoken_addr      : implicit via DataProvider getReserveTokenAddresses (not used here yet)
      - emode_category   : 1=ETH-correlated; differs per cluster
      - oracle_asset     : the asset key passed to PriceOracle.getAssetPrice
      - dex_aliases      : DeFiLlama symbol substrings (e.g. wstETH uses "steth" pool too)
      - fallback_lt/le   : per-asset hardcoded fallback (only when reserve fetch returns 0)
    """
    from simulation.assets import get_asset
    asset = get_asset(asset_symbol)
    last_err = None
    oracle_arg = _addr_arg(asset.aave_oracle_asset_addr)

    # Resolve protocol addresses
    if protocol == "spark":
        pool_addr, data_provider_addr, price_oracle_addr = SPARK_POOL, SPARK_DATA_PROVIDER, SPARK_PRICE_ORACLE
    elif protocol == "aave_v3":
        pool_addr, data_provider_addr, price_oracle_addr = AAVE_POOL, AAVE_DATA_PROVIDER, AAVE_PRICE_ORACLE
    else:
        raise ValueError(f"Unsupported lending protocol: {protocol!r}. Known: aave_v3, spark.")

    # Pull per-asset fallback floor for LT (rsETH=0.75, wstETH≈0.785).
    # We avoid a giant if/elif by keeping the fallback co-located with reserve fetch failure.
    LT_FLOOR = {"rsETH": 0.75, "wstETH": 0.785}.get(asset.symbol, 0.70)
    LT_EMODE_FLOOR = {"rsETH": 0.93, "wstETH": 0.93}.get(asset.symbol, 0.90)

    async with httpx.AsyncClient(timeout=10.0) as client:
        for rpc in RPC_ENDPOINTS:
            try:
                # 1. Reserve config (LTV/LT/bonus/frozen) — same call shape for any asset
                params = await fetch_market_params(
                    asset.aave_reserve_addr, asset.symbol, client, rpc,
                    data_provider_addr=data_provider_addr,
                )

                # 2. Oracle price (USD, 8 decimals)
                price_raw = await _eth_call(
                    client, price_oracle_addr,
                    SEL_ASSET_PRICE + oracle_arg, rpc
                )
                oracle_price = int(price_raw, 16) / 1e8

                # 3. eMode params (if asset belongs to one)
                if asset.aave_emode_category is not None:
                    emode_arg = (
                        "00000000000000000000000000000000000000000000000000000000000000"
                        + f"{asset.aave_emode_category:02x}"
                    )
                    emode_raw = await _eth_call(client, pool_addr, SEL_EMODE_DATA + emode_arg, rpc)
                    emode_w = _words(emode_raw)
                    lt_emode    = emode_w[1] / 10_000
                    bonus_emode = emode_w[2] / 10_000
                else:
                    lt_emode    = 0.0
                    bonus_emode = 1.0

                block = await _eth_block(client, rpc)

                dex_liq_raw = await _fetch_dex_liquidity(client, symbol_aliases=asset.dex_symbol_aliases)
                dex_liq_fallback = dex_liq_raw < 1_000_000
                dex_liq = 10_000_000 if dex_liq_fallback else dex_liq_raw

                return OnchainStats(
                    total_collateral_atoken=params.total_collateral,
                    oracle_price_usd=oracle_price,
                    lt_normal=params.lt if params.lt > 0 else LT_FLOOR,
                    lt_emode=lt_emode if lt_emode > 0 else LT_EMODE_FLOOR,
                    liq_bonus_emode=bonus_emode,
                    market_frozen=params.is_frozen,
                    dex_liquidity_usd=dex_liq,
                    dex_liquidity_fallback=dex_liq_fallback,
                    block_number=block,
                    fetched_at=time.time(),
                    asset_symbol=asset.symbol,
                )

            except Exception as e:
                last_err = e
                continue

    raise RuntimeError(f"All RPC endpoints failed for {asset_symbol}. Last error: {last_err}")


async def get_live_stats(force_refresh: bool = False, asset_symbol: str = "rsETH") -> OnchainStats:
    """Return cached stats if fresh, otherwise fetch and cache.

    The legacy `_cache` mirrors rsETH for backwards compatibility; multi-asset cache
    lives in `_multi_cache` keyed by symbol.
    """
    global _cache
    cached = _multi_cache.get(asset_symbol.lower())
    if not force_refresh and cached and cached.age_seconds < CACHE_TTL:
        return cached
    stats = await fetch_onchain_stats(asset_symbol=asset_symbol)
    _multi_cache[asset_symbol.lower()] = stats
    if asset_symbol.lower() == "rseth":
        _cache = stats
    return stats


def get_cached_stats(asset_symbol: str = "rsETH") -> Optional[OnchainStats]:
    """Sync accessor — returns cached value or None if not yet fetched."""
    cached = _multi_cache.get(asset_symbol.lower())
    if cached and cached.age_seconds < CACHE_TTL:
        return cached
    if asset_symbol.lower() == "rseth" and _cache and _cache.age_seconds < CACHE_TTL:
        return _cache
    return None


# ── Risk Gauge ───────────────────────────────────────────────────────────────

def compute_risk_gauge(stats: OnchainStats, market_price_usd: float = None) -> dict:
    """
    Compute 3-metric risk gauge from live on-chain data.

    Metric 1 — Liquidity Buffer:
      dex_liquidity / total_collateral_usd (%)
      Measures how thin the exit liquidity is relative to total collateral.
      < 0.5% = critical (10x undercapitalised vs safe threshold)
      0.5–1.5% = warning
      > 1.5% = safe

    Metric 2 — Oracle-Market Spread:
      |oracle_price - market_price| / oracle_price (%)
      Any divergence signals an ongoing oracle lag event.
      > 2% = critical, 0.5–2% = warning, < 0.5% = safe

    Metric 3 — Cascade Buffer:
      Price drop % needed to start liquidating the most leveraged eMode positions.
      eMode LT = 0.93, empirical avg LTV = 0.88 → buffer = 5.4%
      < 3% = critical, 3–7% = warning, > 7% = safe
    """
    total_collateral_usd = stats.total_collateral_atoken * stats.oracle_price_usd

    # Metric 1: Liquidity buffer
    if total_collateral_usd <= 0:
        liq_ratio_pct = 0.0
    else:
        liq_ratio_pct = stats.dex_liquidity_usd / total_collateral_usd * 100
    if liq_ratio_pct > 1.5:
        liq_zone = "safe"
    elif liq_ratio_pct > 0.5:
        liq_zone = "warning"
    else:
        liq_zone = "critical"

    # Metric 2: Oracle-market spread
    if market_price_usd and market_price_usd > 0:
        spread_pct = abs(stats.oracle_price_usd - market_price_usd) / stats.oracle_price_usd * 100
    else:
        spread_pct = 0.0
    if spread_pct > 2.0:
        spread_zone = "critical"
    elif spread_pct > 0.5:
        spread_zone = "warning"
    else:
        spread_zone = "safe"

    # Metric 3: Cascade buffer
    # Try to calculate avg LTV from cached real positions; fall back to empirical 0.88
    lt_emode = stats.lt_emode
    emode_avg_ltv_source = "estimated"
    try:
        from .position_fetcher import get_cached_positions as _gcp
        _cached = _gcp()
        _emode_pos = [p for p in (_cached or []) if p.mode == "emode" and p.debt_usd > 0 and p.collateral_rseth > 0]
        if len(_emode_pos) >= 3:
            _oracle = stats.oracle_price_usd
            emode_avg_ltv = sum(p.debt_usd / (p.collateral_rseth * _oracle) for p in _emode_pos) / len(_emode_pos)
            emode_avg_ltv_source = f"onchain ({len(_emode_pos)} pos)"
        else:
            emode_avg_ltv = 0.88
    except Exception:
        emode_avg_ltv = 0.88
    cascade_buffer_pct = (lt_emode - emode_avg_ltv) / lt_emode * 100 if lt_emode > 0 else 0.0
    if cascade_buffer_pct > 7:
        cascade_zone = "safe"
    elif cascade_buffer_pct > 3:
        cascade_zone = "warning"
    else:
        cascade_zone = "critical"

    zones = [liq_zone, spread_zone, cascade_zone]
    if "critical" in zones:
        overall_zone = "critical"
    elif "warning" in zones:
        overall_zone = "warning"
    else:
        overall_zone = "safe"

    return {
        "overall_zone": overall_zone,
        "metrics": {
            "liquidity_buffer": {
                "value": round(liq_ratio_pct, 3),
                "unit": "%",
                "label": "유동성 버퍼",
                "description": f"DEX ${stats.dex_liquidity_usd/1e6:.1f}M vs 담보 ${total_collateral_usd/1e9:.2f}B",
                "zone": liq_zone,
                "thresholds": {"safe": 1.5, "warning": 0.5},
            },
            "oracle_spread": {
                "value": round(spread_pct, 3),
                "unit": "%",
                "label": "Oracle-시장 괴리",
                "description": f"Oracle ${stats.oracle_price_usd:.2f} vs 시장 ${market_price_usd:.2f}" if market_price_usd else "시장가 미확인",
                "zone": spread_zone,
                "thresholds": {"safe": 0.5, "warning": 2.0},
            },
            "cascade_buffer": {
                "value": round(cascade_buffer_pct, 1),
                "unit": "%",
                "label": "cascade 여유",
                "description": f"eMode LT {lt_emode:.0%} − 평균 LTV {emode_avg_ltv:.0%} ({emode_avg_ltv_source})",
                "zone": cascade_zone,
                "thresholds": {"safe": 7.0, "warning": 3.0},
            },
        },
        "snapshot": {
            "total_collateral_atoken": round(stats.total_collateral_atoken, 0),
            "total_collateral_usd": round(total_collateral_usd),
            "oracle_price_usd": round(stats.oracle_price_usd, 2),
            "market_price_usd": market_price_usd,
            "dex_liquidity_usd": round(stats.dex_liquidity_usd),
            "dex_liquidity_fallback": stats.dex_liquidity_fallback,
            "block_number": stats.block_number,
        },
        "age_seconds": round(stats.age_seconds),
    }


# ── CAPO Oracle params ────────────────────────────────────────────────────────

async def fetch_capo_params() -> dict:
    """
    Query CAPO Oracle (0x7292C95A) live parameters on-chain.

    Returns:
        current_price_usd        : CAPO latestAnswer() / 1e8  — rsETH/USD with cap applied
        max_yearly_growth_pct    : MAX_YEARLY_RATIO_GROWTH_PERCENT (e.g. 9.68 → 9.68%)
        snapshot_ratio           : snapshotRatio() / 1e18  — rsETH/ETH ratio at last snapshot
        snapshot_timestamp       : snapshotTimestamp() — Unix timestamp of last snapshot
        cap_risk_note            : Human-readable asymmetry warning
    """
    async def _call(rpc: str, data: str) -> Optional[str]:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(rpc, json={
                    "jsonrpc": "2.0", "method": "eth_call",
                    "params": [{"to": CAPO_ORACLE, "data": data}, "latest"],
                    "id": 1,
                })
                r = resp.json().get("result", "")
                return r if (r and r != "0x") else None
        except Exception:
            return None

    rpc = RPC_ENDPOINTS[0] if RPC_ENDPOINTS else "https://eth-pokt.nodies.app"

    price_raw, ratio_raw, snap_ratio_raw, snap_ts_raw, is_capped_raw = await asyncio.gather(
        _call(rpc, SEL_LATEST_ANSWER),
        _call(rpc, SEL_GET_RATIO),
        _call(rpc, SEL_SNAPSHOT_RATIO),
        _call(rpc, SEL_SNAPSHOT_TS),
        _call(rpc, SEL_IS_CAPPED),
    )

    result: dict = {}

    if price_raw:
        try:
            raw_int = int(price_raw, 16)
            # latestAnswer returns int256 — handle two's complement for negative
            if raw_int >= (1 << 255):
                raw_int -= (1 << 256)
            result["current_price_usd"] = raw_int / 1e8
        except (ValueError, TypeError):
            pass

    if ratio_raw:
        try:
            result["current_ratio"] = int(ratio_raw, 16) / 1e18  # current rsETH/ETH
        except (ValueError, TypeError):
            pass

    if snap_ratio_raw:
        try:
            result["snapshot_ratio"] = int(snap_ratio_raw, 16) / 1e18
        except (ValueError, TypeError):
            pass

    if snap_ts_raw:
        try:
            result["snapshot_timestamp"] = int(snap_ts_raw, 16)
        except (ValueError, TypeError):
            pass

    if is_capped_raw:
        try:
            result["is_capped"] = bool(int(is_capped_raw, 16))
        except (ValueError, TypeError):
            pass

    # Asymmetric risk annotation
    result["cap_risk_note"] = (
        "CAPO caps upside growth only. Downside (depeg) passes through immediately. "
        "If rsETH depegs, Aave oracle follows instantly — no lag protection. "
        "If rsETH legitimately appreciates faster than the cap, Aave underprices it."
    )
    return result
