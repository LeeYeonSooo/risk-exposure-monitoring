"""
Independent cross-check of the Resolv backtest claims — does NOT read our snapshot
or our pipeline. Re-queries the raw Morpho API so you can trust the data, not me.

Run: python3 scripts/verify_resolv.py
Then cross-check the same facts on external sources (printed at the end).
"""
import datetime as dt
import httpx

API = "https://blue-api.morpho.org/graphql"
USR = "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110"


def gql(q, v=None):
    return httpx.post(API, json={"query": q, "variables": v or {}}, timeout=40).json()["data"]


def at(series, target):
    ts = target.timestamp()
    best = None
    for p in series or []:
        if p.get("y") is not None and p["x"] <= ts and (best is None or p["x"] > best["x"]):
            best = p
    return best["y"] if best else None


print("=" * 70)
print("CHECK 1 — Did USR actually depeg on 2026-03-23? (raw price API)")
print("=" * 70)
d = gql("""query($a:String!,$s:Int!,$e:Int!){ assetByAddress(address:$a,chainId:1){
  historicalPriceUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y} } }""",
        {"a": USR, "s": int(dt.datetime(2026, 3, 20).timestamp()), "e": int(dt.datetime(2026, 3, 27).timestamp())})
for p in d["assetByAddress"]["historicalPriceUsd"]:
    if p.get("y") is not None:
        print(f"  {dt.datetime.fromtimestamp(p['x']):%Y-%m-%d}  USR = ${p['y']:.4f}")

print("\n" + "=" * 70)
print("CHECK 2 — Was RLP/USDC over-collateralized? (can bad debt even happen?)")
print("=" * 70)
# find the RLP/USDC market
mk = gql("""query{ markets(first:1000,where:{chainId_in:[1]}){ items{ marketId
  collateralAsset{symbol address} loanAsset{symbol} } } }""")
rlp_usdc = next(m for m in mk["markets"]["items"]
                if (m["collateralAsset"] or {}).get("symbol") == "RLP"
                and (m["loanAsset"] or {}).get("symbol") == "USDC")
h = gql("""query($id:String!,$s:Int!,$e:Int!){ marketById(marketId:$id,chainId:1){
  historicalState{
    collateralAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
    borrowAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y} } } }""",
        {"id": rlp_usdc["marketId"], "s": int(dt.datetime(2026, 3, 15).timestamp()),
         "e": int(dt.datetime(2026, 4, 10).timestamp())})
hs = h["marketById"]["historicalState"]
pre = dt.datetime(2026, 3, 22)
col = at(hs["collateralAssetsUsd"], pre)
bor = at(hs["borrowAssetsUsd"], pre)
print(f"  RLP/USDC @ 2026-03-22:  collateral=${col:,.0f}   borrow=${bor:,.0f}")
print(f"  collateralization ratio = {col/bor:.1f}x")
print(f"  Even if RLP loses 68%: remaining collateral = ${col*0.32:,.0f}")
print(f"  vs borrow ${bor:,.0f}  ->  bad debt possible? {'YES' if col*0.32 < bor else 'NO (suppliers safe)'}")

print("\n" + "=" * 70)
print("CHECK 3 — Victim vs non-victim: share price (loss) vs totalAssets (withdrawal)")
print("=" * 70)
for addr, name in [("0x5085Dd6Fb585e6E2A6BE9Cd2A9C5e2bD0e0a0a", "Apostro Resolv USR (claimed victim)")]:
    pass
# fetch by name search instead — pull a few vaults and show share-price vs totalAssets
vd = gql("""query{ vaults(first:1000,orderBy:TotalAssetsUsd,orderDirection:Desc,where:{chainId_in:[1]}){
  items{ address name } } }""")
targets = {"Apostro Resolv USR": "claimed solvency VICTIM",
           "Clearstar Yield USDC": "claimed WITHDRAWAL (not loss)"}
for v in vd["vaults"]["items"]:
    if v["name"] in targets:
        vh = gql("""query($a:String!,$s:Int!,$e:Int!){ vaultByAddress(address:$a,chainId:1){
          historicalState{
            totalAssetsUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y}
            sharePriceUsd(options:{startTimestamp:$s,endTimestamp:$e,interval:DAY}){x y} } } }""",
                 {"a": v["address"], "s": int(dt.datetime(2026, 3, 20).timestamp()),
                  "e": int(dt.datetime(2026, 4, 10).timestamp())})
        s = vh["vaultByAddress"]["historicalState"]
        sp_pre = at(s["sharePriceUsd"], pre)
        sp_min = min((p["y"] for p in s["sharePriceUsd"] if p.get("y") and p["x"] >= pre.timestamp()), default=sp_pre)
        ta_pre = at(s["totalAssetsUsd"], pre)
        ta_post = at(s["totalAssetsUsd"], dt.datetime(2026, 4, 10))
        print(f"  {v['name']} — {targets[v['name']]}")
        print(f"     share price: ${sp_pre:.4f} -> ${sp_min:.4f}  ({(sp_min/sp_pre-1)*100:+.1f}%)  <- SOLVENCY loss")
        print(f"     totalAssets: ${ta_pre:,.0f} -> ${ta_post:,.0f}  ({(ta_post/ta_pre-1)*100:+.1f}%)  <- includes withdrawals")

print("\n" + "=" * 70)
print("EXTERNAL cross-checks you can do WITHOUT this code:")
print("=" * 70)
print("  - USR price 2026-03: coingecko.com/en/coins/resolv-usr  (or defillama)")
print("  - RLP/USDC market:   app.morpho.org  -> search the market, see collateral vs borrow")
print("  - Apostro Resolv USR vault: app.morpho.org -> vault -> share price chart")
