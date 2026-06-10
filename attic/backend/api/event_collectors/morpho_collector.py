"""
Morpho Blue event collector — events.json 의 정의를 동적 엣지로.

Morpho Blue (singleton 0xBBBB...) 의 실제 이벤트를 RPC eth_getLogs 로 읽음:
  - Supply           → supply           (공급자 → Morpho Blue)
  - Borrow           → borrow           (Morpho Blue → 차입자)
  - Liquidate        → liquidation      (청산자 → 차입자, bad debt 추적)

market id (bytes32) 를 discovered_morpho.json 으로 collateral/loan 토큰에 매핑해
"어떤 자산 시장에서 일어난 활동인지" metadata 에 포함.

RPC 실패 시 mock fallback.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

import httpx

try:
    from Crypto.Hash import keccak
    _HAS_KECCAK = True
except Exception:
    _HAS_KECCAK = False

from .base import BaseCollector, DynamicEdge

logger = logging.getLogger(__name__)

ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
ETH_RPC = (
    f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
    if ALCHEMY_KEY else "https://eth.llamarpc.com"
)

MORPHO_BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
# Morpho's public GraphQL API exposes per-user transactions (Supply/Withdraw/Borrow/Repay)
# with NO API key — far faster than RPC eth_getLogs (which bisects on Morpho Blue's volume).
MORPHO_API = "https://blue-api.morpho.org/graphql"
# block→ts anchored at The Merge (exact 12s/block since), accurate to seconds for recent blocks
# (a genesis-based estimate drifts ~1yr over 25M blocks because pre-merge times weren't 12s).
_MERGE_BLOCK = 15537394
_MERGE_TS = 1663224162
_API_PAGE = 100
_API_MAX_PAGES = 25            # safety cap (2500 txns/window)
_API_TYPES = "[MarketSupply, MarketWithdraw, MarketBorrow, MarketRepay]"
_API_QUERY = """
query($tsFrom:Int!,$tsTo:Int!,$skip:Int!){
  transactions(first:%d, skip:$skip, orderBy:Timestamp, orderDirection:Desc,
    where:{chainId_in:[1], timestamp_gte:$tsFrom, timestamp_lte:$tsTo, type_in:%s}){
    items{ hash timestamp type blockNumber logIndex user{address}
      data{ __typename ... on MarketTransferTransactionData {
        assets market{ id collateralAsset{symbol} loanAsset{symbol address decimals} } } } }
    pageInfo{ count countTotal } } }
""" % (_API_PAGE, _API_TYPES)
_DISCOVERED_MORPHO = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "integration" / "output" / "discovered_morpho.json"
)


def _topic0(sig: str) -> str:
    if not _HAS_KECCAK:
        return ""
    k = keccak.new(digest_bits=256)
    k.update(sig.encode())
    return "0x" + k.hexdigest()


# Id = bytes32 (Morpho Blue 의 market id)
TOPIC_SUPPLY = _topic0("Supply(bytes32,address,address,uint256,uint256)")
TOPIC_BORROW = _topic0("Borrow(bytes32,address,address,address,uint256,uint256)")
TOPIC_LIQUIDATE = _topic0("Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)")


def _topic_to_addr(topic: str) -> str:
    return "0x" + topic[-40:]


def _load_market_map() -> dict[str, dict]:
    """discovered_morpho.json 에서 market id → {collateral, loan} 매핑 로드."""
    if not _DISCOVERED_MORPHO.exists():
        return {}
    try:
        data = json.loads(_DISCOVERED_MORPHO.read_text(encoding="utf-8"))
        out = {}
        for m in data.get("_meta", {}).get("markets", []):
            mid = (m.get("marketId") or "").lower()
            if not mid:
                continue
            out[mid] = {
                "collateral": ((m.get("collateralAsset") or {}).get("symbol")),
                "loan": ((m.get("loanAsset") or {}).get("symbol")),
                "collateral_addr": ((m.get("collateralAsset") or {}).get("address") or "").lower(),
                "loan_addr": ((m.get("loanAsset") or {}).get("address") or "").lower(),
            }
        return out
    except Exception:
        return {}


_MOCK_USERS = [
    "0x111111111111111111111111111111111111aaaa",
    "0x222222222222222222222222222222222222bbbb",
    "0x444444444444444444444444444444444444dddd",  # liquidator
]


class MorphoCollector(BaseCollector):
    protocol = "morpho"
    _MAX_LOG_RANGE = int(os.getenv("EVENT_LOG_RANGE", "200"))  # filtered logs → wide range OK (env-tunable)

    def __init__(self, mode: Optional[str] = None):
        # default = the public GraphQL API (fast, no key); rpc/mock available explicitly.
        if mode in ("api", "rpc", "mock"):
            self.mode = mode
        else:
            self.mode = "api"
        self._last_source = self.mode
        self._market_map = _load_market_map()

    def get_source(self) -> str:
        return self._last_source

    def _block_to_ts(self, block: int) -> int:
        # use a live-calibrated anchor (set in _fetch_api) for second-accurate recent mapping;
        # else fall back to the merge anchor (drifts ~days over millions of blocks).
        ab, at = getattr(self, "_anchor", (_MERGE_BLOCK, _MERGE_TS))
        return at + (block - ab) * 12

    async def _calibrate(self, client: httpx.AsyncClient) -> None:
        """Anchor block→ts on the latest real txn (block, timestamp) so the window aligns
        with the other collectors' exact block ranges (the formula drifts otherwise)."""
        q = """query{ transactions(first:1, orderBy:Timestamp, orderDirection:Desc,
               where:{chainId_in:[1]}){ items{ blockNumber timestamp } } }"""
        r = await client.post(MORPHO_API, json={"query": q})
        items = (((r.json().get("data") or {}).get("transactions") or {}).get("items")) or []
        if items:
            self._anchor = (int(items[0]["blockNumber"]), int(items[0]["timestamp"]))

    async def fetch_events(self, from_block: int, to_block: int) -> list[dict]:
        if self.mode == "mock":
            self._last_source = "mock"
            return self._mock_events(from_block, to_block)
        if self.mode == "api":
            try:
                events = await self._fetch_api(from_block, to_block)
                self._last_source = "api"
                return events
            except Exception as e:
                logger.warning(f"Morpho API fetch failed: {e}. rpc fallback.")
                # fall through to rpc
        try:
            events = await self._fetch_rpc(from_block, to_block)
            self._last_source = "rpc"
            return events
        except Exception as e:
            logger.warning(f"Morpho RPC fetch failed: {e}. mock fallback.")
            self._last_source = f"mock-fallback ({type(e).__name__})"
            return self._mock_events(from_block, to_block)

    async def _fetch_api(self, from_block: int, to_block: int) -> list[dict]:
        """Per-user txns via Morpho's GraphQL API (timestamp-filtered from the block range).
        Returns raw items tagged {'api': item}; event_to_edges builds the DynamicEdge."""
        out: list[dict] = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            await self._calibrate(client)
            ts_from, ts_to = self._block_to_ts(from_block), self._block_to_ts(to_block)
            for page in range(_API_MAX_PAGES):
                r = await client.post(MORPHO_API, json={"query": _API_QUERY,
                    "variables": {"tsFrom": ts_from, "tsTo": ts_to, "skip": page * _API_PAGE}})
                r.raise_for_status()
                d = r.json()
                if "errors" in d:
                    raise RuntimeError(str(d["errors"])[:200])
                items = (((d.get("data") or {}).get("transactions") or {}).get("items")) or []
                out.extend({"api": it} for it in items)
                if len(items) < _API_PAGE:
                    break
        return out

    async def _get_logs(self, client, topic0, lo, hi) -> list[dict]:
        if not topic0:
            return []
        try:
            r = await client.post(ETH_RPC, json={
                "jsonrpc": "2.0", "method": "eth_getLogs", "id": 1,
                "params": [{
                    "address": MORPHO_BLUE, "topics": [topic0],
                    "fromBlock": hex(lo), "toBlock": hex(hi),
                }],
            })
            r.raise_for_status()
            data = r.json()
            if "error" in data:                       # JSON-RPC error (e.g. >10k logs)
                raise ValueError(str(data["error"])[:120])
            return data.get("result", []) or []
        except (httpx.HTTPStatusError, ValueError):
            if hi - lo < 16:                          # bisect range-too-large → keep REAL logs
                return []                             # min-span guard bounds malformed queries
            mid = (lo + hi) // 2
            return (await self._get_logs(client, topic0, lo, mid)
                    + await self._get_logs(client, topic0, mid + 1, hi))

    async def _fetch_rpc(self, from_block: int, to_block: int) -> list[dict]:
        events: list[dict] = []
        async with httpx.AsyncClient(timeout=20.0) as client:
            lo = from_block
            while lo <= to_block:
                hi = min(lo + self._MAX_LOG_RANGE - 1, to_block)
                for log in await self._get_logs(client, TOPIC_SUPPLY, lo, hi):
                    events.append({"kind": "supply", "log": log})
                for log in await self._get_logs(client, TOPIC_BORROW, lo, hi):
                    events.append({"kind": "borrow", "log": log})
                for log in await self._get_logs(client, TOPIC_LIQUIDATE, lo, hi):
                    events.append({"kind": "liquidate", "log": log})
                lo = hi + 1
        return events

    def _market_meta(self, market_id: str) -> dict:
        m = self._market_map.get(market_id.lower(), {})
        return {
            "market_id": market_id,
            "collateral": m.get("collateral"),
            "loan": m.get("loan"),
        }

    # supply/repay = EOA → Morpho Blue (deposit) ; withdraw/borrow = Morpho Blue → EOA
    _API_DIR = {"MarketSupply": ("supply", True), "MarketRepay": ("repay", True),
                "MarketWithdraw": ("withdraw", False), "MarketBorrow": ("borrow", False)}

    def _api_to_edges(self, it: dict) -> list[DynamicEdge]:
        info = self._API_DIR.get(it.get("type"))
        if not info:
            return []
        etype, eoa_is_from = info
        user = ((it.get("user") or {}).get("address") or "").lower()
        if not user:
            return []
        data = it.get("data") or {}
        mk = data.get("market") or {}
        loan = mk.get("loanAsset") or {}
        collat = mk.get("collateralAsset") or {}
        assets = data.get("assets")
        dec = loan.get("decimals")
        amt_dec = (float(assets) / (10 ** dec)) if (assets is not None and dec is not None) else None
        frm, to = (user, MORPHO_BLUE) if eoa_is_from else (MORPHO_BLUE, user)
        return [DynamicEdge(
            edge_id=f"morpho:{etype}:{it.get('hash','')}:{it.get('logIndex',0)}",
            edge_type=etype, from_address=frm, to_address=to,
            asset=(loan.get("address") or loan.get("symbol")),
            amount_raw=str(assets) if assets is not None else None, amount_decimal=amt_dec,
            block_number=int(it.get("blockNumber") or 0), tx_hash=it.get("hash", ""),
            log_index=int(it.get("logIndex") or 0), timestamp=int(it.get("timestamp") or 0),
            protocol="morpho", market_id=mk.get("id"),
            metadata={"event": it.get("type"), "collateral": collat.get("symbol"),
                      "loan": loan.get("symbol"), "source": "morpho_api"},
        )]

    def event_to_edges(self, raw_event: dict) -> list[DynamicEdge]:
        if "api" in raw_event:
            return self._api_to_edges(raw_event["api"])
        kind = raw_event.get("kind")
        if "log" not in raw_event:
            return self._mock_to_edges(raw_event)

        log = raw_event["log"]
        topics = log.get("topics", [])
        data = log.get("data", "0x")
        block = int(log.get("blockNumber", "0x0"), 16)
        tx = log.get("transactionHash", "")
        li = int(log.get("logIndex", "0x0"), 16)

        try:
            if kind == "supply" and len(topics) >= 4:
                # Supply(id indexed, caller indexed, onBehalf indexed, assets, shares)
                market_id = topics[1]
                on_behalf = _topic_to_addr(topics[3])
                assets = int(data[2:66], 16) if len(data) >= 66 else 0
                mm = self._market_meta(market_id)
                return [DynamicEdge(
                    edge_id=f"morpho:supply:{tx}:{li}",
                    edge_type="supply",
                    from_address=on_behalf, to_address=MORPHO_BLUE,
                    asset=mm.get("loan"), amount_raw=str(assets),
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="morpho", market_id=market_id,
                    metadata={"event": "Supply", **mm},
                )]

            if kind == "borrow" and len(topics) >= 4:
                # Borrow(id indexed, caller, onBehalf indexed, receiver indexed, assets, shares)
                market_id = topics[1]
                on_behalf = _topic_to_addr(topics[2])
                receiver = _topic_to_addr(topics[3])
                # data = caller(32) + assets(32) + shares(32)
                assets = int(data[2 + 64:2 + 128], 16) if len(data) >= 2 + 128 else 0
                mm = self._market_meta(market_id)
                return [DynamicEdge(
                    edge_id=f"morpho:borrow:{tx}:{li}",
                    edge_type="borrow",
                    from_address=MORPHO_BLUE, to_address=receiver,
                    asset=mm.get("loan"), amount_raw=str(assets),
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="morpho", market_id=market_id,
                    metadata={"event": "Borrow", "on_behalf": on_behalf, **mm},
                )]

            if kind == "liquidate" and len(topics) >= 4:
                # Liquidate(id indexed, caller indexed, borrower indexed, repaidAssets, ...,
                #           seizedAssets, badDebtAssets, badDebtShares)
                market_id = topics[1]
                liquidator = _topic_to_addr(topics[2])
                borrower = _topic_to_addr(topics[3])
                # data: repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares
                seized = int(data[2 + 128:2 + 192], 16) if len(data) >= 2 + 192 else 0
                bad_debt = int(data[2 + 192:2 + 256], 16) if len(data) >= 2 + 256 else 0
                mm = self._market_meta(market_id)
                return [DynamicEdge(
                    edge_id=f"morpho:liquidate:{tx}:{li}",
                    edge_type="liquidation",
                    from_address=liquidator, to_address=borrower,
                    asset=mm.get("collateral"), amount_raw=str(seized),
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="morpho", market_id=market_id,
                    metadata={
                        "event": "Liquidate", "bad_debt": str(bad_debt),
                        "has_bad_debt": bad_debt > 0, **mm,
                    },
                )]
        except Exception as e:
            logger.debug(f"morpho decode fail: {e}")
            return []
        return []

    # ── mock ──────────────────────────────────────────────────────
    def _mock_events(self, from_block: int, to_block: int) -> list[dict]:
        import random
        rnd = random.Random(from_block + 7)
        out = []
        for i in range(5):
            kind = rnd.choice(["supply", "borrow", "liquidate"])
            out.append({
                "mock": True, "kind": kind,
                "user": rnd.choice(_MOCK_USERS),
                "amount": rnd.randint(1000, 50000) * 10**6,  # USDC-ish
                "block": from_block + i, "tx": f"0xmockmorpho{from_block:08x}{i:02x}", "li": i,
            })
        return out

    def _mock_to_edges(self, ev: dict) -> list[DynamicEdge]:
        kind = ev["kind"]; user = ev["user"]; amt = ev["amount"]
        block = ev["block"]; tx = ev["tx"]; li = ev["li"]
        etype = {"supply": "supply", "borrow": "borrow", "liquidate": "liquidation"}[kind]
        frm, to = (user, MORPHO_BLUE) if kind == "supply" else (MORPHO_BLUE, user)
        return [DynamicEdge(
            edge_id=f"morpho:mock:{kind}:{tx}:{li}",
            edge_type=etype, from_address=frm, to_address=to,
            amount_raw=str(amt), block_number=block, tx_hash=tx, log_index=li,
            protocol="morpho", metadata={"event": kind, "mock": True},
        )]
