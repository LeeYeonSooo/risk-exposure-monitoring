"""Solana 잠김/풀형 탐지 — 대량 보유 계정(금고/풀) + 소유 프로그램 역검증.

  ② lock&mint(원본) / ③ 유동성 풀 → getTokenLargestAccounts 로 대량 보유 계정 발견
  → 그 계정의 소유 프로그램이 알려진 브릿지면 확정 (EVM 방법 F 의 Solana 판).

주의: 공개 RPC 는 getTokenLargestAccounts 를 제한(429), 대형 토큰(USDC 등)은 계정 수
초과로 거부될 수 있다 → 한도 넉넉한 RPC(Helius) 권장, 대형 토큰은 발행형으로 대체 감지.
"""

from .rpc import rpc_call, account_owner
from .authority import KNOWN_BRIDGE_PROGRAMS

# 브릿지가 아닌 흔한 DEX/시스템 프로그램 — 대량 보유자 노이즈. 제외.
NOISE_PROGRAMS = {
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   # Orca Whirlpool
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",   # Raydium AMM v4
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",   # Raydium CLMM
    "11111111111111111111111111111111",              # System Program (지갑)
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   # SPL Token Program
}


def detect_holders(rpc, token):
    """잠김/풀형 브릿지 목록 반환 (대량 보유 + 브릿지 프로그램 확정)."""
    bridges = []
    largest = rpc_call(rpc, "getTokenLargestAccounts", [token])
    if not (largest and largest.get("value")):
        print("\n[i] getTokenLargestAccounts 미응답/거부 "
              "(공개 RPC 429 또는 대형 토큰) — 한도 넉넉한 RPC 권장")
        return bridges

    print("\n[i] 대량 보유 계정(금고/풀 후보) 분석:")
    for acc in largest["value"][:5]:
        authority = account_owner(rpc, acc["address"])             # 토큰계정 authority(지갑/PDA)
        program = account_owner(rpc, authority) if authority else None  # 그 PDA 의 소유 프로그램
        amt = acc.get("uiAmountString") or acc.get("amount")
        label = KNOWN_BRIDGE_PROGRAMS.get(program) or KNOWN_BRIDGE_PROGRAMS.get(authority)
        if label:
            print(f"  [★ 확정] {authority}  → {label}  (잔고 {amt})")
            bridges.append({"standard": f"{label} (금고/풀)", "address": authority, "remotes": [],
                            "note": f"대량 보유 + 브릿지 프로그램 소유 (잔고 {amt})"})
        elif program in NOISE_PROGRAMS or authority in NOISE_PROGRAMS:
            continue  # DEX/지갑 노이즈 제외
        elif authority:
            print(f"  [후보]   {authority}  (대량 보유, 프로그램 미확인)")
    return bridges
