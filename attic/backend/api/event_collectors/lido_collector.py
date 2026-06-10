"""
Lido event collector — events.json 의 정의를 실제 동적 엣지로 변환.

사용자 비전: "이벤트 모니터링 = 동적 관계를 노드/엣지로 표현."

본 collector 는 Lido 컨트랙트의 실제 on-chain 이벤트를 RPC eth_getLogs 로 읽어
동적 엣지를 만든다 (event_store SQLite 적재 → focus/search 에서 활용):

  - Submitted          → deposited_to_lido   (예치자 → Lido stETH)
  - WithdrawalRequested→ requested_withdrawal (출금 요청자 → owner)
  - TransferShares     → stETH_moved         (대형 stETH 이동: 프로토콜 간 흐름)

RPC 실패 시 mock fallback (Aave collector 와 동일 패턴).

modules/lido/events.json 의 edge_definitions 와 1:1 대응 — 그 schema 가 진실 공급원.
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

# Lido 컨트랙트
STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84"
WSTETH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"
WITHDRAWAL_QUEUE = "0x889edc2edab5f40e902b864ad4d7ade8e412f9b1"

# 대형 transfer 만 동적 엣지로 (dust 제외) — 100 stETH 이상
MIN_TRANSFER_SHARES = 100 * 10**18


def _topic0(signature: str) -> str:
    """이벤트 시그니처 → keccak256 topic0 hash."""
    if not _HAS_KECCAK:
        return ""
    k = keccak.new(digest_bits=256)
    k.update(signature.encode())
    return "0x" + k.hexdigest()


# events.json 의 event_signature 와 동일
TOPIC_SUBMITTED = _topic0("Submitted(address,uint256,address)")
TOPIC_WITHDRAWAL_REQUESTED = _topic0(
    "WithdrawalRequested(uint256,address,address,uint256,uint256)"
)
TOPIC_TRANSFER_SHARES = _topic0("TransferShares(address,address,uint256)")


def _topic_to_addr(topic: str) -> str:
    """32-byte topic → 20-byte address."""
    return "0x" + topic[-40:]


# 알려진 mock 주소 (RPC 실패 시 데모 데이터)
_MOCK_USERS = [
    "0x111111111111111111111111111111111111aaaa",
    "0x222222222222222222222222222222222222bbbb",
    "0xdc24316b9ae028f1497c275eb9192a3ea0f67022",  # Curve stETH pool
    "0x93c4b944d05dfe6df7645a86cd2206016c51564d",  # EigenLayer wstETH strategy
]


class LidoCollector(BaseCollector):
    protocol = "lido"

    # min transfer size to record (stETH/wstETH units) — focus on whales, bound db size
    _MIN_TRANSFER = float(os.getenv("LIDO_MIN_TRANSFER", "25"))

    def __init__(self, mode: Optional[str] = None):
        # default = fast Alchemy getAssetTransfers (no subgraph, reuses the key); rpc/mock available.
        if mode in ("transfers", "rpc", "mock"):
            self.mode = mode
        elif _alc.available():
            self.mode = "transfers"
        else:
            self.mode = "rpc" if ALCHEMY_KEY and _HAS_KECCAK else "mock"
        self._last_source = self.mode

    def get_source(self) -> str:
        return self._last_source

    # ─────────────────────────────────────────────────────────────
    # fetch
    # ─────────────────────────────────────────────────────────────

    async def fetch_events(self, from_block: int, to_block: int) -> list[dict]:
        if self.mode == "mock":
            self._last_source = "mock"
            return self._mock_events(from_block, to_block)
        if self.mode == "transfers":
            try:
                tr = await _alc.fetch_transfers([STETH, WSTETH], from_block, to_block)
                self._last_source = "transfers"
                return [{"transfer": t} for t in tr if t["value"] >= self._MIN_TRANSFER]
            except Exception as e:
                logger.warning(f"Lido transfers fetch failed: {e}. rpc fallback.")
        try:
            events = await self._fetch_rpc(from_block, to_block)
            self._last_source = "rpc"
            return events
        except Exception as e:
            logger.warning(f"Lido RPC fetch failed: {e}. mock fallback.")
            self._last_source = f"mock-fallback ({type(e).__name__})"
            return self._mock_events(from_block, to_block)

    async def _get_logs(
        self, client: httpx.AsyncClient, address: str, topic0: str,
        from_block: int, to_block: int,
    ) -> list[dict]:
        if not topic0:
            return []
        try:
            r = await client.post(ETH_RPC, json={
                "jsonrpc": "2.0", "method": "eth_getLogs", "id": 1,
                "params": [{
                    "address": address,
                    "topics": [topic0],
                    "fromBlock": hex(from_block),
                    "toBlock": hex(to_block),
                }],
            })
            r.raise_for_status()
            data = r.json()
            if "error" in data:                       # JSON-RPC error (e.g. >10k logs)
                raise ValueError(str(data["error"])[:120])
            return data.get("result", []) or []
        except (httpx.HTTPStatusError, ValueError):
            # range too large / too many results → bisect instead of falling back to mock,
            # so high-volume topics (stETH TransferShares) still return REAL logs. Min-span
            # guard bounds recursion (a genuinely malformed query gives up → real-empty, not mock).
            if to_block - from_block < 16:
                return []
            mid = (from_block + to_block) // 2
            return (await self._get_logs(client, address, topic0, from_block, mid)
                    + await self._get_logs(client, address, topic0, mid + 1, to_block))

    # eth_getLogs chunk size. Contract+topic-FILTERED queries (Submitted/Withdrawal/
    # TransferShares on a single contract) stay well under Alchemy's response-size cap even
    # over wide ranges, so 10 blocks was needlessly tiny (→ 200 calls/2k blk → 429 rate-limit).
    # Env-tunable; default 500 = 50× fewer requests, far better coverage per poll cycle.
    _MAX_LOG_RANGE = int(os.getenv("EVENT_LOG_RANGE", "200"))

    async def _fetch_rpc(self, from_block: int, to_block: int) -> list[dict]:
        events: list[dict] = []
        async with httpx.AsyncClient(timeout=20.0) as client:
            # 10블록 단위로 chunk (무료 티어 제한 회피)
            lo = from_block
            while lo <= to_block:
                hi = min(lo + self._MAX_LOG_RANGE - 1, to_block)
                # Submitted (deposits)
                for log in await self._get_logs(client, STETH, TOPIC_SUBMITTED, lo, hi):
                    events.append({"kind": "submitted", "log": log})
                # WithdrawalRequested
                for log in await self._get_logs(
                    client, WITHDRAWAL_QUEUE, TOPIC_WITHDRAWAL_REQUESTED, lo, hi
                ):
                    events.append({"kind": "withdrawal_requested", "log": log})
                # TransferShares (대형만 — 필터는 event_to_edges 에서)
                for log in await self._get_logs(client, STETH, TOPIC_TRANSFER_SHARES, lo, hi):
                    events.append({"kind": "transfer_shares", "log": log})
                lo = hi + 1
        return events

    # ─────────────────────────────────────────────────────────────
    # convert
    # ─────────────────────────────────────────────────────────────

    def _transfer_to_edges(self, t: dict) -> list[DynamicEdge]:
        """stETH/wstETH transfer → edge (the EOA's Lido footprint for cross-protocol joins)."""
        frm, to = t["from"], t["to"]
        if not frm or not to:
            return []
        return [DynamicEdge(
            edge_id=f"lido:transfer:{t['hash']}:{frm[:8]}",
            edge_type="steth_transfer", from_address=frm, to_address=to,
            asset=(t.get("contract") or STETH), amount_raw=None, amount_decimal=t.get("value"),
            block_number=t.get("blockNum", 0), tx_hash=t.get("hash", ""), log_index=0,
            timestamp=0, protocol="lido", market_id=None,
            metadata={"event": "Transfer", "asset_sym": t.get("asset"), "source": "alchemy_transfers"},
        )]

    def event_to_edges(self, raw_event: dict) -> list[DynamicEdge]:
        if "transfer" in raw_event:
            return self._transfer_to_edges(raw_event["transfer"])
        kind = raw_event.get("kind")
        # mock 이벤트는 이미 정리된 형식
        if "log" not in raw_event:
            return self._mock_to_edges(raw_event)

        log = raw_event["log"]
        topics = log.get("topics", [])
        data = log.get("data", "0x")
        block = int(log.get("blockNumber", "0x0"), 16)
        tx = log.get("transactionHash", "")
        li = int(log.get("logIndex", "0x0"), 16)

        try:
            if kind == "submitted" and len(topics) >= 2:
                # Submitted(address indexed sender, uint256 amount, address referral)
                sender = _topic_to_addr(topics[1])
                amount = int(data[2:66], 16) if len(data) >= 66 else 0
                return [DynamicEdge(
                    edge_id=f"lido:submitted:{tx}:{li}",
                    edge_type="deposited_to_lido",
                    from_address=sender, to_address=STETH,
                    asset=STETH, amount_raw=str(amount),
                    amount_decimal=amount / 1e18,
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="lido",
                    metadata={"event": "Submitted"},
                )]

            if kind == "withdrawal_requested" and len(topics) >= 4:
                # WithdrawalRequested(uint256 indexed requestId, address indexed requestor,
                #                      address indexed owner, uint256 amountOfStETH, ...)
                requestor = _topic_to_addr(topics[2])
                owner = _topic_to_addr(topics[3])
                amount = int(data[2:66], 16) if len(data) >= 66 else 0
                return [DynamicEdge(
                    edge_id=f"lido:withdrawal:{tx}:{li}",
                    edge_type="requested_withdrawal_for",
                    from_address=requestor, to_address=owner,
                    asset=STETH, amount_raw=str(amount),
                    amount_decimal=amount / 1e18,
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="lido",
                    metadata={"event": "WithdrawalRequested"},
                )]

            if kind == "transfer_shares" and len(topics) >= 3:
                # TransferShares(address indexed from, address indexed to, uint256 sharesValue)
                frm = _topic_to_addr(topics[1])
                to = _topic_to_addr(topics[2])
                shares = int(data[2:66], 16) if len(data) >= 66 else 0
                # 대형 이동만 (프로토콜 간 흐름이 의미 있음)
                if shares < MIN_TRANSFER_SHARES:
                    return []
                # mint/burn (0x0) 제외 — 이미 Submitted 로 커버
                zero = "0x0000000000000000000000000000000000000000"
                if frm == zero or to == zero:
                    return []
                return [DynamicEdge(
                    edge_id=f"lido:transfer:{tx}:{li}",
                    edge_type="stETH_moved",
                    from_address=frm, to_address=to,
                    asset=STETH, amount_raw=str(shares),
                    amount_decimal=shares / 1e18,
                    block_number=block, tx_hash=tx, log_index=li,
                    protocol="lido",
                    metadata={"event": "TransferShares"},
                )]
        except Exception as e:
            logger.debug(f"lido event decode fail: {e}")
            return []
        return []

    # ─────────────────────────────────────────────────────────────
    # mock
    # ─────────────────────────────────────────────────────────────

    def _mock_events(self, from_block: int, to_block: int) -> list[dict]:
        """RPC 없이도 focus/search 데모가 작동하도록 결정론적 mock."""
        import random
        rnd = random.Random(from_block)  # 결정론적
        out = []
        for i in range(6):
            kind = rnd.choice(["submitted", "withdrawal_requested", "transfer_shares"])
            user = rnd.choice(_MOCK_USERS)
            other = rnd.choice(_MOCK_USERS)
            amt = rnd.randint(100, 5000) * 10**18
            out.append({
                "mock": True, "kind": kind,
                "user": user, "other": other, "amount": amt,
                "block": from_block + i, "tx": f"0xmocklido{from_block:08x}{i:02x}",
                "li": i,
            })
        return out

    def _mock_to_edges(self, ev: dict) -> list[DynamicEdge]:
        kind = ev["kind"]; user = ev["user"]; other = ev["other"]
        amt = ev["amount"]; block = ev["block"]; tx = ev["tx"]; li = ev["li"]
        etype = {
            "submitted": "deposited_to_lido",
            "withdrawal_requested": "requested_withdrawal_for",
            "transfer_shares": "stETH_moved",
        }[kind]
        to_addr = STETH if kind == "submitted" else other
        return [DynamicEdge(
            edge_id=f"lido:mock:{kind}:{tx}:{li}",
            edge_type=etype,
            from_address=user, to_address=to_addr,
            asset=STETH, amount_raw=str(amt), amount_decimal=amt / 1e18,
            block_number=block, tx_hash=tx, log_index=li,
            protocol="lido", market_id=None,
            metadata={"event": kind, "mock": True},
        )]
