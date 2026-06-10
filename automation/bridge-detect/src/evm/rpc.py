"""저수준 온체인 호출 계층 — eth_call 과 주소 디코딩 헬퍼."""

import requests
from eth_utils import keccak, to_checksum_address
from eth_abi import encode, decode


def rpc_request(rpc, method, params):
    """범용 JSON-RPC 호출. 성공 시 result, 실패/에러 시 None."""
    try:
        j = requests.post(rpc, json={"jsonrpc": "2.0", "id": 1,
                                     "method": method, "params": params}, timeout=30).json()
    except Exception:
        return None
    if "error" in j:
        return None
    return j.get("result")


def eth_call(rpc, to, sig, types, values, ret):
    """단일 eth_call. 반환: (status, decoded) — status ∈ {OK, EMPTY, ERR, BADRESP, DECODE}."""
    sel = keccak(text=sig)[:4]
    data = "0x" + (sel + (encode(types, values) if types else b"")).hex()
    try:
        j = requests.post(rpc, json={"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                                     "params": [{"to": to, "data": data}, "latest"]}, timeout=25).json()
    except Exception as e:
        return ("BADRESP", str(e)[:60])
    if "error" in j:
        return ("ERR", j["error"].get("message"))
    result = j.get("result")
    if not result or result == "0x":
        return ("EMPTY", None)
    try:
        raw = bytes.fromhex(result[2:])
        return ("OK", decode(ret, raw))   # 비표준 응답이면 decode 가 throw → 아래서 흡수
    except Exception as e:
        return ("DECODE", str(e)[:40])    # 디코드 실패도 멈추지 않고 흡수


def addr_from_bytes(b):
    """bytes(보통 bytes32) → checksum 주소 (하위 20바이트). 비어있으면 None."""
    return to_checksum_address("0x" + b[-20:].hex()) if b else None


def addr_or_none(res):
    """address 디코드 결과가 0이 아니면 checksum 주소, 아니면 None."""
    return to_checksum_address(res[0]) if res and int(res[0], 16) != 0 else None


def try_addr(rpc, token, *sigs):
    """여러 후보 시그니처 중 처음으로 0이 아닌 주소를 반환. 반환: (sig, addr) 또는 (None, None)."""
    for sig in sigs:
        st, res = eth_call(rpc, token, sig, [], [], ["address"])
        if st == "OK":
            a = addr_or_none(res)
            if a:
                return sig, a
    return None, None
