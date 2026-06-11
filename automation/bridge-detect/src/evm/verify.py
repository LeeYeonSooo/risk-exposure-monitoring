"""브릿지 컨트랙트 역검증 — 후보 주소가 "실제 브릿지처럼 동작하는지" 온체인으로 증명.

라벨(남이 붙인 이름)에 의존하지 않고, 후보 주소에 브릿지 표준 함수를 직접 호출해
응답하면 그 브릿지로 "확정"한다. (방법 F 의 핵심 — 잔고 정황을 구조적 증거로 승격)
"""

from eth_utils import to_checksum_address

from .rpc import eth_call


def verify_bridge_contract(rpc, addr):
    """후보 주소에 브릿지 인터페이스를 호출해 매칭되는 표준을 반환. 아니면 None.

    반환: {"standard": ..., "detail": ...} 또는 None
    """
    a = to_checksum_address(addr)

    # ① CCIP TokenPool — getSupportedChains() + getToken()
    st, _ = eth_call(rpc, a, "getSupportedChains()", [], [], ["uint64[]"])
    if st == "OK":
        stt, tok = eth_call(rpc, a, "getToken()", [], [], ["address"])
        detail = to_checksum_address(tok[0]) if stt == "OK" else None
        return {"standard": "Chainlink CCIP (TokenPool)", "detail": detail}

    # ② Wormhole NTT Manager — getMode() + token()
    st, _ = eth_call(rpc, a, "getMode()", [], [], ["uint8"])
    if st == "OK":
        stt, tok = eth_call(rpc, a, "token()", [], [], ["address"])
        if stt == "OK":
            return {"standard": "Wormhole NTT (Manager)", "detail": to_checksum_address(tok[0])}

    # ③ Stargate Pool — poolId() + token()
    st, pid = eth_call(rpc, a, "poolId()", [], [], ["uint256"])
    if st == "OK":
        stt, tok = eth_call(rpc, a, "token()", [], [], ["address"])
        if stt == "OK":
            return {"standard": "Stargate (Pool)", "detail": f"poolId={pid[0]}"}

    # ④ LayerZero OApp/Endpoint — endpoint() (그 주소가 OApp 인 경우)
    st, ep = eth_call(rpc, a, "endpoint()", [], [], ["address"])
    if st == "OK" and int(ep[0], 16) != 0:
        return {"standard": "LayerZero (OApp)", "detail": to_checksum_address(ep[0])}

    # ⑤ Hop Bridge AMM Wrapper — l2CanonicalToken()
    st, ct = eth_call(rpc, a, "l2CanonicalToken()", [], [], ["address"])
    if st == "OK" and int(ct[0], 16) != 0:
        return {"standard": "Hop (AMM Wrapper)", "detail": to_checksum_address(ct[0])}

    # ⑥ Circle CCTP TokenMessenger — localMinter() + localMessageTransmitter()
    st, lm = eth_call(rpc, a, "localMinter()", [], [], ["address"])
    if st == "OK" and int(lm[0], 16) != 0:
        return {"standard": "Circle CCTP (TokenMessenger)", "detail": to_checksum_address(lm[0])}

    # ⑥-b Wormhole Token Bridge(Portal) — 고유 함수 조합으로 판정 (오탐 방지: 단독 X)
    #     tokenImplementation() + wormhole()(코어 브릿지) 둘 다 응답해야 인정
    st1, ti = eth_call(rpc, a, "tokenImplementation()", [], [], ["address"])
    st2, wh = eth_call(rpc, a, "wormhole()", [], [], ["address"])
    if st1 == "OK" and st2 == "OK" and int(ti[0], 16) != 0 and int(wh[0], 16) != 0:
        return {"standard": "Wormhole Token Bridge (Portal)", "detail": to_checksum_address(wh[0])}

    # ⑦ Polygon ChildChainManager — rootToChildToken(address) 매핑 보유
    st, _ = eth_call(rpc, a, "childChainManagerProxy()", [], [], ["address"])
    if st == "OK":
        return {"standard": "Polygon PoS (ChildChainManager)", "detail": None}

    # ⑦-b Across Protocol SpokePool — 유동성/인텐트 브릿지(토큰에 흔적 없음).
    #     numberOfDeposits()+fillDeadlineBuffer() 조합은 Across SpokePool 고유 지문 → 구조 확정.
    st1, _ = eth_call(rpc, a, "numberOfDeposits()", [], [], ["uint32"])
    st2, _ = eth_call(rpc, a, "fillDeadlineBuffer()", [], [], ["uint32"])
    if st1 == "OK" and st2 == "OK":
        return {"standard": "Across Protocol (SpokePool)", "detail": None}

    # ⑧ 일반 크로스체인 메시저 — endpoint/router 류 (LayerZero EndpointV2 등)
    for sig in ("messageLibManager()", "defaultSendLibrary(uint32)"):
        # 인자 없는 것만 가볍게: messaging 컨트랙트 지문
        if "(" in sig and sig.endswith("()"):
            st, _ = eth_call(rpc, a, sig, [], [], ["address"])
            if st == "OK":
                return {"standard": "Messaging/Bridge endpoint", "detail": None}

    return None
