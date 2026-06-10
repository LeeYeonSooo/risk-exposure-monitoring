"""EVM 계열 어댑터 — 방법 B/C/D/E (eth_call · eth_getLogs 기반)."""

from .detect import detect_evm

__all__ = ["detect_evm"]
