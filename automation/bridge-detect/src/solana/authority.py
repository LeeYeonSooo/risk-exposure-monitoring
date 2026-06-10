"""Solana 발행형 탐지 — SPL 민트의 발행 권한자(mintAuthority) + CCTP.

  ① burn&mint / ② lock&mint(목적지) → mintAuthority 가 곧 발행 주체(브릿지/발행사).
  알려진 브릿지 프로그램/권한자면 확정.
"""

from .rpc import rpc_call

# Circle CCTP — native USDC/EURC 민트 + 프로그램
CCTP_MINTS = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr": "EURC",
}
CCTP_PROGRAM = "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3"  # TokenMessengerMinter

# 알려진 브릿지 프로그램(소유 프로그램/권한자) → 라벨 (holders.py 도 공유)
KNOWN_BRIDGE_PROGRAMS = {
    "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb": "Wormhole Token Bridge (lock&mint)",
    "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth": "Wormhole Core",
    CCTP_PROGRAM: "Circle CCTP (burn&mint)",
    "NTTPobMd5XLzh5Y7hZ4HBQ3JqfUhuFfSGT1KrUmMR9p": "Wormhole NTT",
}
# 알려진 발행 권한자 PDA → 라벨
KNOWN_AUTHORITIES = {
    "BCD75RNBHrJJpW4dXVagL5mPjzRLnVZq4YirJdjEYMV7": "Wormhole Token Bridge (wrapped mint authority)",
}


def detect_authority(rpc, token):
    """발행형 브릿지 목록 반환 (CCTP + mintAuthority)."""
    bridges = []

    # CCTP 알려진 민트
    if token in CCTP_MINTS:
        print(f"[★] Circle CCTP — native {CCTP_MINTS[token]} (burn&mint)")
        bridges.append({"standard": "Circle CCTP", "address": CCTP_PROGRAM, "remotes": [],
                        "note": f"native {CCTP_MINTS[token]}"})

    # SPL 민트의 발행 권한자
    res = rpc_call(rpc, "getAccountInfo", [token, {"encoding": "jsonParsed"}])
    parsed = ((res or {}).get("value") or {}).get("data", {})
    parsed = parsed.get("parsed", {}) if isinstance(parsed, dict) else {}
    if parsed.get("type") == "mint":
        authority = (parsed.get("info") or {}).get("mintAuthority")
        if authority:
            label = KNOWN_AUTHORITIES.get(authority) or KNOWN_BRIDGE_PROGRAMS.get(authority)
            if label:
                print(f"[★ 확정] 발행 권한자 = {label} — {authority}")
                bridges.append({"standard": f"{label} (발행 권한자)", "address": authority,
                                "remotes": [], "note": "mintAuthority = 알려진 브릿지"})
            else:
                # 알려진 브릿지가 아니면 발행사로 보고 출력하지 않음 (브릿지만 보고)
                print(f"[i] 발행 권한자 {authority} — 브릿지 미확정(발행사 추정), 제외")
    return bridges
