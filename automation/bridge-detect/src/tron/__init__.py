"""Tron(TVM) 계열 어댑터 — EVM 탐지 로직 재사용 + Tron 주소/RPC 변환."""

from .detect import detect_tron

__all__ = ["detect_tron"]
