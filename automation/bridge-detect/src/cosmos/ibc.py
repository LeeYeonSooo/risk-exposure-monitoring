"""Cosmos IBC denom-trace — IBC 토큰의 전송 채널(브릿지)과 원본 토큰 추적.

  GET {lcd}/ibc/apps/transfer/v1/denom_traces/{hash}
    → { denom_trace: { path: "transfer/channel-0", base_denom: "uatom" } }
"""

from .rpc import lcd_for, get_json


def denom_trace(lcd, ibc_hash):
    """IBC denom-trace 조회 (신/구 경로 모두 시도)."""
    for path in ("ibc/apps/transfer/v1/denom_traces",
                 "ibc/applications/transfer/v1/denom_traces"):
        j = get_json(f"{lcd}/{path}/{ibc_hash}")
        if j and j.get("denom_trace"):
            return j["denom_trace"]
    return None


def detect_ibc(token, chain, rpc=None):
    """IBC 브릿지(채널)·원본 토큰을 (bridges, raw) 로 반환."""
    lcd = rpc or lcd_for(chain)
    ibc_hash = token[4:]
    print(f"[i] lcd={lcd}\n")

    trace = denom_trace(lcd, ibc_hash)
    if not trace:
        print("[!] denom-trace 조회 실패 (LCD 응답 없음 또는 미등록 토큰)")
        return [], {"denom_trace": None}

    path = trace.get("path", "")        # 예: "transfer/channel-0"
    base = trace.get("base_denom", "")  # 예: "uatom"
    channel = path.split("/")[-1] if path else None   # 이 체인이 받은 브릿지 채널

    print("[★] IBC Transfer 브릿지 감지")
    print(f"    채널(path): {path}")
    print(f"    원본 denom : {base}")

    bridges = [{
        "standard": "IBC Transfer",
        "address": channel,
        "remotes": [{"chain": "origin", "address": base}],
        "note": f"IBC 경로 {path} 로 들어온 토큰. 원본 denom={base}",
    }]
    return bridges, {"denom_trace": trace}
