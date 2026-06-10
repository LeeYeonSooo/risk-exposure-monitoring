"""방법 E — 발행(mint) 이벤트 추적 (강화판).

토큰이 함수로 브릿지를 안 알려줘도, 실제 발행 기록(Transfer from 0x0)은 체인에 남는다.
그 mint 를 일으킨 트랜잭션의 대상 컨트랙트를 빈도순으로 집계하면 브릿지가 드러난다.

강화점:
  - 구간 페이지네이션: 공개 RPC 가 getLogs 범위를 좁게 제한해도 과거로 여러 번 훑어 더 넓게 커버.
  - 노이즈 필터: DEX 정산/애그리게이터 컨트랙트(스왑 중 발행에 끼어듦)를 제외.
  - 아카이브 RPC 를 넘기면 한 번에 더 넓은 구간을 잡아 더 잘 복구된다.
"""

from eth_utils import keccak, to_checksum_address

from .rpc import rpc_request
from .chains import resolve_rpc

TRANSFER_TOPIC = "0x" + keccak(text="Transfer(address,address,uint256)").hex()
ZERO_TOPIC = "0x" + "00" * 32          # indexed from == address(0) (mint)
WINDOWS = [200000, 50000, 10000, 2000]  # 한 청크 getLogs 범위 (RPC 한도 초과 시 축소)
MAX_CHUNKS = 12                        # 과거로 훑는 청크 수 (페이지네이션)
TARGET_TXS = 30                        # 이만큼 mint tx 모으면 조기 종료
MAX_TX_LOOKUPS = 40                    # tx 조회 상한

# 브릿지가 아닌 흔한 인프라(스왑 정산/애그리게이터) — 발행에 끼어들어 노이즈가 됨. 제외.
NOISE = {a.lower() for a in [
    "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",  # CoW Protocol GPv2Settlement
    "0x1111111254EEB25477B68fb85Ed929f73A960582",  # 1inch AggregationRouter V5
    "0x111111125421cA6dc452d289314280a0f8842A65",  # 1inch AggregationRouter V6
    "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",  # 0x Exchange Proxy
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",  # Uniswap Universal Router
    "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",  # KyberSwap Meta Aggregator
    "0xE592427A0AEce92De3Edee1F18E0157C05861564",  # Uniswap V3 SwapRouter
]}


def _max_window(rpc, token, latest):
    """RPC 가 허용하는 가장 큰 getLogs 청크 크기를 찾는다."""
    for win in WINDOWS:
        frm = max(0, latest - win)
        logs = rpc_request(rpc, "eth_getLogs", [{
            "address": token, "topics": [TRANSFER_TOPIC, ZERO_TOPIC],
            "fromBlock": hex(frm), "toBlock": hex(latest)}])
        if logs is not None:
            return win, logs
    return None, None


def _is_contract(rpc, addr):
    code = rpc_request(rpc, "eth_getCode", [addr, "latest"])
    return bool(code) and code != "0x"


def method_e(token_address, src_chain, rpc):
    print("\n" + "=" * 60)
    print("[방법 E] 발행(mint) 이벤트 추적 — 함수로 안 잡히는 브릿지 탐지")
    print("=" * 60)
    rpc = resolve_rpc(src_chain, rpc)
    if not rpc:
        print(f"[!] 체인 {src_chain} 읽기 RPC 를 찾지 못함 — RPC 직접 지정 필요")
        return {"candidates": []}
    token = to_checksum_address(token_address)

    latest_hex = rpc_request(rpc, "eth_blockNumber", [])
    if not latest_hex:
        print("[!] eth_blockNumber 실패 — RPC 응답 없음")
        return {"candidates": []}
    latest = int(latest_hex, 16)

    win, first = _max_window(rpc, token, latest)
    if win is None:
        print("[!] eth_getLogs 실패 (RPC가 로그 조회를 제한). 아카이브 RPC 지정 권장")
        return {"candidates": []}

    # 페이지네이션: 과거로 청크 단위 훑으며 mint 로그 누적 (충분히 모이면 조기 종료)
    logs = list(first or [])
    end = latest - win - 1
    chunks = 1
    seen_tx = {lg.get("transactionHash") for lg in logs if lg.get("transactionHash")}
    while len(seen_tx) < TARGET_TXS and chunks < MAX_CHUNKS and end > 0:
        frm = max(0, end - win)
        chunk = rpc_request(rpc, "eth_getLogs", [{
            "address": token, "topics": [TRANSFER_TOPIC, ZERO_TOPIC],
            "fromBlock": hex(frm), "toBlock": hex(end)}])
        chunks += 1
        end = frm - 1
        if not chunk:
            continue
        logs += chunk
        seen_tx |= {lg.get("transactionHash") for lg in chunk if lg.get("transactionHash")}

    blocks_scanned = win * chunks
    if not logs:
        print(f"[i] 최근 약 {blocks_scanned:,}블록({chunks}청크) 내 발행 기록 없음")
        return {"candidates": []}

    # mint 트랜잭션의 대상 컨트랙트(tx.to)를 빈도순 집계
    counts, looked = {}, set()
    for lg in logs:
        h = lg.get("transactionHash")
        if not h or h in looked:
            continue
        looked.add(h)
        if len(looked) > MAX_TX_LOOKUPS:
            break
        tx = rpc_request(rpc, "eth_getTransactionByHash", [h])
        to = tx and tx.get("to")
        if not to:
            continue
        a = to_checksum_address(to)
        if a == token or a.lower() in NOISE:   # 노이즈/자기자신 제외
            continue
        counts[a] = counts.get(a, 0) + 1

    if not counts:
        print(f"[i] 약 {blocks_scanned:,}블록 분석 — 브릿지 후보 특정 실패(노이즈만 있거나 EOA 발행)")
        return {"candidates": []}

    ranked = sorted(counts.items(), key=lambda x: -x[1])
    candidates = [{"address": a, "mint_tx_count": n} for a, n in ranked if _is_contract(rpc, a)]

    print(f"[i] 약 {blocks_scanned:,}블록({chunks}청크), mint {len(looked)}건 분석\n")
    if candidates:
        print("[★] 발행을 일으킨 컨트랙트 (브릿지 후보, 발행 빈도순):")
        for c in candidates[:5]:
            print(f"    - {c['address']}  (mint {c['mint_tx_count']}건)")
        print("    ※ 빈도 1위가 브릿지일 가능성이 가장 높음")
    else:
        print("[i] 컨트랙트형 발행 주체 없음 (EOA가 직접 mint했을 수 있음)")
    return {"candidates": candidates}
