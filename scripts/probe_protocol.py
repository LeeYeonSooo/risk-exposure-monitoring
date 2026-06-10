#!/usr/bin/env python3
"""
프로토콜 이벤트 프로브 하네스 — 흐름맵 디코더 추가 자동화 (docs/flow-situation-board.md)

주소만 주면:
  1) 코드 존재 확인 → 최근 N블록 로그 수집 (publicnode, 어댑티브 청킹)
  2) distinct topic0 별 빈도·shape(ntopics/datawords) 집계
  3) openchain.xyz 시그니처 DB 벌크 조회 → 이벤트 이름+인자형 자동 해석
  4) (옵션 --selectors) 그 로그들이 속한 tx 의 input selector 도 역조회 → 함수↔이벤트 교차증거
  5) 액션 후보(supply/withdraw/borrow/repay/…) 분류 + TS 매핑 스니펫 출력

⚠ 마지막 판단(이 Withdraw 가 '인출'인지 '차입'인지 등 의미)은 사람이 한다 — 하네스는 증거만 제시.
   검증 사례: Aave V3 (8/8 자동 해석), Compound V3 (base 인출/차입 혼재 발견은 사람 몫이었음).

사용:
  python3 scripts/probe_protocol.py 0x87870bca... --name "Aave Core" --blocks 1800 --selectors
"""
import argparse
import json
import sys
import urllib.request
from collections import Counter, defaultdict

HDR = {"content-type": "application/json", "user-agent": "Mozilla/5.0 chain-spiral-probe/0.1"}
RPCS = ["https://ethereum-rpc.publicnode.com", "https://rpc.mevblocker.io"]
OPENCHAIN = "https://api.openchain.xyz/signature-database/v1/lookup"
ACTION_WORDS = ["supply", "deposit", "withdraw", "borrow", "repay", "mint", "burn", "redeem", "liquidat", "operate", "transfer", "flash"]


def rpc(method, params, timeout=60):
    last = None
    for url in RPCS:
        try:
            req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), headers=HDR)
            r = json.load(urllib.request.urlopen(req, timeout=timeout))
            if "error" in r:
                last = r["error"]
                continue
            return r["result"]
        except Exception as e:  # noqa: BLE001
            last = e
    raise SystemExit(f"RPC {method} 실패: {str(last)[:200]}")


def get_logs(addr, frm, to):
    """어댑티브 청킹 — 전체 범위 시도, 실패 시 반으로."""
    try:
        return rpc("eth_getLogs", [{"address": addr, "fromBlock": hex(frm), "toBlock": hex(to)}])
    except SystemExit:
        if to - frm < 50:
            raise
        mid = (frm + to) // 2
        return get_logs(addr, frm, mid) + get_logs(addr, mid + 1, to)


def openchain_lookup(kind, ids):
    """kind: 'event'(topic0) | 'function'(4byte). 20개씩 벌크."""
    out = {}
    ids = [i for i in ids if i]
    for i in range(0, len(ids), 20):
        chunk = ",".join(ids[i:i + 20])
        try:
            req = urllib.request.Request(f"{OPENCHAIN}?{kind}={chunk}&filter=true", headers=HDR)
            r = json.load(urllib.request.urlopen(req, timeout=20))
            for k, v in (r.get("result", {}).get(kind, {}) or {}).items():
                if v:
                    out[k] = v[0]["name"]
        except Exception as e:  # noqa: BLE001
            print(f"  (openchain {kind} 조회 일부 실패: {str(e)[:80]})", file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("address")
    ap.add_argument("--name", default="?")
    ap.add_argument("--blocks", type=int, default=1800)
    ap.add_argument("--selectors", action="store_true", help="tx input selector 교차증거(느림)")
    ap.add_argument("--json", action="store_true", help="기계가 읽을 JSON 출력")
    a = ap.parse_args()
    addr = a.address.lower()

    code = rpc("eth_getCode", [addr, "latest"])
    if code == "0x":
        raise SystemExit(f"{addr}: 코드 없음 — 주소가 틀렸거나 EOA")
    latest = int(rpc("eth_blockNumber", []), 16)
    logs = get_logs(addr, latest - a.blocks + 1, latest)
    print(f"# {a.name} {addr}\n# 최근 {a.blocks}블록 로그 {len(logs)}건 (head {latest})\n")

    # topic0 별 집계 + shape
    by_topic = defaultdict(list)
    for l in logs:
        by_topic[l["topics"][0]].append(l)
    sigs = openchain_lookup("event", list(by_topic))

    # selector 교차증거
    sel_evidence = defaultdict(Counter)  # topic0 -> Counter(selector_name)
    if a.selectors:
        tx_hashes = list({l["transactionHash"] for ls in by_topic.values() for l in ls[:30]})[:250]
        txs = {}
        for i in range(0, len(tx_hashes), 100):
            batch = [{"jsonrpc": "2.0", "id": j, "method": "eth_getTransactionByHash", "params": [h]} for j, h in enumerate(tx_hashes[i:i + 100])]
            req = urllib.request.Request(RPCS[0], data=json.dumps(batch).encode(), headers=HDR)
            for item in json.load(urllib.request.urlopen(req, timeout=60)):
                t = item.get("result")
                if t:
                    txs[t["hash"]] = t
        sels = {t["input"][:10] for t in txs.values() if (t.get("to") or "").lower() == addr and len(t["input"]) >= 10}
        sel_names = openchain_lookup("function", list(sels))
        for tp, ls in by_topic.items():
            for l in ls[:30]:
                t = txs.get(l["transactionHash"])
                if t and (t.get("to") or "").lower() == addr:
                    sel_evidence[tp][sel_names.get(t["input"][:10], t["input"][:10])] += 1

    rows = []
    for tp, ls in sorted(by_topic.items(), key=lambda kv: -len(kv[1])):
        s = ls[0]
        shape = {"ntopics": len(s["topics"]), "datawords": len(s["data"][2:]) // 64}
        name = sigs.get(tp, "(미등록)")
        action = next((w for w in ACTION_WORDS if w in name.lower()), None)
        rows.append({"topic0": tp, "count": len(ls), "name": name, "action_hint": action, **shape,
                     "via_selectors": dict(sel_evidence[tp].most_common(3)) if a.selectors else None,
                     "sample_topics": s["topics"][1:], "sample_data_words": [int(w, 16) for w in (s["data"][2:][i:i + 64] for i in range(0, len(s["data"][2:]), 64))][:6]})

    if a.json:
        print(json.dumps(rows, indent=1))
        return

    for r in rows:
        print(f"{'★' if r['action_hint'] else ' '} {r['count']:5d}×  {r['name']}")
        print(f"        topic0={r['topic0']}")
        print(f"        shape: indexed={r['ntopics'] - 1} datawords={r['datawords']}", end="")
        if r["via_selectors"]:
            print(f"  ← 호출 함수: {r['via_selectors']}", end="")
        print()
    print("\n# ── TS 매핑 후보 (의미는 사람이 검증할 것!) ──")
    for r in rows:
        if r["action_hint"]:
            print(f'  "{r["topic0"]}": {{ name: "{r["name"].split("(")[0]}", hint: "{r["action_hint"]}" }},  // {r["count"]}×, indexed={r["ntopics"] - 1}, words={r["datawords"]}')


if __name__ == "__main__":
    main()
