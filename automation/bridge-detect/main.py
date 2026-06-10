#!/usr/bin/env python3
"""get_token_bridge_address 진입점 — 토큰 주소를 넣으면 계열을 자동 판별해 브릿지를 찾는다.

지원 계열: EVM(방법 B·C·D·E) · Solana · Cosmos(IBC).
라우터가 토큰 주소 형식과 chain 힌트로 알맞은 어댑터를 자동 선택한다.

사용법(코드):
  from main import main
  main("0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7")          # EVM(Ethereum)
  main("0xd993935e13851dd7517af10687ec7e5022127228", 8453)    # EVM(Base)
  main("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "solana")   # Solana
  main("ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", "osmosis")  # Cosmos

명령줄:
  python main.py <토큰주소> [체인] [RPC]
"""

import sys

from src.router import detect


def print_summary(result):
    print("\n" + "═" * 60)
    print("최종: 이 토큰이 사용 중인 브릿지 주소")
    print("═" * 60)

    if result.get("error"):
        print(f"● {result['error']}")
        return

    bridges = result.get("bridges", [])
    if not bridges:
        print("● 감지된 브릿지 없음 (단일체인 토큰이거나, 토큰이 정보를 미노출)")
        return

    print(f"[계열: {result.get('family')}]  발견 {len(bridges)}건")
    for br in bridges:
        line = f"● {br['standard']} — {br.get('address')}"
        if br.get("note"):
            line += f"   ({br['note']})"
        print(line)
        for rm in br.get("remotes", []):
            print(f"    └ {rm['chain']:<14} {rm['address']}")


def main(token_address, chain=None, rpc=None):
    """토큰 주소를 받아 계열 자동 판별 → 브릿지 탐지 → 요약 출력 + 결과 dict 반환.

    chain 생략 시: 0x주소는 Ethereum(1)로, 그 외는 주소 형식으로 계열 추론.
    """
    result = detect(token_address, chain, rpc)
    print_summary(result)
    return result


if __name__ == "__main__":
    if len(sys.argv) > 1:
        token = sys.argv[1]
        chain = sys.argv[2] if len(sys.argv) > 2 else None
        rpc = sys.argv[3] if len(sys.argv) > 3 else None
        main(token, chain, rpc)
    else:
        # 예시 실행 (토큰 주소만 바꿔 쓰면 됨)
        main("0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7")
