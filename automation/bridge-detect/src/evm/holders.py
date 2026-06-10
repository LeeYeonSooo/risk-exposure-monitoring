"""방법 F — 금고/풀 잔고 분석 + 인터페이스 역검증.

lock&mint 원본(잠김)·유동성 풀은 토큰 컨트랙트에 흔적이 없고 mint 도 안 한다.
대신 그 브릿지는 토큰을 **대량 보유**한다(금고에 잠그거나 풀에 공급).

  1) 최근 Transfer 를 모아 토큰을 많이 받은 주소(=금고/풀 후보)를 찾고
  2) 각 후보의 balanceOf 로 실제 큰 잔고를 확인한 뒤
  3) verify_bridge_contract 로 "그 주소가 진짜 브릿지인지" 인터페이스로 역검증한다.

→ '잔고 크다'(정황) 를 '브릿지 함수에 응답한다'(구조적 증거) 로 승격해 라벨 없이 확정.
"""

from eth_utils import keccak, to_checksum_address

from .rpc import rpc_request, eth_call
from .chains import resolve_rpc
from .verify import verify_bridge_contract

TRANSFER_TOPIC = "0x" + keccak(text="Transfer(address,address,uint256)").hex()
WINDOWS = [200000, 50000, 10000, 2000]   # getLogs 청크 (한도 초과 시 축소)
MAX_CHUNKS = 6
MAX_CANDIDATES = 15                       # balanceOf/검증 대상 상한


def _scan_received(rpc, token, latest):
    """최근 Transfer 로그를 모아 {수신주소: 누적 수신량} 집계."""
    received = {}
    # 허용되는 최대 청크 크기 탐색
    win = None
    for w in WINDOWS:
        test = rpc_request(rpc, "eth_getLogs", [{
            "address": token, "topics": [TRANSFER_TOPIC],
            "fromBlock": hex(max(0, latest - w)), "toBlock": hex(latest)}])
        if test is not None:
            win = w
            logs = test
            break
    if win is None:
        return received, None
    # 페이지네이션
    end = latest
    for _ in range(MAX_CHUNKS):
        frm = max(0, end - win)
        chunk = rpc_request(rpc, "eth_getLogs", [{
            "address": token, "topics": [TRANSFER_TOPIC],
            "fromBlock": hex(frm), "toBlock": hex(end)}]) if end != latest else logs
        end = frm - 1
        for lg in (chunk or []):
            topics = lg.get("topics") or []
            if len(topics) < 3:
                continue
            to_addr = "0x" + topics[2][-40:]
            data = lg.get("data") or "0x"
            try:
                val = int(data, 16) if data not in ("", "0x") else 0
            except ValueError:
                val = 0
            received[to_addr] = received.get(to_addr, 0) + val
        if end <= 0:
            break
    return received, win


def _is_contract(rpc, addr):
    code = rpc_request(rpc, "eth_getCode", [addr, "latest"])
    return bool(code) and code != "0x"


def _balance_of(rpc, token, addr):
    st, res = eth_call(rpc, token, "balanceOf(address)", ["address"],
                       [to_checksum_address(addr)], ["uint256"])
    return res[0] if st == "OK" else 0


def method_f(token_address, src_chain, rpc):
    print("\n" + "=" * 60)
    print("[방법 F] 금고/풀 잔고 분석 + 인터페이스 역검증")
    print("=" * 60)
    rpc = resolve_rpc(src_chain, rpc)
    if not rpc:
        print("[!] 읽기 RPC 를 찾지 못함")
        return {"verified": [], "candidates": []}
    token = to_checksum_address(token_address)

    latest_hex = rpc_request(rpc, "eth_blockNumber", [])
    if not latest_hex:
        print("[!] eth_blockNumber 실패")
        return {"verified": [], "candidates": []}
    latest = int(latest_hex, 16)

    received, win = _scan_received(rpc, token, latest)
    if not received:
        print("[i] 최근 Transfer 가 없거나 getLogs 제한으로 후보를 못 찾음")
        return {"verified": [], "candidates": []}

    # 수신량 상위 후보의 실제 잔고 확인 → 큰 잔고 컨트랙트만
    ranked = sorted(received.items(), key=lambda x: -x[1])[:MAX_CANDIDATES]
    big = []
    for addr, _recv in ranked:
        if int(addr, 16) == 0 or to_checksum_address(addr) == token:
            continue
        bal = _balance_of(rpc, token, addr)
        if bal > 0 and _is_contract(rpc, addr):
            big.append((to_checksum_address(addr), bal))
    big.sort(key=lambda x: -x[1])

    print(f"[i] 약 {win and win*MAX_CHUNKS:,}블록 스캔, 큰 잔고 컨트랙트 {len(big)}개 검증\n")

    verified, candidates = [], []
    for addr, bal in big[:8]:
        v = verify_bridge_contract(rpc, addr)
        if v:
            verified.append({"address": addr, "balance": bal, **v})
            print(f"  [★ 확정] {addr}  → {v['standard']}  (잔고 {bal})")
        else:
            candidates.append({"address": addr, "balance": bal})
            print(f"  [후보]   {addr}  (큰 잔고, 인터페이스 미확인)")

    if not verified and not candidates:
        print("[i] 큰 잔고의 컨트랙트형 보유자 없음")
    return {"verified": verified, "candidates": candidates}
