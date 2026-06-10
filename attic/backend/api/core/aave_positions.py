"""
aave_positions.py — POSITION-LEVEL Aave V3 contagion (option b: accurate, heavier).

Aave is a SHARED pool: users borrow against a basket of collateral, so bad debt from
one collateral asset's depeg cannot be attributed at the reserve level. This module
does it properly — per borrower:
  1. fetch every account that uses asset X as collateral (top N by balance)
  2. fetch each account's FULL position basket (all collateral + all debt)
  3. re-price X by (1-delta), recompute health factor, and compute the account's
     bad debt = max(0, total_debt - collateral_value_after_liquidation)
  4. attribute that bad debt to the borrowed assets, aggregate across accounts

Data: Messari-schema Aave V3 subgraph at AAVE_V3_SUBGRAPH_URL (The Graph gateway).
  Market.liquidationThreshold is in PERCENT (e.g. "81"); balances are token units.
"""
from __future__ import annotations

import os
from collections import defaultdict
from typing import Optional

import httpx

try:
    from dotenv import load_dotenv; load_dotenv()
except Exception:
    pass

import re as _re

from . import dex_liquidity as _dex

AAVE_SUBGRAPH = os.getenv("AAVE_V3_SUBGRAPH_URL", "").strip()
# SparkLend = Aave V3 fork, SAME Messari schema → reuse this whole engine, just swap the
# subgraph deployment id on the same gateway/key. Spark is Sky's lending arm (big venue).
_SPARK_ID = "GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si"
SPARK_SUBGRAPH = (_re.sub(r"(subgraphs/id/)[^/?]+", r"\g<1>" + _SPARK_ID, AAVE_SUBGRAPH)
                  if AAVE_SUBGRAPH else "")
_PAGE = 200


def _gql(client: httpx.Client, query: str, variables: dict, url: str = "") -> dict:
    r = client.post(url or AAVE_SUBGRAPH, json={"query": query, "variables": variables}, timeout=60)
    r.raise_for_status()
    d = r.json()
    if "errors" in d:
        raise RuntimeError(str(d["errors"])[:300])
    return d["data"]


_Q_MARKETS = """query($sym:String!){ markets(first:20, where:{inputToken_:{symbol:$sym}}){
  id liquidationThreshold inputToken{ symbol decimals } } }"""

_Q_MARKETS_MULTI = """query($syms:[String!]!){ markets(first:80, where:{inputToken_:{symbol_in:$syms}}){
  id liquidationThreshold inputToken{ symbol decimals } } }"""

_Q_COLLATERAL_ACCOUNTS = """query($mids:[String!]!,$first:Int!,$skip:Int!){
  positions(first:$first, skip:$skip, orderBy:balance, orderDirection:desc,
    where:{market_in:$mids, side:COLLATERAL, balance_gt:0}){ account{ id } balance } }"""

_Q_ACCOUNT_POSITIONS = """query($ids:[String!]!){
  accounts(first:1000, where:{id_in:$ids}){
    id
    positions(first:100, where:{balance_gt:0, hashClosed:null}){
      side isCollateral balance
      market{ liquidationThreshold inputTokenPriceUSD inputToken{ symbol decimals } }
    }
  } }"""


_Q_COLLATERAL_ASSETS = """query{ markets(first:400, where:{liquidationThreshold_gt:0}){
  inputToken{ symbol decimals } inputTokenBalance inputTokenPriceUSD } }"""

# Reserve-level liquidity (for the LIQUIDITY-run channel): deposit vs borrow → utilization.
_Q_RESERVE_LIQ = """query($sym:String!){ markets(first:20, where:{inputToken_:{symbol:$sym}}){
  id name totalDepositBalanceUSD totalBorrowBalanceUSD inputToken{ symbol } } }"""

# Per-reserve liquidation penalty (the liquidator's bonus, in PERCENT) → base recovery.
_Q_RESERVE_PENALTY = """query($sym:String!){ markets(first:20, where:{inputToken_:{symbol:$sym}}){
  liquidationPenalty totalDepositBalanceUSD inputToken{ symbol } } }"""
_penalty_cache: dict = {}


def reserve_recovery(asset_symbol: str, subgraph: str = "") -> float | None:
    """Aave/Spark base recovery for `asset_symbol` from the reserve's REAL liquidation penalty
    (bonus): recovery = 1/(1 + penalty/100). Supply-weighted across the asset's reserves.
    Cached. None if unavailable (caller falls back to the oracle-type default)."""
    key = (asset_symbol, subgraph or AAVE_SUBGRAPH)
    if key in _penalty_cache:
        return _penalty_cache[key]
    val = None
    try:
        with httpx.Client() as client:
            rows = _gql(client, _Q_RESERVE_PENALTY, {"sym": asset_symbol},
                        url=subgraph)["markets"]
        num = den = 0.0
        for r in rows:
            p = r.get("liquidationPenalty")
            w = float(r.get("totalDepositBalanceUSD") or 0.0) or 1.0
            if p is not None:
                num += (1.0 / (1.0 + float(p) / 100.0)) * w
                den += w
        if den > 0:
            val = round(num / den, 4)
    except Exception:
        val = None
    _penalty_cache[key] = val
    return val


def reserve_liquidity(asset_symbol: str, subgraph: str = "") -> dict | None:
    """Aave/Spark reserve liquidity for `asset_symbol` as a SUPPLIED asset:
    {supply_usd, borrow_usd, utilization, n_markets}. utilization = borrow/supply drives
    liq_h = max(0, U+ρ−1). None if no reserve / no subgraph. subgraph picks the venue."""
    url = subgraph or AAVE_SUBGRAPH
    if not url:
        return None
    try:
        with httpx.Client() as client:
            ms = _gql(client, _Q_RESERVE_LIQ, {"sym": asset_symbol}, url=url)["markets"]
    except Exception:
        return None
    supply = sum(float(m.get("totalDepositBalanceUSD") or 0) for m in ms)
    borrow = sum(float(m.get("totalBorrowBalanceUSD") or 0) for m in ms)
    if supply <= 0:
        return None
    return {"supply_usd": supply, "borrow_usd": borrow,
            "utilization": borrow / supply, "n_markets": len(ms)}


def list_aave_collateral_assets(subgraph: str = "") -> list[dict]:
    """Assets usable as collateral (liquidationThreshold>0), by approx supply. subgraph
    selects the venue (Aave default, or pass SPARK_SUBGRAPH for SparkLend)."""
    if not (subgraph or AAVE_SUBGRAPH):
        return []
    with httpx.Client() as client:
        ms = _gql(client, _Q_COLLATERAL_ASSETS, {}, url=subgraph)["markets"]
    agg: dict[str, dict] = {}
    for m in ms:
        it = m.get("inputToken") or {}
        sym = it.get("symbol")
        if not sym:
            continue
        dec = int(it.get("decimals") or 18)
        bal = float(m.get("inputTokenBalance") or 0) / (10 ** dec)
        px = float(m.get("inputTokenPriceUSD") or 0)
        a = agg.setdefault(sym, {"symbol": sym, "supply_usd": 0.0, "n_markets": 0})
        a["supply_usd"] += bal * px
        a["n_markets"] += 1
    return sorted(agg.values(), key=lambda x: -x["supply_usd"])


def _bal(p: dict) -> float:
    dec = int((((p.get("market") or {}).get("inputToken") or {}).get("decimals")) or 18)
    try:
        return float(p["balance"]) / (10 ** dec)
    except Exception:
        return 0.0


def _price(p: dict) -> float:
    return float((p.get("market") or {}).get("inputTokenPriceUSD") or 0.0)


def _lt(p: dict) -> float:
    # percent string -> fraction
    return float((p.get("market") or {}).get("liquidationThreshold") or 0.0) / 100.0


def _sym(p: dict) -> str:
    return (((p.get("market") or {}).get("inputToken") or {}).get("symbol")) or "?"


def simulate_aave_multi_shock(asset_deltas: dict[str, float], top_accounts: int = _PAGE,
                              recovery: float = 1.0, subgraph: str = "",
                              dex_recovery: bool = False, depth_haircut: float = 0.0) -> dict:
    """Position-level shock of MULTIPLE collateral assets SIMULTANEOUSLY.

    This is the common-mode / shared-oracle case: when one feed fails, every asset it
    prices drops at once, so a borrower's WHOLE basket can be haircut in the same step
    (e.g. wstETH AND weETH together). That is strictly more severe than shocking each
    asset alone, and only a position-level recompute captures it — reserve-level
    aggregation cannot.

    asset_deltas: {symbol: delta} — each collateral symbol's price multiplier is (1-delta).
    recovery:     liquidation recovery factor (1.0 = sell at market; <1 = slippage/bonus haircut).
    subgraph:     venue selector (Aave default, or SPARK_SUBGRAPH for SparkLend — same schema).
    """
    url = subgraph or AAVE_SUBGRAPH
    if not url:
        raise RuntimeError("subgraph url not set")
    syms = [s for s, d in asset_deltas.items() if d and d > 0]
    if not syms:
        return {"assets": [], "available": True, "n_accounts_scanned": 0,
                "n_with_debt": 0, "n_liquidatable": 0, "total_bad_debt_usd": 0.0,
                "collateral_liquidated_usd": 0.0, "bad_debt_by_asset": {}}

    with httpx.Client() as client:
        mk = _gql(client, _Q_MARKETS_MULTI, {"syms": syms}, url=url)["markets"]
        mids = [m["id"] for m in mk]
        if not mids:
            return {"assets": syms, "available": True, "n_accounts_scanned": 0,
                    "n_with_debt": 0, "n_liquidatable": 0, "total_bad_debt_usd": 0.0,
                    "collateral_liquidated_usd": 0.0, "bad_debt_by_asset": {},
                    "reason": "no market with these collaterals"}

        # collateral accounts across ALL affected markets (union, top N by balance)
        pos = _gql(client, _Q_COLLATERAL_ACCOUNTS,
                   {"mids": mids, "first": min(top_accounts, 1000), "skip": 0}, url=url)["positions"]
        acct_ids = list(dict.fromkeys([p["account"]["id"] for p in pos]))[:top_accounts]
        if not acct_ids:
            return {"assets": syms, "available": True, "n_accounts_scanned": 0,
                    "n_with_debt": 0, "n_liquidatable": 0, "total_bad_debt_usd": 0.0,
                    "collateral_liquidated_usd": 0.0, "bad_debt_by_asset": {}}

        # full baskets (batch in chunks of 100 ids)
        accounts = []
        for i in range(0, len(acct_ids), 100):
            chunk = acct_ids[i:i + 100]
            accounts += _gql(client, _Q_ACCOUNT_POSITIONS, {"ids": chunk}, url=url)["accounts"]

    def _shocked_price(p: dict) -> float:
        price = _price(p)
        d = asset_deltas.get(_sym(p))
        return price * (1.0 - d) if d else price

    bad_debt_by_asset: dict[str, float] = defaultdict(float)
    n_liquidatable = 0
    n_with_debt = 0
    total_bad_debt = 0.0
    collateral_at_risk_usd = 0.0

    # ── pass 1: find liquidatable accounts; accumulate the AGGREGATE collateral that must
    #    be sold per symbol (these liquidations hit the DEX simultaneously) ──
    liq_accounts: list[tuple] = []
    total_liq_by_sym: dict[str, float] = defaultdict(float)
    for acc in accounts:
        collat, debt = [], []
        for p in acc.get("positions", []):
            if p.get("side") == "COLLATERAL" and p.get("isCollateral"):
                collat.append(p)
            elif p.get("side") == "BORROWER":
                debt.append(p)
        total_debt = sum(_bal(p) * _price(p) for p in debt)
        if total_debt <= 0:
            continue
        n_with_debt += 1
        weighted_after = sum(_bal(p) * _shocked_price(p) * _lt(p) for p in collat)
        if (weighted_after / total_debt) < 1.0:
            liq_accounts.append((acc.get("id", ""), collat, debt, total_debt))
            for p in collat:
                total_liq_by_sym[_sym(p)] += _bal(p) * _shocked_price(p)

    # per-symbol AGGREGATE effective recovery (Cifuentes fire-sale): the haircut depends on
    # the TOTAL simultaneous sale of that collateral vs its DEX depth — so even a deep asset
    # gets marked down when the whole pool liquidates at once. NAV/CAPO assets unchanged.
    eff_rec_by_sym: dict[str, float] = {}
    if dex_recovery:
        for s, sold in total_liq_by_sym.items():
            depth = _dex.dex_depth_for(s) * (1.0 - depth_haircut)  # LP flight in a run (A4)
            eff_rec_by_sym[s] = _dex.effective_recovery(
                s, recovery, liquidation_usd=sold, dex_depth_usd=depth)

    # ── pass 2: bad debt per account, using the aggregate-fire-sale recovery ──
    account_rows: list[dict] = []
    for acc_id, collat, debt, total_debt in liq_accounts:
        n_liquidatable += 1
        collat_after = sum(_bal(p) * _shocked_price(p) for p in collat)
        collateral_at_risk_usd += collat_after
        if dex_recovery:
            recoverable = sum(_bal(p) * _shocked_price(p) * eff_rec_by_sym.get(_sym(p), recovery)
                              for p in collat)
        else:
            recoverable = collat_after * recovery
        shortfall = max(0.0, total_debt - recoverable)
        if shortfall > 0:
            total_bad_debt += shortfall
            acc_by_borrow: dict[str, float] = defaultdict(float)
            for p in debt:
                dv = _bal(p) * _price(p)
                if dv > 0:
                    share = shortfall * (dv / total_debt)
                    bad_debt_by_asset[_sym(p)] += share
                    acc_by_borrow[_sym(p)] += share
            account_rows.append({
                "id": acc_id, "bad_debt_usd": round(shortfall),
                "debt_usd": round(total_debt), "collateral_usd": round(collat_after),
                "collateral_syms": sorted({_sym(p) for p in collat}),
                "borrowed": {k: round(v) for k, v in
                             sorted(acc_by_borrow.items(), key=lambda x: -x[1]) if v >= 1},
            })

    account_rows.sort(key=lambda r: -r["bad_debt_usd"])
    return {
        "assets": syms, "deltas": {k: round(v, 6) for k, v in asset_deltas.items()},
        "available": True,
        "n_accounts_scanned": len(accounts), "n_with_debt": n_with_debt,
        "n_liquidatable": n_liquidatable,
        "total_bad_debt_usd": round(total_bad_debt),
        "collateral_liquidated_usd": round(collateral_at_risk_usd),
        "bad_debt_by_asset": {k: round(v) for k, v in
                              sorted(bad_debt_by_asset.items(), key=lambda x: -x[1]) if v >= 1},
        "accounts": account_rows,   # per-liquidatable-account detail (top by bad debt)
    }


def simulate_aave_shock(asset_symbol: str, delta: float, top_accounts: int = _PAGE,
                        recovery: float = 1.0, subgraph: str = "",
                        dex_recovery: bool = False, depth_haircut: float = 0.0) -> dict:
    """Position-level single-asset shock. Thin wrapper over simulate_aave_multi_shock
    (one entry in the basket), preserving the original {asset, delta} response keys."""
    res = simulate_aave_multi_shock({asset_symbol: delta}, top_accounts=top_accounts,
                                    recovery=recovery, subgraph=subgraph,
                                    dex_recovery=dex_recovery, depth_haircut=depth_haircut)
    res["asset"] = asset_symbol
    res["delta"] = delta
    # preserve historical "no market" semantics for single-asset callers
    if res.get("reason") == "no market with these collaterals":
        res["available"] = False
        res["reason"] = f"no market with collateral {asset_symbol}"
    return res


if __name__ == "__main__":
    import sys, json
    asset = sys.argv[1] if len(sys.argv) > 1 else "wstETH"
    d = float(sys.argv[2]) if len(sys.argv) > 2 else 0.4
    print(json.dumps(simulate_aave_shock(asset, d), indent=2))
