"""Stellar 어댑터 — 검증된 발행자 화이트리스트로 확정 (오탐 0).

Stellar 의 classic 자산은 `CODE:ISSUER` 형식으로, 컨트랙트가 아니라 '발행자 계정'이 찍는다.
StarkGate·Wormhole 처럼 온체인으로 역검증할 브릿지 인터페이스가 **없다**. 게다가 `home_domain`
은 발행자가 자기신고하는 값이라 가짜 'USDC'(임의 도메인)가 수십 개 존재 → 스푸핑 가능.

따라서 라벨/도메인에 기대지 않고 **EXACT 발행자 주소 화이트리스트**(실측 검증된 것만)로
확정한다 — EVM 방법 G·Solana known_bridges·Tron KNOWN_BRIDGES 와 같은 방식(오탐 0).
화이트리스트에 없는 발행자는 발행사로 보고 확정하지 않는다(누락 > 오탐).
"""

from .rpc import resolve_horizon, account

# 실측 검증한 발행자 계정(Horizon home_domain 확인) → (라벨, note)
# 새 브릿지(Allbridge 등)는 발행자 주소를 직접 검증한 뒤에만 추가한다.
KNOWN_ISSUERS = {
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN":
        ("Circle CCTP (native USDC)", "Circle 발행 USDC (home_domain=circle.com) — CCTP burn&mint"),
    "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2":
        ("Circle CCTP (native EURC)", "Circle 발행 EURC (home_domain=circle.com) — CCTP burn&mint"),
}


def _parse_asset(token):
    """'CODE:ISSUER' → (code, issuer). XLM/native → ('XLM', None). 형식오류 → (None, None)."""
    t = (token or "").strip()
    if t.lower() in ("xlm", "native"):
        return "XLM", None
    if ":" in t:
        code, _, issuer = t.partition(":")
        return code.strip(), issuer.strip()
    if t.startswith("G") and len(t) == 56:   # 발행자 주소만 준 경우
        return None, t
    return None, None


def detect_stellar(token, chain="stellar", rpc=None):
    print("\n" + "=" * 60)
    print("[Stellar] 발행자 화이트리스트 — 검증된 브릿지/발행자만 확정")
    print("=" * 60)
    horizon = resolve_horizon(rpc)
    code, issuer = _parse_asset(token)

    if issuer is None:
        msg = "XLM 네이티브 → 브릿지 없음" if code == "XLM" else \
              "Stellar 자산은 CODE:ISSUER 형식 필요 (예: USDC:GA5ZSEJY…)"
        print(f"[i] {msg}")
        return {"family": "stellar", "token": token, "chain": "stellar", "bridges": [],
                "raw": {"code": code, "issuer": None}}

    acc = account(horizon, issuer)
    domain = (acc or {}).get("home_domain")
    print(f"[i] {code or '?'}  issuer={issuer[:10]}…  home_domain={domain}  (자기신고값, 확정 근거 아님)")

    bridges = []
    if issuer in KNOWN_ISSUERS:
        label, note = KNOWN_ISSUERS[issuer]
        print(f"  [★ 확정] {label}")
        bridges.append({"standard": f"{label} (발행자 확정)", "address": issuer,
                        "remotes": [], "note": note})
    else:
        print(f"  [i] 검증된 브릿지 발행자 화이트리스트에 없음 → 온체인 확정 불가(발행사 추정).")

    if not bridges:
        print("\n[i] 감지된 브릿지 없음 "
              "(Stellar 발행자 기반 — 인터페이스가 없어 검증 화이트리스트 외엔 확정 불가)")

    return {"family": "stellar", "token": token, "chain": "stellar",
            "bridges": bridges, "raw": {"code": code, "issuer": issuer, "home_domain": domain}}
