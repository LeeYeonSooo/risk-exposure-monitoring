#!/usr/bin/env python3
"""
EOA/contract DFS dependency crawler (price-free, arbitrary token).

핵심 규칙:
  - 토큰 T의 홀더 후보를 Dune(net-transfer)로 발견 → 실제 잔고는 archive balanceOf로 보정.
  - 각 홀더 분류: EOA(코드 없음) / 컨트랙트(인터페이스 probe + Etherscan 이름).
  - 컨트랙트가 "그 자체로 ERC20 receipt/wrapper/vault" 면(aToken·ERC4626·심볼 있는 ERC20)
    → 그걸 토큰으로 보고 홀더를 다시 크롤(DFS). = 예치자/래퍼 보유자 역추적.
  - EOA / Safe / 정체불명 / 토큰 아님(싱글톤) → leaf.
컷오프: 각 레벨에서 그 토큰 totalSupply 대비 MIN_FRAC 이상 + top-K. (price-free)
재현성: 모든 값 block 고정 + cache.

usage: python3 feeder/crawl.py <token_addr|symbol> <block> [--depth N] [--k K] [--minfrac F]
"""
import json, os, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "cache"); os.makedirs(CACHE, exist_ok=True)
ENV = os.environ.get("DEP_ENGINE_ENV") or os.path.join(ROOT, "..", ".env")
sys.path.insert(0, ROOT)
import ledger_adapters as LA   # 확장 종류 B (singleton-ledger 어댑터 레지스트리)

def load_env():
    e={}
    for ln in open(ENV):
        ln=ln.strip()
        if "=" in ln and not ln.startswith("#"):
            k,v=ln.split("=",1); e[k.strip()]=v.strip()
    return e
E=load_env()
RPC=E["ETH_RPC"]; DUNE_KEY=E["DUNE_API_KEY"]; ETHERSCAN=E["ETHERSCAN_API_KEY"]
DUNE_QID="7644342"

KNOWN={"steth":"0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
       "wsteth":"0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
       "weth":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
       "wbtc":"0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"}

# ---------- low level ----------
def _post(url,body=None,headers=None,method="POST"):
    data=json.dumps(body).encode() if body is not None else None
    r=urllib.request.Request(url,data=data,headers=headers or {},method=method)
    return json.loads(urllib.request.urlopen(r,timeout=90).read())

def rpc(method,params):
    return _post(RPC,{"jsonrpc":"2.0","id":1,"method":method,"params":params},
                 {"Content-Type":"application/json"})["result"]

def eth_call(to,data,block):
    try: return rpc("eth_call",[{"to":to,"data":data},hex(block)])
    except Exception: return None

SEL={"totalSupply":"0x18160ddd","symbol":"0x95d89b41","decimals":"0x313ce567",
     "underlying":"0xb16a19de","asset":"0x38d52e0f"}

def _int(h):
    return int(h,16) if h and h!="0x" else 0
def balanceof(token,addr,block):
    return _int(eth_call(token,"0x70a08231"+addr[2:].rjust(64,"0"),block))
def total_supply(token,block): return _int(eth_call(token,SEL["totalSupply"],block))
def get_decimals(token,block):
    d=_int(eth_call(token,SEL["decimals"],block)); return d if 0<d<=36 else 18
def get_code(addr):
    c=cache_get("code",addr)
    if c is not None: return c
    code=rpc("eth_getCode",[addr,"latest"])
    cache_put("code",addr,code); return code
def read_addr(to,sel,block):
    h=eth_call(to,sel,block)
    if not h or h=="0x" or len(h)<42: return None
    a="0x"+h[-40:]
    return a if int(a,16)!=0 else None
def mkctx(block,label=None,K=12,MINFRAC=0.01,token=None,amount=None):
    # 어댑터에 주입하는 ctx (block 고정 closures). 어댑터는 RPC/Dune/HTTP 재구현 안 함.
    #   token  = 이 ledger 가 보유한 "부모 토큰"(Morpho 처럼 다중토큰 ledger 에 필수).
    #   amount = 펼치는 엣지의 토큰 수량(transformed 핸드오프 어댑터가 그대로 넘길 때 사용).
    return {"eth_call": lambda to,data: eth_call(to,data,block),
            "read_addr": lambda to,sel: read_addr(to,sel,block),
            "dune": dune_exec, "post": _post, "cache_get": cache_get, "cache_put": cache_put,
            "label": label, "block": block, "token": token, "amount": amount,
            "K": K, "MINFRAC": MINFRAC}
def read_symbol(to,block):
    h=eth_call(to,SEL["symbol"],block)
    if not h or h=="0x": return None
    try:
        b=bytes.fromhex(h[2:])
        # dynamic string ABI: offset(32)+len(32)+data, or bytes32
        if len(b)>=64:
            ln=int.from_bytes(b[32:64],"big")
            if 0<ln<=64: return b[64:64+ln].decode("utf8","ignore").strip("\x00") or None
        return b.rstrip(b"\x00").decode("utf8","ignore") or None
    except Exception: return None

# ---------- cache ----------
def cache_get(kind,key):
    p=os.path.join(CACHE,kind); os.makedirs(p,exist_ok=True)
    f=os.path.join(p,key.replace("/","_")+".json")
    if os.path.exists(f):
        try: return json.load(open(f))
        except Exception: return None
    return None
def cache_put(kind,key,val):
    p=os.path.join(CACHE,kind); os.makedirs(p,exist_ok=True)
    json.dump(val,open(os.path.join(p,key.replace("/","_")+".json"),"w"))

# ---------- Dune ----------
def dune_exec(qid,params):
    # 임의 파라미터 쿼리 실행 -> rows(list[dict]). 어댑터도 ctx 통해 재사용.
    hdr={"X-Dune-Api-Key":DUNE_KEY,"Content-Type":"application/json"}
    ex=_post(f"https://api.dune.com/api/v1/query/{qid}/execute",
             {"performance":"free","query_parameters":params},hdr)
    eid=ex["execution_id"]
    for _ in range(60):
        st=_post(f"https://api.dune.com/api/v1/execution/{eid}/status",None,hdr,"GET")["state"]
        if st=="QUERY_STATE_COMPLETED": break
        if st in ("QUERY_STATE_FAILED","QUERY_STATE_CANCELLED"): return []
        time.sleep(3)
    res=_post(f"https://api.dune.com/api/v1/execution/{eid}/results",None,hdr,"GET")
    return res["result"]["rows"]

def dune_holders(token,block):
    ck=f"{token}_{block}"
    c=cache_get("holders",ck)
    if c is not None: return c
    rows=[r["holder"] for r in dune_exec(DUNE_QID,{"token":token,"block":str(block)})]
    cache_put("holders",ck,rows); return rows

# ---------- Etherscan label ----------
def etherscan_name(addr):
    c=cache_get("esname",addr)
    if c is not None: return c
    try:
        u=f"https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address={addr}&apikey={ETHERSCAN}"
        d=json.loads(urllib.request.urlopen(u,timeout=30).read())
        nm=d["result"][0].get("ContractName","") if isinstance(d.get("result"),list) else ""
    except Exception: nm=""
    cache_put("esname",addr,nm); time.sleep(0.21); return nm

# ---------- classify ----------
def classify(addr,block):
    ck=cache_get("classify",addr)
    if ck is not None: return ck
    out={"addr":addr,"kind":"unknown","label":None,"expandable":False,"adapter":None,"note":None}
    code=get_code(addr)
    if not code or code=="0x":
        out.update(kind="EOA",label="EOA",expandable=False)
        cache_put("classify",addr,out); return out
    nm=etherscan_name(addr); out["label"]=nm or None
    # 확장 종류 B 먼저: singleton-ledger 어댑터 매칭 (ERC20 포장지가 아닌 프로토콜 장부)
    ad=LA.match(addr,mkctx(block,nm))
    if ad:
        out.update(kind=f"ledger:{ad.name}",adapter=ad.name,expandable=False,
                   note=f"singleton ledger; expand via adapter:{ad.name}")
        cache_put("classify",addr,out); return out
    # interface probes (확장 종류 A: ERC20-unwrap)
    if read_addr(addr,SEL["underlying"],block):
        out.update(kind="aToken",expandable=True)            # Aave/Spark aToken
    elif read_addr(addr,SEL["asset"],block):
        out.update(kind="erc4626_vault",expandable=True)     # MetaMorpho/Yearn/Boring 등
    else:
        sym=read_symbol(addr,block); ts=total_supply(addr,block)
        if sym and ts>0:
            # Pendle 토큰 역할 인식(프로젝트 위협모델용) — 도달성은 동일(generic unwrap), 의미만 부여.
            low=sym.lower(); role=None
            if low.startswith("sy-"): role="pendle_SY"
            elif low.startswith("pt-"): role="pendle_PT"
            elif low.startswith("yt-"): role="pendle_YT"
            elif "pendle-lp" in low or low=="pendle-lpt": role="pendle_LP"
            note=f"{role}; symbol={sym}" if role else f"symbol={sym}"
            out.update(kind="erc20_receipt",expandable=True,note=note)  # wstETH/cToken/Pendle 등
        else:
            # 토큰 아님 = 싱글톤/풀/Safe/기타 → leaf
            low=(nm or "").lower()
            if "safe" in low: out.update(kind="safe")
            elif nm: out.update(kind="contract")
            else: out.update(kind="opaque")
    cache_put("classify",addr,out); return out

# ---------- DFS ----------
# 통일 재귀: 어떤 경로로 발견된 홀더든(직접 holder / 어댑터 child) 동일 dispatch 를 다시 탄다.
#   dispatch = classify → 종류A(ERC20 unwrap) | 종류B(ledger 어댑터) | leaf.
# 덕분에 "예치자/차입자 → vault → vault 예치자 → …" 가 끊기지 않고 이어진다.

def visit_token(token,block,depth,K,MINFRAC,visited,edges,token_label=None):
    """token 의 홀더를 Dune+balanceOf 로 열거(컷오프) → 각자 dispatch."""
    token=token.lower()
    ts=total_supply(token,block) or 1
    dec=get_decimals(token,block)
    rows=[]
    for h in dune_holders(token,block):
        h=h.lower(); b=balanceof(token,h,block)
        if b>0: rows.append((h,b,b/ts))
    rows=[r for r in rows if r[2]>=MINFRAC]
    rows.sort(key=lambda x:-x[1]); rows=rows[:K]
    print(f"{'  '*depth}┌ {token_label or token[:10]}  (holders kept {len(rows)}, dec {dec})")
    for h,b,frac in rows:
        dispatch(token,h,b/(10**dec),frac,block,depth,K,MINFRAC,visited,edges)

def dispatch(from_token,holder,amount,frac,block,depth,K,MINFRAC,visited,edges,via=None,position=None):
    """홀더 1개 처리: 엣지 생성 + (깊이/visited 허용 시) 종류A 재귀 또는 종류B expand.
       position = 어댑터가 채운 포지션 detail(역할·담보·차입·위험설정값) → 엣지에 부착."""
    if holder.lower()==from_token.lower():
        return  # 토큰이 자기 자신 보유(escrow/unclaimed) → self-loop 방지(bipartite 위반 방지)
    info=classify(holder,block)
    tag=info["kind"]; lab=info["label"] or ""
    pad="  "*depth
    mark=f" via {via}" if via else ""
    print(f"{pad}├─ {holder[:10]} {amount:>14,.0f} {('%4.1f%%'%(frac*100)) if frac is not None else '   ?'}  [{tag}] {lab}{mark}")
    edge={"from_token":from_token,"holder":holder,"amount":amount,
          "frac":round(frac,4) if frac is not None else None,
          "kind":tag,"label":lab,"depth":depth}
    if via: edge["via"]=via
    if info.get("note"): edge["note"]=info["note"]
    if position: edge["position"]=position
    edges.append(edge)
    if depth>=MAXDEPTH or holder in visited:
        return
    # 종류 A: 홀더가 그 자체로 ERC20 → 그 토큰의 홀더를 다시 열거
    if info["expandable"]:
        visited.add(holder)
        visit_token(holder,block,depth+1,K,MINFRAC,visited,edges,
                    token_label=(info.get("note") or info["label"] or holder[:10]))
    # 종류 B: singleton-ledger 어댑터 → 프로토콜 소스로 하위 포지션 펼침, 각 child 를 다시 dispatch
    elif info.get("adapter"):
        visited.add(holder)
        ad=LA.by_name(info["adapter"]); ctx=mkctx(block,info["label"],K,MINFRAC,token=from_token,amount=amount)
        children=ad.expand(holder,block,ctx) if ad else None
        if children=="ERC20":
            # 어댑터가 "이 토큰분은 그냥 ERC20 영수증 unwrap 하라" 위임 (예: Comet 베이스 공급자)
            edge["resolved"]=True
            visit_token(holder,block,depth+1,K,MINFRAC,visited,edges,token_label=info["label"] or holder[:10])
        elif children is None:
            edge["resolved"]=False  # 미구현/조회불가 → opaque leaf
            print(f"{pad}│  └ unresolved (adapter:{info['adapter']} TODO)")
        else:
            edge["resolved"]=True
            csum=sum(c["amount"] for c in children)
            # §6: silent 누락 금지 — 어댑터가 커버한 비율을 부모 엣지에 명시(절단분=기타).
            edge["children_sum"]=round(csum,2)
            edge["coverage"]=round(csum/amount,4) if amount else None
            for c in children:
                ca=c["addr"].lower(); camt=c["amount"]
                dispatch(holder,ca,camt,(camt/amount if amount else None),
                         block,depth+1,K,MINFRAC,visited,edges,via=info["adapter"],
                         position=c.get("position"))

if __name__=="__main__":
    arg=sys.argv[1].lower(); token=KNOWN.get(arg,arg)
    block=int(sys.argv[2])
    MAXDEPTH=int(sys.argv[sys.argv.index("--depth")+1]) if "--depth" in sys.argv else 3
    K=int(sys.argv[sys.argv.index("--k")+1]) if "--k" in sys.argv else 12
    MINFRAC=float(sys.argv[sys.argv.index("--minfrac")+1]) if "--minfrac" in sys.argv else 0.01
    print(f"# crawl {token} @block {block}  depth<={MAXDEPTH} top{K} minfrac{MINFRAC}")
    edges=[]; visit_token(token,block,0,K,MINFRAC,set([token.lower()]),edges,token_label=arg)
    out=os.path.join(ROOT,"..","graphs",f"crawl.{arg}.{block}.json")
    json.dump({"root":token,"block":block,"edges":edges},open(out,"w"),indent=2)
    print(f"\nsaved {os.path.abspath(out)}  ({len(edges)} edges)")
