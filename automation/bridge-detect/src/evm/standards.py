"""방법 C — 온체인 다중 표준 감지.

토큰의 view 함수(지문)를 프로빙해 어떤 브릿지 표준인지 식별한다.
각 프로브는 매칭되면 dict, 아니면 None 을 반환한다.
"""

from eth_utils import keccak, to_checksum_address

from .rpc import eth_call, rpc_request, addr_or_none, try_addr
from .chains import resolve_rpc, lz_eid_names


def probe_layerzero(rpc, token, src_chain):
    sig, ep = try_addr(rpc, token, "endpoint()", "lzEndpoint()")
    if not ep:
        return None
    sta, inner = eth_call(rpc, token, "token()", [], [], ["address"])
    inner_tok = addr_or_none(inner) if sta == "OK" else None
    kind = f"OFTAdapter (wraps {inner_tok})" if inner_tok else "OFT (토큰 자체)"
    eids = lz_eid_names()
    peers = []
    for eid in sorted(eids):
        st, res = eth_call(rpc, token, "peers(uint32)", ["uint32"], [eid], ["bytes32"])
        if st == "OK" and int.from_bytes(res[0], "big") != 0:
            peers.append({"chain": eids[eid], "id": eid,
                          "bridge": to_checksum_address("0x" + res[0].hex()[-40:])})
    return {"standard": "LayerZero OFT", "hub": ep, "kind": kind, "remotes": peers}


def probe_xerc20(rpc, token, src_chain):
    sig, lb = try_addr(rpc, token, "lockbox()")
    if not lb:
        return None
    return {"standard": "xERC20 (EIP-7281)", "hub": lb, "kind": "lockbox",
            "remotes": [], "note": "체인별 bridge 는 공식 배포/이벤트에서 확인"}


def probe_hyperlane(rpc, token, src_chain):
    sig, mb = try_addr(rpc, token, "mailbox()")
    if not mb:
        return None
    st, res = eth_call(rpc, token, "domains()", [], [], ["uint32[]"])
    domains = list(res[0]) if st == "OK" else []
    remotes = []
    for d in domains:
        st, r = eth_call(rpc, token, "routers(uint32)", ["uint32"], [d], ["bytes32"])
        if st == "OK" and int.from_bytes(r[0], "big") != 0:
            remotes.append({"chain": f"domain:{d}", "id": d,
                            "bridge": to_checksum_address("0x" + r[0].hex()[-40:])})
    return {"standard": "Hyperlane Warp", "hub": mb, "kind": "mailbox", "remotes": remotes}


def probe_optimism(rpc, token, src_chain):
    sig, l1 = try_addr(rpc, token, "remoteToken()", "l1Token()")
    if not l1:
        return None
    _, br = try_addr(rpc, token, "bridge()", "BRIDGE()", "l2Bridge()")
    return {"standard": "OP Standard Bridge", "hub": br, "kind": "OptimismMintableERC20",
            "remotes": [{"chain": "L1 origin", "id": 0, "bridge": l1}],
            "note": "OP-계열 체인의 브릿지 발행 토큰. hub=이 체인의 StandardBridge, remote=L1 원본 토큰"}


def probe_arbitrum(rpc, token, src_chain):
    # l1Address() 는 Arbitrum·zkSync 둘 다 쓰므로 체인ID로 구분 + l2Bridge 수집
    sig, l1 = try_addr(rpc, token, "l1Address()")
    if not l1:
        return None
    l2bridge = try_addr(rpc, token, "l2Bridge()", "bridge()", "BRIDGE()")[1]
    if src_chain == 324:
        std, note = "zkSync Bridge", "zkSync 게이트웨이 발행 토큰. hub=l2Bridge, remote=L1 원본"
    elif src_chain == 42161:
        std, note = "Arbitrum Bridge", "Arbitrum 게이트웨이 발행 토큰. remote=L1 원본"
    else:
        std, note = "L2 Canonical Bridge", "l1Address 보유(Arbitrum/zkSync 계열). remote=L1 원본"
    return {"standard": std, "hub": l2bridge, "kind": "l1Address token",
            "remotes": [{"chain": "L1 origin", "id": 0, "bridge": l1}], "note": note}


def probe_axelar(rpc, token, src_chain):
    st, res = eth_call(rpc, token, "interchainTokenId()", [], [], ["bytes32"])
    has_id = st == "OK" and int.from_bytes(res[0], "big") != 0
    sig, its = try_addr(rpc, token, "interchainTokenService()")
    if not has_id and not its:
        return None
    tid = "0x" + res[0].hex() if has_id else None
    return {"standard": "Axelar ITS", "hub": its, "kind": "Interchain Token",
            "remotes": [], "note": f"tokenId={tid}. 체인별 주소는 ITS.tokenManagerAddress(tokenId) 로 조회"}


# CCTP V2 TokenMessenger 는 거의 모든 체인에 동일(결정적) 주소로 배포됨.
CCTP_V2_TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"


def probe_cctp(rpc, token, src_chain):
    """온체인 감지: Circle USDC/EURC(FiatToken) + 이 체인에 CCTP V2 배포 여부.
       하드코딩 토큰목록 없이 어떤 체인의 native USDC/EURC 든 잡는다."""
    ss, sym = eth_call(rpc, token, "symbol()", [], [], ["string"])
    symbol = sym[0] if ss == "OK" else ""
    if symbol not in ("USDC", "EURC"):
        return None
    # masterMinter 는 Circle FiatToken 의 지문 (브릿지된 USDC.e 는 없음)
    sm, mm = eth_call(rpc, token, "masterMinter()", [], [], ["address"])
    if sm != "OK" or int(mm[0], 16) == 0:
        return None
    # 이 체인에 CCTP V2 TokenMessenger 가 배포(코드 존재)돼 있는지
    code = rpc_request(rpc, "eth_getCode", [CCTP_V2_TOKEN_MESSENGER, "latest"])
    if not code or code == "0x":
        return None
    return {"standard": "Circle CCTP", "hub": to_checksum_address(CCTP_V2_TOKEN_MESSENGER),
            "kind": f"native {symbol} (CCTP V2)", "remotes": [],
            "note": "TokenMessengerV2(=hub)가 모든 CCTP 체인 공통 진입점 (결정적 주소)"}


def probe_polygon(rpc, token, src_chain):
    """Polygon PoS child token: DEPOSITOR_ROLE 보유자 = ChildChainManager(브릿지)."""
    role = keccak(text="DEPOSITOR_ROLE")
    st, c = eth_call(rpc, token, "getRoleMemberCount(bytes32)", ["bytes32"], [role], ["uint256"])
    if st != "OK" or c[0] == 0:
        return None
    members = []
    for i in range(min(c[0], 5)):
        s, m = eth_call(rpc, token, "getRoleMember(bytes32,uint256)", ["bytes32", "uint256"], [role, i], ["address"])
        if s == "OK" and int(m[0], 16) != 0:
            members.append(to_checksum_address(m[0]))
    if not members:
        return None
    return {"standard": "Polygon PoS", "hub": members[0], "kind": "ChildChainManager(depositor)",
            "remotes": [{"chain": "depositor", "id": 0, "bridge": a} for a in members],
            "note": "DEPOSITOR_ROLE 보유자 = Polygon PoS 브릿지(ChildChainManager)"}


def probe_wormhole_ntt(rpc, token, src_chain):
    """Wormhole NTT: token.minter() 가 NttManager(=token() 일치 + getMode 보유)."""
    _, m = try_addr(rpc, token, "minter()")
    if not m:
        return None
    st, t = eth_call(rpc, m, "token()", [], [], ["address"])
    if st != "OK" or int(t[0], 16) == 0 or to_checksum_address(t[0]) != token:
        return None
    sm, _mode = eth_call(rpc, m, "getMode()", [], [], ["uint8"])
    if sm != "OK":
        return None
    return {"standard": "Wormhole NTT", "hub": m, "kind": "NttManager",
            "remotes": [], "note": "NttManager=발행 관리자. 연결 체인은 manager.getPeer(chainId) 로 조회"}


PROBES = [probe_layerzero, probe_xerc20, probe_hyperlane, probe_optimism,
          probe_arbitrum, probe_axelar, probe_cctp, probe_polygon, probe_wormhole_ntt]


def method_c(token_address, src_chain, rpc):
    print("\n" + "=" * 60)
    print("[방법 C] 온체인 다중 표준 감지")
    print("  (LayerZero·xERC20·Hyperlane·OP·Arbitrum·Axelar·CCTP·Polygon·Wormhole NTT)")
    print("=" * 60)
    rpc = resolve_rpc(src_chain, rpc)
    if not rpc:
        print(f"[!] 체인 {src_chain} 읽기 RPC 를 찾지 못함 — --rpc 로 지정 필요")
        return {"detected": []}
    token = to_checksum_address(token_address)

    detected = []
    for probe in PROBES:
        try:
            r = probe(rpc, token, src_chain)
        except Exception:
            r = None
        if r:
            detected.append(r)
            print(f"\n[★] {r['standard']} 감지 — hub={r.get('hub')} ({r['kind']})")
            if r.get("note"):
                print(f"    {r['note']}")
            for rm in r["remotes"]:
                print(f"    └ {rm['chain']:<14} {rm['bridge']}")
            if r["standard"] == "LayerZero OFT":
                print(f"    연결 체인 {len(r['remotes'])}개")

    if not detected:
        print("\n[i] 알려진 온체인 브릿지 표준이 이 주소에서 감지되지 않음.")
        print("    (lock&mint 토큰은 별도 어댑터 주소로 조회, 또는 방법 B/D 로 확인)")
    return {"detected": detected}
