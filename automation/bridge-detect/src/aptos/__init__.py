"""Aptos(Move VM) 어댑터 — Coin/Fungible Asset 토큰의 표준 브릿지를 온체인으로 확정."""

from .detect import detect_aptos

__all__ = ["detect_aptos"]
