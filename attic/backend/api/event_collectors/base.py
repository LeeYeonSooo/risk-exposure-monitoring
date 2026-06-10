"""
BaseCollector — 모든 프로토콜 폴러가 따라야 할 공통 인터페이스.

다른 팀원이 자기 프로토콜 폴러 만들 때 이 클래스를 상속.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class DynamicEdge:
    """본인 어휘로 정규화된 동적 엣지 (이벤트 → 엣지 변환 결과)."""
    edge_id: str
    edge_type: str           # 예: 'supply', 'borrow', 'liquidation', 'atoken_transfer'
    from_address: str
    to_address: str
    asset: Optional[str] = None       # underlying 자산 주소
    amount_raw: Optional[str] = None  # stringified integer
    amount_decimal: Optional[float] = None
    block_number: int = 0
    tx_hash: str = ""
    log_index: int = 0
    timestamp: int = 0
    protocol: str = ""
    market_id: Optional[str] = None
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class CollectorResult:
    """폴링 1회 실행의 결과 통계."""
    protocol: str
    from_block: int
    to_block: int
    edges_collected: int
    new_edges: int           # 중복 제외 실제 적재된 개수
    skipped: int = 0
    duration_seconds: float = 0.0
    source: str = "subgraph"  # 'subgraph' | 'rpc' | 'mock'
    error: Optional[str] = None


class BaseCollector(ABC):
    """
    모든 프로토콜 폴러의 공통 인터페이스.

    구현 클래스 예시: AaveCollector, LidoCollector, MorphoCollector

    필수 구현:
    - protocol: 클래스 변수 (식별자)
    - fetch_events(): 외부 소스에서 이벤트 가져옴
    - event_to_edges(): raw 이벤트 → 본인 어휘 엣지 리스트로 변환
    """

    protocol: str = "unknown"  # 자식 클래스에서 override

    @abstractmethod
    async def fetch_events(self, from_block: int, to_block: int) -> list[dict]:
        """
        Subgraph 또는 RPC 에서 raw 이벤트 가져오기.

        Returns:
            raw event dict 리스트 — 구현체별 자유 형식
        """
        ...

    @abstractmethod
    def event_to_edges(self, raw_event: dict) -> list[DynamicEdge]:
        """
        raw 이벤트 1개 → DynamicEdge 리스트 (1개 또는 여러 개) 로 변환.

        예: LiquidationCall → 3개 엣지 (liquidation / repay_via_liquidation / collateral_seized)
        예: 위임 케이스 supply → 2개 엣지 (supply / supply_on_behalf)
        """
        ...

    async def collect(self, from_block: int, to_block: int) -> tuple[list[DynamicEdge], CollectorResult]:
        """
        fetch_events + event_to_edges 를 묶은 편의 함수.
        실제 DB 적재는 호출자가 처리.
        """
        import time
        t0 = time.time()
        try:
            raw_events = await self.fetch_events(from_block, to_block)
            edges: list[DynamicEdge] = []
            for ev in raw_events:
                edges.extend(self.event_to_edges(ev))
            return edges, CollectorResult(
                protocol=self.protocol,
                from_block=from_block,
                to_block=to_block,
                edges_collected=len(edges),
                new_edges=0,  # 호출자가 DB 적재 후 채움
                duration_seconds=round(time.time() - t0, 2),
            )
        except Exception as e:
            return [], CollectorResult(
                protocol=self.protocol,
                from_block=from_block,
                to_block=to_block,
                edges_collected=0,
                new_edges=0,
                duration_seconds=round(time.time() - t0, 2),
                error=str(e),
            )
