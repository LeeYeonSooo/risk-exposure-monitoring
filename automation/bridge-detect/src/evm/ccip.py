"""방법 B — 온체인 Chainlink CCIP.

TokenAdminRegistry.getPool(토큰) → 토큰 전용 TokenPool(브릿지)
→ getSupportedChains()/getRemotePools()/getRemoteToken() 로 연결 체인별 브릿지·토큰 주소.
"""

from eth_utils import to_checksum_address

from .rpc import eth_call, addr_from_bytes
from .chains import ccip_registries, resolve_rpc, selector_names


def method_b(token_address, src_chain, rpc):
    print("\n" + "=" * 60)
    print("[방법 B] 온체인 CCIP — 네이티브 전용 브릿지(TokenPool) 탐색")
    print("=" * 60)
    registry = ccip_registries().get(src_chain)
    if not registry:
        print(f"[i] 체인 {src_chain} 은 CCIP 미지원 체인 → CCIP 브릿지 없음 (정상)")
        return {"pool": None, "remotes": []}
    rpc = resolve_rpc(src_chain, rpc)
    if not rpc:
        print(f"[!] 체인 {src_chain} 읽기 RPC 를 찾지 못함 — --rpc 로 지정 필요")
        return {"pool": None, "remotes": []}
    print(f"[i] registry={registry}  rpc={rpc[:45]}…\n")

    token = to_checksum_address(token_address)
    st, res = eth_call(rpc, to_checksum_address(registry), "getPool(address)", ["address"], [token], ["address"])
    if st != "OK" or int(res[0], 16) == 0:
        print(f"[!] getPool 실패/미등록 → 이 토큰은 CCIP TokenPool 이 없음 ({st}: {res})")
        return {"pool": None, "remotes": []}
    pool = to_checksum_address(res[0])
    print(f"[★] {token_address} 의 CCIP TokenPool (현재 네이티브 브릿지):")
    print(f"    {pool}\n")

    st, chains = eth_call(rpc, pool, "getSupportedChains()", [], [], ["uint64[]"])
    selectors = list(chains[0]) if st == "OK" else []
    names = selector_names()
    remotes = []
    for sel in selectors:
        cname = names.get(sel, f"selector:{sel}")
        sp, pools = eth_call(rpc, pool, "getRemotePools(uint64)", ["uint64"], [sel], ["bytes[]"])
        stk, tok = eth_call(rpc, pool, "getRemoteToken(uint64)", ["uint64"], [sel], ["bytes"])
        remote_pools = [addr_from_bytes(b) for b in pools[0]] if sp == "OK" else []
        remote_token = addr_from_bytes(tok[0]) if stk == "OK" else None
        remotes.append({"chain": cname, "selector": sel,
                        "remote_bridge_pools": remote_pools, "remote_token": remote_token})
        print(f"  ✔ {cname:<14}")
        for rp in remote_pools:
            print(f"        브릿지(remote pool): {rp}")
        print(f"        그 체인 토큰        : {remote_token}")

    print(f"\n[B 요약] 연결 체인 {len(remotes)}개 / 메인 TokenPool: {pool}")
    return {"pool": pool, "remotes": remotes}
