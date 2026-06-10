"""Solana 방법 G — 알려진 브릿지 금고(custody) 직접 대조 (lock, 금액 무관).

Wormhole Token Bridge 는 native SPL 토큰을 mint별 custody PDA 에 잠근다(lock).
그 PDA 를 직접 유도해 잔고를 확인하면, 금액과 무관하게(0보다 크면) lock 을 잡는다.
PDA 가 화이트리스트 프로그램(Wormhole)에서 결정적으로 나오므로 오탐이 없다.
"""

from .rpc import rpc_call
from .pda import find_program_address
from ..common import b58decode

# Wormhole Token Bridge 프로그램 (custody PDA = seeds=[mint], program=이것)
WORMHOLE_TOKEN_BRIDGE = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb"


def detect_known_locks(rpc, mint):
    """알려진 브릿지 금고에 이 민트가 잠겨 있는지 확인 → 브릿지 목록."""
    bridges = []
    try:
        mint_bytes = b58decode(mint)
        if not mint_bytes or len(mint_bytes) != 32:
            return bridges
    except Exception:
        return bridges

    # Wormhole Token Bridge custody PDA
    custody = find_program_address([mint_bytes], WORMHOLE_TOKEN_BRIDGE)
    if custody:
        res = rpc_call(rpc, "getTokenAccountBalance", [custody])
        amount = ((res or {}).get("value") or {}).get("amount")
        if amount and int(amount) > 0:
            ui = (res["value"].get("uiAmountString") or amount)
            print(f"[★ 확정] Wormhole Token Bridge 금고에 lock — {custody}  (잔고 {ui})")
            bridges.append({"standard": "Wormhole Token Bridge (lock&mint, 잠금 확정)",
                            "address": custody, "remotes": [],
                            "note": f"custody PDA 에 {ui} 잠김"})
    return bridges
