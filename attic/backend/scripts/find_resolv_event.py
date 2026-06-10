"""
Phase 0 (event finder) — data-first incident selection.

Per phase1_data_gate lesson: let the data pick the event, not the news headline.
Pulls USR/wstUSR/RLP price history + the material markets' collateral/borrow over a
wide window, and surfaces the sharpest moves so we can lock the shock date + magnitude.
"""
import asyncio
import datetime as dt
import json
import httpx

API = "https://blue-api.morpho.org/graphql"
USR = "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110"
WSTUSR = "0x1202f5c7b4b9e47a1a484e8b270be34dbbc75055"
RLP = "0x4956b52ae2ff65d74ca2d61207523288e4528f96"

START = int(dt.datetime(2025, 10, 1).timestamp())
END = int(dt.datetime(2026, 5, 29).timestamp())

# Material markets identified in probe_resolv (marketId -> label)
MARKETS = {
    "0xe1b65304edd8d8d1c3d6e1c5d6a5b3c": None,  # placeholder; filled dynamically below
}


async def gql(client, query, variables=None):
    r = await client.post(API, json={"query": query, "variables": variables or {}})
    d = r.json()
    if "errors" in d:
        print("ERR", json.dumps(d["errors"])[:300]); return None
    return d.get("data")


Q_PRICE = """
query P($addr: String!, $start: Int!, $end: Int!) {
  assetByAddress(address: $addr, chainId: 1) {
    symbol
    historicalPriceUsd(options: {startTimestamp: $start, endTimestamp: $end, interval: DAY}) { x y }
  }
}
"""

Q_MKT = """
query MH($id: String!, $start: Int!, $end: Int!) {
  marketById(marketId: $id, chainId: 1) {
    collateralAsset { symbol } loanAsset { symbol }
    historicalState {
      collateralAssetsUsd(options: {startTimestamp: $start, endTimestamp: $end, interval: DAY}) { x y }
      borrowAssetsUsd(options: {startTimestamp: $start, endTimestamp: $end, interval: DAY}) { x y }
    }
  }
}
"""

Q_MARKETS = """
query M($first: Int!) {
  markets(first: $first, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: {chainId_in: [1]}) {
    items { marketId collateralAsset { address symbol } loanAsset { symbol } }
  }
}
"""

RESOLV = {USR, WSTUSR, RLP}


def sharpest_drop(series):
    """Return (date, from, to, pct) of the largest single-day USD drop."""
    pts = [(p["x"], p["y"]) for p in series if p.get("y") is not None]
    worst = None
    for (t0, y0), (t1, y1) in zip(pts, pts[1:]):
        if y0 and y0 > 1000:
            d = (y1 - y0) / y0
            if worst is None or d < worst[3]:
                worst = (dt.datetime.fromtimestamp(t1).strftime("%Y-%m-%d"), y0, y1, d)
    return worst


def price_trough(series):
    pts = [(p["x"], p["y"]) for p in series if p.get("y") is not None]
    if not pts:
        return None
    tmin = min(pts, key=lambda p: p[1])
    return dt.datetime.fromtimestamp(tmin[0]).strftime("%Y-%m-%d"), tmin[1]


async def main():
    async with httpx.AsyncClient(timeout=60.0) as client:
        print("=== PRICE history (depeg detection) ===")
        for addr, nm in [(USR, "USR"), (WSTUSR, "wstUSR"), (RLP, "RLP")]:
            d = await gql(client, Q_PRICE, {"addr": addr, "start": START, "end": END})
            a = (d or {}).get("assetByAddress") or {}
            ser = a.get("historicalPriceUsd") or []
            tr = price_trough(ser)
            if tr:
                print(f"  {a.get('symbol') or nm:8} {len(ser)}pts  trough=${tr[1]:.4f} @ {tr[0]}  last=${ser[-1]['y']:.4f}")
            else:
                print(f"  {nm:8} no price series")

        print("\n=== material Resolv markets: sharpest single-day collateral drop ===")
        md = await gql(client, Q_MARKETS, {"first": 1000})
        items = (md or {}).get("markets", {}).get("items", [])
        resolv = [m for m in items if ((m.get("collateralAsset") or {}).get("address") or "").lower() in RESOLV]
        for m in resolv:
            hd = await gql(client, Q_MKT, {"id": m["marketId"], "start": START, "end": END})
            mh = (hd or {}).get("marketById")
            if not mh:
                continue
            hs = mh["historicalState"]
            col = hs.get("collateralAssetsUsd") or []
            ys = [p["y"] for p in col if p.get("y")]
            if not ys or max(ys) < 1_000_000:   # only material markets (peak > $1M)
                continue
            sym = f"{(mh.get('collateralAsset') or {}).get('symbol')}/{(mh.get('loanAsset') or {}).get('symbol')}"
            drop = sharpest_drop(col)
            peak = max(ys)
            print(f"  {sym:14} {m['marketId'][:12]}.. peak=${peak:,.0f}")
            if drop:
                print(f"      worst day: {drop[0]}  ${drop[1]:,.0f} -> ${drop[2]:,.0f}  ({drop[3]*100:+.1f}%)")
            # print the daily series compactly around the trough month for inspection
            tail = [(dt.datetime.fromtimestamp(p['x']).strftime('%m-%d'), int(p['y'])) for p in col if p.get('y') is not None]
            # show every 5th point to keep it short
            sampled = tail[::5]
            print("      series(5d):", " ".join(f"{d}:{v//1000}k" for d, v in sampled))


if __name__ == "__main__":
    asyncio.run(main())
