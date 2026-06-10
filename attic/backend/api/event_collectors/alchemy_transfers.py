"""
alchemy_transfers.py — fast token-transfer collection via Alchemy's enhanced
`alchemy_getAssetTransfers` API (one paginated call covers a wide block range, no
eth_getLogs 10-block chunking / 10k-log bisection).

Used by the Lido / Sky collectors: a protocol's token TRANSFERS (stETH, USDS, …) are the
cross-protocol whale signal the EOA-bridge discovery joins on. Real data, fast, reuses the
existing ALCHEMY_API_KEY — the answer for protocols whose The Graph subgraph isn't served.
"""
from __future__ import annotations

import os

import httpx

ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
_URL = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}" if ALCHEMY_KEY else ""
_MAX_PAGES = 20            # safety cap (20×1000 transfers per window)
_PAGE = 1000


def available() -> bool:
    return bool(ALCHEMY_KEY)


async def fetch_transfers(contracts: list[str], from_block: int, to_block: int) -> list[dict]:
    """All ERC-20 transfers of `contracts` in [from_block, to_block], paginated.
    Each item: {hash, blockNum(int), from, to, value(float), asset, contract}."""
    if not _URL:
        raise RuntimeError("ALCHEMY_API_KEY not set")
    out: list[dict] = []
    lc = [c.lower() for c in contracts]
    async with httpx.AsyncClient(timeout=30.0) as client:
        page_key = None
        for _ in range(_MAX_PAGES):
            params = {
                "fromBlock": hex(from_block), "toBlock": hex(to_block),
                "contractAddresses": lc, "category": ["erc20"],
                "withMetadata": False, "excludeZeroValue": True, "maxCount": hex(_PAGE),
                "order": "asc",
            }
            if page_key:
                params["pageKey"] = page_key
            r = await client.post(_URL, json={"jsonrpc": "2.0", "id": 1,
                                              "method": "alchemy_getAssetTransfers",
                                              "params": [params]})
            r.raise_for_status()
            d = r.json()
            if "error" in d:
                raise RuntimeError(str(d["error"])[:160])
            res = d.get("result") or {}
            for t in res.get("transfers", []):
                out.append({
                    "hash": t.get("hash", ""),
                    "blockNum": int(t.get("blockNum", "0x0"), 16),
                    "from": (t.get("from") or "").lower(),
                    "to": (t.get("to") or "").lower(),
                    "value": float(t.get("value") or 0.0),
                    "asset": t.get("asset"),
                    "contract": ((t.get("rawContract") or {}).get("address") or "").lower(),
                })
            page_key = res.get("pageKey")
            if not page_key:
                break
    return out
