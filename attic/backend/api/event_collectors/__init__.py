"""
event_collectors — Layer 2 동적 이벤트 수집 (Phase 3+).

각 프로토콜 collector 는 BaseCollector 를 상속하고
event_to_edges() 로 raw 이벤트를 본인 어휘의 DynamicEdge 로 변환.
"""

from .base import BaseCollector, DynamicEdge, CollectorResult
from .aave_collector import AaveCollector
from .lido_collector import LidoCollector
from .morpho_collector import MorphoCollector
from .sky_collector import SkyCollector
from . import event_store

__all__ = [
    "BaseCollector",
    "DynamicEdge",
    "CollectorResult",
    "AaveCollector",
    "LidoCollector",
    "MorphoCollector",
    "SkyCollector",
    "event_store",
]
