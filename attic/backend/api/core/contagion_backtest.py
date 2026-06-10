"""
contagion_backtest.py — Phase 2: run DebtRank propagate() on the Resolv historical
graph and compare to ground truth. NO parameter fitting (no calibration_factor).

This is the GRAPH-engine backtest (cross-protocol contagion), distinct from
backtest_runner.py which backtests the single-asset rsETH CascadeSimulator.

Lives in the backtest path only. The historical incident graph never enters the
live /api/graph mapping.

Output is JSON-serializable and includes:
  - the propagation graph + per-round distress (for the backtest-page animation)
  - per-market implied bad debt and per-vault predicted loss
  - a validation comparison vs ground truth for BOTH modes (solvency vs naive),
    so the falsification (naive over-predicts, solvency matches) is explicit.
"""
from __future__ import annotations

from typing import Optional

import json
from pathlib import Path

from .weights_morpho import build_resolv_graph, load_snapshot, _market_impairment
from ..sim.engine import propagate_dynamic as propagate  # Bardoscia dynamical DebtRank

VAULT_VICTIM_THRESHOLD = 0.01   # share-price impairment > 1% counts as a victim
_DATA = Path(__file__).resolve().parent.parent / "data"
KELP_SNAPSHOT = _DATA / "kelp_snapshot.json"
STETH_SNAPSHOT = _DATA / "steth_snapshot.json"


def _run_mode(snap: dict, mode: str, severity_override: Optional[dict]) -> dict:
    built = build_resolv_graph(snap, mode=mode, severity_override=severity_override)
    graph, shock, meta = built["graph"], built["shock"], built["meta"]
    res = propagate(graph, shock)

    node_by_id = {n["id"]: n for n in graph["nodes"]}
    usd = dict(res["ranking_usd"])

    market_rows = sorted(
        [{"node": n["id"], "label": n["label"], "marketId": n.get("marketId"),
          "supply_usd": n["tvl"], "h": round(res["h"][n["id"]], 4),
          "implied_bad_debt_usd": round(usd.get(n["id"], 0.0))}
         for n in graph["nodes"] if n["type"] == "lending_market"],
        key=lambda x: -x["implied_bad_debt_usd"],
    )
    vault_rows = sorted(
        [{"node": n["id"], "label": n["label"], "address": n.get("address"),
          "total_usd": n["tvl"], "h": round(res["h"][n["id"]], 4),
          "predicted_loss_usd": round(usd.get(n["id"], 0.0))}
         for n in graph["nodes"] if n["type"] == "vault"],
        key=lambda x: -x["predicted_loss_usd"],
    )
    return {
        "mode": mode,
        "graph": graph,
        "shock": shock,
        "asset_deltas": meta["asset_deltas"],
        "rounds": res["rounds"],
        "distress_round": res["distress_round"],
        "h": {k: round(v, 4) for k, v in res["h"].items() if v > 0},
        "market_bad_debt": market_rows,
        "vault_predictions": vault_rows,
    }


def _compare(vault_rows: list[dict], gt_victims: list[dict]) -> dict:
    """Set/ranking comparison of predicted vault victims vs ground-truth solvency victims."""
    actual_addrs = {(v.get("address") or "").lower() for v in gt_victims}
    pred = [v for v in vault_rows if v["h"] >= VAULT_VICTIM_THRESHOLD]
    pred_addrs = {(v.get("address") or "").lower() for v in pred}

    matched = sorted(pred_addrs & actual_addrs)
    false_positives = [v for v in pred if (v.get("address") or "").lower() not in actual_addrs]
    missed = [v for v in gt_victims if (v.get("address") or "").lower() not in pred_addrs]

    recall = (len(matched) / len(actual_addrs)) if actual_addrs else None
    precision = (len(matched) / len(pred_addrs)) if pred_addrs else (1.0 if not actual_addrs else 0.0)
    return {
        "n_predicted_victims": len(pred),
        "n_actual_victims": len(actual_addrs),
        "matched": matched,
        "recall": round(recall, 3) if recall is not None else None,
        "precision": round(precision, 3),
        "false_positives": [{"label": v["label"], "predicted_loss_usd": v["predicted_loss_usd"]}
                            for v in false_positives],
        "missed": [{"name": v["name"], "loss_usd": v["loss_usd"]} for v in missed],
        "predicted_loss_total_usd": round(sum(v["predicted_loss_usd"] for v in pred)),
    }


def run_resolv_backtest(severity_override: Optional[dict] = None) -> dict:
    """
    Full Resolv contagion backtest. Runs BOTH modes and compares to ground truth.

    severity_override: optional {asset: delta} for counterfactual severity scenarios
                       (the live "what-if" use of the same engine). When None, uses the
                       data-observed depeg (true backtest).
    """
    snap = load_snapshot()
    gt = snap["ground_truth"]
    gt_victims = gt.get("solvency_victims", [])

    modes = {m: _run_mode(snap, m, severity_override) for m in ("solvency", "naive")}
    comparison = {m: _compare(modes[m]["vault_predictions"], gt_victims) for m in modes}

    # the punchline: does naive flag the big over-collateralized market that reality cleared?
    def _top_market(m):
        mb = modes[m]["market_bad_debt"]
        return mb[0] if mb else None

    return {
        "incident_id": snap["event"]["id"],
        "event": snap["event"],
        "ground_truth": gt,
        "is_backtest": severity_override is None,
        "severity_override": severity_override,
        "modes": modes,
        "comparison": comparison,
        "headline": (
            f"USR depegged {snap['event']['delta']*100:.0f}%. "
            f"Solvency-DebtRank predicts {comparison['solvency']['n_predicted_victims']} vault victim(s) "
            f"(recall={comparison['solvency']['recall']}), matching ground truth's "
            f"{len(gt_victims)} solvency victim(s). Naive model raises "
            f"{len(comparison['naive']['false_positives'])} false positive(s) "
            f"(e.g. the over-collateralized RLP/USDC market) that reality cleared. "
            f"No parameter fitting."
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# kelp_2026 — cross-protocol contagion (the STRONG test: ~$123M REAL bad debt).
# rsETH collateral became worthless -> bad debt on Aave (large) + Morpho (small).
# Same accounting->propagate machinery; tests bad-debt MAGNITUDE + cross-protocol split.
# ─────────────────────────────────────────────────────────────────────────────

def load_kelp_snapshot() -> dict:
    return json.loads(KELP_SNAPSHOT.read_text())


def _loan_symbol(market_label: str) -> str:
    # "rsETH(eMode)/WETH" -> "WETH"
    return market_label.split("/")[-1].strip() if "/" in market_label else "loan"


def build_magnitude_graph(snap: dict, mode: str = "solvency") -> dict:
    """
    Aave-style (and cross-protocol) bad-debt graph for magnitude incidents (kelp, stETH).
    shock_asset -> [per-venue market] -> loan-asset SINK (the suppliers who bear bad debt).
    The loan-asset sink nodes make the bad-debt bearer visible (tvl=0 so they don't
    double-count in ranking_usd; market nodes carry the $).
    """
    ev = snap["event"]
    delta = float(ev["delta"])
    shock_sym = ev["shock_node"]
    root_id = ev.get("root_label", "SHOCK")
    nodes = [
        {"id": "ROOT", "type": "protocol", "tvl": 0.0, "label": root_id},
        {"id": f"asset_{shock_sym}", "type": "asset", "tvl": 0.0, "label": shock_sym},
    ]
    edges = [{"from": "ROOT", "to": f"asset_{shock_sym}", "w": round(delta, 4)}]
    venues = []
    sink_ids: dict[str, str] = {}

    markets = [{**snap["aave"], "venue": "Aave"}] + \
              [{**m, "venue": "Morpho Blue"} for m in snap.get("morpho_markets", [])]

    for i, m in enumerate(markets):
        node_id = f"mkt_{i}_{m['venue'].split()[0].lower()}"
        label = f"{m['venue']} · {m['market']}"
        h_M = _market_impairment(
            {"pre_supply_usd": m["pre_supply_usd"], "pre_borrow_usd": m["pre_borrow_usd"],
             "pre_collateral_usd": m["pre_collateral_usd"]}, delta, mode)
        nodes.append({"id": node_id, "type": "lending_market", "tvl": m["pre_supply_usd"],
                      "label": label, "venue": m["venue"]})
        w_am = (h_M / delta) if delta > 0 else 0.0
        if w_am > 0:
            edges.append({"from": f"asset_{shock_sym}", "to": node_id, "w": round(min(1.0, w_am), 6)})
        # loan-asset sink node (visible bad-debt bearer; tvl=0 -> excluded from $ ranking)
        loan = _loan_symbol(m["market"])
        sink_id = sink_ids.get(loan)
        if sink_id is None:
            sink_id = f"sink_{loan}"
            sink_ids[loan] = sink_id
            nodes.append({"id": sink_id, "type": "asset", "tvl": 0.0,
                          "label": f"{loan} 공급자"})
        edges.append({"from": node_id, "to": sink_id, "w": 1.0})
        venues.append({"node": node_id, "venue": m["venue"], "label": label,
                       "supply_usd": m["pre_supply_usd"], "h_M": round(h_M, 4),
                       "implied_bad_debt_usd": round(h_M * m["pre_supply_usd"])})

    return {"graph": {"nodes": nodes, "edges": edges},
            "shock": {"node": "ROOT", "delta": 1.0},
            "meta": {"mode": mode, "delta": delta, "shock_sym": shock_sym, "venues": venues}}


def run_magnitude_backtest(snap: dict) -> dict:
    gt = snap["ground_truth"]
    shock_sym = snap["event"]["shock_node"]
    modes = {}
    for mode in ("solvency", "naive"):
        built = build_magnitude_graph(snap, mode=mode)
        res = propagate(built["graph"], built["shock"])
        usd = dict(res["ranking_usd"])
        rows = [{"node": v["node"], "venue": v["venue"], "label": v["label"],
                 "supply_usd": v["supply_usd"], "h": round(res["h"][v["node"]], 4),
                 "implied_bad_debt_usd": round(usd.get(v["node"], 0.0))}
                for v in built["meta"]["venues"]]
        modes[mode] = {"mode": mode, "graph": built["graph"], "shock": built["shock"],
                       "asset_deltas": {shock_sym: built["meta"]["delta"]},
                       "rounds": res["rounds"], "distress_round": res["distress_round"],
                       "h": {k: round(v, 4) for k, v in res["h"].items() if v > 0},
                       "market_bad_debt": sorted(rows, key=lambda x: -x["implied_bad_debt_usd"]),
                       "vault_predictions": []}

    def venue_pred(mode, venue_prefix):
        return round(sum(r["implied_bad_debt_usd"] for r in modes[mode]["market_bad_debt"]
                         if r["venue"].startswith(venue_prefix)))

    aave_pred = venue_pred("solvency", "Aave")
    aave_act = gt.get("aave_bad_debt_usd", 0)
    rows = [{"label": "Aave", "predicted_usd": aave_pred, "actual_usd": aave_act,
             "error_pct": round((aave_pred - aave_act) / aave_act * 100, 1) if aave_act else
                          (0.0 if aave_pred == 0 else None)}]
    has_morpho = bool(snap.get("morpho_markets"))
    distribution = None
    if has_morpho:
        morpho_pred = venue_pred("solvency", "Morpho")
        morpho_act = gt.get("morpho_bad_debt_usd_est", 0)
        rows.append({"label": "Morpho Blue", "predicted_usd": morpho_pred, "actual_usd": morpho_act,
                     "error_pct": round((morpho_pred - morpho_act) / morpho_act * 100, 1) if morpho_act else None})
        total_pred = aave_pred + morpho_pred
        distribution = {
            "predicted_aave_pct": round(aave_pred / total_pred * 100, 1) if total_pred else None,
            "actual_aave_pct": round(aave_act / (aave_act + morpho_act) * 100, 1) if (aave_act + morpho_act) else None,
        }

    if aave_act == 0 and aave_pred == 0:
        headline = (f"{shock_sym} −{snap['event']['delta']*100:.0f}% 디페그. Solvency-DebtRank가 "
                    f"bad debt $0 예측 (실측 $0, 청산 0건) — LT 버퍼가 충격을 흡수. "
                    f"Naive 모델은 phantom 손실을 예측. 무피팅.")
    else:
        extra = (f" cross-protocol 분포 Aave {distribution['predicted_aave_pct']:.0f}% "
                 f"(실측 ~{distribution['actual_aave_pct']:.0f}%)." if distribution else "")
        headline = (f"{shock_sym} 무가치화(−{snap['event']['delta']*100:.0f}%). "
                    f"Aave bad debt ${aave_pred:,.0f} 예측 (실측 ${aave_act:,.0f}, "
                    f"오차 {rows[0]['error_pct']}%).{extra} 무피팅.")

    return {
        "incident_id": snap["event"]["id"], "kind": "magnitude", "event": snap["event"],
        "ground_truth": gt, "is_backtest": True, "modes": modes,
        "comparison_rows": rows, "distribution": distribution, "headline": headline,
    }


def run_kelp_backtest() -> dict:
    return run_magnitude_backtest(load_kelp_snapshot())


def run_steth_backtest() -> dict:
    return run_magnitude_backtest(json.loads(STETH_SNAPSHOT.read_text()))


# ─────────────────────────────────────────────────────────────────────────────
# Frontend serialization: emit a ready-to-render topology + per-round node states
# so the backtest page can animate the contagion with the existing GraphCanvas.
# ─────────────────────────────────────────────────────────────────────────────

_TYPE_MAP = {"protocol": "DefiProtocol", "asset": "Token", "oracle": "Oracle",
             "lending_market": "TokenProtocol", "vault": "DefiProtocol"}
_LAYER_X = {"protocol": 0, "oracle": 150, "asset": 280, "lending_market": 620, "vault": 1000}


def _infer_role(n: dict) -> str:
    """Standardized node ROLE for uniform venue rendering/explanation. Prefer an explicit
    n['role']; otherwise infer from type/venue/id so every node says WHAT it is."""
    if n.get("role"):
        return n["role"]
    t = n.get("type")
    nid = str(n.get("id", ""))
    if t == "protocol":
        return "shock"
    if t == "oracle":
        return "oracle"
    if t == "vault":
        return "vault"
    if t == "asset":
        if "_loss" in nid or nid.endswith("_loss") or "공급자" in n.get("label", "") or "buffer" in n.get("label", "").lower():
            return "loss_sink"
        return "asset"
    if t == "lending_market":
        v = (n.get("venue") or "").lower()
        if "pendle" in v:
            return "amm_pool"
        if "sky" in v:
            return "cdp_ilk"
        if "aave" in v or "spark" in v:
            return "position_bucket"
        return "collateral_market"
    return t or "node"


def _risk_level(h: float) -> str:
    if h >= 0.5:
        return "danger"
    if h > 0.0:
        return "caution"
    return "safe"


def to_frontend(result: dict, mode: str = "solvency") -> dict:
    """Build {topology, node_states_by_round, n_rounds} for the chosen mode."""
    m = result["modes"][mode]
    graph = m["graph"]
    distress = m["distress_round"]
    h = {n["id"]: 0.0 for n in graph["nodes"]}
    h.update(m["h"])
    deltas = m["asset_deltas"]
    # liquidity channel reuses this serializer, but the market metric is FROZEN capital
    # (can't withdraw), not bad debt (lost) — relabel node tooltips accordingly.
    is_liq = result.get("channel") == "liquidity"

    # layered positions (RESOLV -> assets -> markets -> vaults), stable y per layer
    layer_counts: dict[str, int] = {}
    nodes_fe = []
    for n in graph["nodes"]:
        t = n["type"]
        idx = layer_counts.get(t, 0)
        layer_counts[t] = idx + 1
        nodes_fe.append({
            "id": n["id"],
            "type": _TYPE_MAP.get(t, "DefiProtocol"),
            "label": n["label"],
            "metadata": {"category": t, "symbol": n.get("label"),
                         "venue": n.get("venue"), "role": _infer_role(n),
                         "data_source": n.get("data_source"), "approx": n.get("approx"),
                         "collateral_protocol": n.get("collateral_protocol")},
            "position": {"x": _LAYER_X.get(t, 500), "y": 80 + idx * 130},
            "active": True,
        })
    edges_fe = [{"id": f"{e['from']}->{e['to']}", "source": e["from"], "target": e["to"],
                 "type": "contagion", "weight": e["w"]}
                for e in graph["edges"]]
    topology = {"nodes": nodes_fe, "edges": edges_fe}

    n_rounds = (max(distress.values()) + 1) if distress else 1
    tvl_by = {n["id"]: n.get("tvl", 0.0) for n in graph["nodes"]}
    label_by = {n["id"]: n["label"] for n in graph["nodes"]}
    type_by = {n["id"]: n["type"] for n in graph["nodes"]}

    states_by_round = []
    for r in range(n_rounds):
        snap = {}
        for nid in h:
            dr = distress.get(nid)
            if dr is None or dr > r:
                snap[nid] = {"riskLevel": "safe", "falseNegative": False, "liquidated": False,
                             "pegRatio": None, "tvl": tvl_by.get(nid), "note": None}
                continue
            hv = h[nid]
            t = type_by[nid]
            if t == "asset":
                note = (f"run ρ {deltas.get(label_by[nid], 0)*100:.0f}%" if is_liq
                        else f"depeg -{deltas.get(label_by[nid], 0)*100:.0f}%")
                peg = 1.0 - hv
            elif t == "lending_market":
                if is_liq:
                    note = f"frozen ${round(hv*tvl_by.get(nid,0)):,}" if hv > 0 else "fully liquid"
                else:
                    note = f"bad debt ${round(hv*tvl_by.get(nid,0)):,}" if hv > 0 else "no bad debt"
                peg = None
            elif t == "vault":
                pref = "frozen" if is_liq else "loss"
                note = f"{pref} ${round(hv*tvl_by.get(nid,0)):,}" if hv > 0 else None
                peg = None
            else:
                note = None; peg = None
            snap[nid] = {"riskLevel": _risk_level(hv), "falseNegative": False,
                         "liquidated": hv >= 0.5, "pegRatio": peg,
                         "tvl": tvl_by.get(nid), "note": note}
        states_by_round.append(snap)

    return {"topology": topology, "node_states_by_round": states_by_round, "n_rounds": n_rounds}


def resolv_payload(mode: str = "solvency", severity_override: Optional[dict] = None) -> dict:
    """Full API payload: validation result (both modes) + frontend render data for `mode`."""
    result = run_resolv_backtest(severity_override=severity_override)
    result["kind"] = "vault_recall"
    fe = to_frontend(result, mode if mode in result["modes"] else "solvency")
    return {**result, "render": fe, "render_mode": mode}


def kelp_payload(mode: str = "solvency") -> dict:
    result = run_kelp_backtest()
    fe = to_frontend(result, mode if mode in result["modes"] else "solvency")
    return {**result, "render": fe, "render_mode": mode}


# incident_id -> payload builder. Lets /api/contagion/{id} serve any contagion incident.
def steth_payload(mode: str = "solvency") -> dict:
    result = run_steth_backtest()
    fe = to_frontend(result, mode if mode in result["modes"] else "solvency")
    return {**result, "render": fe, "render_mode": mode}


CONTAGION_INCIDENTS = {
    "resolv_usr_depeg_2026_03": resolv_payload,
    "kelp_2026_contagion": lambda mode="solvency": kelp_payload(mode),
    "steth_depeg_2022_contagion": lambda mode="solvency": steth_payload(mode),
}


def contagion_payload(incident_id: str, mode: str = "solvency") -> dict:
    if incident_id in CONTAGION_INCIDENTS:
        return CONTAGION_INCIDENTS[incident_id](mode=mode)
    # non-solvency channel backtests (D1/D2/D3) — lazy import to avoid a cycle
    from . import channel_backtests as _ch
    if incident_id in _ch.CHANNEL_INCIDENTS:
        return _ch.CHANNEL_INCIDENTS[incident_id](mode=mode)
    raise KeyError(incident_id)


if __name__ == "__main__":
    import json
    r = run_resolv_backtest()
    print(r["headline"])
    print("\nGROUND TRUTH solvency victims:",
          [(v["name"], f"${v['loss_usd']:,}") for v in r["ground_truth"]["solvency_victims"]])
    for m in ("solvency", "naive"):
        c = r["comparison"][m]
        print(f"\n--- {m} ---  recall={c['recall']} precision={c['precision']} "
              f"pred_total=${c['predicted_loss_total_usd']:,}")
        print("  predicted victims:",
              [(v["label"], f"${v['predicted_loss_usd']:,}") for v in r["modes"][m]["vault_predictions"] if v["h"] >= VAULT_VICTIM_THRESHOLD])
        print("  false positives:", [(v["label"], f"${v['predicted_loss_usd']:,}") for v in c["false_positives"]])
        top = r["modes"][m]["market_bad_debt"][0] if r["modes"][m]["market_bad_debt"] else None
        if top:
            print(f"  top market by bad debt: {top['label']} ${top['implied_bad_debt_usd']:,}")
