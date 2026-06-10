"""Solana(SVM) 계열 어댑터 — SPL 민트의 발행 권한자/브릿지 프로그램 탐지."""

from .detect import detect_solana

__all__ = ["detect_solana"]
