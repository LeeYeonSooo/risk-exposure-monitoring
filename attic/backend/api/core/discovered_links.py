"""
discovered_links.py — BEHAVIORAL cross-protocol dependencies discovered from on-chain
events, surfaced INTO the contagion propagation.

WHY this exists (the original design intent):
  Traditional bank-style risk graphs only connect what's DECLARED on a balance sheet
  ("this market uses this collateral"). But the dangerous links in DeFi are often
  HIDDEN: the same whale supplies on Aave AND Morpho, so an Aave blow-up forces them
  to unwind Morpho — a contagion path no declared-accounting graph can see.

  Our discovery pipeline finds these via events:
    - position_copresence  : the SAME whale EOA holds positions on two protocols
                             (latent — a correlated forced-deleveraging path).
    - eoa_bridge           : a whale EOA actually MOVED capital between protocols
                             (realized flow — a stronger, directed path).

  Those land in integration/output/discovered_*.json. THIS module loads the
  cross-protocol BEHAVIORAL edges (not the structural plumbing, which contagion already
  rebuilds from live state) and exposes them so `live_contagion` can inject them into the
  propagation graph as a separate, clearly-labeled tier.

HONESTY: these are correlational/behavioral, NOT balance-sheet claims. They carry a
discounted transmission weight (κ × tier_factor) and are reported separately from the
exact hop-1 bad-debt $ — never folded into the verified number.
"""
from __future__ import annotations

import json
from pathlib import Path

_HERE = Path(__file__).resolve().parent
PROJECT_ROOT = _HERE.parent.parent.parent            # core → api → backend → repo root
_OUT = PROJECT_ROOT / "integration" / "output"
_COPRESENCE = _OUT / "discovered_copresence.json"
_EOA_BRIDGE = _OUT / "discovered_eoa_bridges.json"

# Transmission discount for a behavioral edge vs a declared collateral edge. A shared-whale
# co-presence is a *latent* forced-deleveraging correlation, not a direct claim — so it
# transmits a fraction. Tier scales it: a REALIZED flow (capital actually moved) is the
# strongest behavioral signal; LATENT (just co-present) is weaker; POTENTIAL weaker still.
_KAPPA_BRIDGE = 0.3
_TIER_FACTOR = {"realized": 1.0, "latent": 0.5, "potential": 0.25}

# Protocol registry: maps discovery's protocol ids → a normalized node identity for the
# contagion graph, plus its KIND. Two kinds behave differently when a shared-whale bridge
# is surfaced into propagation:
#   - lending : the protocol BEARS bad debt (Aave/Morpho/Spark/Sky). A shock that stresses
#               it can drag the shared whales' exposure on the OTHER lending protocol
#               (forced deleveraging) → surfaced as a loss exposure on that venue.
#   - issuer  : the protocol ISSUES a token used as collateral elsewhere (Lido→stETH,
#               etherFi→weETH, Pendle→PT). The hidden path is a FORCED TOKEN SELL: a
#               stressed lending protocol → shared whales dump the issued token → depeg
#               that hits its collateral markets. Surfaced as a forced-sell path on `asset`.
_PROTO_REGISTRY: dict[str, dict] = {
    "aave-v3":     {"kind": "lending", "venue": "Aave V3"},
    "aave_v3":     {"kind": "lending", "venue": "Aave V3"},
    "aave":        {"kind": "lending", "venue": "Aave V3"},
    "morpho":      {"kind": "lending", "venue": "Morpho Blue"},
    "morpho-blue": {"kind": "lending", "venue": "Morpho Blue"},
    "morpho_blue": {"kind": "lending", "venue": "Morpho Blue"},
    "spark":       {"kind": "lending", "venue": "Spark"},
    "sparklend":   {"kind": "lending", "venue": "Spark"},
    "sky":         {"kind": "lending", "venue": "Sky CDP"},
    "sky-cdp":     {"kind": "lending", "venue": "Sky CDP"},
    "maker":       {"kind": "lending", "venue": "Sky CDP"},
    "lido":        {"kind": "issuer",  "venue": "Lido",     "asset": "wstETH"},
    "etherfi":     {"kind": "issuer",  "venue": "etherFi",  "asset": "weETH"},
    "ether.fi":    {"kind": "issuer",  "venue": "etherFi",  "asset": "weETH"},
    "kelp":        {"kind": "issuer",  "venue": "Kelp",     "asset": "rsETH"},
    "renzo":       {"kind": "issuer",  "venue": "Renzo",    "asset": "ezETH"},
    "pendle":      {"kind": "issuer",  "venue": "Pendle",   "asset": None},  # PT — many, no single asset
}


def _proto_meta(p: str) -> dict:
    key = (p or "").lower().strip()
    return _PROTO_REGISTRY.get(key, {"kind": "lending", "venue": (p or "").strip()})


def _norm_proto(p: str) -> str:
    return _proto_meta(p)["venue"]


def _load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def tier_weight(tier: str) -> float:
    """Behavioral transmission weight for a bridge of the given tier (κ × tier_factor)."""
    return round(_KAPPA_BRIDGE * _TIER_FACTOR.get(tier, 0.25), 4)


def _pick_at_risk(a: dict, c: dict, b: dict, default_usd: float) -> tuple[dict, dict, float]:
    """Decide which side is AT RISK (surfaced) vs STRESSED (the shocked trigger).
    - lending ↔ lending: the side carrying the discovered $ is at risk (forced deleveraging).
    - lending ↔ issuer : the ISSUER's token is dumped when the lending side is stressed →
                          the issuer asset is at risk; the lending side is the trigger.
    - issuer  ↔ issuer : pick the one with $ (rare). Returns (at_risk, stressed, exposure_usd)."""
    if a["kind"] == "issuer" and c["kind"] == "lending":
        return a, c, default_usd
    if c["kind"] == "issuer" and a["kind"] == "lending":
        return c, a, default_usd
    # lending↔lending (or issuer↔issuer): the Morpho/$-carrying side is at risk
    if a["venue"] == "Morpho Blue":
        return a, c, default_usd
    if c["venue"] == "Morpho Blue":
        return c, a, default_usd
    return c, a, default_usd


def behavioral_bridges() -> list[dict]:
    """Cross-protocol BEHAVIORAL bridges discovered from events, normalized to:
        {stressed_venue, at_risk_venue, at_risk_kind, at_risk_asset, tier, shared_whales,
         exposure_usd, quantified, w, source}
    `stressed_venue` is the trigger (the shock must hit it); `at_risk_venue` is the hidden
    exposure surfaced. `quantified`=False when discovery gave no USD (path shown qualitatively).
    Empty / mock / errored files yield no bridges (no fake edges)."""
    out: list[dict] = []

    def _emit(pa: str, pb: str, raw_usd: float, tier: str, whales: int, source: str, top):
        a, c = _proto_meta(pa), _proto_meta(pb)
        if not a["venue"] or not c["venue"] or a["venue"] == c["venue"]:
            return
        at_risk, stressed, usd = _pick_at_risk(a, c, {}, raw_usd)
        # The copresence discovery only computes USD on the MORPHO side (combined_morpho_usd =
        # shared whales' Morpho supply). So a $ figure is only meaningful when MORPHO is the
        # at-risk side; for any other at-risk side that number is irrelevant → keep qualitative.
        if at_risk["venue"] != "Morpho Blue":
            usd = 0.0
        out.append({
            "stressed_venue": stressed["venue"],
            "at_risk_venue": at_risk["venue"],
            "at_risk_kind": at_risk["kind"],
            "at_risk_asset": at_risk.get("asset"),
            "tier": tier,
            "shared_whales": int(whales or 0),
            "exposure_usd": round(usd) if usd > 0 else 0,
            "quantified": usd > 0,
            "w": tier_weight(tier),
            "source": source,
            "top_shared": (top or [])[:5],
        })

    # ── position co-presence (same whale on both protocols → latent path; has $ on Morpho) ──
    cop = _load_json(_COPRESENCE)
    for b in ((cop or {}).get("_meta", {}) or {}).get("bridges", []):
        usd = float(b.get("combined_morpho_usd") or b.get("combined_usd") or 0.0)
        _emit(b.get("protocol_a", ""), b.get("protocol_b", ""), usd,
              b.get("tier", "latent"), b.get("shared_whales", 0),
              "position_copresence", b.get("top_shared"))

    # ── EOA bridge (whale moved/holds across protocols; realized=directed flow) ──
    eoa = _load_json(_EOA_BRIDGE)
    for b in ((eoa or {}).get("_meta", {}) or {}).get("bridges", []):
        # realized_amount is a mixed-asset token-unit sum (not USD) → keep qualitative; the
        # value of a realized bridge is the STRONGER tier (directed flow), not a $ figure.
        _emit(b.get("protocol_a", ""), b.get("protocol_b", ""), 0.0,
              b.get("tier", "latent"), b.get("shared_whales", 0),
              "eoa_bridge", b.get("top_shared"))

    # ── merge duplicate (stressed→at_risk) pairs: a pair may appear as BOTH a latent
    #    copresence (with $) and a realized EOA flow (stronger tier, no $). Keep the highest
    #    transmission weight, the $ exposure if any side has it, and the max whale count. ──
    merged: dict[tuple, dict] = {}
    for b in out:
        key = (b["stressed_venue"], b["at_risk_venue"])
        cur = merged.get(key)
        if cur is None or b["w"] > cur["w"]:
            base = dict(b) if cur is None else {**cur, "tier": b["tier"], "w": b["w"], "source": b["source"]}
            merged[key] = base
            cur = merged[key]
        # carry the best $ exposure + whale count + source list across the merged pair
        if b["exposure_usd"] > cur.get("exposure_usd", 0):
            cur["exposure_usd"] = b["exposure_usd"]; cur["quantified"] = b["quantified"]
        cur["shared_whales"] = max(cur["shared_whales"], b["shared_whales"])
        srcs = set(cur.get("sources", [cur["source"]])); srcs.add(b["source"])
        cur["sources"] = sorted(srcs)
    return list(merged.values())


def bridges_touching(venues: set[str]) -> list[dict]:
    """Behavioral bridges whose STRESSED side (the trigger) is among the `venues` present in
    a shock — so the at-risk side is the hidden exposure that shock surfaces."""
    return [b for b in behavioral_bridges() if b["stressed_venue"] in venues]
