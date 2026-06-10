"""방법 D — 범용 발행권한(mint authority) 스캔.

표준을 몰라도, 토큰을 mint/bridge 할 권한을 가진 주소 = 브릿지 (catch-all).
minter()/bridge()/gateway() 같은 getter + MINTER_ROLE 등 역할 멤버를 조회한다.
"""

from eth_utils import keccak, to_checksum_address

from .rpc import eth_call
from .chains import resolve_rpc

_GETTERS = [("minter()", "high"), ("bridge()", "high"), ("BRIDGE()", "high"),
            ("l2Bridge()", "high"), ("gateway()", "med"), ("l2Gateway()", "med"),
            ("childChainManager()", "high"), ("controller()", "med"), ("owner()", "low")]
_ROLES = ["MINTER_ROLE", "BRIDGE_ROLE", "DEPOSITOR_ROLE", "BURNER_ROLE", "MINTER_BURNER_ROLE"]
_CONF_RANK = {"high": 3, "med": 2, "low": 1}


def method_d(token_address, src_chain, rpc):
    print("\n" + "=" * 60)
    print("[방법 D] 범용 발행권한 스캔 — 표준 무관 mint/bridge 권한자 탐지")
    print("=" * 60)
    rpc = resolve_rpc(src_chain, rpc)
    if not rpc:
        print(f"[!] 체인 {src_chain} 읽기 RPC 를 찾지 못함 — --rpc 로 지정 필요")
        return {"authorities": []}
    token = to_checksum_address(token_address)

    found = {}  # addr -> (reason, conf)

    def add(addr, reason, conf):
        if not addr or int(addr, 16) == 0:
            return
        a = to_checksum_address(addr)
        if a == token:
            return
        if a not in found or _CONF_RANK[conf] > _CONF_RANK[found[a][1]]:
            found[a] = (reason, conf)

    for sig, conf in _GETTERS:
        st, res = eth_call(rpc, token, sig, [], [], ["address"])
        if st == "OK":
            add(res[0], sig, conf)
    for rn in _ROLES:
        role = keccak(text=rn)
        st, c = eth_call(rpc, token, "getRoleMemberCount(bytes32)", ["bytes32"], [role], ["uint256"])
        if st == "OK" and c[0] > 0:
            for i in range(min(c[0], 20)):
                s, m = eth_call(rpc, token, "getRoleMember(bytes32,uint256)", ["bytes32", "uint256"], [role, i], ["address"])
                if s == "OK":
                    add(m[0], f"{rn} 멤버", "high")

    authorities = [{"address": a, "reason": r, "confidence": conf} for a, (r, conf) in found.items()]
    authorities.sort(key=lambda x: -_CONF_RANK[x["confidence"]])

    strong = [a for a in authorities if a["confidence"] in ("high", "med")]
    weak = [a for a in authorities if a["confidence"] == "low"]
    if strong:
        print("[★] 발행/브릿지 권한자 (브릿지 가능성 높음):")
        for a in strong:
            print(f"    - {a['address']}  ({a['reason']}, {a['confidence']})")
    if weak:
        print("[i] 관리자 권한 (브릿지 아닐 수 있음 — 참고):")
        for a in weak:
            print(f"    - {a['address']}  ({a['reason']})")
    if not authorities:
        print("[i] 읽을 수 있는 발행권한 인터페이스 없음 "
              "(프록시/커스텀 → 온체인 단독 감지 불가, 그 브릿지 전용 로직 필요)")
    return {"authorities": authorities}
