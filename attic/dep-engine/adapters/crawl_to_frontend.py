#!/usr/bin/env python3
"""feeder crawl.<tok>.<block>.json  ->  new-simulator frontend sim.json (react-flow shape).
crawl 출력은 트리(edge: from_token -> holder, amount/frac/kind/label/depth/via). 이를
{nodes:[{id,type,label,data}], edges:[{id,source,target,label,edge_type}]} 로 변환.
노드 id = 주소(소문자). 같은 주소는 노드 1개로 dedup, 엣지는 전부 보존(DAG 허용).
Usage: python3 adapters/crawl_to_frontend.py graphs/crawl.<tok>.<block>.json [out.sim.json]"""
import json, sys, os
from collections import Counter

# child kind / via -> edge_type (프론트 색상용 카테고리)
VIA2ET = {"morpho": "morpho", "eigenlayer": "restake", "kelp": "transformed",
          "maker": "cdp", "compound_v3": "compound_v3", "aave_v3": "lending"}
def edge_type(e):
    via = e.get("via")
    if via in VIA2ET: return VIA2ET[via]
    k = e["kind"]
    if k == "aToken":         return "lending"
    if k == "erc4626_vault":  return "vault"
    if k == "erc20_receipt":  return "wrapper"
    if str(k).startswith("ledger:"): return k.split(":")[1]
    if k in ("EOA", "safe"):  return "holds"
    return "holds"

def short(a): return a[:6] + "…" + a[-4:]

# kind -> 사람이 읽는 프로토콜 이름
KIND_LABEL = {
    "aToken": "Aave", "ledger:aave_v3": "Aave", "erc4626_vault": "ERC4626 Vault",
    "ledger:morpho": "Morpho", "ledger:eigenlayer": "EigenLayer",
    "ledger:kelp": "Kelp", "ledger:maker": "Maker", "ledger:compound_v3": "Compound v3",
}
# 주요 토큰 주소 -> 심볼 (root/홀더 라벨용)
KNOWN_TOKEN = {
    "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": "stETH",
    "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
    "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee": "weETH",
    "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7": "rsETH",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
}
# 컨트랙트명 패턴 -> 친화적 이름
def name_hint(label):
    if not label: return None
    low = label.lower()
    if "oftadapter" in low or "oft" == low: return "LayerZero OFT (bridge)"
    if "nodedelegator" in low: return "Kelp NodeDelegator"
    if "boringvault" in low: return "BoringVault (Veda)"
    if "cellar" in low: return "Sommelier Cellar"
    if "gnosissafe" in low or "safeproxy" in low: return None  # safe 는 따로 처리
    if "transparentupgradeable" in low or "initializableimmutable" in low \
       or "erc1967" in low or low in ("proxy", "ossifiableproxy"): return None  # 의미없는 프록시명 버림
    return label  # 그 외 진짜 이름은 유지

def node_label(addr, kind, label, sym=None):
    a = addr.lower()
    # 1) erc20 receipt: 심볼이 가장 의미있음 (wstETH / SY-weETH / PENDLE-LPT …)
    if kind == "erc20_receipt":
        return sym or KNOWN_TOKEN.get(a) or "wrapper"
    # 2) kind 기반 프로토콜 이름
    if kind in KIND_LABEL:
        base = KIND_LABEL[kind]
        return f"{base} ({sym})" if sym else base
    # 3) 지갑류 (name_hint 보다 먼저 — label="EOA" 가 힌트에 가로채이지 않게)
    if kind == "EOA": return f"EOA {short(addr)}"
    if kind == "safe": return f"Safe {short(addr)}"
    if kind == "opaque": return f"opaque {short(addr)}"
    # 4) 컨트랙트명 힌트 (의미없는 프록시명은 버리고 주소로)
    hint = name_hint(label)
    if hint: return hint
    return f"{short(addr)}"

def approx(kind, e):
    # 불확실(점선) 표시: opaque/unresolved/미해결 ledger
    if kind == "opaque": return True
    if e.get("resolved") is False: return True
    return False

def convert(d):
    root = d["root"].lower()
    edges_in = d["edges"]
    # 노드 메타: 주소별로 (가장 얕은 depth, kind, label 우선)
    def sym_of(note):
        if not note: return None
        # note 예: "symbol=wstETH" 또는 "pendle_SY; symbol=SY-weETH"
        for part in str(note).split(";"):
            part = part.strip()
            if part.startswith("symbol="): return part[len("symbol="):]
        return None
    meta = {}
    def touch(addr, kind=None, label=None, depth=None, note=None):
        addr = addr.lower()
        m = meta.setdefault(addr, {"kind": kind, "label": label, "depth": depth, "sym": sym_of(note)})
        if depth is not None and (m["depth"] is None or depth < m["depth"]):
            m["depth"] = depth
        if kind and (not m.get("kind") or m["kind"] in (None, "token")):
            m["kind"] = kind
        if label and not m.get("label"):
            m["label"] = label
        if not m.get("sym"):
            m["sym"] = sym_of(note)
        return addr
    touch(root, "token", None, -1)  # root
    for e in edges_in:
        touch(e["from_token"])
        touch(e["holder"].lower(), e["kind"], e.get("label"), e["depth"], e.get("note"))
    nodes = []
    for addr, m in meta.items():
        is_root = addr == root
        kind = "token" if is_root else (m.get("kind") or "opaque")
        sym = m.get("sym")
        if is_root:
            lab = KNOWN_TOKEN.get(addr) or sym or m.get("label") or short(addr)
        else:
            lab = node_label(addr, kind, m.get("label"), sym)
        nodes.append({
            "id": addr,
            "type": "token" if is_root else "protocol",
            "label": lab,
            "data": {"category": kind, "kind": kind, "label": m.get("label"),
                     "symbol": sym, "depth": m.get("depth"), "address": addr,
                     "approx": (kind == "opaque")},
        })
    def pos_label(p):
        # 포지션 detail -> 사람이 읽는 라벨 (price-free, 토큰 네이티브)
        d = p.get("detail", {}); role = p.get("role")
        def n(x): return f"{x:,.0f}" if isinstance(x, (int, float)) else x
        if role == "collateral":
            bsym = d.get("loan_symbol") or d.get("base_symbol") or ""
            bor = d.get("borrow") if d.get("borrow") is not None else d.get("base_borrow")
            risk = d.get("lltv") if d.get("lltv") is not None else d.get("liq_factor")
            s = f"담보 {n(d.get('collateral'))}"
            if bor: s += f" · 차입 {n(bor)} {bsym}"
            if risk: s += f" · LLTV {risk*100:.0f}%"
            return s
        if role == "supply":
            amt = d.get("supplied") if d.get("supplied") is not None else d.get("supply")
            s = f"예치 {n(amt)}"
            if d.get("liq_threshold") is not None: s += f" · LT {d['liq_threshold']*100:.0f}%"
            elif d.get("idle_share") is not None: s += f" (idle {n(d['idle_share'])})"
            if d.get("utilization") is not None: s += f" · util {d['utilization']*100:.0f}%"
            return s
        if role == "restake":
            op = d.get("operator"); ops = f" · op {op[:8]}…" if op else ""
            return f"restake {n(d.get('underlying'))}{ops}"
        return None

    edges = []
    for i, e in enumerate(edges_in):
        s = e["from_token"].lower(); t = e["holder"].lower()
        if s == t: continue
        amt = e["amount"]; frac = e.get("frac"); pos = e.get("position")
        pl = pos_label(pos) if pos else None
        lab = pl if pl else ((f"{frac*100:.1f}% " if frac is not None else "") + f"{amt:,.0f}")
        ed = {"id": f"{s}->{t}#{i}", "source": s, "target": t, "label": lab,
              "edge_type": edge_type(e), "amount": amt, "depth": e["depth"]}
        if e.get("via"): ed["via"] = e["via"]
        if e.get("coverage") is not None: ed["coverage"] = e["coverage"]
        if pos: ed["position"] = pos
        edges.append(ed)
    return {"nodes": nodes, "edges": edges,
            "metadata": {"root": root, "block": d["block"], "edge_count": len(edges),
                         "source": "feeder/crawl + adapters/crawl_to_frontend.py"}}

if __name__ == "__main__":
    src = sys.argv[1]; d = json.load(open(src))
    out = convert(d)
    od = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "graphs", "frontend")
    op = sys.argv[2] if len(sys.argv) > 2 else os.path.join(od, "crawl.sim.json")
    os.makedirs(os.path.dirname(op), exist_ok=True)
    open(op, "w").write(json.dumps(out, ensure_ascii=False, indent=2))
    print("saved", op)
    print(f"nodes {len(out['nodes'])} | edges {len(out['edges'])}")
    print("node.kind:", dict(Counter(n["data"]["category"] for n in out["nodes"])))
    print("edge_type:", dict(Counter(e["edge_type"] for e in out["edges"])))
