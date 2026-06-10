"""
Aave V3 Subgraph collector.

Two modes:
- 'subgraph' (default if AAVE_V3_SUBGRAPH_URL env var is set)
- 'mock'     (used if subgraph URL missing or unreachable — generates demo events
              so Phase 4 토큰/주소 포커스 모드가 환경 무관하게 작동)

Subgraph schema reference:
  Messari aave-v3-ethereum (or BGD Labs equivalent) — events:
    deposits, withdraws, borrows, repays, liquidates, flashloans
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

from .base import BaseCollector, DynamicEdge

logger = logging.getLogger(__name__)

# Aave V3 Ethereum Subgraph URL
# 우선순위:
#   1. AAVE_V3_SUBGRAPH_URL 환경변수 (사용자 설정)
#   2. AAVE_V3_SUBGRAPH_URL_FALLBACK 환경변수 (백업)
#   3. 빈 문자열 → mock 모드 강제
#
# 권장 URL 예시 (.env 에 다음 중 하나 설정):
#   - The Graph Studio: https://api.studio.thegraph.com/query/{ID}/aave-v3-ethereum/version/latest
#   - Decentralized Network: https://gateway-arbitrum.network.thegraph.com/api/{API_KEY}/subgraphs/id/{ID}
#   - Goldsky mirror: https://api.goldsky.com/api/public/{PROJECT}/subgraphs/aave-v3-ethereum/...
#   - 자체 호스팅 Subsquid 등
AAVE_SUBGRAPH_URL = os.getenv("AAVE_V3_SUBGRAPH_URL", "").strip()
AAVE_MARKET_ID = "1:0x2f39d218133afab8f2b819b1066c7e434ad94e9e"

# 핵심 자산 (mock 모드에서 사용)
_MOCK_ASSETS = {
    "wsteth": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    "weeth":  "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee",
    "weth":   "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "usdc":   "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "gho":    "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f",
}
_MOCK_USERS = [
    "0x111111111111111111111111111111111111aaaa",
    "0x222222222222222222222222222222222222bbbb",
    "0x333333333333333333333333333333333333cccc",
    "0x444444444444444444444444444444444444dddd",  # liquidator bot
    "0x555555555555555555555555555555555555eeee",
]
AAVE_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"


class AaveCollector(BaseCollector):
    protocol = "aave-v3"

    def __init__(self, mode: Optional[str] = None):
        # 명시적 mode 우선, 아니면 환경변수 확인
        if mode in ("subgraph", "mock"):
            self.mode = mode
        else:
            self.mode = "subgraph" if AAVE_SUBGRAPH_URL else "mock"
        self._last_source: str = self.mode

    def get_source(self) -> str:
        """가장 최근 fetch 의 실제 데이터 소스 (fallback 발생 추적용)."""
        return self._last_source

    # ─────────────────────────────────────────────────────────────
    # fetch_events
    # ─────────────────────────────────────────────────────────────

    async def fetch_events(self, from_block: int, to_block: int) -> list[dict]:
        if self.mode == "mock":
            return self._mock_events(from_block, to_block)
        # subgraph 모드 — 실패 시 mock 자동 fallback
        try:
            events = await self._fetch_subgraph(from_block, to_block)
            self._last_source = "subgraph"
            return events
        except Exception as e:
            logger.warning(
                f"Aave subgraph fetch failed: {e}. Falling back to mock data for this call."
            )
            self._last_source = f"mock-fallback ({type(e).__name__})"
            return self._mock_events(from_block, to_block)

    async def _fetch_subgraph(self, from_block: int, to_block: int) -> list[dict]:
        """Aave V3 subgraph 에서 deposits/withdraws/borrows/repays/liquidates/flashloans 조회."""
        query = """
        query Events($from: Int!, $to: Int!) {
          deposits(first: 100, where: {blockNumber_gte: $from, blockNumber_lte: $to}) {
            id hash blockNumber timestamp logIndex asset { id symbol decimals }
            amount amountUSD account { id } accountActor: account { id }
          }
          withdraws(first: 100, where: {blockNumber_gte: $from, blockNumber_lte: $to}) {
            id hash blockNumber timestamp logIndex asset { id symbol decimals }
            amount amountUSD account { id }
          }
          borrows(first: 100, where: {blockNumber_gte: $from, blockNumber_lte: $to}) {
            id hash blockNumber timestamp logIndex asset { id symbol decimals }
            amount amountUSD account { id }
          }
          repays(first: 100, where: {blockNumber_gte: $from, blockNumber_lte: $to}) {
            id hash blockNumber timestamp logIndex asset { id symbol decimals }
            amount amountUSD account { id }
          }
          liquidates(first: 100, where: {blockNumber_gte: $from, blockNumber_lte: $to}) {
            id hash blockNumber timestamp logIndex
            asset { id symbol decimals }
            liquidator { id } liquidatee { id }
            amount amountUSD profitUSD
          }
        }
        """
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                AAVE_SUBGRAPH_URL,
                json={"query": query, "variables": {"from": from_block, "to": to_block}},
            )
            if resp.status_code != 200:
                raise RuntimeError(f"subgraph HTTP {resp.status_code}")
            data = resp.json().get("data", {}) or {}

        # raw → 통일된 형식으로
        events: list[dict] = []
        for ev in data.get("deposits") or []:
            events.append({"kind": "supply", **ev})
        for ev in data.get("withdraws") or []:
            events.append({"kind": "withdraw", **ev})
        for ev in data.get("borrows") or []:
            events.append({"kind": "borrow", **ev})
        for ev in data.get("repays") or []:
            events.append({"kind": "repay", **ev})
        for ev in data.get("liquidates") or []:
            events.append({"kind": "liquidation", **ev})
        return events

    def _mock_events(self, from_block: int, to_block: int) -> list[dict]:
        """데모용 mock 이벤트 — 본인 어휘 검증/Phase 4 데모 데이터."""
        import random
        rng = random.Random(from_block * 1000 + to_block)
        n = min(40, max(8, to_block - from_block))

        kinds = ["supply", "withdraw", "borrow", "repay", "liquidation"]
        weights = [4, 2, 3, 2, 1]
        events: list[dict] = []
        for i in range(n):
            kind = rng.choices(kinds, weights=weights, k=1)[0]
            asset_addr = rng.choice(list(_MOCK_ASSETS.values()))
            user = rng.choice(_MOCK_USERS[:3])
            block = from_block + rng.randint(0, max(1, to_block - from_block))
            base = {
                "kind": kind,
                "id": f"mock-{kind}-{i}",
                "hash": f"0x{i:064x}",
                "blockNumber": block,
                "timestamp": 1707000000 + block * 12,
                "logIndex": i * 4,
                "asset": {"id": asset_addr, "symbol": _sym(asset_addr), "decimals": 18},
                "amount": str(rng.randint(10**17, 10**21)),
                "amountUSD": str(round(rng.uniform(100, 100000), 2)),
                "account": {"id": user},
            }
            if kind == "liquidation":
                base["liquidator"] = {"id": _MOCK_USERS[3]}  # bot
                base["liquidatee"] = {"id": user}
                base["profitUSD"] = str(round(rng.uniform(50, 5000), 2))
            events.append(base)
        return events

    # ─────────────────────────────────────────────────────────────
    # event_to_edges — raw → 본인 어휘 엣지
    # ─────────────────────────────────────────────────────────────

    def event_to_edges(self, raw_event: dict) -> list[DynamicEdge]:
        kind = raw_event.get("kind")
        if kind == "supply":
            return self._edge_supply(raw_event)
        if kind == "withdraw":
            return self._edge_withdraw(raw_event)
        if kind == "borrow":
            return self._edge_borrow(raw_event)
        if kind == "repay":
            return self._edge_repay(raw_event)
        if kind == "liquidation":
            return self._edge_liquidation(raw_event)
        return []

    # ── 헬퍼 ─────────────────────────────────────────────────────

    def _common(self, ev: dict) -> dict:
        decimals = (ev.get("asset") or {}).get("decimals", 18)
        amount_raw = str(ev.get("amount", "0"))
        amount_decimal = None
        try:
            amount_decimal = float(int(amount_raw)) / (10 ** int(decimals))
        except (ValueError, TypeError):
            pass
        return {
            "asset": ((ev.get("asset") or {}).get("id") or "").lower(),
            "amount_raw": amount_raw,
            "amount_decimal": amount_decimal,
            "block_number": int(ev.get("blockNumber") or 0),
            "tx_hash": (ev.get("hash") or "").lower(),
            "log_index": int(ev.get("logIndex") or 0),
            "timestamp": int(ev.get("timestamp") or 0),
            "protocol": self.protocol,
            "market_id": AAVE_MARKET_ID,
        }

    @staticmethod
    def _eid(prefix: str, ev: dict) -> str:
        return f"aave-v3:{prefix}:{(ev.get('hash') or '')[:10]}:{ev.get('logIndex') or 0}"

    # ── 엣지 변환 함수들 ─────────────────────────────────────────

    def _edge_supply(self, ev: dict) -> list[DynamicEdge]:
        user = ((ev.get("account") or {}).get("id") or "").lower()
        c = self._common(ev)
        return [DynamicEdge(
            edge_id=self._eid("supply", ev), edge_type="supply",
            from_address=user, to_address=AAVE_POOL,
            metadata={"amountUSD": ev.get("amountUSD")},
            **c,
        )]

    def _edge_withdraw(self, ev: dict) -> list[DynamicEdge]:
        user = ((ev.get("account") or {}).get("id") or "").lower()
        c = self._common(ev)
        return [DynamicEdge(
            edge_id=self._eid("withdraw", ev), edge_type="withdraw",
            from_address=AAVE_POOL, to_address=user,
            metadata={"amountUSD": ev.get("amountUSD")},
            **c,
        )]

    def _edge_borrow(self, ev: dict) -> list[DynamicEdge]:
        user = ((ev.get("account") or {}).get("id") or "").lower()
        c = self._common(ev)
        return [DynamicEdge(
            edge_id=self._eid("borrow", ev), edge_type="borrow",
            from_address=AAVE_POOL, to_address=user,
            metadata={"amountUSD": ev.get("amountUSD")},
            **c,
        )]

    def _edge_repay(self, ev: dict) -> list[DynamicEdge]:
        user = ((ev.get("account") or {}).get("id") or "").lower()
        c = self._common(ev)
        return [DynamicEdge(
            edge_id=self._eid("repay", ev), edge_type="repay",
            from_address=user, to_address=AAVE_POOL,
            metadata={"amountUSD": ev.get("amountUSD")},
            **c,
        )]

    def _edge_liquidation(self, ev: dict) -> list[DynamicEdge]:
        """청산 1건 → 엣지 3개: liquidation / repay_via_liquidation / collateral_seized"""
        liquidator = ((ev.get("liquidator") or {}).get("id") or "").lower()
        borrower = ((ev.get("liquidatee") or {}).get("id") or "").lower()
        c = self._common(ev)

        edges = []
        # 1) 관계 엣지 (자금 흐름 없음)
        edges.append(DynamicEdge(
            edge_id=self._eid("liquidation", ev), edge_type="liquidation",
            from_address=liquidator, to_address=borrower,
            asset=None, amount_raw=None, amount_decimal=None,
            block_number=c["block_number"], tx_hash=c["tx_hash"], log_index=c["log_index"],
            timestamp=c["timestamp"], protocol=c["protocol"], market_id=c["market_id"],
            metadata={
                "amountUSD": ev.get("amountUSD"),
                "profitUSD": ev.get("profitUSD"),
            },
        ))
        # 2) 청산자가 Pool 에 채무 갚음
        edges.append(DynamicEdge(
            edge_id=self._eid("repay_via_liquidation", ev),
            edge_type="repay_via_liquidation",
            from_address=liquidator, to_address=AAVE_POOL,
            metadata={"borrower": borrower, "amountUSD": ev.get("amountUSD")},
            **c,
        ))
        # 3) Pool 이 청산자에게 담보 이전 (receiveAToken=false 가정, 단순화)
        edges.append(DynamicEdge(
            edge_id=self._eid("collateral_seized", ev),
            edge_type="collateral_seized",
            from_address=AAVE_POOL, to_address=liquidator,
            metadata={"borrower": borrower, "amountUSD": ev.get("amountUSD")},
            **c,
        ))
        return edges


def _sym(addr: str) -> str:
    """mock 모드용 — 주소에서 토큰 심볼 역추적."""
    for sym, a in _MOCK_ASSETS.items():
        if a == addr:
            return sym.upper()
    return "UNK"
