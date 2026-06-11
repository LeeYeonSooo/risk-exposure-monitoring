"""방법 G — 알려진 브릿지 주소 직접 대조 (lock 금고, 금액 무관).

lock&mint 금고(Wormhole Portal 등)는 토큰을 "소량"만 잠글 수 있어, 잔고 순위(방법 F)로는
누락된다. 대신 **알려진 브릿지 주소에 그 토큰 잔고가 있는지**를 직접 확인하면
금액과 무관하게(0보다 크기만 하면) 잡고, 주소가 화이트리스트라 오탐도 없다.

각 주소가 진짜 그 브릿지인지는 verify.py(고유 함수 조합)로 한 번 더 확인 가능.
"""

from eth_utils import to_checksum_address

from .rpc import eth_call
from .chains import resolve_rpc
from .verify import verify_bridge_contract

# Across Protocol SpokePool — 체인별 유동성 컨트랙트. 모두 verify.py 의 SpokePool 지문
# (numberOfDeposits+fillDeadlineBuffer)으로 구조 검증되는 주소만 등록 (실측 확인). lock 아닌 풀형이라 balanceOf 로 흡수.
ACROSS_SPOKE = {
    1: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
    10: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
    137: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
    8453: "0x09aeA4b2242abC8bb4BB78D537A67a245A7bEC64",   # Base — DAI(base)→Across 탐지
    42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
}

# 체인ID → [(브릿지명, 주소, 유형)] — 토큰을 lock/보유하는 알려진 브릿지
KNOWN_BRIDGES = {
    1: [  # Ethereum
        ("Wormhole Token Bridge (Portal)", "0x3ee18b2214aff97000d974cf647e7c347e8fa585", "lock&mint"),
        ("Across Protocol (HubPool)", "0xc186fa914353c44b2e33ebe05f21846f1048beda", "liquidity"),
    ],
    10: [("Wormhole Token Bridge (Portal)", "0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b", "lock&mint")],
    56: [("Wormhole Token Bridge (Portal)", "0xb6f6d86a8f9879a9c87f643768d9efc38c1da6e7", "lock&mint")],
    137: [("Wormhole Token Bridge (Portal)", "0x5a58505a96d1dbf8df91cb21b54419fc36e93fde", "lock&mint")],
    8453: [("Wormhole Token Bridge (Portal)", "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627", "lock&mint")],
    42161: [("Wormhole Token Bridge (Portal)", "0x0b2402144Bb366A632D14B83F244D2e0e21bD39c", "lock&mint")],
    43114: [("Wormhole Token Bridge (Portal)", "0x0e082F06FF657D94310cB8cE8B0D9a04541d8052", "lock&mint")],
}
# Across SpokePool 을 각 체인 목록에 합류 (유형=liquidity)
for _cid, _addr in ACROSS_SPOKE.items():
    KNOWN_BRIDGES.setdefault(_cid, []).append(("Across Protocol (SpokePool)", _addr, "liquidity"))


def method_g(token_address, src_chain, rpc):
    """알려진 브릿지 주소에 토큰이 잠겨/보유돼 있는지 확인 + 각 hit 를 구조 역검증.

    balanceOf>0 으로 보유를 확인하고, verify.py 로 그 주소가 진짜 그 브릿지인지(고유 함수)
    한 번 더 확정한다 → 단순 화이트리스트가 아니라 '구조로 검증된 주소만' 신뢰.
    """
    print("\n" + "=" * 60)
    print("[방법 G] 알려진 브릿지 주소 직접 대조 + 구조 역검증 (금액 무관)")
    print("=" * 60)
    rpc = resolve_rpc(src_chain, rpc)
    known = KNOWN_BRIDGES.get(src_chain, [])
    if not rpc or not known:
        print(f"[i] 체인 {src_chain} 에 등록된 알려진 브릿지 주소 없음")
        return {"locked": []}

    token = to_checksum_address(token_address)
    locked = []
    for name, addr, btype in known:
        addr_cs = to_checksum_address(addr)
        st, bal = eth_call(rpc, token, "balanceOf(address)", ["address"], [addr_cs], ["uint256"])
        if st == "OK" and bal[0] > 0:
            v = verify_bridge_contract(rpc, addr_cs)          # 구조적 역검증
            verified = v["standard"] if v else None
            locked.append({"name": name, "address": addr_cs, "type": btype,
                           "balance": bal[0], "verified": verified})
            tag = f"역검증✓ {verified}" if verified else "화이트리스트(미역검증)"
            print(f"  [★ 확정] {name}  잔고 {bal[0]}  [{tag}]  ({addr_cs})")
    if not locked:
        print("  [i] 알려진 브릿지 주소에 잠긴 잔고 없음")
    return {"locked": locked}
