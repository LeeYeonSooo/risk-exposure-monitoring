"""방법 G — 알려진 브릿지 주소 직접 대조 (lock 금고, 금액 무관).

lock&mint 금고(Wormhole Portal 등)는 토큰을 "소량"만 잠글 수 있어, 잔고 순위(방법 F)로는
누락된다. 대신 **알려진 브릿지 주소에 그 토큰 잔고가 있는지**를 직접 확인하면
금액과 무관하게(0보다 크기만 하면) 잡고, 주소가 화이트리스트라 오탐도 없다.

각 주소가 진짜 그 브릿지인지는 verify.py(고유 함수 조합)로 한 번 더 확인 가능.
"""

from eth_utils import to_checksum_address

from .rpc import eth_call
from .chains import resolve_rpc

# 체인ID → [(브릿지명, 주소, 유형)] — 토큰을 lock 해 보유하는 알려진 브릿지 금고
KNOWN_BRIDGES = {
    1: [  # Ethereum
        ("Wormhole Token Bridge (Portal)", "0x3ee18b2214aff97000d974cf647e7c347e8fa585", "lock&mint"),
    ],
    10: [("Wormhole Token Bridge (Portal)", "0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b", "lock&mint")],
    56: [("Wormhole Token Bridge (Portal)", "0xb6f6d86a8f9879a9c87f643768d9efc38c1da6e7", "lock&mint")],
    137: [("Wormhole Token Bridge (Portal)", "0x5a58505a96d1dbf8df91cb21b54419fc36e93fde", "lock&mint")],
    8453: [("Wormhole Token Bridge (Portal)", "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627", "lock&mint")],
    42161: [("Wormhole Token Bridge (Portal)", "0x0b2402144Bb366A632D14B83F244D2e0e21bD39c", "lock&mint")],
    43114: [("Wormhole Token Bridge (Portal)", "0x0e082F06FF657D94310cB8cE8B0D9a04541d8052", "lock&mint")],
}


def method_g(token_address, src_chain, rpc):
    """알려진 브릿지 주소에 토큰이 잠겨(보유돼) 있는지 직접 확인."""
    print("\n" + "=" * 60)
    print("[방법 G] 알려진 브릿지 주소 직접 대조 — lock 금고(금액 무관)")
    print("=" * 60)
    rpc = resolve_rpc(src_chain, rpc)
    known = KNOWN_BRIDGES.get(src_chain, [])
    if not rpc or not known:
        print(f"[i] 체인 {src_chain} 에 등록된 알려진 브릿지 주소 없음")
        return {"locked": []}

    token = to_checksum_address(token_address)
    locked = []
    for name, addr, btype in known:
        st, bal = eth_call(rpc, token, "balanceOf(address)", ["address"],
                           [to_checksum_address(addr)], ["uint256"])
        if st == "OK" and bal[0] > 0:
            locked.append({"name": name, "address": to_checksum_address(addr),
                           "type": btype, "balance": bal[0]})
            print(f"  [★ 확정] {name}  잔고 {bal[0]}  ({addr})")
    if not locked:
        print("  [i] 알려진 브릿지 주소에 잠긴 잔고 없음")
    return {"locked": locked}
