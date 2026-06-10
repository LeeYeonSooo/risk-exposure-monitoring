"""EVM 어댑터 오케스트레이터 — 방법 B·C·D 를 차례로 돌리고, 비면 E(fallback) 실행.

결과를 라우터 공통 포맷(bridges 리스트)으로 정규화해 반환한다.
"""

from .ccip import method_b
from .standards import method_c
from .authority import method_d
from .events import method_e
from .holders import method_f
from .known_bridges import method_g
from .verify import verify_bridge_contract
from .chains import resolve_rpc


def _to_int_chain(chain):
    """EVM 체인 식별자를 정수 체인ID로 정규화 (기본 1=Ethereum)."""
    if chain is None:
        return 1
    if isinstance(chain, int):
        return chain
    s = str(chain).strip()
    return int(s) if s.isdigit() else 1


def detect_evm(token, chain=1, rpc=None):
    """토큰 주소로 EVM 브릿지를 탐지하고 정규화된 결과 dict 를 반환."""
    chain_id = _to_int_chain(chain)

    b = method_b(token, chain_id, rpc)
    c = method_c(token, chain_id, rpc)
    d = method_d(token, chain_id, rpc)

    strong = [a for a in d.get("authorities", []) if a["confidence"] in ("high", "med")]
    found = bool(b.get("pool") or c.get("detected") or strong)
    # B·C·D 가 비면 발행 이벤트(E) → 그래도 없으면 잔고+역검증(F) fallback
    e = method_e(token, chain_id, rpc) if not found else {"candidates": []}
    f = method_f(token, chain_id, rpc) if not (found or e.get("candidates")) else {"verified": [], "candidates": []}
    g = method_g(token, chain_id, rpc)   # 알려진 브릿지 주소 직접 대조 (항상 실행, 금액 무관 lock 탐지)

    # ── 공통 포맷(bridges)으로 정규화 ──
    bridges = []

    for lk in g.get("locked", []):
        bridges.append({"standard": f"{lk['name']} ({lk['type']}, 잠금 확정)", "address": lk["address"],
                        "remotes": [], "note": f"알려진 브릿지 주소에 {lk['balance']} 잠김"})

    if b.get("pool"):
        remotes = [{"chain": r["chain"], "address": rp}
                   for r in b["remotes"] for rp in r["remote_bridge_pools"]]
        bridges.append({"standard": "Chainlink CCIP", "address": b["pool"],
                        "remotes": remotes, "note": "TokenPool (네이티브 브릿지)"})

    for det in c.get("detected", []):
        bridges.append({
            "standard": det["standard"], "address": det.get("hub"),
            "remotes": [{"chain": rm["chain"], "address": rm["bridge"]} for rm in det["remotes"]],
            "note": det.get("note"),
        })

    # 발행권한자(D)·발행이벤트(E) 후보는 "브릿지 인터페이스 역검증"으로 브릿지/발행사 구분
    rpc_r = resolve_rpc(chain_id, rpc)

    def _bridge_only(addr, src_note):
        """발행 권한자/주체가 브릿지 인터페이스에 응답할 때만 dict, 아니면 None(발행사로 보고 버림)."""
        v = verify_bridge_contract(rpc_r, addr) if rpc_r else None
        if not v:
            return None
        return {"standard": f"{v['standard']} (발행권한 역검증 확정)", "address": addr,
                "remotes": [], "note": f"{src_note} → 브릿지 인터페이스 응답 = 브릿지 확정"}

    for a in strong:
        b2 = _bridge_only(a["address"], f"발행권한 {a['reason']}")
        if b2:
            bridges.append(b2)

    for cand in e.get("candidates", [])[:3]:
        b2 = _bridge_only(cand["address"], f"발행이벤트 mint {cand['mint_tx_count']}건")
        if b2:
            bridges.append(b2)

    # 방법 F: 역검증으로 확정된 금고/풀 브릿지 + 미확정 큰 잔고 후보
    for v in f.get("verified", []):
        bridges.append({"standard": f"{v['standard']} (잔고+역검증 확정)", "address": v["address"],
                        "remotes": [], "note": "큰 잔고 + 브릿지 인터페이스 응답 → 확정"})
    for cand in f.get("candidates", [])[:3]:
        bridges.append({"standard": "금고/풀 후보 (미확정)", "address": cand["address"],
                        "remotes": [], "note": "큰 잔고지만 표준 인터페이스 미응답 → 추정"})

    return {"family": "evm", "token": token, "chain": chain_id,
            "bridges": bridges, "raw": {"b": b, "c": c, "d": d, "e": e, "f": f, "g": g}}
