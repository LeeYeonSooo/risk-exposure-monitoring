"""라우터 — 토큰 주소/체인을 보고 계열(EVM·Solana·Cosmos)을 판별해 알맞은 어댑터로 분기한다.

이 모듈이 도구의 핵심 진입점이다. 사용자는 계열을 신경 쓸 필요 없이 토큰 주소만 넣으면
라우터가 형식을 보고 자동으로 맞는 어댑터를 호출한다.

  detect("0x...", 1)             → EVM 어댑터 (방법 B/C/D/E)
  detect("EPjF...", "solana")    → Solana 어댑터
  detect("ibc/<HASH>", "osmosis")→ Cosmos 어댑터
"""

from .common import classify_family

# 모든 어댑터가 반환하는 공통 결과 포맷:
#   {
#     "family": "evm" | "solana" | "cosmos",
#     "token":  <입력 토큰>,
#     "chain":  <정규화된 체인>,
#     "bridges": [ { "standard", "address", "remotes":[{chain,address}], "note" }, ... ],
#     "raw":    <계열별 원본 응답>,
#   }


def detect(token, chain=None, rpc=None):
    """토큰의 브릿지를 자동 탐지. 계열은 라우터가 판별한다.

    Args:
        token: 토큰 주소 (EVM 0x..., Solana base58, Cosmos ibc/...)
        chain: 체인 식별자 — EVM 은 정수 chainId(기본 1), Solana 는 'solana',
               Cosmos 는 체인명('osmosis' 등). 생략 시 주소 형식으로 추론.
        rpc:   직접 지정할 RPC/LCD URL (선택).

    Returns:
        공통 포맷 결과 dict. 판별 실패 시 family=None + error.
    """
    family = classify_family(token, chain)
    print("\n" + "█" * 60)
    print(f"[Router] token={token}")
    print(f"         chain 힌트={chain!r}  →  계열: {family or '판별 불가'}")
    print("█" * 60)

    if family == "evm":
        from .evm import detect_evm
        return detect_evm(token, chain, rpc)
    if family == "solana":
        from .solana import detect_solana
        return detect_solana(token, chain or "solana", rpc)
    if family == "tron":
        from .tron import detect_tron
        return detect_tron(token, chain or "tron", rpc)
    if family == "aptos":
        from .aptos import detect_aptos
        return detect_aptos(token, chain or "aptos", rpc)
    if family == "sui":
        from .sui import detect_sui
        return detect_sui(token, chain or "sui", rpc)
    if family == "starknet":
        from .starknet import detect_starknet
        return detect_starknet(token, chain or "starknet", rpc)
    if family == "stellar":
        from .stellar import detect_stellar
        return detect_stellar(token, chain or "stellar", rpc)
    if family == "cosmos":
        from .cosmos import detect_cosmos
        return detect_cosmos(token, chain, rpc)

    print("[!] 체인 계열을 판별하지 못했습니다.")
    print("    chain 인자로 명시하세요 — 예: 1(EVM) · 'solana' · 'osmosis'(Cosmos)")
    return {"family": None, "token": token, "chain": chain, "bridges": [],
            "error": "체인 계열 판별 실패 — chain 인자로 명시 필요"}
