#!/usr/bin/env python3
"""크롤 산출물 불변식 검증 (CLAUDE.md §6 일부) + 트리 요약.
usage: python3 feeder/validate.py graphs/crawl.steth.25235536.json"""
import json, sys, collections

d = json.load(open(sys.argv[1]))
edges = d["edges"]
print(f"root={d['root'][:12]} block={d['block']} edges={len(edges)}")

# 1) bipartite: from_token != holder (self-loop 금지)
selfloops = [e for e in edges if e["from_token"].lower() == e["holder"].lower()]
print(f"[bipartite] self-loops: {len(selfloops)}  {'OK' if not selfloops else 'FAIL'}")

# 2) depth 분포 / kind 분포
by_depth = collections.Counter(e["depth"] for e in edges)
by_kind = collections.Counter(e["kind"] for e in edges)
print(f"[depths] {dict(sorted(by_depth.items()))}")
print(f"[kinds ] {dict(by_kind)}")

# 3) ledger 노드 resolve 상태
led = [e for e in edges if str(e["kind"]).startswith("ledger:")]
for e in led:
    print(f"  ledger {e['kind']:16} resolved={e.get('resolved')} amt={e['amount']:,.0f} {e['label']}")

# 4) via(어댑터 child) 집계
via = collections.Counter(e["via"] for e in edges if e.get("via"))
print(f"[via   ] {dict(via)}")

# 5) 트리 출력
kids = collections.defaultdict(list)
for e in edges:
    kids[e["from_token"].lower()].append(e)
root = d["root"].lower()
seen = set()
def show(tok, depth):
    if depth > 6 or tok in seen: return
    seen.add(tok)
    for e in sorted(kids.get(tok, []), key=lambda x: -x["amount"])[:6]:
        v = f" via:{e['via']}" if e.get("via") else ""
        r = "" if e.get("resolved", True) else " [unresolved]"
        print(f"{'    '*depth}└ {e['holder'][:10]} {e['amount']:>12,.0f} [{e['kind']}] {e['label']}{v}{r}")
        show(e["holder"].lower(), depth + 1)
print("\n=== tree ===")
show(root, 0)
