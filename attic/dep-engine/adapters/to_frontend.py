#!/usr/bin/env python3
"""bipartite-graphhh graph.json  ->  new-simulator frontend (simulator_graph.json shape).
Usage: python3 adapters/to_frontend.py graphs/wstETH.<block>.graph.json
Out:   graphs/frontend/<token>.sim.json   { nodes:[{id,type,label,data}], edges:[{id,source,target,label,edge_type}], metadata }
Mapping is lossless-enough for rendering; full detail stays in the source graph.json (drill-down)."""
import json, sys, os, re

ROLE2ET   = {"collateral":"collateral","collateral_isolated":"collateral","cdp_collateral":"collateral",
             "lp_pair":"dex","deposit_supply":"yield","loan_asset":"yield","mint_backing":"collateral","issued_by":"issued_by"}
ROLE2NROLE= {"collateral":"collateral_market","collateral_isolated":"collateral_market","cdp_collateral":"cdp_ilk",
             "lp_pair":"amm_pool","deposit_supply":"vault","loan_asset":"vault","mint_backing":"vault"}
ROLE2KR   = {"collateral":"담보","collateral_isolated":"담보(격리)","cdp_collateral":"CDP담보",
             "lp_pair":"LP","deposit_supply":"예치","loan_asset":"대출","mint_backing":"백킹"}

def slug(s): return re.sub(r'[^a-z0-9]+','_',s.lower()).strip('_')

def convert(g):
    tok = next(n for n in g["nodes"] if n["node_id"].startswith("token:"))
    taddr = tok["address"].lower()
    sym = tok["metadata"]["symbol"]
    nodes, edges, seen_oracle = [], [], {}
    # token node
    nodes.append({"id":taddr,"type":"token","label":sym,
        "data":{"description":"[lst_token]","category":"lst","protocol":"lido","symbol":sym,
                "decimals":tok["metadata"]["decimals"],"role":"asset",
                "total_supply":tok["metadata"]["total_supply"],"market_cap_usd":tok["metadata"]["market_cap_usd"]}})
    by_id={n["node_id"]:n for n in g["nodes"]}
    for e in g["edges"]:
        pn = by_id[e["target"]]; pid = pn["address"].lower(); pr = e["classification"]["primary_role"]
        cw = e["core_weight"]; conf = e["meta"]["confidence"]
        nodes.append({"id":pid,"type":"protocol","label":pn["label"],
            "data":{"description":f"[{pn['metadata'].get('architecture','')}]","category":e["classification"]["protocol_class"],
                    "protocol":pn["node_id"].split(':')[1],"symbol":None,"role":ROLE2NROLE.get(pr,"collateral_market"),
                    "venue":pn["label"],"tokens_held":pn["metadata"].get("tokens_held"),
                    "tokens_held_usd":pn["metadata"].get("tokens_held_usd"),
                    "data_source":"live","approx":conf!="HIGH"}})
        pct = round((cw.get("pct_of_supply") or 0)*100,1)
        edges.append({"id":f"{taddr}->{pid}","source":taddr,"target":pid,
            "label":f"{ROLE2KR.get(pr,pr)} {pct}%","edge_type":ROLE2ET.get(pr,pr)})
        # oracle node + edge (if resolved address)
        oa = (e.get("oracle") or {}).get("oracle_address")
        if oa:
            oa=oa.lower()
            if oa not in seen_oracle:
                seen_oracle[oa]=1
                nodes.append({"id":oa,"type":"oracle","label":f"{pn['label']} oracle",
                    "data":{"description":"[price_feed]","category":"oracle","role":"oracle",
                            "oracle_type":e["oracle"].get("oracle_type")}})
            edges.append({"id":f"{taddr}->oracle:{oa}","source":taddr,"target":oa,
                "label":"오라클 의존","edge_type":"oracle"})
    # bridges (token metadata) -> bridge nodes/edges
    for b in tok["metadata"].get("bridges",{}).get("ethereum",[]):
        bid=f"bridge:{slug(b['bridge'])}"
        nodes.append({"id":bid,"type":"bridge","label":b["bridge"],
            "data":{"description":"[bridge]","category":"bridge","role":"bridge",
                    "dest_chains":b["dest_chains"],"mechanism":b["mechanism"],"locked_amount":b["locked_amount"]}})
        edges.append({"id":f"{taddr}->{bid}","source":taddr,"target":bid,
            "label":f"{b['bridge']} {b['locked_amount']:,}","edge_type":"bridge"})
    # dedup nodes by id
    uniq={}; 
    for n in nodes: uniq.setdefault(n["id"],n)
    return {"nodes":list(uniq.values()),"edges":edges,
            "metadata":{"root":taddr,"symbol":sym,"snapshot_block":g["meta"]["snapshot_block"],
                        "snapshot_ts":g["meta"]["snapshot_ts"],"source":"bipartite-graphhh/adapters/to_frontend.py",
                        "note":"flat react-flow shape for new-simulator frontend; full detail in source graph.json"}}

if __name__=="__main__":
    src=sys.argv[1]; g=json.load(open(src))
    out=convert(g)
    od="/Users/link/bipartite-graphhh/graphs/frontend"
    op=os.path.join(od,f"{out['metadata']['symbol']}.sim.json")
    open(op,"w").write(json.dumps(out,ensure_ascii=False,indent=2))
    print("saved",op)
    print(f"nodes {len(out['nodes'])} | edges {len(out['edges'])}")
    from collections import Counter
    print("node.type:",dict(Counter(n['type'] for n in out['nodes'])))
    print("edge_type:",dict(Counter(e['edge_type'] for e in out['edges'])))
