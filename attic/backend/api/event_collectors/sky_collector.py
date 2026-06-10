"""
Sky (구 MakerDAO) event collector — events.jsonc 정의를 동적 엣지로.

RPC eth_getLogs 로 Sky 핵심 컨트랙트의 실제 이벤트 수집:
  - LitePSM.SellGem/BuyGem      → psm_swap      (USDC ↔ USDS)
  - DaiUsds.DaiToUsds/UsdsToDai → convert       (DAI ↔ USDS)
  - sUSDS/stUSDS Deposit/Withdraw → savings_flow
  - D3MHub.Wind/Unwind          → d3m_capital_flow (★ cross-protocol)

RPC 실패 시 mock fallback. Alchemy 무료 티어 10블록 chunk.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

try:
    from Crypto.Hash import keccak
    _HAS_KECCAK = True
except Exception:
    _HAS_KECCAK = False

from .base import BaseCollector, DynamicEdge
from . import alchemy_transfers as _alc

logger = logging.getLogger(__name__)

ALCHEMY_KEY = os.getenv("ALCHEMY_API_KEY", "")
ETH_RPC = (
    f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
    if ALCHEMY_KEY else "https://eth.llamarpc.com"
)

# Sky 컨트랙트 (nodes.jsonc 기준, lowercase)
LITEPSM = "0xf6e72db5454dd049d0788e411b06cfaf16853042"
DAIUSDS = "0x3225737a9bbb6473cb4a45b7244aca2befdb276a"
SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd"
STUSDS = "0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9"
D3M_HUB = "0x12f36cdea3a28c35ac8c6cc71d9265c17c74a27f"
USDS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
DAI = "0x6b175474e89094c44da98b954eedeac495271d0f"


def _t(sig: str) -> str:
    if not _HAS_KECCAK:
        return ""
    k = keccak.new(digest_bits=256)
    k.update(sig.encode())
    return "0x" + k.hexdigest()


TOPIC_SELLGEM = _t("SellGem(address,uint256,uint256)")
TOPIC_BUYGEM = _t("BuyGem(address,uint256,uint256)")
TOPIC_DAI2USDS = _t("DaiToUsds(address,address,uint256)")
TOPIC_USDS2DAI = _t("UsdsToDai(address,address,uint256)")
TOPIC_DEPOSIT = _t("Deposit(address,address,uint256,uint256)")
TOPIC_WITHDRAW = _t("Withdraw(address,address,address,uint256,uint256)")
TOPIC_WIND = _t("Wind(bytes32,uint256)")
TOPIC_UNWIND = _t("Unwind(bytes32,uint256)")


def _addr(topic: str) -> str:
    return "0x" + topic[-40:].lower()


_MOCK_USERS = [
    "0x111111111111111111111111111111111111aaaa",
    "0x222222222222222222222222222222222222bbbb",
]


class SkyCollector(BaseCollector):
    protocol = "sky"
    _MAX_LOG_RANGE = int(os.getenv("EVENT_LOG_RANGE", "200"))  # filtered logs → wide range OK (env-tunable)

    _MIN_TRANSFER = float(os.getenv("SKY_MIN_TRANSFER", "10000"))  # USDS/sUSDS units (~$ stable)

    def __init__(self, mode: Optional[str] = None):
        # default = fast Alchemy getAssetTransfers (USDS/sUSDS); rpc/mock available explicitly.
        if mode in ("transfers", "rpc", "mock"):
            self.mode = mode
        elif _alc.available():
            self.mode = "transfers"
        else:
            self.mode = "rpc" if ALCHEMY_KEY and _HAS_KECCAK else "mock"
        self._last_source = self.mode

    def get_source(self) -> str:
        return self._last_source

    async def fetch_events(self, from_block: int, to_block: int) -> list[dict]:
        if self.mode == "mock":
            self._last_source = "mock"
            return self._mock_events(from_block, to_block)
        if self.mode == "transfers":
            try:
                tr = await _alc.fetch_transfers([USDS, SUSDS], from_block, to_block)
                self._last_source = "transfers"
                return [{"transfer": t} for t in tr if t["value"] >= self._MIN_TRANSFER]
            except Exception as e:
                logger.warning(f"Sky transfers fetch failed: {e}. rpc fallback.")
        try:
            ev = await self._fetch_rpc(from_block, to_block)
            self._last_source = "rpc"
            return ev
        except Exception as e:
            logger.warning(f"Sky RPC fetch failed: {e}. mock fallback.")
            self._last_source = f"mock-fallback ({type(e).__name__})"
            return self._mock_events(from_block, to_block)

    def _transfer_to_edges(self, t: dict) -> list[DynamicEdge]:
        frm, to = t["from"], t["to"]
        if not frm or not to:
            return []
        return [DynamicEdge(
            edge_id=f"sky:transfer:{t['hash']}:{frm[:8]}",
            edge_type="usds_transfer", from_address=frm, to_address=to,
            asset=(t.get("contract") or USDS), amount_raw=None, amount_decimal=t.get("value"),
            block_number=t.get("blockNum", 0), tx_hash=t.get("hash", ""), log_index=0,
            timestamp=0, protocol="sky", market_id=None,
            metadata={"event": "Transfer", "asset_sym": t.get("asset"), "source": "alchemy_transfers"},
        )]

    async def _get_logs(self, client, address, topic0, lo, hi) -> list[dict]:
        if not topic0:
            return []
        try:
            r = await client.post(ETH_RPC, json={
                "jsonrpc": "2.0", "method": "eth_getLogs", "id": 1,
                "params": [{"address": address, "topics": [topic0],
                            "fromBlock": hex(lo), "toBlock": hex(hi)}],
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
            return (await self._get_logs(client, address, topic0, lo, mid)
                    + await self._get_logs(client, address, topic0, mid + 1, hi))

    async def _fetch_rpc(self, from_block: int, to_block: int) -> list[dict]:
        events: list[dict] = []
        # (address, topic0, kind) 조합
        queries = [
            (LITEPSM, TOPIC_SELLGEM, "sellgem"),
            (LITEPSM, TOPIC_BUYGEM, "buygem"),
            (DAIUSDS, TOPIC_DAI2USDS, "dai2usds"),
            (DAIUSDS, TOPIC_USDS2DAI, "usds2dai"),
            (SUSDS, TOPIC_DEPOSIT, "susds_deposit"),
            (SUSDS, TOPIC_WITHDRAW, "susds_withdraw"),
            (STUSDS, TOPIC_DEPOSIT, "stusds_deposit"),
            (STUSDS, TOPIC_WITHDRAW, "stusds_withdraw"),
            (D3M_HUB, TOPIC_WIND, "wind"),
            (D3M_HUB, TOPIC_UNWIND, "unwind"),
        ]
        async with httpx.AsyncClient(timeout=20.0) as client:
            lo = from_block
            while lo <= to_block:
                hi = min(lo + self._MAX_LOG_RANGE - 1, to_block)
                for address, topic0, kind in queries:
                    for log in await self._get_logs(client, address, topic0, lo, hi):
                        events.append({"kind": kind, "log": log})
                lo = hi + 1
        return events

    def event_to_edges(self, raw_event: dict) -> list[DynamicEdge]:
        if "transfer" in raw_event:
            return self._transfer_to_edges(raw_event["transfer"])
        kind = raw_event.get("kind")
        if "log" not in raw_event:
            return self._mock_to_edges(raw_event)
        log = raw_event["log"]
        topics = log.get("topics", [])
        data = log.get("data", "0x")
        block = int(log.get("blockNumber", "0x0"), 16)
        tx = log.get("transactionHash", "")
        li = int(log.get("logIndex", "0x0"), 16)

        def d(i):  # data word i (uint)
            s = 2 + i * 64
            return int(data[s:s + 64], 16) if len(data) >= s + 64 else 0

        try:
            if kind in ("sellgem", "buygem") and len(topics) >= 2:
                owner = _addr(topics[1])
                value = d(0)
                fwd = kind == "sellgem"  # sell gem = USDC→USDS
                return [DynamicEdge(
                    edge_id=f"sky:psm:{kind}:{tx}:{li}",
                    edge_type="psm_swap",
                    from_address=owner if fwd else LITEPSM,
                    to_address=LITEPSM if fwd else owner,
                    asset=USDC, amount_raw=str(value),
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="sky",
                    metadata={"event": "SellGem" if fwd else "BuyGem", "direction": "USDC→USDS" if fwd else "USDS→USDC"},
                )]

            if kind in ("dai2usds", "usds2dai") and len(topics) >= 3:
                usr = _addr(topics[2])
                wad = d(0)
                fwd = kind == "dai2usds"
                return [DynamicEdge(
                    edge_id=f"sky:conv:{kind}:{tx}:{li}",
                    edge_type="mint_wrapper",
                    from_address=usr, to_address=DAIUSDS,
                    asset=DAI if fwd else USDS, amount_raw=str(wad),
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="sky",
                    metadata={"event": "DaiToUsds" if fwd else "UsdsToDai"},
                )]

            if kind in ("susds_deposit", "stusds_deposit") and len(topics) >= 3:
                owner = _addr(topics[2])
                assets = d(0)
                module = SUSDS if "susds" in kind and "st" not in kind else STUSDS
                return [DynamicEdge(
                    edge_id=f"sky:savings:{kind}:{tx}:{li}",
                    edge_type="supply",
                    from_address=owner, to_address=module,
                    asset=USDS, amount_raw=str(assets),
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="sky",
                    metadata={"event": "Deposit", "module": "sUSDS" if module == SUSDS else "stUSDS"},
                )]

            if kind in ("susds_withdraw", "stusds_withdraw") and len(topics) >= 4:
                owner = _addr(topics[3])
                assets = d(0)
                module = SUSDS if kind == "susds_withdraw" else STUSDS
                return [DynamicEdge(
                    edge_id=f"sky:savings:{kind}:{tx}:{li}",
                    edge_type="withdraw",
                    from_address=module, to_address=owner,
                    asset=USDS, amount_raw=str(assets),
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="sky",
                    metadata={"event": "Withdraw", "module": "sUSDS" if module == SUSDS else "stUSDS"},
                )]

            if kind in ("wind", "unwind") and len(topics) >= 2:
                amt = d(0)
                fwd = kind == "wind"
                return [DynamicEdge(
                    edge_id=f"sky:d3m:{kind}:{tx}:{li}",
                    edge_type="vault_allocation",
                    from_address=D3M_HUB if fwd else "external",
                    to_address="external" if fwd else D3M_HUB,
                    asset=USDS, amount_raw=str(amt),
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="sky",
                    metadata={"event": "Wind" if fwd else "Unwind", "cross_protocol": True, "ilk": topics[1]},
                )]
        except Exception as e:
            logger.debug(f"sky decode fail: {e}")
            return []
        return []

    # ── mock ──
    def _mock_events(self, from_block: int, to_block: int) -> list[dict]:
        import random
        rnd = random.Random(from_block + 11)
        out = []
        for i in range(5):
            kind = rnd.choice(["sellgem", "dai2usds", "susds_deposit", "wind"])
            out.append({"mock": True, "kind": kind, "user": rnd.choice(_MOCK_USERS),
                        "amount": rnd.randint(1000, 100000) * 10**18,
                        "block": from_block + i, "tx": f"0xmocksky{from_block:08x}{i:02x}", "li": i})
        return out

    def _mock_to_edges(self, ev: dict) -> list[DynamicEdge]:
        kind = ev["kind"]; user = ev["user"]; amt = ev["amount"]
        block = ev["block"]; tx = ev["tx"]; li = ev["li"]
        m = {
            "sellgem": ("psm_swap", user, LITEPSM, USDC),
            "dai2usds": ("mint_wrapper", user, DAIUSDS, DAI),
            "susds_deposit": ("supply", user, SUSDS, USDS),
            "wind": ("vault_allocation", D3M_HUB, "external", USDS),
        }[kind]
        etype, frm, to, asset = m
        return [DynamicEdge(
            edge_id=f"sky:mock:{kind}:{tx}:{li}", edge_type=etype,
            from_address=frm, to_address=to, asset=asset, amount_raw=str(amt),
            block_number=block, tx_hash=tx, log_index=li, protocol="sky",
            metadata={"event": kind, "mock": True})]
