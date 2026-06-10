"""
Fetches a specific wallet's Aave V3 rsETH position from on-chain.

Two eth_call calls per lookup:
  1. Pool.getUserAccountData(user)  → total collateral, debt, HF
  2. DataProvider.getUserReserveData(rsETH, user) → rsETH-specific balance

No subgraph or event log access required.
"""

import re
import asyncio
import httpx
from Crypto.Hash import keccak

import os as _os
_ALCHEMY_KEY = _os.getenv("ALCHEMY_API_KEY", "")
RPC_ENDPOINTS = (
    [f"https://eth-mainnet.g.alchemy.com/v2/{_ALCHEMY_KEY}"] if _ALCHEMY_KEY else []
) + [
    "https://eth-pokt.nodies.app",
    "https://virginia.rpc.blxrbdn.com",
    "https://uk.rpc.blxrbdn.com",
]

AAVE_POOL          = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
AAVE_DATA_PROVIDER = "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3"
RSETH_ADDRESS      = "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7"


def _sel(sig: str) -> str:
    h = keccak.new(digest_bits=256)
    h.update(sig.encode())
    return "0x" + h.hexdigest()[:8]


SEL_ACCOUNT = _sel("getUserAccountData(address)")
SEL_RESERVE = _sel("getUserReserveData(address,address)")

_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _words(hex_result: str) -> list:
    data = hex_result[2:] if hex_result.startswith("0x") else hex_result
    return [int(data[i:i + 64], 16) for i in range(0, len(data), 64)]


def _addr_arg(addr: str) -> str:
    return "000000000000000000000000" + addr[2:].lower()


# ── Scenario risk table ───────────────────────────────────────────────────────

# For each scenario, the oracle price shock applied to the collateral
SCENARIO_SHOCKS = {
    "oracle_manipulation": {"name": "[S1] 오라클 조작",       "shock_pct": 15},
    "bridge_hack":         {"name": "[S2] 브리지 해킹",        "shock_pct": 40},
    "eigenlayer_slashing": {"name": "[S3] EigenLayer 슬래싱",  "shock_pct": 15},
    "mass_withdrawal":     {"name": "[S4] 대량 인출",          "shock_pct": 20},
}


def _scenario_risks(
    health_factor: float,
    total_collateral_usd: float,
    total_debt_usd: float,
    lt_weighted: float,
    rseth_collateral_usd: float,
    rseth_lt: float,
) -> list:
    """
    Compute post-shock HF for each scenario using the proper Aave V3 formula.

    Aave HF =  Σ(coll_i × p_i × LT_i)  /  Σ(debt_j × p_j)

    When only rsETH price drops by p (no debt asset move), the new HF is:

        HF_new = (V_lt_total − V_rseth × LT_rseth × p) / D
               = HF × (1 − p × (V_rseth × LT_rseth) / V_lt_total)
               = HF × (1 − p × f_lt)

    Where f_lt is the *LT-weighted* fraction of rsETH in the collateral basket,
    NOT the plain value fraction.  The old code used V_rseth / V_total which
    biases the result whenever rsETH's LT differs from the basket's average LT
    (e.g. in eMode LT_rseth=0.93 vs basket avg ~0.80 → ~16% under-estimate of impact).

    LIMITATION: wallet_fetcher currently fetches only the rsETH leg via
    getUserReserveData. We therefore cannot apply correlated shocks to other
    collateral assets (e.g. wstETH dropping alongside rsETH during a generic
    LST panic). Full multi-collateral simulation needs portfolio_fetcher input;
    see /api/wallet/{addr}/portfolio-simulate (P0-3, todo).
    """
    if total_debt_usd <= 0 or health_factor == float("inf"):
        return []

    v_lt_total = total_collateral_usd * lt_weighted  # Σ(V_i × LT_i)
    if v_lt_total <= 0:
        return []

    f_lt = (rseth_collateral_usd * rseth_lt) / v_lt_total

    risks = []
    for sid, s in SCENARIO_SHOCKS.items():
        p = s["shock_pct"] / 100
        # Linear formula — correct because LT_i and amounts don't change under
        # a pure price shock, only price_i does, and only for the affected asset.
        new_hf = health_factor * (1 - p * f_lt)
        risks.append({
            "scenario":   sid,
            "name":       s["name"],
            "shock_pct":  s["shock_pct"],
            "shock_assets": ["rsETH"],   # which assets the shock is applied to
            "f_lt_used":  round(f_lt, 4),
            "new_hf":     round(max(new_hf, 0), 3),
            "liquidated": new_hf < 1.0,
        })
    return risks


# ── Main fetch ────────────────────────────────────────────────────────────────

async def fetch_wallet_position(wallet: str, oracle_price: float) -> dict:
    """
    Returns the user's Aave V3 position including scenario risk.

    Parameters
    ----------
    wallet       Ethereum address (0x...)
    oracle_price Current rsETH oracle price in USD
    """
    wallet = wallet.strip()
    if not _ADDR_RE.match(wallet):
        return {"error": "유효하지 않은 이더리움 주소입니다 (0x + 40 hex chars)"}

    user_arg      = _addr_arg(wallet)
    rseth_arg     = _addr_arg(RSETH_ADDRESS)

    last_err = None
    async with httpx.AsyncClient(timeout=10.0) as client:
        for rpc in RPC_ENDPOINTS:
            try:
                # 1. getUserAccountData(user)
                r1 = await client.post(rpc, json={
                    "jsonrpc": "2.0", "method": "eth_call",
                    "params": [{"to": AAVE_POOL, "data": SEL_ACCOUNT + user_arg}, "latest"],
                    "id": 1,
                })
                r1.raise_for_status()
                raw1 = r1.json().get("result", "")

                # 2. getUserReserveData(rsETH, user)
                r2 = await client.post(rpc, json={
                    "jsonrpc": "2.0", "method": "eth_call",
                    "params": [{"to": AAVE_DATA_PROVIDER,
                                "data": SEL_RESERVE + rseth_arg + user_arg}, "latest"],
                    "id": 2,
                })
                r2.raise_for_status()
                raw2 = r2.json().get("result", "")

                break
            except Exception as e:
                last_err = e
                raw1 = raw2 = ""
                continue

    if not raw1 or raw1 == "0x":
        return {"error": f"RPC 조회 실패: {last_err}"}

    # Parse getUserAccountData (6 uint256 values)
    w1 = _words(raw1)
    total_collateral_usd = w1[0] / 1e8
    total_debt_usd       = w1[1] / 1e8
    lt_weighted          = w1[3] / 10_000  # 7500 → 0.75
    health_factor_raw    = w1[5]
    health_factor = health_factor_raw / 1e18 if health_factor_raw < 2**128 else float("inf")

    # No Aave position
    if total_collateral_usd < 0.01:
        return {
            "address": wallet,
            "has_position": False,
            "message": "이 주소에는 Aave V3 포지션이 없습니다.",
        }

    # Parse getUserReserveData (9 values: aToken, stDebt, varDebt, ...)
    w2 = _words(raw2) if raw2 and raw2 != "0x" else [0] * 9
    rseth_collateral     = w2[0] / 1e18   # currentATokenBalance
    rseth_collateral_usd = rseth_collateral * oracle_price
    rseth_fraction       = min(rseth_collateral_usd / total_collateral_usd, 1.0) \
                           if total_collateral_usd > 0 else 0.0

    # Liquidation metrics
    # drop_to_liq: % fall in collateral value that brings HF to 1.0
    # Only valid for finite HF (user has debt)
    if health_factor == float("inf") or total_debt_usd < 0.01:
        drop_to_liq_pct = None
        liq_oracle_price = None
    else:
        # rseth_fraction-aware formula:
        #   When only rsETH oracle drops (other collateral stable):
        #   P_liq = oracle * (1/HF - 1 + f) / f   where f = rseth_fraction
        #   numerator <= 0 → rsETH can reach zero and position stays healthy
        #   (i.e. other collateral alone covers the debt → no liq via rsETH)
        if rseth_fraction > 0:
            _num = (1 / health_factor) - 1 + rseth_fraction
            if _num <= 0:
                liq_oracle_price = None   # rsETH alone cannot trigger liquidation
                drop_to_liq_pct  = None
            else:
                liq_oracle_price = round(oracle_price * _num / rseth_fraction, 2)
                drop_to_liq_pct  = round((1 - _num / rseth_fraction) * 100, 1)
        else:
            liq_oracle_price = None   # no rsETH collateral
            drop_to_liq_pct  = None

    # Zone
    if health_factor == float("inf"):
        zone = "safe"
    elif health_factor > 1.5:
        zone = "safe"
    elif health_factor > 1.1:
        zone = "warning"
    elif health_factor > 1.0:
        zone = "critical"
    else:
        zone = "liquidatable"

    return {
        "address": wallet,
        "has_position": True,
        "total_collateral_usd": round(total_collateral_usd, 2),
        "total_debt_usd": round(total_debt_usd, 2),
        "rseth_collateral": round(rseth_collateral, 4),
        "rseth_collateral_usd": round(rseth_collateral_usd, 2),
        "rseth_fraction": round(rseth_fraction, 3),
        "health_factor": round(health_factor, 3) if health_factor != float("inf") else 9999,
        "lt_weighted": lt_weighted,
        "liq_oracle_price": liq_oracle_price,
        "drop_to_liq_pct": drop_to_liq_pct,
        "zone": zone,
        # rsETH-specific LT: prefer eMode LT (0.93) when the user is in eMode,
        # otherwise fall back to the wallet's overall lt_weighted (per-asset LT
        # isn't queryable from getUserAccountData alone).
        "scenario_risks": _scenario_risks(
            health_factor=health_factor,
            total_collateral_usd=total_collateral_usd,
            total_debt_usd=total_debt_usd,
            lt_weighted=lt_weighted,
            rseth_collateral_usd=rseth_collateral_usd,
            # Use 0.93 if the wallet's lt_weighted ≥ 0.85 (heuristic for eMode); else the rsETH normal LT 0.75
            rseth_lt=0.93 if lt_weighted >= 0.85 else 0.75,
        ),
        "oracle_price_usd": round(oracle_price, 2),
    }
