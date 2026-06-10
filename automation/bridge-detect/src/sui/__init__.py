"""Sui(Move VM) 어댑터 — 코인 타입의 표준 브릿지(Wormhole·Sui Bridge·CCTP)를 온체인 확정."""

from .detect import detect_sui

__all__ = ["detect_sui"]
