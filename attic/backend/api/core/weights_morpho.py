"""
weights_morpho.py — Phase 1: derive DebtRank edge weights w from Morpho accounting.

Reads the pre-shock snapshot (api/data/resolv_snapshot.json, built by
scripts/build_resolv_snapshot.py) and produces a graph for api/sim/engine.propagate().

This module lives in the BACKTEST path only. It does NOT touch the live /api/graph
mapping (simulation page). The historical incident graph it builds is isolated here.

Graph shape (propagate contract):
  nodes: [{id, type, tvl, label, ...}]
  edges: [{from, to, w}]   w in [0,1]
  shock: {node: "RESOLV", delta: 1.0}

Weight design (the honest part):
  RESOLV -> asset      w = delta_asset           (per-asset observed depeg)
  asset  -> market     w = h_M / delta_asset      (so h_asset=delta_asset => market gets h_M)
                       where h_M is the SOLVENCY bad-debt fraction (LLTV-buffer aware,
                       nonlinear in delta) — see _market_impairment. The nonlinearity
                       lives here in weight construction; the engine stays pure-linear.
  market -> vault      w = vault_alloc_to_M / vault_total   (structural exposure ratio)

Two modes:
  "solvency" : LLTV-buffer-aware h_M (correct; predicts ~0 loss where over-collateralized)
  "naive"    : h_M = delta * borrow/supply (ignores over-collateralization buffer)
               -> the falsification baseline (over-predicts).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

SNAPSHOT_PATH = Path(__file__).resolve().parent.parent / "data" / "resolv_snapshot.json"

# loan-asset peg assumption: loan assets (USDC/USDT/AUSD/sUSDS) are NOT shocked here.
# Only Resolv collateral assets depeg.
_SHOCKABLE = {"USR", "wstUSR", "RLP"}


def load_snapshot(path: Path = SNAPSHOT_PATH) -> dict:
    return json.loads(Path(path).read_text())


def _asset_deltas(snap: dict, severity_override: Optional[dict] = None) -> dict[str, float]:
    """Per-asset depeg fraction delta = (pre - trough)/pre, or scenario override."""
    out: dict[str, float] = {}
    for sym, pt in (snap["event"].get("price_trough") or {}).items():
        pre = pt.get("pre") or 0.0
        trough = pt.get("trough")
        if pre > 0 and trough is not None:
            out[sym] = max(0.0, min(1.0, (pre - trough) / pre))
    if severity_override:
        out.update({k: float(v) for k, v in severity_override.items()})
    return out


def _market_impairment(m: dict, delta_asset: float, mode: str,
                       recovery_factor: float = 1.0) -> float:
    """
    Fraction of a market's SUPPLIER capital destroyed (bad debt / supply), in [0,1].

    Field semantics (Morpho Blue market `state`, verified against the API):
      pre_supply_usd     = supplyAssetsUsd     — LOAN asset supplied by lenders (= the
                           capital at risk; the denominator of h_M)
      pre_borrow_usd     = borrowAssetsUsd     — LOAN asset borrowed (the debt to cover)
      pre_collateral_usd = collateralAssetsUsd — COLLATERAL posted (what gets liquidated)
    These are three DIFFERENT quantities (supply≠collateral); h_M is bad debt borne by the
    LOAN suppliers, not the collateral holders.

    solvency: bad_debt = max(0, borrow - collateral*(1-delta)*recovery_factor)
              -> over-collateralized markets absorb the shock (h_M -> 0).
    naive:    h_M = delta * borrow/supply  (no buffer; over-predicts).
    """
    supply = m.get("pre_supply_usd") or 0.0
    borrow = m.get("pre_borrow_usd") or 0.0
    collat = m.get("pre_collateral_usd") or 0.0
    if supply <= 0:
        return 0.0
    if mode == "naive":
        return max(0.0, min(1.0, delta_asset * (borrow / supply)))
    # solvency (default)
    recoverable = collat * (1.0 - delta_asset) * recovery_factor
    bad_debt = max(0.0, borrow - recoverable)
    return max(0.0, min(1.0, bad_debt / supply))


def _mkt_node_id(m: dict) -> str:
    return f"mkt_{m['marketId'][:10]}"


def _vault_node_id(v: dict) -> str:
    return f"vault_{v['address'][:10]}"


def build_resolv_graph(
    snap: Optional[dict] = None,
    mode: str = "solvency",
    severity_override: Optional[dict] = None,
    min_market_supply_usd: float = 100.0,
) -> dict:
    """
    Build {graph, shock, meta} for propagate().

    mode: "solvency" (LLTV-buffer aware) or "naive" (falsification baseline).
    severity_override: {"USR": 0.95, ...} to run counterfactual severity scenarios.
    """
    if snap is None:
        snap = load_snapshot()
    deltas = _asset_deltas(snap, severity_override)

    nodes: list[dict] = []
    edges: list[dict] = []
    node_ids: set[str] = set()

    def add_node(nid, ntype, tvl, label, **extra):
        if nid in node_ids:
            return
        node_ids.add(nid)
        nodes.append({"id": nid, "type": ntype, "tvl": float(tvl or 0.0), "label": label, **extra})

    # ── synthetic root: the Resolv protocol failure ──
    add_node("RESOLV", "protocol", 0.0, "Resolv (USR issuer)")

    # ── shockable collateral assets (only those that actually appear as collateral) ──
    used_assets = {m["collateral"] for m in snap["markets"]
                   if (m.get("pre_supply_usd") or 0) >= min_market_supply_usd}
    for sym in used_assets:
        if sym in _SHOCKABLE and sym in deltas:
            add_node(f"asset_{sym}", "asset", 0.0, sym)
            edges.append({"from": "RESOLV", "to": f"asset_{sym}", "w": round(deltas[sym], 4)})

    # ── markets + collateral edges (asset -> market, nonlinear weight) ──
    market_meta: list[dict] = []
    for m in snap["markets"]:
        supply = m.get("pre_supply_usd") or 0.0
        if supply < min_market_supply_usd:
            continue
        sym = m["collateral"]
        if sym not in _SHOCKABLE or sym not in deltas:
            continue
        d = deltas[sym]
        h_M = _market_impairment(m, d, mode)
        mid = _mkt_node_id(m)
        label = f"{m['collateral']}/{m['loan']}"
        add_node(mid, "lending_market", supply, label,
                 marketId=m["marketId"], lltv=m.get("lltv"))
        # w_{A->M} = h_M / delta_asset  =>  with h_asset = delta_asset, market receives h_M.
        w_am = (h_M / d) if d > 0 else 0.0
        if w_am > 0:
            edges.append({"from": f"asset_{sym}", "to": mid, "w": round(min(1.0, w_am), 6)})
        market_meta.append({"node": mid, "label": label, "marketId": m["marketId"],
                            "supply_usd": supply, "h_M": round(h_M, 4),
                            "implied_bad_debt_usd": round(h_M * supply)})

    # ── vaults + allocation edges (market -> vault, structural exposure) ──
    for v in snap["vaults"]:
        total = v.get("pre_total_usd") or 0.0
        allocs = v.get("alloc_by_market") or {}
        if total <= 0 or not allocs:
            continue
        # only connect if it allocates into a market we kept
        kept = {mm["marketId"]: mm["node"] for mm in market_meta}
        edge_rows = []
        for market_id, alloc_usd in allocs.items():
            if market_id in kept and alloc_usd and alloc_usd > 0:
                w_mv = min(1.0, alloc_usd / total)
                if w_mv > 0:
                    edge_rows.append({"from": kept[market_id], "to": _vault_node_id(v), "w": round(w_mv, 6)})
        if edge_rows:
            add_node(_vault_node_id(v), "vault", total, v["name"], address=v["address"])
            edges.extend(edge_rows)

    graph = {"nodes": nodes, "edges": edges}
    shock = {"node": "RESOLV", "delta": 1.0}
    meta = {
        "mode": mode,
        "asset_deltas": {k: round(v, 4) for k, v in deltas.items()},
        "markets": market_meta,
        "n_nodes": len(nodes), "n_edges": len(edges),
        "severity_override": severity_override,
    }
    return {"graph": graph, "shock": shock, "meta": meta}


if __name__ == "__main__":
    for mode in ("solvency", "naive"):
        r = build_resolv_graph(mode=mode)
        print(f"\n=== mode={mode}: {r['meta']['n_nodes']} nodes, {r['meta']['n_edges']} edges ===")
        print("asset deltas:", r["meta"]["asset_deltas"])
        for mm in sorted(r["meta"]["markets"], key=lambda x: -x["supply_usd"]):
            if mm["supply_usd"] > 1000:
                print(f"  {mm['label']:14} supply=${mm['supply_usd']:>12,.0f} "
                      f"h_M={mm['h_M']:.3f} implied_bad_debt=${mm['implied_bad_debt_usd']:>10,}")
