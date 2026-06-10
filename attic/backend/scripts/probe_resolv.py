"""
Phase 0 probe — Resolv (USR) incident data availability on Morpho Blue API.

Confirmed schema (introspected):
  markets.items.marketId / state.{supply,collateral,borrow}AssetsUsd
  marketById(marketId, chainId).historicalState.collateralAssetsUsd(options) -> [{x,y}]
  vaultByAddress(address, chainId).historicalState.allocation[].supplyAssetsUsd(options) -> [{x,y}]

Run:  python3 scripts/probe_resolv.py
"""
import asyncio
import json
import datetime as dt
import httpx

MORPHO_API = "https://blue-api.morpho.org/graphql"

USR = "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110"
WSTUSR = "0x1202f5c7b4b9e47a1a484e8b270be34dbbc75055"
RLP = "0x4956b52ae2ff65d74ca2d61207523288e4528f96"
RESOLV_COLLATERALS = {USR, WSTUSR, RLP}

# Wide window around the referenced 2026-03 Resolv incident.
START = int(dt.datetime(2026, 2, 1).timestamp())
END = int(dt.datetime(2026, 4, 30).timestamp())


async def gql(client, query, variables=None):
    r = await client.post(MORPHO_API, json={"query": query, "variables": variables or {}})
    d = r.json()
    if "errors" in d:
        print("  GraphQL errors:", json.dumps(d["errors"])[:400])
        return None
    return d.get("data")


Q_MARKETS = """
query M($first: Int!) {
  markets(first: $first, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: {chainId_in: [1]}) {
    items {
      marketId lltv
      collateralAsset { address symbol }
      loanAsset { address symbol }
      state { supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd }
    }
  }
}
"""

Q_VAULTS = """
query V($first: Int!) {
  vaults(first: $first, orderBy: TotalAssetsUsd, orderDirection: Desc, where: {chainId_in: [1]}) {
    items {
      address name
      state {
        totalAssetsUsd
        allocation { supplyAssetsUsd market { marketId collateralAsset { symbol } loanAsset { symbol } } }
      }
    }
  }
}
"""

Q_MARKET_HIST = """
query MH($id: String!, $start: Int!, $end: Int!) {
  marketById(marketId: $id, chainId: 1) {
    marketId
    collateralAsset { symbol }
    loanAsset { symbol }
    historicalState {
      collateralAssetsUsd(options: {startTimestamp: $start, endTimestamp: $end, interval: DAY}) { x y }
      supplyAssetsUsd(options: {startTimestamp: $start, endTimestamp: $end, interval: DAY}) { x y }
      borrowAssetsUsd(options: {startTimestamp: $start, endTimestamp: $end, interval: DAY}) { x y }
    }
  }
}
"""

Q_VAULT_HIST = """
query VH($addr: String!, $start: Int!, $end: Int!) {
  vaultByAddress(address: $addr, chainId: 1) {
    address name
    historicalState {
      totalAssetsUsd(options: {startTimestamp: $start, endTimestamp: $end, interval: DAY}) { x y }
      allocation {
        market { marketId collateralAsset { symbol } loanAsset { symbol } }
        supplyAssetsUsd(options: {startTimestamp: $start, endTimestamp: $end, interval: DAY}) { x y }
      }
    }
  }
}
"""


def _minmax(series):
    ys = [p["y"] for p in series if p.get("y") is not None]
    if not ys:
        return "empty"
    peak = max(ys)
    peak_i = ys.index(peak)
    peak_t = dt.datetime.fromtimestamp(series[peak_i]["x"]).strftime("%Y-%m-%d")
    return f"{len(series)}pts min=${min(ys):,.0f} max=${peak:,.0f}@{peak_t} last=${ys[-1]:,.0f}"


async def main():
    async with httpx.AsyncClient(timeout=60.0) as client:
        print("=" * 72)
        print("STEP 1: Morpho markets with USR/wstUSR/RLP collateral (current)")
        print("=" * 72)
        mdata = await gql(client, Q_MARKETS, {"first": 1000})
        markets = (mdata or {}).get("markets", {}).get("items", [])
        resolv_markets = [m for m in markets
                          if ((m.get("collateralAsset") or {}).get("address") or "").lower() in RESOLV_COLLATERALS]
        print(f"total markets scanned: {len(markets)} | Resolv-collateral markets: {len(resolv_markets)}")
        for m in resolv_markets:
            st = m.get("state") or {}
            print(f"  {m['marketId'][:14]}.. {(m.get('collateralAsset') or {}).get('symbol')}/"
                  f"{(m.get('loanAsset') or {}).get('symbol')}  now supply=${(st.get('supplyAssetsUsd') or 0):,.0f}")
        resolv_keys = {m["marketId"] for m in resolv_markets}

        print("\n" + "=" * 72)
        print("STEP 2: vaults currently allocating into Resolv markets")
        print("=" * 72)
        vdata = await gql(client, Q_VAULTS, {"first": 1000})
        vaults = (vdata or {}).get("vaults", {}).get("items", [])
        vaults_hit = []
        for v in vaults:
            allocs = ((v.get("state") or {}).get("allocation") or [])
            hit = [a for a in allocs if (a.get("market") or {}).get("marketId") in resolv_keys]
            if hit:
                exp = sum((a.get("supplyAssetsUsd") or 0) for a in hit)
                vaults_hit.append((v, exp))
        vaults_hit.sort(key=lambda x: -x[1])
        print(f"vaults scanned: {len(vaults)} | allocating into Resolv markets: {len(vaults_hit)}")
        for v, exp in vaults_hit:
            tot = (v.get("state") or {}).get("totalAssetsUsd") or 0
            print(f"  {v['name'][:34]:34} {v['address'][:10]}.. total=${tot:,.0f} resolv_exposure=${exp:,.0f}")

        print("\n" + "=" * 72)
        print("STEP 3: market historicalState time series (peak finder)")
        print("=" * 72)
        for m in resolv_markets:
            hd = await gql(client, Q_MARKET_HIST, {"id": m["marketId"], "start": START, "end": END})
            mh = (hd or {}).get("marketById")
            if not mh or not mh.get("historicalState"):
                print(f"  {m['marketId'][:14]}.. NO HISTORY")
                continue
            hs = mh["historicalState"]
            sym = f"{(mh.get('collateralAsset') or {}).get('symbol')}/{(mh.get('loanAsset') or {}).get('symbol')}"
            print(f"  {m['marketId'][:14]}.. {sym}")
            print(f"     collateralUsd: {_minmax(hs.get('collateralAssetsUsd') or [])}")
            print(f"     borrowUsd:     {_minmax(hs.get('borrowAssetsUsd') or [])}")

        print("\n" + "=" * 72)
        print("STEP 4 [CRITICAL]: vault historical ALLOCATION time series")
        print("=" * 72)
        if vaults_hit:
            vaddr = vaults_hit[0][0]["address"]
            vname = vaults_hit[0][0]["name"]
            vh = await gql(client, Q_VAULT_HIST, {"addr": vaddr, "start": START, "end": END})
            vobj = (vh or {}).get("vaultByAddress")
            if vobj and vobj.get("historicalState"):
                hs = vobj["historicalState"]
                print(f"  vault: {vname} ({vaddr[:10]}..)")
                print(f"  totalAssetsUsd: {_minmax(hs.get('totalAssetsUsd') or [])}")
                allocs = hs.get("allocation") or []
                print(f"  allocation entries (markets): {len(allocs)}")
                for a in allocs:
                    mk = (a.get("market") or {})
                    if mk.get("marketId") in resolv_keys:
                        sym = f"{(mk.get('collateralAsset') or {}).get('symbol')}/{(mk.get('loanAsset') or {}).get('symbol')}"
                        print(f"    [RESOLV] {sym}: {_minmax(a.get('supplyAssetsUsd') or [])}")
                print("  ==> vault historical allocation time series: AVAILABLE")
            else:
                print("  vault historicalState EMPTY <-- RISK MATERIALIZED")
        else:
            print("  (no resolv vault to probe)")


if __name__ == "__main__":
    asyncio.run(main())
