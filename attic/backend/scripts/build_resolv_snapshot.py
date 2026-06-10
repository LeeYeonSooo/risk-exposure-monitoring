"""
Phase 0 finalizer — build the pre-shock snapshot + ground truth around the
USR depeg of 2026-05-08 (USR -> ~$0.10), the data-selected event.

Outputs api/data/resolv_snapshot.json with:
  - event: {date, shock_node, delta, price_trajectory}
  - markets[]: pre-shock collateral/supply/borrow USD + asset symbols (for w numerator/denominator)
  - vaults[]:  pre-shock total + per-market allocation USD (for allocation edge w)
  - ground_truth: post-shock vault total drop (realized impairment proxy)

This file is the ONLY thing Phase 1/2 read; it stays in the backtest path.
"""
import asyncio
import datetime as dt
import json
from pathlib import Path
import httpx

API = "https://blue-api.morpho.org/graphql"
USR = "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110"
WSTUSR = "0x1202f5c7b4b9e47a1a484e8b270be34dbbc75055"
RLP = "0x4956b52ae2ff65d74ca2d61207523288e4528f96"
RESOLV = {USR, WSTUSR, RLP}
SYM = {USR: "USR", WSTUSR: "wstUSR", RLP: "RLP"}

# Event window. Cliff: USR $0.999 (03-22) -> $0.32 (03-23) -> $0.11 (04-03).
# Pre-shock snapshot day = 2026-03-22 (last clean peg).
PRE_SHOCK = dt.datetime(2026, 3, 22)
POST_SHOCK = dt.datetime(2026, 4, 10)
PRICE_START = int(dt.datetime(2026, 3, 15).timestamp())
PRICE_END = int(dt.datetime(2026, 4, 15).timestamp())
HIST_START = int(dt.datetime(2026, 2, 15).timestamp())   # enough lead for DAY series
HIST_END = int(POST_SHOCK.timestamp())


async def gql(client, q, v=None):
    r = await client.post(API, json={"query": q, "variables": v or {}})
    d = r.json()
    if "errors" in d:
        print("ERR", json.dumps(d["errors"])[:300]); return None
    return d.get("data")


Q_PRICE = """query P($a:String!,$s:Int!,$e:Int!){ assetByAddress(address:$a,chainId:1){
  symbol historicalPriceUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y} } }"""

Q_MARKETS = """query M($f:Int!){ markets(first:$f,orderBy:SupplyAssetsUsd,orderDirection:Desc,where:{chainId_in:[1]}){
  items{ marketId lltv collateralAsset{address symbol} loanAsset{address symbol} } } }"""

Q_MKT_HIST = """query MH($id:String!,$s:Int!,$e:Int!){ marketById(marketId:$id,chainId:1){
  collateralAsset{symbol} loanAsset{symbol}
  historicalState{
    collateralAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
    supplyAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
    borrowAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
  } } }"""

Q_VAULTS = """query V($f:Int!){ vaults(first:$f,orderBy:TotalAssetsUsd,orderDirection:Desc,where:{chainId_in:[1]}){
  items{ address name state{ totalAssetsUsd allocation{ market{marketId} } } } } }"""

Q_VAULT_HIST = """query VH($a:String!,$s:Int!,$e:Int!){ vaultByAddress(address:$a,chainId:1){
  address name
  historicalState{
    totalAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
    sharePriceUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
    allocation{ market{marketId collateralAsset{symbol} loanAsset{symbol}}
      supplyAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y} }
  } } }"""


def val_at(series, target_dt):
    """Closest daily point at-or-before target."""
    ts = target_dt.timestamp()
    best = None
    for p in series or []:
        if p.get("y") is None:
            continue
        if p["x"] <= ts and (best is None or p["x"] > best["x"]):
            best = p
    if best is None and series:
        best = series[0]
    return best["y"] if best else None


async def main():
    async with httpx.AsyncClient(timeout=60.0) as client:
        # ── prices / depeg magnitude ──
        prices = {}
        traj = {}
        for a in (USR, WSTUSR, RLP):
            d = await gql(client, Q_PRICE, {"a": a, "s": PRICE_START, "e": PRICE_END})
            ser = ((d or {}).get("assetByAddress") or {}).get("historicalPriceUsd") or []
            traj[SYM[a]] = [{"d": dt.datetime.fromtimestamp(p["x"]).strftime("%m-%d"),
                             "p": round(p["y"], 4)} for p in ser if p.get("y") is not None]
            prices[SYM[a]] = {
                "pre": val_at(ser, PRE_SHOCK),
                "trough": min((p["y"] for p in ser if p.get("y")), default=None),
            }
        usr_pre = prices["USR"]["pre"] or 1.0
        usr_trough = prices["USR"]["trough"] or usr_pre
        delta = max(0.0, min(1.0, (usr_pre - usr_trough) / usr_pre))
        print(f"USR pre=${usr_pre:.4f} trough=${usr_trough:.4f} -> shock delta={delta:.3f}")

        # ── markets with Resolv collateral ──
        md = await gql(client, Q_MARKETS, {"f": 1000})
        items = (md or {}).get("markets", {}).get("items", [])
        resolv = [m for m in items if ((m.get("collateralAsset") or {}).get("address") or "").lower() in RESOLV]
        markets_out = []
        for m in resolv:
            hd = await gql(client, Q_MKT_HIST, {"id": m["marketId"], "s": HIST_START, "e": HIST_END})
            mh = (hd or {}).get("marketById")
            if not mh:
                continue
            hs = mh["historicalState"]
            col = val_at(hs.get("collateralAssetsUsd"), PRE_SHOCK) or 0.0
            sup = val_at(hs.get("supplyAssetsUsd"), PRE_SHOCK) or 0.0
            bor = val_at(hs.get("borrowAssetsUsd"), PRE_SHOCK) or 0.0
            markets_out.append({
                "marketId": m["marketId"],
                "collateral": (m.get("collateralAsset") or {}).get("symbol"),
                "loan": (m.get("loanAsset") or {}).get("symbol"),
                "lltv": int(m.get("lltv") or 0) / 1e18 if m.get("lltv") else None,
                "pre_collateral_usd": col, "pre_supply_usd": sup, "pre_borrow_usd": bor,
            })
        markets_out.sort(key=lambda x: -x["pre_supply_usd"])
        resolv_keys = {m["marketId"] for m in markets_out}
        print(f"\nResolv markets (pre-shock {PRE_SHOCK:%Y-%m-%d}):")
        for m in markets_out:
            print(f"  {m['collateral']}/{m['loan']:6} supply=${m['pre_supply_usd']:,.0f} "
                  f"collat=${m['pre_collateral_usd']:,.0f} borrow=${m['pre_borrow_usd']:,.0f}")

        # ── vaults allocating into those markets ──
        vd = await gql(client, Q_VAULTS, {"f": 1000})
        vaults = (vd or {}).get("vaults", {}).get("items", [])
        cand = [v for v in vaults if any((a.get("market") or {}).get("marketId") in resolv_keys
                                         for a in ((v.get("state") or {}).get("allocation") or []))]
        vaults_out = []
        for v in cand:
            vh = await gql(client, Q_VAULT_HIST, {"a": v["address"], "s": HIST_START, "e": HIST_END})
            vobj = (vh or {}).get("vaultByAddress")
            if not vobj:
                continue
            hs = vobj["historicalState"]
            tot_pre = val_at(hs.get("totalAssetsUsd"), PRE_SHOCK) or 0.0
            tot_post = val_at(hs.get("totalAssetsUsd"), POST_SHOCK) or 0.0
            # SOLVENCY loss proxy = share-price impairment (NOT totalAssets drop, which
            # also captures withdrawals = the liquidity channel we explicitly exclude).
            sp_series = hs.get("sharePriceUsd") or []
            sp_pre = val_at(sp_series, PRE_SHOCK) or 0.0
            sp_min_post = min(
                (p["y"] for p in sp_series
                 if p.get("y") is not None and p["x"] >= PRE_SHOCK.timestamp()),
                default=sp_pre,
            )
            impair_frac = max(0.0, (sp_pre - sp_min_post) / sp_pre) if sp_pre > 0 else 0.0
            allocs = {}
            for a in (hs.get("allocation") or []):
                mk = (a.get("market") or {})
                if mk.get("marketId") in resolv_keys:
                    allocs[mk["marketId"]] = val_at(a.get("supplyAssetsUsd"), PRE_SHOCK) or 0.0
            resolv_exp = sum(allocs.values())
            if tot_pre < 1000 and resolv_exp < 1000:
                continue
            vaults_out.append({
                "address": v["address"], "name": v["name"],
                "pre_total_usd": tot_pre, "post_total_usd": tot_post,
                "totalassets_drop_usd": max(0.0, tot_pre - tot_post),   # includes withdrawals (NOT loss)
                "share_price_pre": sp_pre, "share_price_min_post": sp_min_post,
                "impairment_frac": round(impair_frac, 4),               # SOLVENCY loss fraction
                "realized_loss_usd": round(impair_frac * tot_pre),      # ground-truth solvency loss
                "pre_resolv_exposure_usd": resolv_exp,
                "alloc_by_market": allocs,
            })
        vaults_out.sort(key=lambda x: -x["realized_loss_usd"])
        print(f"\nVaults: SOLVENCY loss (share-price impairment) vs totalAssets drop "
              f"({PRE_SHOCK:%m-%d}->{POST_SHOCK:%m-%d}):")
        print(f"  {'vault':30} {'exposure':>12} {'impair%':>8} {'LOSS$':>12} {'tot.drop$':>12}")
        for v in vaults_out[:15]:
            print(f"  {v['name'][:30]:30} ${v['pre_resolv_exposure_usd']:>10,.0f} "
                  f"{v['impairment_frac']*100:>7.1f}% ${v['realized_loss_usd']:>10,.0f} "
                  f"${v['totalassets_drop_usd']:>10,.0f}")

        # ── ground truth: separate solvency (model scope) from liquidity (out of scope) ──
        IMPAIR_MIN = 0.01   # >1% share-price drop counts as a solvency victim
        solvency_victims = [
            {"name": v["name"], "address": v["address"],
             "impairment_frac": v["impairment_frac"], "loss_usd": v["realized_loss_usd"]}
            for v in vaults_out if v["impairment_frac"] >= IMPAIR_MIN
        ]
        solvency_victims.sort(key=lambda x: -x["loss_usd"])
        liquidity_only = [
            {"name": v["name"], "totalassets_drop_usd": v["totalassets_drop_usd"]}
            for v in vaults_out
            if v["impairment_frac"] < IMPAIR_MIN and v["totalassets_drop_usd"] > 100_000
        ]
        liquidity_only.sort(key=lambda x: -x["totalassets_drop_usd"])
        ground_truth = {
            "channel_note": ("Solvency loss measured by share-price impairment (model scope). "
                             "totalAssets drops with flat share price are WITHDRAWALS = liquidity "
                             "channel (out of model scope, per sim_spec 5.3)."),
            "solvency_loss_total_usd": round(sum(v["realized_loss_usd"] for v in vaults_out)),
            "solvency_victims": solvency_victims,             # = the set/ranking the model must reproduce
            "liquidity_only_drops": liquidity_only,           # must NOT be claimed as model hits
            "headline": ("USR depegged -88.6% yet curated USDC vaults took ~0 solvency loss "
                         "(over-collateralization + working liquidations). Only pure-USR vaults impaired."),
        }
        print(f"\nGROUND TRUTH: solvency loss total = ${ground_truth['solvency_loss_total_usd']:,} | "
              f"solvency victims = {len(solvency_victims)} | liquidity-only runs = {len(liquidity_only)}")

        out = {
            "ground_truth": ground_truth,
            "event": {
                "id": "resolv_usr_depeg_2026_03",
                "date": "2026-03-23",
                "pre_shock_date": PRE_SHOCK.strftime("%Y-%m-%d"),
                "post_shock_date": POST_SHOCK.strftime("%Y-%m-%d"),
                "shock_node": "USR",
                "delta": round(delta, 4),
                "usr_pre_price": usr_pre, "usr_trough_price": usr_trough,
                "price_trough": prices, "price_trajectory": traj,
                "source": "Morpho Blue API historicalPriceUsd + market/vault historicalState (data-selected event)",
            },
            "markets": markets_out,
            "vaults": vaults_out,
        }
        outpath = Path(__file__).resolve().parent.parent / "api" / "data" / "resolv_snapshot.json"
        outpath.parent.mkdir(parents=True, exist_ok=True)
        outpath.write_text(json.dumps(out, indent=2))
        print(f"\nWROTE {outpath}  ({len(markets_out)} markets, {len(vaults_out)} vaults)")


if __name__ == "__main__":
    asyncio.run(main())
