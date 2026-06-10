"""
live_contagion.py — run the SAME DebtRank contagion on CURRENT (live) Morpho state.

Backtest (contagion_backtest.py) uses historical snapshots; this uses current `state`
for a USER-CHOSEN shock asset + severity. Same weight logic (weights_morpho._market_impairment),
same engine (sim.engine.propagate), same frontend serializer (contagion_backtest.to_frontend).

"Live dependency = accumulated events = current state" — we read state, not raw events.

Endpoints (main.py):
  GET /api/contagion/live/assets            -> shockable collateral assets (current exposure)
  GET /api/contagion/live?asset=wstETH&delta=0.3  -> weighted graph + propagation + impact
"""
from __future__ import annotations

import time
from typing import Optional

import httpx

from .weights_morpho import _market_impairment
from . import contagion_backtest as _cb
from . import aave_positions as _aave
from . import derivatives as _derivatives
from . import dex_liquidity as _dex
from . import oracle_feeds as _oracle
from . import liquidity as _liq
from . import sky_cdp as _sky
from . import pendle_amm as _pendle
from . import discovered_links as _disc
from ..sim.engine import propagate_dynamic as propagate  # Bardoscia dynamical DebtRank

MORPHO_API = "https://blue-api.morpho.org/graphql"

_TOP_MARKETS_PER_ASSET = 12      # cap graph size for legibility
_TOP_VAULTS = 14                 # keep the most-exposed vaults only
_CACHE_TTL = 300                 # seconds
_cache: dict = {"ts": 0.0, "markets": None, "vaults": None}

_Q_MARKETS = """
query M($first:Int!){ markets(first:$first, orderBy:SupplyAssetsUsd, orderDirection:Desc,
  where:{chainId_in:[1]}){ items{
    marketId lltv
    collateralAsset{ symbol address }
    loanAsset{ symbol }
    state{ supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd }
} } }"""

_Q_VAULTS = """
query V($first:Int!){ vaults(first:$first, orderBy:TotalAssetsUsd, orderDirection:Desc,
  where:{chainId_in:[1]}){ items{
    address name
    state{ totalAssetsUsd allocation{ supplyAssetsUsd market{ marketId } } }
} } }"""


def _gql(client: httpx.Client, query: str, variables: dict) -> dict:
    r = client.post(MORPHO_API, json={"query": query, "variables": variables}, timeout=40)
    r.raise_for_status()
    d = r.json()
    if "errors" in d:
        raise RuntimeError(str(d["errors"])[:300])
    return d["data"]


def _fmt_usd(x: float) -> str:
    """Compact, honest-precision USD for headlines (these are MODEL estimates with
    approximate parameters — full-digit precision would be false precision)."""
    x = float(x or 0)
    if abs(x) >= 1e9:
        return f"${x/1e9:.2f}B"
    if abs(x) >= 1e6:
        return f"${x/1e6:.1f}M"
    if abs(x) >= 1e3:
        return f"${x/1e3:.0f}K"
    return f"${x:.0f}"


def _apply_freeze(nodes: list[dict], freeze: frozenset) -> None:
    """Mark nodes frozen (governance freeze blocker): a frozen node still REALIZES its own
    hop-1 loss but does NOT transmit downstream (engine zeroes its outgoing). Models e.g.
    Aave freezing the rsETH market during the kelp incident. Matches by collateral/asset
    symbol (the first token of a 'collat/loan' market label, or an asset-hub label)."""
    if not freeze:
        return
    fz = {s.lower() for s in freeze}
    for n in nodes:
        t = n.get("type")
        if t == "lending_market":
            collat = (n.get("label", "").split("/")[0]).strip().lower()
            if collat in fz:
                n["frozen"] = True
        elif t == "asset" and str(n.get("id", "")).startswith(("asset_", "deriv_", "oderiv_")):
            if n.get("label", "").split(" ")[0].strip().lower() in fz:
                n["frozen"] = True


def _rec(symbol: str, recovery: float | None) -> float:
    """Resolve the base recovery: None → per-asset auto (liquidation-mechanics derived)."""
    return _dex.auto_base_recovery(symbol) if recovery is None else recovery


def _rec_label(recovery: float | None) -> str:
    return "자동(자산별)" if recovery is None else f"{round(recovery * 100)}%"


def _morpho_base(market: dict, fallback_symbol: str) -> float:
    """Auto base recovery for a Morpho market = 1/LIF from its LLTV (real liquidation
    incentive); falls back to the per-asset oracle-type default if LLTV is missing."""
    return _dex.morpho_recovery_from_lltv(market.get("lltv")) or _dex.auto_base_recovery(fallback_symbol)


def _pt_recovery(market: dict, base_recovery: float | None, borrow_usd: float | None,
                 depth_haircut: float = 0.0) -> float:
    """Fire-sale recovery for a Pendle PT collateral, using the PT's OWN Pendle AMM pool
    liquidity as the depth (PT trades in the Pendle pool, not Uniswap). Falls back to the
    generic NAV behaviour (base) if the PT isn't in Pendle's active set."""
    base_recovery = _rec((market.get("collateralAsset") or {}).get("symbol") or "", base_recovery)
    pt_addr = ((market.get("collateralAsset") or {}).get("address") or "")
    depth = _pendle.pt_amm_depth_by_addr(pt_addr)
    if not depth:
        return base_recovery
    return _dex.firesale_recovery(base_recovery, float(borrow_usd or 0.0),
                                  depth * (1.0 - depth_haircut))


def _eff_recovery(symbol: str, base_recovery: float | None, borrow_usd: float | None,
                  depth_haircut: float = 0.0) -> float:
    """Per-market recovery adjusted for the DEX fire-sale channel (Cifuentes): a DEX-priced
    collateral must be SOLD to cover the borrow, and that sale moves price → lower recovery.
    NAV/CAPO assets (LST/LRT, PT) redeem at NAV and are unchanged. liquidation size ≈ borrow.
    depth_haircut ∈ [0,1): shrinks DEX depth (LP flight in a run) → worse recovery (A4).
    base_recovery=None → per-asset auto base (liquidation-mechanics derived)."""
    base_recovery = _rec(symbol, base_recovery)
    depth = _dex.dex_depth_for(symbol) * (1.0 - depth_haircut)
    return _dex.effective_recovery(symbol, base_recovery,
                                   liquidation_usd=float(borrow_usd or 0.0),
                                   dex_depth_usd=depth)


# bad-debt sink nodes carry a hand-set VIZ h (node colouring only) — excluded from the
# systemic-impact score (see _scored). 0.6 floor + 0.4·δ so worse shocks colour redder.
def _sink_h(delta: float) -> float:
    return round(min(1.0, 0.6 + 0.4 * delta), 4)


_MAX_POS_ACCOUNTS = 12   # cap individual liquidatable-account nodes per venue (legibility)


def _emit_position_venue(graph: dict, res: dict, a: dict, vlabel: str, src_id: str,
                         bucket_id: str, bucket_label: str, price_delta: float) -> None:
    """Full Morpho-level sub-graph for a position venue (Aave V3 / SparkLend):
        src → reserve bucket (position_bucket)
            → individual liquidatable ACCOUNTS (position_account, top by bad debt)
            → per-borrowed-asset supplier reserve loss_sinks (each account → the reserves it owes).
    `approx=True`: from a TOP-N account scan, not a full liquidation engine."""
    last_round = (max(res["distress_round"].values()) + 1) if res["distress_round"] else 2
    graph["nodes"].append({"id": bucket_id, "type": "lending_market",
                           "tvl": float(a.get("collateral_liquidated_usd", 0) or 0),
                           "label": bucket_label, "venue": vlabel, "role": "position_bucket",
                           "data_source": "subgraph", "approx": True})
    graph["edges"].append({"from": src_id, "to": bucket_id, "w": round(price_delta, 4),
                           "etype": "collateral"})
    res["h"][bucket_id] = round(price_delta, 4)
    res["distress_round"][bucket_id] = last_round

    # per-borrowed-asset supplier reserve sinks (drawn individually)
    sink_ids: dict[str, str] = {}
    for sym, bd in (a.get("bad_debt_by_asset") or {}).items():
        sid = f"{bucket_id}_loss_{sym}"
        sink_ids[sym] = sid
        graph["nodes"].append({"id": sid, "type": "asset", "tvl": float(bd),
                               "label": f"{vlabel} {sym} 공급자", "venue": vlabel,
                               "role": "loss_sink", "data_source": "subgraph", "approx": True})
        res["h"][sid] = _sink_h(price_delta)
        res["distress_round"][sid] = last_round + 2

    # individual liquidatable accounts (top by bad debt) → the reserves they leave bad debt in
    for k, acc in enumerate((a.get("accounts") or [])[:_MAX_POS_ACCOUNTS]):
        aid = f"{bucket_id}_acc{k}"
        short = (acc.get("id") or "")[:6]
        graph["nodes"].append({"id": aid, "type": "lending_market",
                               "tvl": float(acc.get("debt_usd", 0) or 0),
                               "label": f"{short}… (HF<1)", "venue": vlabel,
                               "role": "position_account", "data_source": "subgraph", "approx": True})
        graph["edges"].append({"from": bucket_id, "to": aid, "w": round(price_delta, 4),
                               "etype": "collateral"})
        res["h"][aid] = round(price_delta, 4)
        res["distress_round"][aid] = last_round + 1
        bd_total = sum(acc.get("borrowed", {}).values()) or 1
        for sym, bd in (acc.get("borrowed") or {}).items():
            if sym in sink_ids:
                graph["edges"].append({"from": aid, "to": sink_ids[sym],
                                       "w": round(min(1.0, bd / bd_total), 4), "etype": "allocation"})


def _emit_sky_cdp(graph: dict, res: dict, cdp: dict, src_id: str, price_delta: float) -> None:
    """Standardized sub-graph for Sky CDP: src → per-ilk node (role=cdp_ilk) → shared
    USDS/DAI surplus-buffer loss_sink. Per-ilk detail (WSTETH-A/B…) instead of one hub."""
    last_round = (max(res["distress_round"].values()) + 1) if res["distress_round"] else 2
    sink = "skycdp_buffer"
    graph["nodes"].append({"id": sink, "type": "asset", "tvl": float(cdp["total_bad_debt_usd"]),
                           "label": "USDS/DAI surplus buffer", "venue": "Sky CDP",
                           "role": "loss_sink", "data_source": "registry", "approx": True})
    res["h"][sink] = _sink_h(price_delta)
    res["distress_round"][sink] = last_round + 1
    for it in cdp.get("ilks", []):
        if it.get("bad_debt_usd", 0) <= 0:
            continue
        nid = f"skycdp_{it['ilk']}"
        graph["nodes"].append({"id": nid, "type": "lending_market", "tvl": float(it["collateral_usd"]),
                               "label": f"Sky · {it['ilk']}", "venue": "Sky CDP", "role": "cdp_ilk",
                               "data_source": "registry", "approx": True})
        graph["edges"].append({"from": src_id, "to": nid, "w": round(price_delta, 4),
                               "etype": "collateral"})
        # h so that h·collateral ≈ ilk bad debt (keeps the score honest)
        res["h"][nid] = round(min(1.0, it["bad_debt_usd"] / it["collateral_usd"]), 4) if it["collateral_usd"] else 0.0
        res["distress_round"][nid] = last_round
        graph["edges"].append({"from": nid, "to": sink, "w": 1.0, "etype": "allocation"})


def _load_live(force: bool = False) -> tuple[list, list]:
    """Fetch + cache current markets and vaults."""
    now = time.time()
    if not force and _cache["markets"] is not None and (now - _cache["ts"]) < _CACHE_TTL:
        return _cache["markets"], _cache["vaults"]
    with httpx.Client() as client:
        markets = _gql(client, _Q_MARKETS, {"first": 1000})["markets"]["items"]
        vaults = _gql(client, _Q_VAULTS, {"first": 1000})["vaults"]["items"]
    _cache.update(ts=now, markets=markets, vaults=vaults)
    return markets, vaults


def list_shockable_assets(limit: int = 200) -> list[dict]:
    """Collateral assets across Morpho ∪ Aave, tagged with which venues they appear in."""
    markets, _ = _load_live()
    agg: dict[str, dict] = {}
    for m in markets:
        ca = m.get("collateralAsset") or {}
        sym = ca.get("symbol")
        if not sym:
            continue
        st = m.get("state") or {}
        a = agg.setdefault(sym, {"symbol": sym, "address": ca.get("address"),
                                 "n_markets": 0, "supply_usd": 0.0, "borrow_usd": 0.0,
                                 "venues": ["morpho"]})
        a["n_markets"] += 1
        a["supply_usd"] += st.get("supplyAssetsUsd") or 0.0
        a["borrow_usd"] += st.get("borrowAssetsUsd") or 0.0
    # union with Aave collateral assets
    try:
        for av in _aave.list_aave_collateral_assets():
            sym = av["symbol"]
            if sym in agg:
                if "aave" not in agg[sym]["venues"]:
                    agg[sym]["venues"].append("aave")
                agg[sym]["supply_usd"] += av["supply_usd"]
                agg[sym]["n_markets"] += av["n_markets"]
            else:
                agg[sym] = {"symbol": sym, "address": None, "n_markets": av["n_markets"],
                            "supply_usd": av["supply_usd"], "borrow_usd": 0.0, "venues": ["aave"]}
    except Exception:
        pass
    # union with SparkLend collateral assets (Sky's lending arm)
    try:
        for sv in _aave.list_aave_collateral_assets(subgraph=_aave.SPARK_SUBGRAPH):
            sym = sv["symbol"]
            if sym in agg:
                if "spark" not in agg[sym]["venues"]:
                    agg[sym]["venues"].append("spark")
                agg[sym]["supply_usd"] += sv["supply_usd"]
                agg[sym]["n_markets"] += sv["n_markets"]
            else:
                agg[sym] = {"symbol": sym, "address": None, "n_markets": sv["n_markets"],
                            "supply_usd": sv["supply_usd"], "borrow_usd": 0.0, "venues": ["spark"]}
    except Exception:
        pass
    out = sorted(agg.values(), key=lambda x: -x["supply_usd"])
    return [a for a in out if a["supply_usd"] > 100_000][:limit]


def _live_supply_by_symbol() -> dict[str, float]:
    """Aggregate live collateral supply (Morpho ∪ Aave ∪ Spark) per symbol — used to
    intersect oracle blast radii with assets that actually carry exposure."""
    markets, _ = _load_live()
    supply: dict[str, float] = {}
    for m in markets:
        sym = (m.get("collateralAsset") or {}).get("symbol")
        if not sym:
            continue
        supply[sym] = supply.get(sym, 0.0) + ((m.get("state") or {}).get("supplyAssetsUsd") or 0.0)
    for getter in (lambda: _aave.list_aave_collateral_assets(),
                   lambda: _aave.list_aave_collateral_assets(subgraph=_aave.SPARK_SUBGRAPH)):
        try:
            for a in getter():
                supply[a["symbol"]] = supply.get(a["symbol"], 0.0) + a["supply_usd"]
        except Exception:
            pass
    return supply


def list_runnable_assets(limit: int = 80) -> list[dict]:
    """Supplied (loan) assets on Morpho — selectable targets for a LIQUIDITY run. Each
    aggregates supply/borrow across its markets to expose live utilization (the buffer
    that decides whether a run is absorbed)."""
    markets, _ = _load_live()
    agg: dict[str, dict] = {}
    for m in markets:
        la = m.get("loanAsset") or {}
        sym = la.get("symbol")
        if not sym:
            continue
        st = m.get("state") or {}
        a = agg.setdefault(sym, {"symbol": sym, "address": None, "n_markets": 0,
                                 "supply_usd": 0.0, "borrow_usd": 0.0,
                                 "venues": ["morpho"], "kind": "loan"})
        a["n_markets"] += 1
        a["supply_usd"] += st.get("supplyAssetsUsd") or 0.0
        a["borrow_usd"] += st.get("borrowAssetsUsd") or 0.0
    for a in agg.values():
        a["utilization"] = round(a["borrow_usd"] / a["supply_usd"], 4) if a["supply_usd"] else 0.0
    out = sorted(agg.values(), key=lambda x: -x["supply_usd"])
    return [a for a in out if a["supply_usd"] > 100_000][:limit]


def list_shockable_oracles() -> list[dict]:
    """Shared oracles whose failure is a COMMON-MODE shock (one feed → many assets
    depeg at once). Each is returned as a shock target alongside plain collateral
    assets (symbol = oracle id, kind = 'oracle'). Blast radius = assets with live
    exposure that the oracle prices; supply_usd = their aggregate collateral."""
    supply = _live_supply_by_symbol()
    live_syms = set(supply)
    out: list[dict] = []
    for oid, meta in _oracle.ORACLES.items():
        affected = _oracle.assets_for_oracle(oid, live_syms)
        if not affected:
            continue
        blast = sum(supply.get(s, 0.0) for s in affected)
        out.append({
            "symbol": oid, "label": meta["label"], "kind": "oracle",
            "provider": meta.get("provider"), "note": meta.get("note"),
            "address": None, "n_markets": len(affected),
            "supply_usd": blast, "borrow_usd": 0.0,
            "venues": ["oracle"], "affected": list(affected.keys()),
        })
    return sorted(out, key=lambda x: -x["supply_usd"])


def build_live_graph(asset_symbol: str, delta: float, mode: str = "solvency",
                     recovery: float | None = None, downstream: bool = True,
                     include_markets: bool = True, dex_depth_haircut: float = 0.0,
                     freeze: frozenset = frozenset(), firesale: bool = True) -> dict:
    """Weighted contagion graph for shocking `asset_symbol` by `delta`, from current state.
    recovery: liquidation recovery factor passed to the absorption formula.
    downstream: include tier-2 vault-share-as-collateral recursion.
    include_markets: include Morpho markets/vaults (False = only root+asset, e.g. Aave-only).
    firesale: when False, use `recovery` directly (NO DEX price-impact haircut) — this is the
    M1-only NAIVE absorption floor used to isolate the fire-sale mechanism's contribution."""
    markets, vaults = _load_live()
    # markets collateralized by the chosen asset, biggest first, capped
    sel = ([m for m in markets if (m.get("collateralAsset") or {}).get("symbol") == asset_symbol]
           if include_markets else [])
    sel.sort(key=lambda m: -((m.get("state") or {}).get("supplyAssetsUsd") or 0))
    sel = sel[:_TOP_MARKETS_PER_ASSET]
    sel_ids = {m["marketId"] for m in sel}

    nodes = [
        {"id": "ROOT", "type": "protocol", "tvl": 0.0, "label": f"{asset_symbol} 충격"},
        {"id": f"asset_{asset_symbol}", "type": "asset", "tvl": 0.0, "label": asset_symbol},
    ]
    edges = [{"from": "ROOT", "to": f"asset_{asset_symbol}", "w": round(delta, 4), "etype": "shock"}]
    venues = []
    id_for = {}
    for i, m in enumerate(sel):
        st = m.get("state") or {}
        supply = st.get("supplyAssetsUsd") or 0.0
        if supply <= 0:
            continue
        # auto base = this market's REAL liquidation incentive (Morpho LIF from LLTV); manual r overrides
        mkt_base = recovery if recovery is not None else _morpho_base(m, asset_symbol)
        h_M = _market_impairment(
            {"pre_supply_usd": supply, "pre_borrow_usd": st.get("borrowAssetsUsd") or 0.0,
             "pre_collateral_usd": st.get("collateralAssetsUsd") or 0.0}, delta, mode,
            recovery_factor=(mkt_base if not firesale else
                             _eff_recovery(asset_symbol, mkt_base, st.get("borrowAssetsUsd"),
                                           depth_haircut=dex_depth_haircut)))
        nid = f"mkt_{i}"
        id_for[m["marketId"]] = nid
        loan = (m.get("loanAsset") or {}).get("symbol") or "?"
        nodes.append({"id": nid, "type": "lending_market", "tvl": supply,
                      "label": f"{asset_symbol}/{loan}", "marketId": m["marketId"]})
        w = (h_M / delta) if delta > 0 else 0.0
        if w > 0:
            edges.append({"from": f"asset_{asset_symbol}", "to": nid, "w": round(min(1.0, w), 6),
                          "etype": "collateral"})
        venues.append({"node": nid, "label": f"{asset_symbol}/{loan}", "supply_usd": supply,
                       "h_M": round(h_M, 4), "implied_bad_debt_usd": round(h_M * supply)})

    # ── Derivatives: tokens that are claims on the shock asset (Lido wstETH, etherFi
    #    weETH, Pendle PT…) depeg with it → their collateral markets. ONE mechanism,
    #    many protocols plug in (see derivatives.py). depeg = δ × depeg_factor. ──
    if include_markets and delta > 0:
        derivs = sorted(_derivatives.derivatives_of(asset_symbol, markets),
                        key=lambda d: -((d["market"].get("state") or {}).get("supplyAssetsUsd") or 0))[:10]
        hubs_made: set[str] = set()
        for k, d in enumerate(derivs):
            m = d["market"]; st = m.get("state") or {}
            supply = st.get("supplyAssetsUsd") or 0.0
            if supply <= 0:
                continue
            f = d["depeg_factor"]
            d_delta = delta * f
            is_pt = d["label"].upper().startswith("PT")
            pt_addr = ((m.get("collateralAsset") or {}).get("address") or "")
            pt_pool = _pendle.pt_amm_depth_by_addr(pt_addr) if is_pt else None
            hub = f"deriv_{d['label']}"
            if hub not in hubs_made:
                hubs_made.add(hub)
                # Pendle PT hub = the PT's AMM pool node (the depth that prices PT liquidations).
                hub_node = {"id": hub, "type": "asset", "tvl": float(pt_pool or 0.0),
                            "label": f"{d['label']} ({d['protocol']})", "venue": d["protocol"]}
                if is_pt:
                    hub_node["role"] = "amm_pool"
                    hub_node["data_source"] = "pendle_live" if pt_pool else "fallback_nav"
                nodes.append(hub_node)
                edges.append({"from": f"asset_{asset_symbol}", "to": hub,
                              "w": round(min(1.0, f), 4), "etype": "derivative"})
            d_base = recovery if recovery is not None else _morpho_base(m, d["label"])
            h_M = _market_impairment(
                {"pre_supply_usd": supply, "pre_borrow_usd": st.get("borrowAssetsUsd") or 0.0,
                 "pre_collateral_usd": st.get("collateralAssetsUsd") or 0.0}, d_delta, mode,
                recovery_factor=(d_base if not firesale else
                                 _pt_recovery(m, d_base, st.get("borrowAssetsUsd"), dex_depth_haircut)
                                     if is_pt
                                     else _eff_recovery(d["label"], d_base, st.get("borrowAssetsUsd"),
                                                        depth_haircut=dex_depth_haircut)))
            nid = f"deriv_mkt_{k}"
            id_for[m["marketId"]] = nid
            loan = (m.get("loanAsset") or {}).get("symbol") or "?"
            nodes.append({"id": nid, "type": "lending_market", "tvl": supply,
                          "label": f"{d['label']}/{loan}", "marketId": m["marketId"], "tier": 1,
                          "venue": "Morpho Blue", "collateral_protocol": d["protocol"],
                          "data_source": ("pendle_live" if pt_pool else "pendle_fallback") if is_pt else None})
            w = (h_M / d_delta) if d_delta > 0 else 0.0
            if w > 0:
                edges.append({"from": hub, "to": nid, "w": round(min(1.0, w), 6), "etype": "collateral"})
            venues.append({"node": nid, "label": f"{d['label']}/{loan}", "supply_usd": supply,
                           "h_M": round(h_M, 4), "implied_bad_debt_usd": round(h_M * supply)})

    # vaults allocating into the selected markets — keep only the top ones by exposure
    # into those markets (avoids cramming 70+ vaults into the canvas).
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
                      "label": v["name"], "address": v["address"], "tier": 1})
        edges.extend(rows)

    # ── downstream (tier-2): vault SHARE tokens reused as collateral elsewhere ──
    # Genuine recursive solvency contagion. Empirically tiny in current DeFi
    # (~9 markets, all <$42k as of 2026-05) but modeled so the engine is truly
    # multi-hop and we can report WHY deep $ cascade is negligible (see propagation_spec).
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
        nid = f"ds_mkt_{j}"
        nodes.append({"id": nid, "type": "lending_market", "tvl": supply,
                      "label": f"{(m['collateralAsset'] or {}).get('symbol')}/{loan}", "tier": 2})
        # vault share fully impaired → conservative no-buffer transfer (h_vault carries it)
        w = min(1.0, (st.get("borrowAssetsUsd") or 0.0) / supply) if supply else 0.0
        if w > 0:
            edges.append({"from": src, "to": nid, "w": round(w, 6)})

    # tag pool protocol on every lending market (all graph-level markets are Morpho Blue;
    # position venues add their own venue tag in run_*). Lets the UI show WHICH protocol.
    for n in nodes:
        if n.get("type") == "lending_market" and not n.get("venue"):
            n["venue"] = "Morpho Blue"
    _apply_freeze(nodes, freeze)

    return {"graph": {"nodes": nodes, "edges": edges},
            "shock": {"node": "ROOT", "delta": 1.0},
            "meta": {"mode": mode, "delta": delta, "asset": asset_symbol, "venues": venues,
                     "frozen": sorted(freeze)}}


def run_live_contagion(asset_symbol: str, delta: float,
                       venues=("morpho", "aave"), recovery: float | None = None,
                       downstream: bool = True, channel: str = "solvency",
                       dex_depth_haircut: float = 0.0, freeze: frozenset = frozenset(),
                       firesale: bool = True, naive: bool = False,
                       include_discovered: bool = False) -> dict:
    # Oracle shock target → common-mode channel (one feed fails → many assets at once).
    if _oracle.is_oracle(asset_symbol):
        oc = "liquidity" if channel == "liquidity" else "solvency"
        r = run_oracle_common_mode(asset_symbol, delta, venues=venues,
                                   recovery=recovery, downstream=downstream, channel=oc,
                                   freeze=freeze)
        if include_discovered:
            _inject_behavioral_bridges(r, venues)
            r["render"] = _cb.to_frontend(r, "solvency")
        return r
    # Liquidity-run channel (orthogonal to solvency): can suppliers withdraw? Here `delta` = ρ.
    if channel == "liquidity":
        r = _liq.run_liquidity_contagion(asset_symbol, delta, downstream=downstream, venues=venues)
        if include_discovered:
            _inject_behavioral_bridges(r, venues)
            r["render"] = _cb.to_frontend(r, "solvency")
        return r
    # Price-depeg cascade (the unified scenario): δ is the CAUSE; the engine auto-applies the
    # amplification mechanisms the asset's properties enable — M2 DEX fire-sale, M3 oracle-lag
    # arbitrage, M4 withdrawal-run feedback — each gated + calibrated. `naive`=M1-only floor.
    if channel == "depeg":
        return _run_depeg_cascade(asset_symbol, delta, venues=venues, recovery=recovery,
                                  downstream=downstream, freeze=freeze, naive=naive,
                                  include_discovered=include_discovered)
    # channel == "solvency": the RAW single solvency pass (internal primitive used by the
    # cascade; `firesale=False` gives the no-amplification absorption floor).
    use_morpho = "morpho" in venues
    use_aave = "aave" in venues
    built = build_live_graph(asset_symbol, delta, recovery=recovery,
                             downstream=downstream, include_markets=use_morpho,
                             dex_depth_haircut=dex_depth_haircut, freeze=freeze, firesale=firesale)
    graph = built["graph"]
    res = propagate(graph, built["shock"])
    usd = dict(res["ranking_usd"])

    markets = sorted(
        [{"node": n["id"], "label": n["label"], "supply_usd": n["tvl"],
          "h": round(res["h"][n["id"]], 4), "bad_debt_usd": round(usd.get(n["id"], 0.0))}
         for n in graph["nodes"] if n["type"] == "lending_market"],
        key=lambda x: -x["bad_debt_usd"])
    vaults = sorted(
        [{"node": n["id"], "label": n["label"], "address": n.get("address"),
          "total_usd": n["tvl"], "h": round(res["h"][n["id"]], 4),
          "loss_usd": round(usd.get(n["id"], 0.0))}
         for n in graph["nodes"] if n["type"] == "vault"],
        key=lambda x: -x["loss_usd"])

    morpho_bad_debt = sum(m["bad_debt_usd"] for m in markets)
    # split out the Pendle-PT-collateral portion (still ON Morpho, but attributable to Pendle)
    pendle_pt_bad_debt = sum(m["bad_debt_usd"] for m in markets
                             if str(m.get("label", "")).upper().startswith("PT"))
    total_vault_loss = sum(v["loss_usd"] for v in vaults)

    # ── Position-level lending venues (Aave V3 + SparkLend): per-borrower HF recompute ──
    # SparkLend = Aave fork (same engine, different subgraph). Both run identically.
    use_spark = "spark" in venues
    position_specs = []
    if use_aave:
        position_specs.append(("Aave V3", _aave.AAVE_SUBGRAPH, "venue_aave"))
    if use_spark:
        position_specs.append(("Spark", _aave.SPARK_SUBGRAPH, "venue_spark"))

    # Sky CDP uses the per-asset fallback; Aave/Spark resolve their REAL per-reserve penalty below.
    rec_pos = _rec(asset_symbol, recovery)
    position_venues = []
    pos_bad_debt = 0.0
    for vlabel, vurl, hub in position_specs:
        # auto base = this venue's real liquidation penalty (1/(1+penalty)); manual r overrides
        rec_v = recovery if recovery is not None else (
            _aave.reserve_recovery(asset_symbol, vurl) or _dex.auto_base_recovery(asset_symbol))
        try:
            a = _aave.simulate_aave_shock(asset_symbol, delta, recovery=rec_v, subgraph=vurl,
                                          dex_recovery=firesale, depth_haircut=dex_depth_haircut)
        except Exception:
            a = {"available": False, "reason": f"{vlabel} fetch failed"}
        if not (a.get("available") and a.get("total_bad_debt_usd", 0) > 0):
            continue
        a["venue"] = vlabel
        position_venues.append(a)
        pos_bad_debt += a["total_bad_debt_usd"]
        _emit_position_venue(graph, res, a, vlabel, f"asset_{asset_symbol}",
                             hub, f"{vlabel} · {asset_symbol} 리저브", delta)

    # ── Sky (Maker) CDP venue — ilk-level liquidation-ratio absorption ──
    if "skycdp" in venues and _sky.has_ilks(asset_symbol):
        cdp = _sky.cdp_shock(asset_symbol, delta, recovery=rec_pos)
        if cdp.get("available") and cdp.get("total_bad_debt_usd", 0) > 0:
            position_venues.append(cdp)
            pos_bad_debt += cdp["total_bad_debt_usd"]
            _emit_sky_cdp(graph, res, cdp, f"asset_{asset_symbol}", delta)

    aave_bad_debt = pos_bad_debt
    # No double-counting: Morpho markets, Aave/Spark POSITIONS and Sky CDP are DISJOINT
    # protocols (separate debts), and vault loss is reported separately (total_vault_loss),
    # not folded into total_bad_debt. So this sum adds each bad debt exactly once.
    total_bad_debt = morpho_bad_debt + aave_bad_debt

    # ── relative systemic-impact score (DebtRank centrality) ──
    # hop-1 = exact $ (above). This is the *relative* "how much of the touched
    # network is impaired" — reported as a 0-100 score, NOT exact downstream $.
    # Only real lending positions contribute: markets (h=h_M, tvl=supply) and vaults
    # (propagated h, tvl=total). Synthetic hubs / loss-sink nodes carry hand-set viz `h`
    # (for node colouring) and are EXCLUDED here so the score isn't polluted by them.
    _scored = [n for n in graph["nodes"]
               if n.get("type") in ("lending_market", "vault") and n.get("tvl", 0) > 0
               and n.get("role") not in ("position_bucket", "position_account", "cdp_ilk", "amm_pool")]
    net_value = sum(n["tvl"] for n in _scored)
    impaired_value = sum(res["h"].get(n["id"], 0.0) * n["tvl"] for n in _scored)
    systemic_impact = round(100 * impaired_value / net_value, 1) if net_value > 0 else 0.0
    n_downstream = sum(1 for n in graph["nodes"] if n.get("tier") == 2)

    result = {
        "incident_id": f"live_{asset_symbol}", "kind": "live",
        "event": {"id": f"live_{asset_symbol}", "date": "now", "shock_node": asset_symbol,
                  "delta": delta, "pre_shock_date": "현재 state",
                  "description": f"{asset_symbol} −{delta*100:.0f}% 가정 (what-if)"},
        "modes": {"solvency": {
            "mode": "solvency", "graph": graph, "shock": built["shock"],
            "asset_deltas": {asset_symbol: delta},
            "rounds": res["rounds"], "distress_round": res["distress_round"],
            "h": {k: round(v, 4) for k, v in res["h"].items() if v > 0},
            "market_bad_debt": [{"node": m["node"], "label": m["label"], "supply_usd": m["supply_usd"],
                                 "h": m["h"], "implied_bad_debt_usd": m["bad_debt_usd"]} for m in markets],
            "vault_predictions": [{"node": v["node"], "label": v["label"], "address": v["address"],
                                   "total_usd": v["total_usd"], "h": v["h"],
                                   "predicted_loss_usd": v["loss_usd"]} for v in vaults],
        }},
        "impact": {
            "total_bad_debt_usd": round(total_bad_debt),
            "morpho_bad_debt_usd": round(morpho_bad_debt),
            "pendle_pt_bad_debt_usd": round(pendle_pt_bad_debt),  # subset of Morpho (PT collateral)
            "aave_bad_debt_usd": round(aave_bad_debt),
            "total_vault_loss_usd": round(total_vault_loss),
            "n_markets": len(markets), "n_vaults": len(vaults),
            "top_markets": markets[:8], "top_vaults": vaults[:8],
            "position_venues": position_venues,   # [{venue, n_liquidatable, bad_debt_by_asset, ...}]
            "systemic_impact_score": systemic_impact,   # 0-100, relative (DebtRank centrality)
            "n_downstream_nodes": n_downstream,
            "lambda_max": res.get("lambda_max", 0.0),   # Λ spectral radius: >1 = amplifying regime
            "stable": res.get("stable", True),           # Bardoscia stability (loop amplification)
            "shock_oracle_type": _dex.oracle_type(asset_symbol),  # nav (fire-sale OFF) | dex
            "shock_dex_depth_usd": (round(_dex.dex_depth_for(asset_symbol))
                                    if _dex.oracle_type(asset_symbol) == "dex" else 0),
            "data_quality": {
                "morpho": "live full graph (markets + vaults)",
                "aave_spark": "position-level, top-200 account scan (approx, not full liquidation engine)",
                "sky_cdp": "ilk-level, curated balances (approx)",
                "pendle_pt": "PT fire-sale via live Pendle AMM pool depth (fallback NAV if pool inactive)",
                "dex_depth": "live Uniswap v3 (fallback registry)",
            },
        },
        "headline": (
            f"{asset_symbol} −{delta*100:.0f}% 가정 — 검증 bad debt(hop-1) 약 {_fmt_usd(total_bad_debt)} "
            f"(Morpho {_fmt_usd(morpho_bad_debt)} · 포지션venue {_fmt_usd(aave_bad_debt)}), "
            f"시스템 영향도 {systemic_impact}/100. "
            + (f"포지션 청산 {sum(v.get('n_liquidatable',0) for v in position_venues)}계정"
               f"({'/'.join(v['venue'] for v in position_venues)}). " if position_venues else "")
            + f"solvency 모델 · 회수율 {_rec_label(recovery)} · what-if."),
    }
    fe = _cb.to_frontend(result, "solvency")
    return {**result, "render": fe, "render_mode": "solvency"}


# ─────────────────────────────────────────────────────────────────────────────
# UNIFIED PRICE-DEPEG CASCADE
#
# A price depeg δ is the single INPUT (its cause — mint, exploit, slow depeg — is
# irrelevant to the mechanics). Given δ, the realistic outcome is a cascade of
# amplification mechanisms, each GATED by the asset's properties and CALIBRATED to
# real incidents:
#
#   M1 흡수 (absorption)   — overcollateralization buffer → hop-1 bad debt. ALWAYS.
#   M2 DEX fire-sale       — forced liquidation selling → price impact → worse recovery.
#                            DEX-priced only (NAV/CAPO redeem at NAV). depth/size-driven.
#                            Grounded: CRV 2023 (Curve founder positions, thin DEX).
#   M3 오라클 지연 차익     — a fast depeg outruns the feed; attacker borrows/mints against
#                            the stale price → drains loan liquidity → bad debt on correction.
#                            DEX-priced only; intensity scales with δ severity (slow depeg =
#                            no lag). Grounded: Ankr aBNBc → Helio HAY 2022.
#   M4 인출런 환류 (run)    — depeg → derived withdrawal run → queue congestion (LST) + DEX LP
#                            flight → secondary depeg → fixed point. Gated to LST-with-queue
#                            or high-utilization markets. Grounded: stETH 2022.
#
# The NAIVE floor = M1 only (no amplification). `amplification_x = total / naive` shows how
# much the mechanisms added — and lets the floor act as a falsification baseline.
# ─────────────────────────────────────────────────────────────────────────────
# ── BEHAVIORAL cross-protocol bridges (discovered from events) → into the propagation ──
# The original design intent: surface HIDDEN dependencies that a declared-accounting graph
# can't see. The same whale on Aave AND Morpho is a forced-deleveraging path between the
# two — invisible to "this market uses this collateral", but real. `discovered_links`
# finds these from on-chain events; here we inject them into the rendered graph as a
# SEPARATE behavioral tier (role="bridge", data_source="discovered") so DebtRank-style
# distress surfaces them. They carry a discounted weight and are reported apart from the
# exact hop-1 bad-debt $ (behavioral/latent ≠ verified loss).
def _inject_behavioral_bridges(result: dict, active_venues) -> None:
    imp = result.get("impact") or {}
    # which venues actually took a hit in THIS shock (only a stressed protocol can drag its
    # shared whales on the OTHER protocol)
    stressed: set[str] = set()
    if (imp.get("morpho_bad_debt_usd") or 0) > 0:
        stressed.add("Morpho Blue")
    for pv in (imp.get("position_venues") or []):
        if (pv.get("total_bad_debt_usd") or 0) > 0:
            stressed.add(pv.get("venue"))
    if imp.get("channel") == "liquidity" and (imp.get("total_frozen_usd") or 0) > 0:
        stressed.add("Morpho Blue")

    venue_set = set()
    for v in active_venues:
        venue_set.add({"morpho": "Morpho Blue", "aave": "Aave V3", "spark": "Spark",
                       "skycdp": "Sky CDP", "pendle": "Pendle"}.get(v, v))
    bridges = _disc.bridges_touching(venue_set)

    imp["hidden_paths"] = []
    imp["n_hidden_paths"] = 0
    imp["discovered_bridge_usd"] = 0
    if not bridges:
        return

    s_mode = result["modes"]["solvency"]
    g = s_mode["graph"]
    last_round = (max(s_mode["distress_round"].values()) + 1) if s_mode["distress_round"] else 2
    # anchor: the shock-asset hub (or the oracle hub for common-mode)
    anchor = next((n["id"] for n in g["nodes"] if str(n["id"]).startswith("asset_")), None)
    if anchor is None:
        anchor = "oracle" if any(n["id"] == "oracle" for n in g["nodes"]) else "ROOT"

    hidden: list[dict] = []
    total_at_risk = 0
    for k, b in enumerate(bridges):
        stressed_side = b["stressed_venue"]
        if stressed_side not in stressed:        # the trigger protocol must actually be hit
            continue
        at_risk_side = b["at_risk_venue"]
        is_issuer = b["at_risk_kind"] == "issuer"
        asset = b.get("at_risk_asset")
        w = b["w"]
        quantified = b["quantified"]
        at_risk = round(b["exposure_usd"] * w) if quantified else 0
        nid = f"bridge_{k}"
        # issuer = forced token sell (LST dump → depeg); lending = forced deleveraging exposure
        if is_issuer:
            label = f"{at_risk_side} 공유고래 {asset or '토큰'} 강제매도 ({b['shared_whales']}명·숨은 경로)"
        else:
            label = f"{at_risk_side} 공유고래 노출 ({b['shared_whales']}명·숨은 경로)"
        g["nodes"].append({"id": nid, "type": "asset",
                           "tvl": float(b["exposure_usd"]) if quantified else 0.0,
                           "label": label, "venue": "shared-whale", "role": "bridge",
                           "data_source": "discovered", "approx": True})
        g["edges"].append({"from": anchor, "to": nid, "w": round(w, 4), "etype": "copresence"})
        s_mode["h"][nid] = round(w, 4)
        s_mode["distress_round"][nid] = last_round
        hidden.append({"from_venue": stressed_side, "to_venue": at_risk_side,
                       "kind": b["at_risk_kind"], "asset": asset, "tier": b["tier"],
                       "shared_whales": b["shared_whales"], "exposure_usd": b["exposure_usd"],
                       "at_risk_usd": at_risk, "quantified": quantified,
                       "w": w, "source": b["source"]})
        total_at_risk += at_risk

    imp["hidden_paths"] = hidden
    imp["n_hidden_paths"] = len(hidden)
    imp["discovered_bridge_usd"] = total_at_risk
    if hidden:
        q = sum(1 for h in hidden if h["quantified"])
        dollar = f"{_fmt_usd(total_at_risk)} 추가 노출" if total_at_risk > 0 else "노출 미정량"
        result["headline"] = (result.get("headline", "")
                              + f" · 숨은 경로 {len(hidden)}개(공유고래 cross-protocol, {dollar}"
                              + (f", {len(hidden)-q}개는 미정량" if q < len(hidden) else "")
                              + "·이벤트 발견·행동기반).")


_CASCADE_KAPPA = 0.35          # solvency distress → extra panic in the derived run (M4)
_CASCADE_RUN_FROM_DEPEG = 0.7  # how much of the (effective) depeg drives the withdrawal run (M4)
_CASCADE_MAX_ITERS = 4
_LAG_DELTA0 = 0.3              # below this depeg the oracle keeps up → no M3 lag arbitrage
_LAG_DRAIN_MAX = 0.6          # max share of available borrow liquidity drained at an extreme depeg
_HIGH_U = 0.8                 # market utilization above which a run materially amplifies (M4)


def _oracle_lag_severity(delta: float) -> float:
    """M3 intensity in [0,1]: a SLOW depeg (small δ) lets the oracle keep up → no lag arbitrage;
    a FAST/extreme depeg (large δ, e.g. an instant mint-dump) outruns the feed → full lag window.
    Linear ramp from δ0. Replaces the old flat 60% dump/drain assumption."""
    return round(max(0.0, min(1.0, (delta - _LAG_DELTA0) / (1.0 - _LAG_DELTA0))), 4)


def asset_mechanism_profile(symbol: str) -> dict:
    """Which amplification mechanisms a price depeg on `symbol` switches on, from the asset's
    properties (one place, so the cascade and the UI agree):
      - firesale (M2) / oracle_lag (M3): DEX-priced assets only (NAV/CAPO ignore DEX spot).
      - run_feedback (M4): LST with a redemption queue, OR a high-utilization market.
      - available_borrow_usd: loan-side liquidity in this asset's collateral markets — the cap
        an oracle-lag attacker can drain (M3)."""
    otype = _dex.oracle_type(symbol)           # "nav" | "dex"
    is_dex = (otype == "dex")
    has_queue = symbol in _liq._QUEUE_PARAMS    # LST/LRT with a withdrawal queue
    markets, _ = _load_live()
    avail = 0.0
    high_u = False
    for m in markets:
        if (m.get("collateralAsset") or {}).get("symbol") != symbol:
            continue
        st = m.get("state") or {}
        s = st.get("supplyAssetsUsd") or 0.0
        b = st.get("borrowAssetsUsd") or 0.0
        avail += max(0.0, s - b)
        if s > 0 and (b / s) >= _HIGH_U:
            high_u = True
    return {
        "symbol": symbol, "oracle_type": otype,
        "firesale": is_dex,                       # M2
        "oracle_lag": is_dex,                     # M3
        "has_queue": has_queue,
        "high_utilization": high_u,
        "run_feedback": has_queue or high_u,      # M4
        "dex_depth_usd": round(_dex.dex_depth_for(symbol)),
        "available_borrow_usd": round(avail),
    }


def _run_depeg_cascade(asset_symbol: str, x: float,
                       venues=("morpho", "aave", "spark"), recovery: float | None = None,
                       downstream: bool = True, freeze: frozenset = frozenset(),
                       naive: bool = False, include_discovered: bool = False) -> dict:
    """The unified price-depeg scenario. δ=x is the CAUSE; the engine auto-applies M1–M4 gated
    by `asset_mechanism_profile`, then decomposes the bad debt by mechanism. `naive`=M1 floor."""
    prof = asset_mechanism_profile(asset_symbol)

    # ── M1: naive absorption floor (no fire-sale, no run, no oracle-lag) ──
    naive_res = run_live_contagion(asset_symbol, x, venues=venues, recovery=recovery,
                                   downstream=downstream, channel="solvency",
                                   dex_depth_haircut=0.0, freeze=freeze, firesale=False)
    m1 = naive_res["impact"]["total_bad_debt_usd"]

    if naive:
        imp = naive_res["impact"]
        imp["channel"] = "depeg"; imp["naive"] = True
        imp["mechanisms"] = ["absorption"]
        imp["mech_absorption_usd"] = m1
        imp["mech_firesale_usd"] = imp["mech_oracle_lag_usd"] = imp["mech_run_feedback_usd"] = 0
        imp["naive_floor_usd"] = m1
        imp["amplification_x"] = 1.0
        naive_res["channel"] = "depeg"
        naive_res["event"]["description"] = f"{asset_symbol} 가격 depeg −{x*100:.0f}% (naive 흡수 바닥값, 증폭 없음)"
        naive_res["headline"] = (
            f"{asset_symbol} 가격 depeg −{x*100:.0f}% (naive 바닥값) — 흡수만 {_fmt_usd(m1)}. "
            "fire-sale·오라클지연·인출런 증폭 제외 (반증 기준선).")
        naive_res["render"] = _cb.to_frontend(naive_res, "solvency")
        return naive_res

    # ── M2: fire-sale at base δ (DEX-priced only; NAV → same as naive) ──
    if prof["firesale"]:
        base_fs = run_live_contagion(asset_symbol, x, venues=venues, recovery=recovery,
                                     downstream=downstream, channel="solvency",
                                     dex_depth_haircut=0.0, freeze=freeze, firesale=True)
        base_fs_bd = base_fs["impact"]["total_bad_debt_usd"]
    else:
        base_fs = naive_res
        base_fs_bd = m1

    # ── M4: withdrawal-run feedback fixed point (LST queue / high-U) ──
    rho = queue_depeg = depth_haircut = 0.0
    price_delta = x
    iters = 0
    final = base_fs
    liq = None
    if prof["run_feedback"]:
        for it in range(_CASCADE_MAX_ITERS):
            iters = it + 1
            price_delta = min(1.0, x + queue_depeg)
            depth_haircut = _dex.lp_exit_fraction(rho)
            if it == 0 and queue_depeg == 0.0 and depth_haircut == 0.0:
                final = base_fs   # iter-0 == the base fire-sale pass already computed
            else:
                final = run_live_contagion(asset_symbol, price_delta, venues=venues,
                                           recovery=recovery, downstream=downstream,
                                           channel="solvency", dex_depth_haircut=depth_haircut,
                                           freeze=freeze, firesale=prof["firesale"])
            systemic = (final["impact"].get("systemic_impact_score") or 0.0) / 100.0
            new_rho = min(1.0, _CASCADE_RUN_FROM_DEPEG * price_delta + _CASCADE_KAPPA * systemic)
            queue_depeg = _liq.lst_queue_depeg(asset_symbol, new_rho)
            if abs(new_rho - rho) < 0.01:
                rho = new_rho
                break
            rho = new_rho
        liq = _liq.run_liquidity_contagion(asset_symbol, rho, downstream=downstream, venues=venues)

    cascade_bd = final["impact"]["total_bad_debt_usd"]
    queue_contrib = round(max(0.0, price_delta - x), 4)

    # ── M3: oracle-lag arbitrage drain (DEX-priced only, δ-severity scaled) ──
    lag_bd = 0.0
    drain = 0.0
    if prof["oracle_lag"]:
        sev = _oracle_lag_severity(x)
        drain = _LAG_DRAIN_MAX * sev * prof["available_borrow_usd"]
        lag_bd = round(drain * x)

    # ── mechanism decomposition (each ≥ 0) ──
    m2 = max(0, round(base_fs_bd - m1)) if prof["firesale"] else 0
    m4 = max(0, round(cascade_bd - base_fs_bd))
    m3 = lag_bd
    total = round(cascade_bd + lag_bd)
    amp = round(total / m1, 2) if m1 > 0 else None
    frozen = (liq["impact"].get("total_frozen_usd", 0) if liq else 0)
    active = ["absorption"]
    if m2 > 0: active.append("firesale")
    if m3 > 0: active.append("oracle_lag")
    if m4 > 0 or frozen > 0: active.append("run_feedback")

    # ── assemble on top of the `final` solvency result ──
    solv = final
    s_imp = solv["impact"]
    solv["kind"] = "live"; solv["channel"] = "depeg"
    s_imp["channel"] = "depeg"; s_imp["naive"] = False
    s_imp["mechanisms"] = active
    s_imp["mech_absorption_usd"] = m1
    s_imp["mech_firesale_usd"] = m2
    s_imp["mech_oracle_lag_usd"] = m3
    s_imp["mech_run_feedback_usd"] = m4
    s_imp["naive_floor_usd"] = m1
    s_imp["amplification_x"] = amp
    s_imp["oracle_lag_drain_usd"] = round(drain)
    s_imp["total_bad_debt_usd"] = total
    s_imp["total_frozen_usd"] = frozen
    s_imp["market_frozen_usd"] = (liq["impact"].get("market_frozen_usd", 0) if liq else 0)
    s_imp["vault_frozen_usd"] = (liq["impact"].get("vault_frozen_usd", 0) if liq else 0)
    s_imp["liq_top_markets"] = (liq["impact"].get("top_markets", []) if liq else [])
    s_imp["queue_depeg"] = queue_contrib
    s_imp["price_delta_effective"] = round(price_delta, 4)
    s_imp["dex_depth_haircut"] = round(depth_haircut, 4)
    s_imp["run_intensity"] = round(rho, 4)
    s_imp["coupling_iters"] = iters
    s_imp.setdefault("data_quality", {})["cascade"] = (
        f"depeg→cascade: M1 흡수=정확$ · M2 fire-sale={'on' if prof['firesale'] else 'off(NAV/CAPO)'} "
        f"· M3 오라클지연={'on(δ-scaled)' if prof['oracle_lag'] else 'off(NAV)'}(모델) "
        f"· M4 인출런환류={'on' if prof['run_feedback'] else 'off'}")

    mech_kr = {"absorption": "흡수", "firesale": "fire-sale", "oracle_lag": "오라클지연", "run_feedback": "인출런환류"}
    solv["event"]["delta"] = x
    solv["event"]["description"] = (
        f"{asset_symbol} 가격 depeg −{x*100:.0f}% → 활성 메커니즘 [{', '.join(mech_kr[a] for a in active)}]"
        + (f" · 실효 −{price_delta*100:.0f}%(런 환류)" if queue_contrib > 0 else ""))
    solv["headline"] = (
        f"{asset_symbol} 가격 depeg −{x*100:.0f}% → 실제 사건형 cascade. "
        f"bad debt {_fmt_usd(total)}"
        + (f" (흡수 {_fmt_usd(m1)}"
           + (f" + fire-sale {_fmt_usd(m2)}" if m2 > 0 else "")
           + (f" + 오라클지연 {_fmt_usd(m3)}" if m3 > 0 else "")
           + (f" + 인출런환류 {_fmt_usd(m4)}" if m4 > 0 else "") + ")")
        + (f" + 동결자본 {_fmt_usd(frozen)}" if frozen > 0 else "")
        + (f". naive 대비 {amp}× 증폭" if amp and amp > 1 else "")
        + ". depeg→cascade(M1–M4) · 자산 성질 게이트 · 사건 보정.")

    # ── render: oracle-lag drain sink (M3) + liquidity frozen cluster (M4) on the graph ──
    s_mode = solv["modes"]["solvency"]
    s_graph = s_mode["graph"]
    existing = {n["id"] for n in s_graph["nodes"]}
    last_round = (max(s_mode["distress_round"].values()) + 1) if s_mode["distress_round"] else 2

    if lag_bd > 0:
        drain_id = "oracle_lag_drain"
        s_graph["nodes"].append({"id": drain_id, "type": "asset", "tvl": float(lag_bd),
                                 "label": f"{asset_symbol} 오라클 지연 대출 드레인", "venue": "oracle-lag",
                                 "role": "loss_sink", "data_source": "model", "approx": True})
        s_graph["edges"].append({"from": f"asset_{asset_symbol}", "to": drain_id,
                                 "w": round(_oracle_lag_severity(x), 4), "etype": "oracle"})
        s_mode["h"][drain_id] = _sink_h(x)
        s_mode["distress_round"][drain_id] = last_round

    if liq is not None and rho > 0:
        lg = liq["modes"]["solvency"]
        l_graph, l_h = lg["graph"], lg["h"]
        liq_hub = "liq_cluster"
        if liq_hub not in existing:
            s_graph["nodes"].append({"id": liq_hub, "type": "asset", "tvl": 0.0,
                                     "label": f"{asset_symbol} 인출런(유동성)"})
            s_graph["edges"].append({"from": f"asset_{asset_symbol}", "to": liq_hub,
                                     "w": round(rho, 4), "etype": "liquidity"})
            s_mode["h"][liq_hub] = round(rho, 4)
            s_mode["distress_round"][liq_hub] = last_round
        frozen_mkts = sorted([n for n in l_graph["nodes"]
                              if n["type"] == "lending_market" and l_h.get(n["id"], 0) > 0],
                             key=lambda n: -(l_h.get(n["id"], 0) * (n.get("tvl") or 0)))[:8]
        for n in frozen_mkts:
            nid = f"L_{n['id']}"
            if nid in existing:
                continue
            s_graph["nodes"].append({**n, "id": nid, "label": f"{n['label']} (동결)"})
            s_graph["edges"].append({"from": liq_hub, "to": nid, "w": 1.0, "etype": "liquidity"})
            s_mode["h"][nid] = l_h[n["id"]]
            s_mode["distress_round"][nid] = last_round + 1

    # ── behavioral cross-protocol bridges (event-discovered hidden dependencies) ──
    if include_discovered:
        _inject_behavioral_bridges(solv, venues)

    solv["render"] = _cb.to_frontend(solv, "solvency")
    return solv


# ─────────────────────────────────────────────────────────────────────────────
# Oracle COMMON-MODE channel — shared_oracle_risk.
#
# A single price feed is a shared dependency: when it fails, EVERY asset priced
# through it mis-prices SIMULTANEOUSLY (see oracle_feeds.py for the grounding). We
# model it as: ROOT → oracle → {affected assets, each by δ×factor} → their lending
# markets (same _market_impairment absorption) → vaults → position venues. The
# DebtRank engine then propagates from all affected assets at once.
#
# Edge-weight trick (same as build_live_graph): the engine propagates h linearly,
# but _market_impairment is non-linear in δ (over-collateralization buffer). So we
# compute h_M at the asset's EFFECTIVE δ and set the asset→market weight = h_M/δ_eff,
# so engine output (δ_eff × w) reproduces h_M exactly.
# ─────────────────────────────────────────────────────────────────────────────

def build_oracle_graph(oracle_id: str, delta: float, mode: str = "solvency",
                       recovery: float | None = None, downstream: bool = True,
                       include_markets: bool = True, dex_depth_haircut: float = 0.0,
                       freeze: frozenset = frozenset()) -> dict:
    markets, vaults = _load_live()
    meta = _oracle.ORACLES.get(oracle_id) or {}
    label = meta.get("label", oracle_id)
    # restrict the nominal asset set to assets that actually carry live exposure, so the
    # graph (and the "N assets" blast count) reflects the current world, not the registry.
    live_syms = set(_live_supply_by_symbol())
    affected = _oracle.assets_for_oracle(oracle_id, live_syms)  # {sym: factor}, live only

    nodes = [
        {"id": "ROOT", "type": "protocol", "tvl": 0.0, "label": f"{label} 장애"},
        {"id": "oracle", "type": "oracle", "tvl": 0.0, "label": label},
    ]
    edges = [{"from": "ROOT", "to": "oracle", "w": round(delta, 4), "etype": "oracle"}]
    venues: list[dict] = []
    id_for: dict[str, str] = {}
    mkt_counter = 0
    affected_with_exposure: list[str] = []

    for sym, factor in affected.items():
        d_eff = delta * factor
        if d_eff <= 0:
            continue
        sel = ([m for m in markets if (m.get("collateralAsset") or {}).get("symbol") == sym]
               if include_markets else [])
        sel.sort(key=lambda m: -((m.get("state") or {}).get("supplyAssetsUsd") or 0))
        sel = sel[:_TOP_MARKETS_PER_ASSET]
        # Asset depeg hub — one per affected asset that has live exposure (Morpho markets
        # here, or Aave/Spark positions handled by the multi-shock venue below).
        aid = f"asset_{sym}"
        nodes.append({"id": aid, "type": "asset", "tvl": 0.0, "label": sym})
        edges.append({"from": "oracle", "to": aid, "w": round(min(1.0, factor), 4), "etype": "oracle"})
        affected_with_exposure.append(sym)
        for m in sel:
            st = m.get("state") or {}
            supply = st.get("supplyAssetsUsd") or 0.0
            if supply <= 0:
                continue
            o_base = recovery if recovery is not None else _morpho_base(m, sym)
            h_M = _market_impairment(
                {"pre_supply_usd": supply, "pre_borrow_usd": st.get("borrowAssetsUsd") or 0.0,
                 "pre_collateral_usd": st.get("collateralAssetsUsd") or 0.0}, d_eff, mode,
                recovery_factor=_eff_recovery(sym, o_base, st.get("borrowAssetsUsd"),
                                              depth_haircut=dex_depth_haircut))
            nid = f"omkt_{mkt_counter}"; mkt_counter += 1
            id_for[m["marketId"]] = nid
            loan = (m.get("loanAsset") or {}).get("symbol") or "?"
            nodes.append({"id": nid, "type": "lending_market", "tvl": supply,
                          "label": f"{sym}/{loan}", "marketId": m["marketId"]})
            w = (h_M / d_eff) if d_eff > 0 else 0.0
            if w > 0:
                edges.append({"from": aid, "to": nid, "w": round(min(1.0, w), 6), "etype": "collateral"})
            venues.append({"node": nid, "label": f"{sym}/{loan}", "supply_usd": supply,
                           "h_M": round(h_M, 4), "implied_bad_debt_usd": round(h_M * supply)})

        # ── Derivatives on this affected underlying (Pendle PT, Lido/etherFi wrappers).
        #    A PT/wrapper is priced via the SAME underlying, so the oracle fault hits it
        #    too. One mechanism, all protocols plug in (derivatives.derivatives_of). ──
        if include_markets and d_eff > 0:
            derivs = sorted(_derivatives.derivatives_of(sym, markets),
                            key=lambda d: -((d["market"].get("state") or {}).get("supplyAssetsUsd") or 0))[:8]
            existing = {n["id"] for n in nodes}
            for d in derivs:
                m = d["market"]; st = m.get("state") or {}
                supply = st.get("supplyAssetsUsd") or 0.0
                if supply <= 0 or m["marketId"] in id_for:
                    continue
                f = d["depeg_factor"]
                d_delta = d_eff * f
                is_pt = d["label"].upper().startswith("PT")
                pt_pool = _pendle.pt_amm_depth_by_addr((m.get("collateralAsset") or {}).get("address") or "") if is_pt else None
                hub = f"oderiv_{d['label']}"
                if hub not in existing:
                    existing.add(hub)
                    hub_node = {"id": hub, "type": "asset", "tvl": float(pt_pool or 0.0),
                                "label": f"{d['label']} ({d['protocol']})", "venue": d["protocol"]}
                    if is_pt:
                        hub_node["role"] = "amm_pool"
                        hub_node["data_source"] = "pendle_live" if pt_pool else "fallback_nav"
                    nodes.append(hub_node)
                    edges.append({"from": aid, "to": hub, "w": round(min(1.0, f), 4),
                                  "etype": "derivative"})
                od_base = recovery if recovery is not None else _morpho_base(m, d["label"])
                h_M = _market_impairment(
                    {"pre_supply_usd": supply, "pre_borrow_usd": st.get("borrowAssetsUsd") or 0.0,
                     "pre_collateral_usd": st.get("collateralAssetsUsd") or 0.0}, d_delta, mode,
                    recovery_factor=(_pt_recovery(m, od_base, st.get("borrowAssetsUsd"), dex_depth_haircut)
                                         if is_pt
                                         else _eff_recovery(d["label"], od_base, st.get("borrowAssetsUsd"),
                                                            depth_haircut=dex_depth_haircut)))
                nid = f"omkt_{mkt_counter}"; mkt_counter += 1
                id_for[m["marketId"]] = nid
                loan = (m.get("loanAsset") or {}).get("symbol") or "?"
                nodes.append({"id": nid, "type": "lending_market", "tvl": supply,
                              "label": f"{d['label']}/{loan}", "marketId": m["marketId"], "tier": 1,
                              "venue": "Morpho Blue", "collateral_protocol": d["protocol"],
                              "data_source": ("pendle_live" if pt_pool else "pendle_fallback") if is_pt else None})
                w = (h_M / d_delta) if d_delta > 0 else 0.0
                if w > 0:
                    edges.append({"from": hub, "to": nid, "w": round(min(1.0, w), 6), "etype": "collateral"})
                venues.append({"node": nid, "label": f"{d['label']}/{loan}", "supply_usd": supply,
                               "h_M": round(h_M, 4), "implied_bad_debt_usd": round(h_M * supply)})

    # vaults allocating into the impaired markets (same exposure-rank cap as build_live_graph)
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
                      "label": v["name"], "address": v["address"], "tier": 1})
        edges.extend(rows)

    # downstream (tier-2): vault SHARE tokens reused as collateral elsewhere
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
        nid = f"ods_mkt_{j}"
        nodes.append({"id": nid, "type": "lending_market", "tvl": supply,
                      "label": f"{(m['collateralAsset'] or {}).get('symbol')}/{loan}", "tier": 2})
        w = min(1.0, (st.get("borrowAssetsUsd") or 0.0) / supply) if supply else 0.0
        if w > 0:
            edges.append({"from": src, "to": nid, "w": round(w, 6)})

    for n in nodes:
        if n.get("type") == "lending_market" and not n.get("venue"):
            n["venue"] = "Morpho Blue"
    _apply_freeze(nodes, freeze)

    return {"graph": {"nodes": nodes, "edges": edges},
            "shock": {"node": "ROOT", "delta": 1.0},
            "meta": {"mode": mode, "delta": delta, "oracle": oracle_id, "label": label,
                     "affected": affected_with_exposure, "venues": venues, "frozen": sorted(freeze)}}


def run_oracle_common_mode(oracle_id: str, delta: float,
                           venues=("morpho", "aave", "spark"), recovery: float | None = None,
                           downstream: bool = True, channel: str = "solvency",
                           freeze: frozenset = frozenset()) -> dict:
    meta = _oracle.ORACLES.get(oracle_id)
    if not meta:
        raise ValueError(f"unknown oracle {oracle_id!r}")
    label = meta.get("label", oracle_id)
    use_morpho = "morpho" in venues
    live_syms = set(_live_supply_by_symbol())
    affected_live = list(_oracle.assets_for_oracle(oracle_id, live_syms).keys())

    # ── C3: oracle failure → panic → liquidity run on every affected (supplied) asset ──
    agg_liq = None
    if channel in ("liquidity", "both"):
        agg_liq = _liq.aggregate_liquidity(affected_live, delta, downstream=downstream, venues=venues)
    if channel == "liquidity":
        if not agg_liq:
            base = _liq.run_liquidity_contagion(affected_live[0] if affected_live else "WETH",
                                                delta, downstream=downstream, venues=venues)
            base["event"]["shock_node"] = label
            base["headline"] = f"{label} 공통 장애 → 인출런 ρ={delta*100:.0f}%: 동결 자본 미미."
            return base
        res_l = agg_liq["dominant"]
        imp = res_l["impact"]
        imp["total_frozen_usd"] = agg_liq["total_frozen_usd"]
        imp["market_frozen_usd"] = agg_liq["market_frozen_usd"]
        imp["vault_frozen_usd"] = agg_liq["vault_frozen_usd"]
        imp["total_bad_debt_usd"] = agg_liq["total_frozen_usd"]
        imp["top_markets"] = agg_liq["top_markets"]
        imp["oracle_id"] = oracle_id
        imp["affected_assets"] = agg_liq["assets"]
        res_l["event"]["shock_node"] = label
        res_l["headline"] = (
            f"{label} 공통 장애 → 인출런 ρ={delta*100:.0f}% ({agg_liq['n_assets']}개 자산 동시) — "
            f"동결 자본 약 ${agg_liq['total_frozen_usd']:,}. shared_oracle_risk · liquidity 채널.")
        return res_l

    # solvency / both: amplify the price shock for `both` (queue depeg + DEX LP flight)
    queue_depeg = depth_haircut = 0.0
    if channel == "both":
        queue_depeg = max((_liq.lst_queue_depeg(s, delta) for s in affected_live), default=0.0)
        depth_haircut = _dex.lp_exit_fraction(delta)
    p_delta = min(1.0, delta + queue_depeg)

    built = build_oracle_graph(oracle_id, p_delta, recovery=recovery,
                               downstream=downstream, include_markets=use_morpho,
                               dex_depth_haircut=depth_haircut, freeze=freeze)
    graph = built["graph"]
    res = propagate(graph, built["shock"])
    usd = dict(res["ranking_usd"])

    markets = sorted(
        [{"node": n["id"], "label": n["label"], "supply_usd": n["tvl"],
          "h": round(res["h"][n["id"]], 4), "bad_debt_usd": round(usd.get(n["id"], 0.0))}
         for n in graph["nodes"] if n["type"] == "lending_market"],
        key=lambda x: -x["bad_debt_usd"])
    vaults = sorted(
        [{"node": n["id"], "label": n["label"], "address": n.get("address"),
          "total_usd": n["tvl"], "h": round(res["h"][n["id"]], 4),
          "loss_usd": round(usd.get(n["id"], 0.0))}
         for n in graph["nodes"] if n["type"] == "vault"],
        key=lambda x: -x["loss_usd"])

    morpho_bad_debt = sum(m["bad_debt_usd"] for m in markets)
    # split out the Pendle-PT-collateral portion (still ON Morpho, but attributable to Pendle)
    pendle_pt_bad_debt = sum(m["bad_debt_usd"] for m in markets
                             if str(m.get("label", "")).upper().startswith("PT"))
    total_vault_loss = sum(v["loss_usd"] for v in vaults)

    # ── Position-level venues (Aave V3 + SparkLend): SIMULTANEOUS multi-asset shock ──
    # The whole affected basket drops at once — exactly where common-mode bites harder
    # than single-asset (a borrower holding two oracle-shared collaterals loses both).
    affected = _oracle.assets_for_oracle(oracle_id)
    asset_deltas = {s: round(p_delta * f, 6) for s, f in affected.items() if p_delta * f > 0}

    position_specs = []
    if "aave" in venues:
        position_specs.append(("Aave V3", _aave.AAVE_SUBGRAPH, "venue_aave"))
    if "spark" in venues:
        position_specs.append(("Spark", _aave.SPARK_SUBGRAPH, "venue_spark"))

    # oracle common-mode hits many mixed assets → a generic DEX auto base; per-asset fire-sale
    # is still applied inside the multi-shock (dex_recovery=True).
    rec_pos = recovery if recovery is not None else _dex.auto_base_recovery("WETH")
    position_venues = []
    pos_bad_debt = 0.0
    for vlabel, vurl, hub in position_specs:
        try:
            a = _aave.simulate_aave_multi_shock(asset_deltas, recovery=rec_pos, subgraph=vurl,
                                                dex_recovery=True, depth_haircut=depth_haircut)
        except Exception:
            a = {"available": False, "reason": f"{vlabel} fetch failed"}
        if not (a.get("available") and a.get("total_bad_debt_usd", 0) > 0):
            continue
        a["venue"] = vlabel
        position_venues.append(a)
        pos_bad_debt += a["total_bad_debt_usd"]
        _emit_position_venue(graph, res, a, vlabel, "oracle", hub,
                             f"{vlabel} (포지션·동시충격)", p_delta)

    aave_bad_debt = pos_bad_debt
    # No double-counting: Morpho markets, Aave/Spark POSITIONS and Sky CDP are DISJOINT
    # protocols (separate debts), and vault loss is reported separately (total_vault_loss),
    # not folded into total_bad_debt. So this sum adds each bad debt exactly once.
    total_bad_debt = morpho_bad_debt + aave_bad_debt

    # relative systemic-impact score (DebtRank centrality over the touched network)
    # Only real lending positions contribute: markets (h=h_M, tvl=supply) and vaults
    # (propagated h, tvl=total). Synthetic hubs / loss-sink nodes carry hand-set viz `h`
    # (for node colouring) and are EXCLUDED here so the score isn't polluted by them.
    _scored = [n for n in graph["nodes"]
               if n.get("type") in ("lending_market", "vault") and n.get("tvl", 0) > 0
               and n.get("role") not in ("position_bucket", "position_account", "cdp_ilk", "amm_pool")]
    net_value = sum(n["tvl"] for n in _scored)
    impaired_value = sum(res["h"].get(n["id"], 0.0) * n["tvl"] for n in _scored)
    systemic_impact = round(100 * impaired_value / net_value, 1) if net_value > 0 else 0.0
    n_affected_assets = len(built["meta"]["affected"])

    result = {
        "incident_id": f"live_oracle_{oracle_id.split(':')[-1]}", "kind": "live_oracle",
        "event": {"id": f"live_{oracle_id}", "date": "now", "shock_node": label,
                  "delta": delta, "pre_shock_date": "현재 state",
                  "description": f"{label} 공통 장애 −{delta*100:.0f}% (common-mode, {n_affected_assets}개 자산 동시)"},
        "modes": {"solvency": {
            "mode": "solvency", "graph": graph, "shock": built["shock"],
            "asset_deltas": {s: round(delta * f, 4) for s, f in affected.items()},
            "rounds": res["rounds"], "distress_round": res["distress_round"],
            "h": {k: round(v, 4) for k, v in res["h"].items() if v > 0},
            "market_bad_debt": [{"node": m["node"], "label": m["label"], "supply_usd": m["supply_usd"],
                                 "h": m["h"], "implied_bad_debt_usd": m["bad_debt_usd"]} for m in markets],
            "vault_predictions": [{"node": v["node"], "label": v["label"], "address": v["address"],
                                   "total_usd": v["total_usd"], "h": v["h"],
                                   "predicted_loss_usd": v["loss_usd"]} for v in vaults],
        }},
        "impact": {
            "total_bad_debt_usd": round(total_bad_debt),
            "morpho_bad_debt_usd": round(morpho_bad_debt),
            "pendle_pt_bad_debt_usd": round(pendle_pt_bad_debt),
            "aave_bad_debt_usd": round(aave_bad_debt),
            "total_vault_loss_usd": round(total_vault_loss),
            "n_markets": len(markets), "n_vaults": len(vaults),
            "top_markets": markets[:8], "top_vaults": vaults[:8],
            "position_venues": position_venues,
            "systemic_impact_score": systemic_impact,
            "n_downstream_nodes": sum(1 for n in graph["nodes"] if n.get("tier") == 2),
            "lambda_max": res.get("lambda_max", 0.0),
            "stable": res.get("stable", True),
            "shock_oracle_type": "common_mode",
            "oracle_id": oracle_id,
            "affected_assets": built["meta"]["affected"],
            "data_quality": {
                "morpho": "live full graph (markets + vaults)",
                "aave_spark": "position-level, top-200 account scan (approx)",
                "sky_cdp": "ilk-level, curated balances (approx)",
                "pendle_pt": "PT fire-sale via live Pendle AMM pool depth (fallback NAV)",
                "dex_depth": "live Uniswap v3 (fallback registry)",
            },
        },
        "headline": (
            f"{label} 공통 장애 −{delta*100:.0f}% — {n_affected_assets}개 자산 동시 디페그(common-mode). "
            f"검증 bad debt(hop-1) 약 {_fmt_usd(total_bad_debt)} "
            f"(Morpho {_fmt_usd(morpho_bad_debt)} · 포지션venue {_fmt_usd(aave_bad_debt)}), "
            f"시스템 영향도 {systemic_impact}/100. "
            + (f"포지션 청산 {sum(v.get('n_liquidatable',0) for v in position_venues)}계정"
               f"({'/'.join(v['venue'] for v in position_venues)}). " if position_venues else "")
            + f"solvency 모델 · 회수율 {_rec_label(recovery)} · shared_oracle_risk."),
    }

    # ── both: fold in the liquidity run on the affected assets + the cross-feed note ──
    if channel == "both":
        frozen = (agg_liq or {}).get("total_frozen_usd", 0)
        result["channel"] = "both"
        imp = result["impact"]
        imp["channel"] = "both"
        imp["total_frozen_usd"] = frozen
        imp["market_frozen_usd"] = (agg_liq or {}).get("market_frozen_usd", 0)
        imp["vault_frozen_usd"] = (agg_liq or {}).get("vault_frozen_usd", 0)
        imp["queue_depeg"] = queue_depeg
        imp["dex_depth_haircut"] = depth_haircut
        imp["price_delta_effective"] = round(p_delta, 4)
        imp["run_intensity"] = delta
        result["headline"] = (
            f"{label} 공통 장애 결합 x={delta*100:.0f}% — bad debt {_fmt_usd(total_bad_debt)} "
            f"+ 동결자본 {_fmt_usd(frozen)} ({n_affected_assets}개 자산). "
            + (f"인출런→상환큐 디페그 +{queue_depeg*100:.1f}%p·DEX LP이탈 {depth_haircut*100:.0f}% → "
               f"가격충격 실효 −{p_delta*100:.0f}% (환류). " if (queue_depeg > 0 or depth_haircut > 0) else "")
            + "shared_oracle_risk · 솔벤시↔유동성 결합.")

    fe = _cb.to_frontend(result, "solvency")
    return {**result, "render": fe, "render_mode": "solvency"}
