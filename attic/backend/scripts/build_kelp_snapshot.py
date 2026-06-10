"""
Build the kelp_2026 cross-protocol contagion snapshot for the GRAPH-engine backtest.

This is the STRONG test the Resolv case lacked: kelp produced ~$123M REAL bad debt
on Aave (system broke), so the model must reproduce a large loss, not "~0".

Aave side: reuse the already-verified cached accounting in backtest_runner.VERIFIED_SNAPSHOTS
           (attacker rsETH deposited, oracle, eMode LTV) + actual getReserveDeficit ($123M).
Morpho side: query rsETH-collateral markets at the incident date (2026-04-17).

Ground truth distribution (independently documented in the kelp snapshot data_note):
  Aave WETH deficit = 99.9% of impact (~$123M), Morpho ~$1M (isolated markets).
"""
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import httpx
from api.core.backtest_runner import VERIFIED_SNAPSHOTS

API = "https://blue-api.morpho.org/graphql"
RSETH = "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7"
PRE = dt.datetime(2026, 4, 17)   # day before the hack cascade (hack 2026-04-18)


def gql(q, v=None):
    return httpx.post(API, json={"query": q, "variables": v or {}}, timeout=40).json()["data"]


def at(series, t):
    ts = t.timestamp(); best = None
    for p in series or []:
        if p.get("y") is not None and p["x"] <= ts and (best is None or p["x"] > best["x"]):
            best = p
    return best["y"] if best else None


def main():
    k = VERIFIED_SNAPSHOTS["kelp_2026"]
    # Aave predicted bad debt (independent of actual $123M): borrowed WETH against
    # rsETH collateral that became worthless = deposited * oracle * eMode_LTV.
    aave_collateral_usd = k["attacker_rseth_deposited"] * k["oracle_price"]
    aave_borrow_usd = aave_collateral_usd * k["attacker_ltv"]
    aave = {
        "venue": "Aave V3",
        "market": "rsETH(eMode)/WETH",
        "pre_collateral_usd": round(aave_collateral_usd),
        "pre_borrow_usd": round(aave_borrow_usd),
        "pre_supply_usd": round(aave_borrow_usd),   # bad debt is bounded by what was borrowed
        "actual_bad_debt_usd": k["actual_bad_debt_usd"],
        "actual_source": "Aave V3.1 getReserveDeficit(WETH) @ block 25,040,000",
    }

    # Morpho rsETH-collateral markets at the incident date
    mk = gql("""query{ markets(first:1000,where:{chainId_in:[1]}){ items{ marketId
      collateralAsset{address symbol} loanAsset{symbol} lltv } } }""")
    rs = [m for m in mk["markets"]["items"]
          if (m["collateralAsset"] or {}).get("address", "").lower() == RSETH]
    s = int(dt.datetime(2026, 4, 8).timestamp()); e = int(dt.datetime(2026, 4, 25).timestamp())
    morpho = []
    for m in rs:
        h = gql("""query($id:String!,$s:Int!,$e:Int!){ marketById(marketId:$id,chainId:1){
          historicalState{
            collateralAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
            supplyAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
            borrowAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y} } } }""",
                 {"id": m["marketId"], "s": s, "e": e})
        hs = h["marketById"]["historicalState"]
        sup = at(hs["supplyAssetsUsd"], PRE) or 0.0
        if sup < 1000:
            continue
        morpho.append({
            "venue": "Morpho Blue",
            "marketId": m["marketId"],
            "market": f"{m['collateralAsset']['symbol']}/{m['loanAsset']['symbol']}",
            "lltv": int(m.get("lltv") or 0) / 1e18 if m.get("lltv") else None,
            "pre_collateral_usd": round(at(hs["collateralAssetsUsd"], PRE) or 0.0),
            "pre_supply_usd": round(sup),
            "pre_borrow_usd": round(at(hs["borrowAssetsUsd"], PRE) or 0.0),
        })

    delta = round(k["actual_depeg_pct"] / 100.0, 4)   # 0.99 — rsETH effectively worthless
    out = {
        "ground_truth": {
            "headline": ("KelpDAO LayerZero hack: rsETH effectively worthless -> ~$123M bad debt on "
                         "Aave (system BROKE). 99.9% concentrated on Aave WETH; Morpho isolated ~$1M."),
            "aave_bad_debt_usd": k["actual_bad_debt_usd"],
            "morpho_bad_debt_usd_est": 1_000_000,
            "distribution_note": "Aave ~99%, Morpho ~$1M, Compound surplus (0). Source: kelp on-chain post-mortem.",
        },
        "event": {
            "id": "kelp_2026_contagion",
            "date": "2026-04-18",
            "pre_shock_date": PRE.strftime("%Y-%m-%d"),
            "shock_node": "rsETH",
            "root_label": "KelpDAO hack",
            "delta": delta,
            "description": "LayerZero DVN 침해 → rsETH 무담보 민팅 → 담보 무가치화 → cross-protocol bad debt",
            "source": "Aave cached archive snapshot + Morpho API historicalState",
        },
        "aave": aave,
        "morpho_markets": morpho,
    }
    outpath = Path(__file__).resolve().parent.parent / "api" / "data" / "kelp_snapshot.json"
    outpath.write_text(json.dumps(out, indent=2))
    print("Aave  rsETH/WETH: collateral=${:,} borrow=${:,}  actual bad debt=${:,}".format(
        aave["pre_collateral_usd"], aave["pre_borrow_usd"], aave["actual_bad_debt_usd"]))
    print("Morpho rsETH markets kept:", len(morpho))
    for m in morpho:
        print(f"  {m['market']:12} supply=${m['pre_supply_usd']:,} collat=${m['pre_collateral_usd']:,} borrow=${m['pre_borrow_usd']:,}")
    print("delta (rsETH):", delta)
    print("WROTE", outpath)


if __name__ == "__main__":
    main()
