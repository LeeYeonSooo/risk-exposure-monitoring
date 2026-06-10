"""Cosmos(IBC) 계열 어댑터 — IBC denom-trace 로 브릿지(채널)·원본 토큰 추적."""

from .detect import detect_cosmos

__all__ = ["detect_cosmos"]
