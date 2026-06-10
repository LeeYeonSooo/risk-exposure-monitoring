"""
liquidity.py — the LIQUIDITY-run contagion channel (separate from solvency/bad-debt).

WHY this is a different channel (the conceptual point):
  The solvency channel asks "is the position underwater" — bad_debt = max(0, borrow −
  collateral·(1−δ)·r). It assumes you CAN sell/withdraw. Liquidity asks the orthogonal
  question: "can suppliers actually get their money OUT?" A position can be perfectly
  solvent (price fine) yet a supplier is STUCK because the cash has been lent out.

MECHANISM (lending-pool liquidity):
  A market/vault holds supply S of the loan asset, of which B is borrowed. Withdrawable
  cash = available = S − B. Utilization U = B/S. In a run, a fraction ρ of suppliers try
  to exit, demanding W = ρ·S. They can only pull `available`. Stuck capital:
      stuck = max(0, ρ·S − (S − B)) = max(0, B − (1−ρ)·S)
      liq_h = stuck / S = max(0, U + ρ − 1)            ← liquidity impairment
  The buffer here is FREE liquidity (1−U), the mirror of the over-collateralization
  buffer in solvency. U low → run absorbed (liq_h=0); U→1 → any run strands ρ of suppliers.

PROPAGATION (reuses the SAME DebtRank engine):
  market (supplier freeze) → vault (MetaMorpho can't honor redemptions; edge = alloc/total)
  → downstream. liq_h propagates exactly like solvency h, on a graph of identical shape.

CROSS-FEED to solvency (lst_queue_depeg): an LST/LRT withdrawal queue (Lido, etherFi,
  Kelp) has finite throughput. A run beyond instant capacity forces holders to dump on the
  secondary market at a discount — i.e. the *liquidity* run CREATES a *price* depeg (stETH
  traded ~6% below NAV in the 2022 run). That depeg then feeds the solvency channel: this
  is the liquidity→solvency环流 the dual model couples.

Papers: Cifuentes-Ferrucci-Shin 2005 (liquidity & fire-sale), Eisenberg-Noe (clearing
  under liquidity constraints), Diamond-Dybvig (run dynamics). Morpho market state gives
  S=supplyAssetsUsd, B=borrowAssetsUsd directly → U is observed, not assumed.
"""
from __future__ import annotations

import time

import httpx

from . import contagion_backtest as _cb
from ..sim.engine import propagate_dynamic as propagate

# imported lazily-style at call (live_contagion already owns the Morpho cache loader)
_TOP_MARKETS = 14
_TOP_VAULTS = 14

# LST/LRT withdrawal-queue parameters.
#   cap           = max secondary-market discount when the queue is badly congested
#                   (stETH ~6% in the 2022 run; LRTs thinner → larger cap)
#   capacity_frac = fraction of a run the queue/instant-liquidity absorbs with ~no discount
#                   (deeper protocols → larger). Excess run beyond this drives the depeg.
_QUEUE_PARAMS: dict[str, dict] = {
    "wstETH": {"cap": 0.06, "capacity_frac": 0.30, "lido": True},
    "stETH":  {"cap": 0.06, "capacity_frac": 0.30, "lido": True},
    "weETH":  {"cap": 0.10, "capacity_frac": 0.12},
    "eETH":   {"cap": 0.10, "capacity_frac": 0.12},
    "rsETH":  {"cap": 0.12, "capacity_frac": 0.08},
    "wrsETH": {"cap": 0.12, "capacity_frac": 0.08},
    "ezETH":  {"cap": 0.12, "capacity_frac": 0.08},
    "cbETH":  {"cap": 0.05, "capacity_frac": 0.25},
    "rETH":   {"cap": 0.06, "capacity_frac": 0.20},
}

# Lido withdrawal-queue live wait-time API (the real congestion signal: longer
# finalization wait → bigger secondary discount as holders sell instead of waiting).
_LIDO_WQ_API = "https://wq-api.lido.fi/v2/request-time/calculate"
_LIDO_REF_STETH = 300_000   # reference run size queried (severe run on an LST collateral)
_LIDO_T_HALF_DAYS = 8.0     # wait at which the depeg reaches half its cap
_lido_cache: dict[int, tuple[float, float | None]] = {}   # amount-bucket → (ts, wait_days)
_LIDO_TTL = 600


def _lido_wait_days(amount_steth: float) -> float | None:
    """Live finalization wait (days) for redeeming `amount_steth` via the Lido queue.
    None on failure → caller uses the capacity model. Cached per amount bucket (10 min),
    so the wait actually varies with run size."""
    amt = int(max(1.0, min(1e12 - 1, amount_steth)))
    bucket = max(1, round(amt / 10_000) * 10_000)   # 10k-stETH buckets
    now = time.time()
    c = _lido_cache.get(bucket)
    if c and (now - c[0]) < _LIDO_TTL:
        return c[1]
    wait = None
    try:
        r = httpx.get(_LIDO_WQ_API, params={"amount": bucket}, timeout=12)
        r.raise_for_status()
        ms = (r.json().get("requestInfo") or {}).get("finalizationIn")
        if ms:
            wait = float(ms) / 1000.0 / 86400.0  # ms → days
    except Exception:
        wait = None
    _lido_cache[bucket] = (now, wait)
    return wait


def _fmt_usd(x: float) -> str:
    """Compact, honest-precision USD for headlines (model estimates, not exact $)."""
    x = float(x or 0)
    if abs(x) >= 1e9:
        return f"${x/1e9:.2f}B"
    if abs(x) >= 1e6:
        return f"${x/1e6:.1f}M"
    if abs(x) >= 1e3:
        return f"${x/1e3:.0f}K"
    return f"${x:.0f}"


def market_illiquidity(supply_usd: float, borrow_usd: float, rho: float) -> float:
    """Fraction of a market's suppliers who CANNOT withdraw under a run of intensity ρ.
    liq_h = max(0, U + ρ − 1),  U = borrow/supply. In [0,1]."""
    if supply_usd <= 0:
        return 0.0
    u = borrow_usd / supply_usd
    return max(0.0, min(1.0, u + rho - 1.0))


def lst_queue_depeg(asset_symbol: str, rho: float) -> float:
    """Liquidity→solvency cross-feed: secondary-market depeg from withdrawal-queue
    congestion for an LST/LRT under a run of intensity ρ. 0 for non-queued assets.

    Lido (wstETH/stETH): uses the LIVE queue wait-time (longer finalization → bigger
    discount as holders sell instead of waiting). Others: a demand/capacity convex model
    — only the portion of the run beyond instant capacity drives the depeg."""
    p = _QUEUE_PARAMS.get(asset_symbol)
    if not p or rho <= 0:
        return 0.0
    cap = p["cap"]

    if p.get("lido"):
        wait = _lido_wait_days(_LIDO_REF_STETH * rho)
        if wait is not None:
            # saturating in wait time: depeg = cap · wait/(wait + T_half)
            return round(cap * wait / (wait + _LIDO_T_HALF_DAYS), 4)

    # capacity model: excess run beyond instant capacity, normalized to [0,1]
    cf = p["capacity_frac"]
    congestion = max(0.0, rho - cf) / max(1e-9, 1.0 - cf)
    return round(cap * congestion, 4)


def build_liquidity_graph(asset_symbol: str, rho: float, downstream: bool = True,
                          venue_names=("morpho", "aave", "spark")) -> dict:
    """Liquidity-run graph for a run of intensity ρ on suppliers of `asset_symbol`
    (the LOAN/supplied asset). Same node/edge shape as the solvency graph so the engine
    and to_frontend serializer are reused. Covers Morpho markets/vaults AND Aave/Spark
    reserves (reserve-level utilization)."""
    from . import live_contagion as _live  # avoid import cycle
    from . import aave_positions as _aave
    markets, vaults = _live._load_live()

    use_morpho = "morpho" in venue_names
    # markets where `asset_symbol` is the SUPPLIED (loan) asset — its suppliers run
    sel = ([m for m in markets if (m.get("loanAsset") or {}).get("symbol") == asset_symbol]
           if use_morpho else [])
    sel.sort(key=lambda m: -((m.get("state") or {}).get("supplyAssetsUsd") or 0))
    sel = sel[:_TOP_MARKETS]

    nodes = [
        {"id": "ROOT", "type": "protocol", "tvl": 0.0, "label": f"{asset_symbol} 인출런"},
        {"id": f"asset_{asset_symbol}", "type": "asset", "tvl": 0.0, "label": asset_symbol},
    ]
    edges = [{"from": "ROOT", "to": f"asset_{asset_symbol}", "w": round(rho, 4), "etype": "run"}]
    venues: list[dict] = []
    id_for: dict[str, str] = {}

    # ── Aave V3 + SparkLend reserves (reserve-level utilization run) ──
    reserve_specs = []
    if "aave" in venue_names:
        reserve_specs.append(("Aave V3", _aave.AAVE_SUBGRAPH, "lresv_aave"))
    if "spark" in venue_names:
        reserve_specs.append(("Spark", _aave.SPARK_SUBGRAPH, "lresv_spark"))
    for vlabel, vurl, nid in reserve_specs:
        r = _aave.reserve_liquidity(asset_symbol, subgraph=vurl)
        if not r or r["supply_usd"] <= 0:
            continue
        liq_h = market_illiquidity(r["supply_usd"], r["borrow_usd"], rho)
        nodes.append({"id": nid, "type": "lending_market", "tvl": r["supply_usd"],
                      "label": f"{vlabel} · {asset_symbol} 리저브", "venue": vlabel})
        w = (liq_h / rho) if rho > 0 else 0.0
        if w > 0:
            edges.append({"from": f"asset_{asset_symbol}", "to": nid,
                          "w": round(min(1.0, w), 6), "etype": "liquidity"})
        venues.append({"node": nid, "label": f"{vlabel} · {asset_symbol}",
                       "supply_usd": r["supply_usd"], "utilization": round(r["utilization"], 4),
                       "liq_h": round(liq_h, 4),
                       "available_usd": round(r["supply_usd"] - r["borrow_usd"]),
                       "frozen_usd": round(liq_h * r["supply_usd"])})

    for i, m in enumerate(sel):
        st = m.get("state") or {}
        supply = st.get("supplyAssetsUsd") or 0.0
        borrow = st.get("borrowAssetsUsd") or 0.0
        if supply <= 0:
            continue
        liq_h = market_illiquidity(supply, borrow, rho)
        u = borrow / supply if supply else 0.0
        nid = f"lmkt_{i}"
        id_for[m["marketId"]] = nid
        collat = (m.get("collateralAsset") or {}).get("symbol") or "?"
        nodes.append({"id": nid, "type": "lending_market", "tvl": supply,
                      "label": f"{collat}/{asset_symbol}", "marketId": m["marketId"],
                      "venue": "Morpho Blue"})
        w = (liq_h / rho) if rho > 0 else 0.0
        if w > 0:
            edges.append({"from": f"asset_{asset_symbol}", "to": nid,
                          "w": round(min(1.0, w), 6), "etype": "liquidity"})
        venues.append({"node": nid, "label": f"{collat}/{asset_symbol}", "supply_usd": supply,
                       "utilization": round(u, 4), "liq_h": round(liq_h, 4),
                       "available_usd": round(supply - borrow),
                       "frozen_usd": round(liq_h * supply)})

    # ── Pendle AMM pools (when the run asset is a Pendle underlying): PT holders rush the
    #    pool → slippage → value they can't exit at par. liq_h = price_impact(ρ·pool, pool). ──
    from . import pendle_amm as _pendle
    from . import dex_liquidity as _dex
    for k, pm in enumerate(sorted(_pendle.markets_for_underlying(asset_symbol),
                                  key=lambda x: -x["liquidity_usd"])[:6]):
        pool = pm["liquidity_usd"]
        if pool <= 0:
            continue
        liq_h = _dex.price_impact(rho * pool, pool)   # slippage to exit ρ of the pool
        nid = f"pendle_{k}"
        nodes.append({"id": nid, "type": "lending_market", "tvl": pool, "venue": "Pendle",
                      "label": f"Pendle PT-{asset_symbol} 풀"})
        w = (liq_h / rho) if rho > 0 else 0.0
        if w > 0:
            edges.append({"from": f"asset_{asset_symbol}", "to": nid,
                          "w": round(min(1.0, w), 6), "etype": "liquidity"})
        venues.append({"node": nid, "label": f"Pendle PT-{asset_symbol}", "supply_usd": pool,
                       "utilization": None, "liq_h": round(liq_h, 4),
                       "available_usd": round(pool * (1 - liq_h)), "frozen_usd": round(liq_h * pool)})

    # vaults supplying `asset_symbol` that allocate into the running markets
    cand = []
    for v in vaults:
        total = (v.get("state") or {}).get("totalAssetsUsd") or 0.0
        if total <= 0:
            continue
        rows, exposure = [], 0.0
        for a in ((v.get("state") or {}).get("allocation") or []):
            mid = (a.get("market") or {}).get("marketId")
            if mid in id_for:
                alloc = a.get("supplyAssetsUsd") or 0.0
                if alloc > 0:
                    exposure += alloc
                    rows.append({"from": id_for[mid], "to": f"vault_{v['address'][:10]}",
                                 "w": round(min(1.0, alloc / total), 6), "etype": "allocation"})
        if rows:
            cand.append((exposure, v, total, rows))
    cand.sort(key=lambda x: -x[0])
    kept_vaults = cand[:_TOP_VAULTS]
    for _exp, v, total, rows in kept_vaults:
        nodes.append({"id": f"vault_{v['address'][:10]}", "type": "vault", "tvl": total,
                      "label": v["name"], "address": v["address"], "tier": 1,
                      "venue": "Morpho Blue"})
        edges.extend(rows)

    # downstream: vault shares reused as collateral → their markets also lose redemption
    vault_addr_to_node = ({v["address"].lower(): f"vault_{v['address'][:10]}"
                           for _e, v, _t, _r in kept_vaults} if downstream else {})
    for j, m in enumerate(markets):
        ca = ((m.get("collateralAsset") or {}).get("address") or "").lower()
        src = vault_addr_to_node.get(ca)
        if not src:
            continue
        st = m.get("state") or {}
        supply = st.get("supplyAssetsUsd") or 0.0
        if supply <= 0:
            continue
        loan = (m.get("loanAsset") or {}).get("symbol") or "?"
        nid = f"lds_mkt_{j}"
        nodes.append({"id": nid, "type": "lending_market", "tvl": supply, "venue": "Morpho Blue",
                      "label": f"{(m['collateralAsset'] or {}).get('symbol')}/{loan}", "tier": 2})
        # a frozen vault share can't be redeemed → markets using it as collateral lose liquidity
        w = min(1.0, (st.get("borrowAssetsUsd") or 0.0) / supply) if supply else 0.0
        if w > 0:
            edges.append({"from": src, "to": nid, "w": round(w, 6)})

    return {"graph": {"nodes": nodes, "edges": edges},
            "shock": {"node": "ROOT", "delta": 1.0},
            "meta": {"rho": rho, "asset": asset_symbol, "venues": venues}}


def aggregate_liquidity(assets: list[str], rho: float, downstream: bool = True,
                        venues=("morpho", "aave", "spark"), max_assets: int = 5) -> dict | None:
    """Run a liquidity run of intensity ρ across MULTIPLE supplied assets (e.g. every asset
    a failed oracle prices) and aggregate the frozen capital. Caps to the `max_assets`
    largest contributors to bound subgraph calls. Returns aggregate totals + the dominant
    asset's full result (for rendering), or None if nothing freezes."""
    results: list[tuple[str, dict]] = []
    for a in assets[:max_assets]:
        try:
            r = run_liquidity_contagion(a, rho, downstream=downstream, venues=venues)
        except Exception:
            continue
        if (r.get("impact") or {}).get("total_frozen_usd", 0) > 0:
            results.append((a, r))
    if not results:
        return None
    results.sort(key=lambda x: -x[1]["impact"]["total_frozen_usd"])
    total_frozen = sum(r["impact"]["total_frozen_usd"] for _, r in results)
    market_frozen = sum(r["impact"].get("market_frozen_usd", 0) for _, r in results)
    vault_frozen = sum(r["impact"].get("vault_frozen_usd", 0) for _, r in results)
    all_mkts: list[dict] = []
    for _, r in results:
        all_mkts += r["impact"].get("top_markets", [])
    all_mkts.sort(key=lambda m: -m.get("bad_debt_usd", 0))
    return {"total_frozen_usd": round(total_frozen), "market_frozen_usd": round(market_frozen),
            "vault_frozen_usd": round(vault_frozen), "top_markets": all_mkts[:8],
            "dominant": results[0][1], "n_assets": len(results),
            "assets": [a for a, _ in results]}


def run_liquidity_contagion(asset_symbol: str, rho: float, downstream: bool = True,
                            venues=("morpho", "aave", "spark")) -> dict:
    """Run the liquidity-run DebtRank on current state (Morpho markets/vaults + Aave/Spark
    reserves). Returns the same payload shape as run_live_contagion (kind='live',
    channel='liquidity'); metrics are FROZEN capital (not lost), utilization-driven."""
    built = build_liquidity_graph(asset_symbol, rho, downstream=downstream, venue_names=venues)
    graph = built["graph"]
    res = propagate(graph, built["shock"])
    usd = dict(res["ranking_usd"])
    vmeta = {v["node"]: v for v in built["meta"]["venues"]}

    markets = sorted(
        [{"node": n["id"], "label": n["label"], "supply_usd": n["tvl"],
          "h": round(res["h"][n["id"]], 4), "frozen_usd": round(usd.get(n["id"], 0.0)),
          "utilization": vmeta.get(n["id"], {}).get("utilization"),
          "available_usd": vmeta.get(n["id"], {}).get("available_usd")}
         for n in graph["nodes"] if n["type"] == "lending_market"],
        key=lambda x: -x["frozen_usd"])
    vaults = sorted(
        [{"node": n["id"], "label": n["label"], "address": n.get("address"),
          "total_usd": n["tvl"], "h": round(res["h"][n["id"]], 4),
          "frozen_usd": round(usd.get(n["id"], 0.0))}
         for n in graph["nodes"] if n["type"] == "vault"],
        key=lambda x: -x["frozen_usd"])

    market_frozen = sum(m["frozen_usd"] for m in markets)
    vault_frozen = sum(v["frozen_usd"] for v in vaults)

    net_value = sum(n.get("tvl", 0.0) for n in graph["nodes"] if n.get("tvl", 0) > 0)
    impaired = sum(res["h"].get(n["id"], 0.0) * n.get("tvl", 0.0)
                   for n in graph["nodes"] if n.get("tvl", 0) > 0)
    systemic = round(100 * impaired / net_value, 1) if net_value > 0 else 0.0

    result = {
        "incident_id": f"live_liq_{asset_symbol}", "kind": "live", "channel": "liquidity",
        "event": {"id": f"liq_{asset_symbol}", "date": "now", "shock_node": asset_symbol,
                  "delta": rho, "pre_shock_date": "현재 state",
                  "description": f"{asset_symbol} 인출런 ρ={rho*100:.0f}% (liquidity)"},
        "modes": {"solvency": {
            "mode": "solvency", "graph": graph, "shock": built["shock"],
            "asset_deltas": {asset_symbol: rho},
            "rounds": res["rounds"], "distress_round": res["distress_round"],
            "h": {k: round(v, 4) for k, v in res["h"].items() if v > 0},
            "market_bad_debt": [{"node": m["node"], "label": m["label"], "supply_usd": m["supply_usd"],
                                 "h": m["h"], "implied_bad_debt_usd": m["frozen_usd"]} for m in markets],
            "vault_predictions": [{"node": v["node"], "label": v["label"], "address": v["address"],
                                   "total_usd": v["total_usd"], "h": v["h"],
                                   "predicted_loss_usd": v["frozen_usd"]} for v in vaults],
        }},
        "impact": {
            "channel": "liquidity",
            "total_frozen_usd": round(market_frozen + vault_frozen),
            "market_frozen_usd": round(market_frozen),
            "vault_frozen_usd": round(vault_frozen),
            # mirror the solvency field names so existing UI cards still render a number
            "total_bad_debt_usd": round(market_frozen + vault_frozen),
            "morpho_bad_debt_usd": round(market_frozen),
            "total_vault_loss_usd": round(vault_frozen),
            "n_markets": len(markets), "n_vaults": len(vaults),
            "top_markets": [{"node": m["node"], "label": m["label"], "supply_usd": m["supply_usd"],
                             "h": m["h"], "bad_debt_usd": m["frozen_usd"],
                             "utilization": m["utilization"], "available_usd": m["available_usd"]}
                            for m in markets[:8]],
            "top_vaults": [{"node": v["node"], "label": v["label"], "total_usd": v["total_usd"],
                            "h": v["h"], "loss_usd": v["frozen_usd"]} for v in vaults[:8]],
            "position_venues": [],
            "systemic_impact_score": systemic,
            "n_downstream_nodes": sum(1 for n in graph["nodes"] if n.get("tier") == 2),
            "lambda_max": res.get("lambda_max", 0.0),
            "stable": res.get("stable", True),
            "shock_oracle_type": "liquidity",
        },
        "headline": (
            f"{asset_symbol} 인출런 ρ={rho*100:.0f}% — 동결 자본(hop-1) 약 {_fmt_usd(market_frozen+vault_frozen)} "
            f"(마켓 {_fmt_usd(market_frozen)} · 볼트 {_fmt_usd(vault_frozen)}), 시스템 영향도 {systemic}/100. "
            f"공급자가 못 빼는 금액(=utilization 버퍼 초과분), 손실 아님. liquidity 채널."),
    }
    fe = _cb.to_frontend(result, "solvency")
    return {**result, "render": fe, "render_mode": "solvency"}
