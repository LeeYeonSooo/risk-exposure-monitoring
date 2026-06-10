"""Solana PDA(Program Derived Address) 유도 — base58 인코딩 + ed25519 off-curve 판정.

브릿지 금고(custody)가 민트별 PDA 인 경우, 그 PDA 를 직접 유도해 잔고를 확인하려고 쓴다.
외부 의존성 없이 순수 파이썬으로 구현.
"""

import hashlib

from ..common import b58decode

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_P = 2 ** 255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


def b58encode(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n > 0:
        n, r = divmod(n, 58)
        s = _B58[r] + s
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + s


def _on_curve(b):
    """32바이트가 유효한 ed25519 점이면 True (= PDA 로는 부적합)."""
    if len(b) != 32:
        return False
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    if y >= _P:
        return False
    u = (y * y - 1) % _P
    v = (_D * y * y + 1) % _P
    xx = (u * pow(v, _P - 2, _P)) % _P
    x = pow(xx, (_P + 3) // 8, _P)
    if (x * x - xx) % _P != 0:
        x = (x * pow(2, (_P - 1) // 4, _P)) % _P
    return (x * x - xx) % _P == 0


def find_program_address(seeds, program_id_b58):
    """findProgramAddress(seeds, program) → PDA(base58 문자열). off-curve 한 첫 bump."""
    program = b58decode(program_id_b58)
    for bump in range(255, -1, -1):
        data = b"".join(seeds) + bytes([bump]) + program + b"ProgramDerivedAddress"
        h = hashlib.sha256(data).digest()
        if not _on_curve(h):
            return b58encode(h)
    return None
