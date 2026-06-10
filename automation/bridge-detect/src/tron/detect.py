"""Tron 어댑터 — EVM 표준/발행권한 탐지를 TronGrid RPC 로 재사용.

Tron 은 TVM 이라 EVM 의 방법 C(표준 프로빙)·D(발행권한 스캔)·G(알려진 브릿지)를
그대로 쓸 수 있다(eth_call 호환). 주소만 Tron↔EVM 변환한다.
  - burn&mint / lock&mint 목적지 → mintAuthority/표준 함수
  - lock 금고 → 알려진 Tron 브릿지 주소 잔고 (JustCryptos 등)
"""

from ..evm.standards import method_c
from ..evm.authority import method_d
from ..evm.rpc import eth_call
from .rpc import resolve_rpc, tron_to_evm, evm_to_tron

TRON_CHAIN_ID = 728126428  # CCIP/표준 레지스트리엔 없음 → method_b 미적용

# Tron 의 알려진 lock 금고(브릿지). 토큰을 잠그고 wrapped 발행. (T-주소)
KNOWN_BRIDGES = [
    # JustCryptos 등 — 필요 시 확장. (예시 형식; 검증된 주소만 추가)
]


def _convert_addr(a):
    """결과의 EVM 0x-주소를 Tron T-주소로 표기 변환 (실패 시 원본)."""
    try:
        return evm_to_tron(a) if a and a.startswith("0x") and len(a) == 42 else a
    except Exception:
        return a


def detect_tron(token, chain="tron", rpc=None):
    print("\n" + "=" * 60)
    print("[Tron] TVM — EVM 표준/발행권한 탐지 재사용")
    print("=" * 60)
    rpc = resolve_rpc(rpc)
    evm_token = tron_to_evm(token)
    if not evm_token:
        print(f"[!] Tron 주소 변환 실패: {token}")
        return {"family": "tron", "token": token, "chain": "tron", "bridges": [], "raw": {}}
    print(f"[i] {token} → EVM형 {evm_token}\n")

    bridges = []

    # 방법 C(표준) + D(발행권한) 를 TronGrid RPC 로 실행
    c = method_c(evm_token, TRON_CHAIN_ID, rpc)
    for det in c.get("detected", []):
        bridges.append({"standard": det["standard"], "address": _convert_addr(det.get("hub")),
                        "remotes": [{"chain": rm["chain"], "address": _convert_addr(rm["bridge"])}
                                    for rm in det["remotes"]], "note": det.get("note")})

    d = method_d(evm_token, TRON_CHAIN_ID, rpc)
    from ..evm.verify import verify_bridge_contract
    for a in [x for x in d.get("authorities", []) if x["confidence"] in ("high", "med")]:
        v = verify_bridge_contract(rpc, a["address"])
        if v:  # 브릿지로 확정된 발행권한자만
            bridges.append({"standard": f"{v['standard']} (발행권한 역검증 확정)",
                            "address": _convert_addr(a["address"]), "remotes": [],
                            "note": "발행권한자가 브릿지 인터페이스 응답"})

    # 알려진 Tron 브릿지 lock 금고 직접 대조
    for name, t_addr in KNOWN_BRIDGES:
        evm_b = tron_to_evm(t_addr)
        st, bal = eth_call(rpc, evm_token, "balanceOf(address)", ["address"], [evm_b], ["uint256"])
        if st == "OK" and bal[0] > 0:
            bridges.append({"standard": f"{name} (lock&mint, 잠금 확정)", "address": t_addr,
                            "remotes": [], "note": f"알려진 브릿지에 {bal[0]} 잠김"})

    if not bridges:
        print("\n[i] 감지된 브릿지 없음")
    return {"family": "tron", "token": token, "chain": "tron", "bridges": bridges, "raw": {"c": c, "d": d}}
