#!/usr/bin/env python3
"""
Singleton-ledger 어댑터 (확장 종류 B).

확장에는 두 종류가 있다:
  (A) ERC20-unwrap  — 홀더가 그 자체로 ERC20(aToken/4626/receipt). Dune erc20 홀더 쿼리로 재귀.
                      => crawl.py 코어가 처리. 제네릭.
  (B) singleton-ledger — 홀더가 수많은 유저 포지션을 내부 storage에 모아둔 프로토콜 컨트랙트.
                      ERC20 포장지가 아니라서 erc20 홀더 쿼리로는 안 풀린다.
                      => 이 파일. 프로토콜별 소스로 하위 홀더 list를 돌려준다.

어댑터 계약(uniform):
  name: str
  matches(addr, ctx) -> bool
      이 컨트랙트가 내 프로토콜인가. 셀렉터 probe 또는 known-address 로 판정. (추측 금지)
  expand(addr, block, ctx) -> list[{"addr","amount","label"}] | None
      하위 포지션(underlying 토큰 단위). 미구현/조회불가면 None
      => 코어가 opaque leaf(confidence LOW)로 두고 재귀 안 함. (에러 아님 §8.6)

ctx (코어가 주입; 어댑터는 RPC 재구현 금지):
  ctx["eth_call"](to, data) -> hex|None     # block 고정
  ctx["read_addr"](to, sel)  -> "0x.."|None  # block 고정, address 리턴 셀렉터
  ctx["label"]               -> etherscan ContractName|None
  ctx["block"]               -> int
"""

# ---- selectors / addresses ----
S_UNDERLYINGTOKEN = "0x2495a599"  # EigenLayer StrategyBase.underlyingToken()
S_TOTALSHARES     = "0x3a98ef39"  # EigenLayer StrategyBase.totalShares()
S_SHARES2UNDER    = "0x7a8b2637"  # StrategyBase.sharesToUnderlyingView(uint256)
S_STAKERSHARES    = "0xfe243a17"  # StrategyManager.stakerDepositShares(address staker,address strategy)
EIGEN_STRATEGY_MANAGER = "0x858646372cc42e1a627fce94aa7a7033e7cf075a"
EIGEN_DELEGATION = "0x39053d51b77dc0d36036fc1fcc8cb819df8ef37a"  # DelegationManager
S_DELEGATEDTO = "0x65da1264"      # delegatedTo(address staker)->operator
EIGEN_STAKERS_QID = "7644818"     # Dune: strategy top stakers by net deposited shares (.env key 소유)

S_POSITION  = "0x93c52062"  # Morpho.position(bytes32,address)->(supplyShares u256,borrowShares u128,collateral u128)
S_MARKET    = "0x5c60e39a"  # Morpho.market(bytes32)->(tSupplyAssets,tSupplyShares,tBorrowAssets,tBorrowShares,lastUpdate,fee)
S_IDPARAMS  = "0x2c3c9157"  # Morpho.idToMarketParams(bytes32)->(loanToken,collateralToken,oracle,irm,lltv 1e18)
S_DECIMALS  = "0x313ce567"
S_BALANCEOF = "0x70a08231"
MORPHO_BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
MORPHO_GQL  = "https://blue-api.morpho.org/graphql"
MORPHO_MARKET_CAP = 15    # 토큰당 상위 마켓 수 (idle/collateral 랭킹 후)
MORPHO_POS_PER_MKT = 15   # 마켓당 상위 포지션 수

def _u(n):    return f"{int(n):064x}"
def _a(addr): return addr.lower().replace("0x","").rjust(64,"0")
def _b32(h):  return h.lower().replace("0x","").rjust(64,"0")  # bytes32 marketId
def _words(hexstr,n):
    if not hexstr or hexstr=="0x": return [0]*n
    s=hexstr[2:]
    return [int(s[i*64:(i+1)*64] or "0",16) for i in range(n)]


class Adapter:
    name = "base"
    def matches(self, addr, ctx): return False
    def expand(self, addr, block, ctx): return None


# ---- Aave v3 (aToken) ----
AAVE_UNDERLYING = "0xb16a19de"  # aToken.UNDERLYING_ASSET_ADDRESS()
AAVE_POOL       = "0x7535d246"  # aToken.POOL()
AAVE_GETCONFIG  = "0xc44b11f7"  # Pool.getConfiguration(address)->uint256 (LTV=bits0-15, LT=16-31, bps)
AAVE_HOLDERS_QID = "7644342"    # 재사용: erc20 net-holders 쿼리 (token,block)
S_TOTALSUPPLY_SEL = "0x18160ddd"
S_BALANCEOF_SEL   = "0x70a08231"


class AaveV3(Adapter):
    """Aave v3 / Spark aToken. 홀더 = 예치자(supply). amount = aToken.balanceOf(=underlying 환산).
       발견=Dune erc20 홀더 / 검증=온체인 balanceOf @block. 위험설정값=reserve LTV·청산임계(price-free)."""
    name = "aave_v3"
    def matches(self, addr, ctx):
        return bool(ctx["read_addr"](addr, AAVE_UNDERLYING)) and bool(ctx["read_addr"](addr, AAVE_POOL))

    def expand(self, addr, block, ctx):
        K = ctx.get("K", 12); MINFRAC = ctx.get("MINFRAC", 0.01)
        underlying = ctx["read_addr"](addr, AAVE_UNDERLYING)
        pool = ctx["read_addr"](addr, AAVE_POOL)
        if not underlying or not pool:
            return None
        dec = 10 ** _dec(ctx, addr)  # aToken decimals == underlying decimals
        usym = _sym(ctx, underlying)
        # reserve 위험설정값 (1콜): LTV / liquidationThreshold (bps)
        cfg = ctx["eth_call"](pool, AAVE_GETCONFIG + _a(underlying))
        ltv = lt = None
        if cfg and cfg != "0x":
            c = int(cfg, 16); ltv = (c & 0xFFFF) / 1e4; lt = ((c >> 16) & 0xFFFF) / 1e4
        ts = ctx["eth_call"](addr, S_TOTALSUPPLY_SEL)
        total = (int(ts, 16) / dec) if ts and ts != "0x" else 0
        if total <= 0:
            return None
        ck = f"aave_holders_{addr}_{block}"
        cands = ctx["cache_get"]("ledger", ck)
        if cands is None:
            rows = ctx["dune"](AAVE_HOLDERS_QID, {"token": addr, "block": str(block)})
            cands = [r.get("holder") for r in rows if isinstance(r.get("holder"), str) and r["holder"].startswith("0x")]
            ctx["cache_put"]("ledger", ck, cands)
        out = []
        for h in cands:
            bh = ctx["eth_call"](addr, S_BALANCEOF_SEL + _a(h))
            sup = (int(bh, 16) / dec) if bh and bh != "0x" else 0
            if sup <= 0 or sup / total < MINFRAC:
                continue
            out.append({"addr": h, "amount": sup, "label": "",
                        "position": {"role": "supply", "venue": addr,
                                     "detail": {"supplied": round(sup, 4), "underlying_symbol": usym,
                                                "ltv": ltv, "liq_threshold": lt},
                                     "verifiable_onchain": True, "confidence": "HIGH"}})
        out.sort(key=lambda x: -x["amount"])
        return out[:K] or None


class EigenLayerStrategy(Adapter):
    """EigenLayer StrategyBase (restaking). 내부 shares 장부, ERC20 아님."""
    name = "eigenlayer"
    def matches(self, addr, ctx):
        # StrategyBase 시그니처: underlyingToken() + totalShares() 둘 다 응답
        if not ctx["read_addr"](addr, S_UNDERLYINGTOKEN):
            return False
        return ctx["eth_call"](addr, S_TOTALSHARES) not in (None, "0x")
    def expand(self, addr, block, ctx):
        # 발견(Dune) -> 검증/환산(온체인). ERC20 의 dune_holders->balanceOf 패턴과 대칭.
        #   1) Dune: 이 strategy 의 net-deposit 상위 staker 후보 (랭킹은 휴리스틱, 권위 X)
        #   2) 온체인: StrategyManager.stakerDepositShares(staker,strategy) @block = 권위 shares
        #   3) 환산: shares * (sharesToUnderlyingView(1e18)/1e18) = underlying(stETH)
        # cutoff(MINFRAC, top-K)는 ERC20 경로와 동일 규칙.
        K = ctx.get("K", 12); MINFRAC = ctx.get("MINFRAC", 0.01)
        ck = f"eigenlayer_{addr}_{block}"
        rows = ctx["cache_get"]("ledger", ck)
        if rows is None:
            rows = ctx["dune"](EIGEN_STAKERS_QID,
                               {"strategy": addr, "block": str(block), "k": str(max(K*4, 50))})
            ctx["cache_put"]("ledger", ck, rows or [])
        # 환산 비율 (1콜): 1.0 share 당 underlying
        r = ctx["eth_call"](addr, S_SHARES2UNDER + _u(10**18))
        if not r or r == "0x":
            return None
        ratio = int(r, 16) / 1e18
        ts = ctx["eth_call"](addr, S_TOTALSHARES)
        total_under = (int(ts, 16) / 1e18) * ratio if ts and ts != "0x" else 0
        if total_under <= 0:
            return None
        out = []
        for row in rows:
            st = (row.get("holder") or "").lower()
            if len(st) != 42:
                continue
            h = ctx["eth_call"](EIGEN_STRATEGY_MANAGER, S_STAKERSHARES + _a(st) + _a(addr))
            shares = int(h, 16) / 1e18 if h and h != "0x" else 0
            if shares <= 0:
                continue
            amt = shares * ratio  # underlying(stETH)
            if amt / total_under < MINFRAC:
                continue
            oph = ctx["eth_call"](EIGEN_DELEGATION, S_DELEGATEDTO + _a(st))
            operator = ("0x" + oph[26:66]) if oph and oph != "0x" and int(oph, 16) else None
            out.append({"addr": st, "amount": amt, "label": "",
                        "position": {"role": "restake", "venue": addr,
                                     "detail": {"shares": round(shares, 4), "underlying": round(amt, 4),
                                                "operator": operator},
                                     "verifiable_onchain": True, "confidence": "HIGH"}})
        out.sort(key=lambda x: -x["amount"])
        return out[:K]


class MorphoBlue(Adapter):
    """Morpho Blue 싱글톤. 다중토큰 ledger — ctx["token"](부모 토큰) 기준으로 펼친다.
       physical 토큰 = Σ(담보마켓 차입자 collateral) + Σ(대출마켓 예치자의 idle 지분).
       발견=GraphQL(마켓·후보 포지션), 검증/환산=온체인 position/market @block."""
    name = "morpho"
    SINGLETON = {MORPHO_BLUE}
    def matches(self, addr, ctx):
        return addr.lower() in self.SINGLETON

    def _gql(self, ctx, q):
        try:
            d = ctx["post"](MORPHO_GQL, {"query": q}, {"content-type": "application/json"})
            return d.get("data") if isinstance(d, dict) else None
        except Exception:
            return None

    def _markets(self, ctx, token, field):
        # first:1000 = 전체 마켓 확보(USDC 등은 500+개) → 랭킹이 최대 idle/collateral 마켓을 놓치지 않게.
        q = ('{ markets(first:1000, where:{chainId_in:[1], %s:["%s"]}){ items{ '
             'marketId state{collateralAssets supplyAssets borrowAssets} } } }') % (field, token)
        d = self._gql(ctx, q)
        try: return d["markets"]["items"]
        except Exception: return []

    def _users(self, ctx, mid, order):
        q = ('{ marketPositions(first:%d, orderBy:%s, orderDirection:Desc, '
             'where:{marketUniqueKey_in:["%s"]}){ items{ user{address} } } }') % (MORPHO_POS_PER_MKT, order, mid)
        d = self._gql(ctx, q)
        try: return [p["user"]["address"].lower() for p in d["marketPositions"]["items"]]
        except Exception: return []

    def _discover(self, ctx, token):
        f = lambda x: float(x or 0)
        # 담보마켓: 물리 토큰 = 담보 잔고 → collateralAssets 기준.
        coll = sorted(self._markets(ctx, token, "collateralAssetAddress_in"),
                      key=lambda m: -f(m["state"]["collateralAssets"]))[:MORPHO_MARKET_CAP]
        # 대출마켓: 물리 토큰 = idle(=supply-borrow) 뿐 → idle 기준으로 랭킹해야 실제 잔고를 잡는다.
        #   (고이용률 대형마켓은 idle 작음 → supplyAssets 기준이면 물리분 놓침)
        loan = sorted(self._markets(ctx, token, "loanAssetAddress_in"),
                      key=lambda m: -(f(m["state"]["supplyAssets"]) - f(m["state"]["borrowAssets"])))[:MORPHO_MARKET_CAP]
        disc = {"collateral": {}, "loan": {}, "n": 0}
        for m in coll:
            disc["collateral"][m["marketId"]] = self._users(ctx, m["marketId"], "Collateral")
        for m in loan:
            disc["loan"][m["marketId"]] = self._users(ctx, m["marketId"], "SupplyShares")
        disc["n"] = len(coll) + len(loan)
        return disc

    def _position(self, ctx, mid, user):
        return _words(ctx["eth_call"](MORPHO_BLUE, S_POSITION + _b32(mid) + _a(user)), 3)
    def _market(self, ctx, mid):
        return _words(ctx["eth_call"](MORPHO_BLUE, S_MARKET + _b32(mid)), 6)
    def _params(self, ctx, mid):
        # (loanToken, collateralToken, oracle, irm, lltv) — word0/1/2 는 주소, word4=lltv(1e18)
        h = ctx["eth_call"](MORPHO_BLUE, S_IDPARAMS + _b32(mid))
        w = _words(h, 5)
        loan = "0x" + (h[2+24:2+64] if h and h != "0x" else "0"*40)
        return loan.lower(), (w[4] / 1e18 if w[4] else None)

    def expand(self, addr, block, ctx):
        token = (ctx.get("token") or "").lower()
        if len(token) != 42:
            return None
        K = ctx.get("K", 12); MINFRAC = ctx.get("MINFRAC", 0.01)
        ck = f"morpho_{token}_{block}"
        disc = ctx["cache_get"]("ledger", ck)
        if disc is None:
            disc = self._discover(ctx, token)
            ctx["cache_put"]("ledger", ck, disc)
        if not disc.get("n"):
            return None
        scale = 10 ** _dec(ctx, token)
        bh = ctx["eth_call"](token, S_BALANCEOF + _a(MORPHO_BLUE))
        phys = (int(bh, 16) if bh and bh != "0x" else 0) / scale
        if phys <= 0:
            return None
        agg = {}  # user -> {"amount": tokenAmt, "best": (contribAmt, position)}
        def add(u, amt, pos):
            e = agg.setdefault(u, {"amount": 0.0, "best": (0.0, None)})
            e["amount"] += amt
            if amt > e["best"][0]: e["best"] = (amt, pos)
        # 담보마켓: 차입자 position.collateral(=token) + 빌린 loan 토큰 양 + LLTV
        for mid, users in disc["collateral"].items():
            tSA, tSS, tBA, tBS = self._market(ctx, mid)[:4]
            loan, lltv = self._params(ctx, mid)
            loan_sym = _sym(ctx, loan) if loan and int(loan, 16) else None
            loan_scale = 10 ** _dec(ctx, loan) if loan and int(loan, 16) else 1
            util = round(tBA / tSA, 4) if tSA > 0 else None
            for u in users:
                ss, bs, col = self._position(ctx, mid, u)
                if col <= 0: continue
                coll = col / scale
                borrow = (bs * tBA / tBS / loan_scale) if (tBS and loan_scale) else 0
                add(u, coll, {"role": "collateral", "venue": mid,
                              "detail": {"collateral": round(coll, 4), "loan_token": loan,
                                         "loan_symbol": loan_sym, "borrow": round(borrow, 4),
                                         "lltv": round(lltv, 4) if lltv else None, "utilization": util},
                              "verifiable_onchain": True, "confidence": "HIGH"})
        # 대출마켓: idle 지분(=physical) 만큼 예치자에 귀속
        for mid, users in disc["loan"].items():
            tSA, tSS, tBA = self._market(ctx, mid)[:3]
            idle = max(tSA - tBA, 0)
            if tSA <= 0 or idle <= 0 or tSS <= 0: continue
            util = round(tBA / tSA, 4)
            for u in users:
                ss = self._position(ctx, mid, u)[0]
                assets = ss * tSA / tSS
                p = assets * idle / tSA
                if p <= 0: continue
                add(u, p / scale, {"role": "supply", "venue": mid,
                                   "detail": {"supply": round(assets / scale, 4),
                                              "idle_share": round(p / scale, 4), "utilization": util},
                                   "verifiable_onchain": True, "confidence": "HIGH"})
        out = [{"addr": u, "amount": e["amount"], "label": "", "position": e["best"][1]}
               for u, e in agg.items() if e["amount"] / phys >= MINFRAC]
        out.sort(key=lambda x: -x["amount"])
        return out[:K] or None


MK_GEM   = "0x7bd2bea7"  # GemJoin.gem()
MK_VAT   = "0x36569e77"  # GemJoin.vat()
MK_ILK   = "0xc5ce281e"  # GemJoin.ilk() -> bytes32
MK_URNS  = "0x2424be5c"  # Vat.urns(bytes32,address)->(ink uint256, art uint256)
MK_ILKS  = "0xd9638d36"  # Vat.ilks(bytes32)->(Art, rate(ray), spot, line, dust)
MAKER_QID = None         # Dune: ilk 별 urn 후보 (배치 후 생성해 채움)


class MakerJoin(Adapter):
    """Maker(MCD/Sky) GemJoin 담보 보관소. 실제 주인 = vat.urns(ilk,urn).ink 를 가진 CDP.
       발견=Dune(vat.frob/urn 목록) / 검증=온체인 vat.urns @block. 부채=art×rate(ray)."""
    name = "maker"
    def matches(self, addr, ctx):
        # GemJoin 시그니처: gem()+vat() 주소 응답 + ilk() bytes32 응답
        if not (ctx["read_addr"](addr, MK_GEM) and ctx["read_addr"](addr, MK_VAT)):
            return False
        return ctx["eth_call"](addr, MK_ILK) not in (None, "0x")

    def expand(self, addr, block, ctx):
        token = (ctx.get("token") or "").lower()
        gem = ctx["read_addr"](addr, MK_GEM)
        if not gem or token != gem.lower():
            return None  # 이 GemJoin 의 담보토큰이 부모 토큰과 다르면 패스
        vat = ctx["read_addr"](addr, MK_VAT)
        ilk = ctx["eth_call"](addr, MK_ILK)  # bytes32 hex
        if not vat or not ilk or ilk == "0x":
            return None
        if not MAKER_QID:
            return None  # 발견 소스(Dune) 미연결 → leaf (정직)
        K = ctx.get("K", 12); MINFRAC = ctx.get("MINFRAC", 0.01)
        dec = 10 ** _dec(ctx, token)
        # ilk rate(ray) for 부채 환산
        ilks = _words(ctx["eth_call"](vat, MK_ILKS + ilk[2:].rjust(64, "0")), 5)
        rate = ilks[1] if ilks[1] else 10 ** 27
        ck = f"maker_{ilk[2:18]}_{block}"
        urns = ctx["cache_get"]("ledger", ck)
        if urns is None:
            rows = ctx["dune"](MAKER_QID, {"ilk": ilk, "block": str(block), "k": str(max(K * 4, 50))})
            urns = [r.get("urn") for r in rows if isinstance(r.get("urn"), str) and r["urn"].startswith("0x")]
            ctx["cache_put"]("ledger", ck, urns)
        gj_bal = ctx["eth_call"](gem, S_BALANCEOF + _a(addr))
        phys = (int(gj_bal, 16) if gj_bal and gj_bal != "0x" else 0) / dec
        if phys <= 0:
            return None
        out = []
        for urn in urns:
            w = _words(ctx["eth_call"](vat, MK_URNS + ilk[2:].rjust(64, "0") + _a(urn)), 2)
            ink, art = w[0] / dec, w[1]
            if ink <= 0 or ink / phys < MINFRAC:
                continue
            debt = art * rate / 1e27 / 1e18  # DAI/USDS
            out.append({"addr": urn, "amount": ink, "label": "",
                        "position": {"role": "cdp_collateral", "venue": addr,
                                     "detail": {"collateral": round(ink, 4), "ilk": _b32_to_str(ilk),
                                                "debt_dai": round(debt, 2)},
                                     "verifiable_onchain": True, "confidence": "HIGH"}})
        out.sort(key=lambda x: -x["amount"])
        return out[:K] or None


def _b32_to_str(h):
    try:
        return bytes.fromhex(h[2:]).rstrip(b"\x00").decode("latin1")
    except Exception:
        return h[:18]


# ---- Compound v3 (Comet) ----
CV3_BASETOKEN = "0xc55dae63"  # baseToken()
CV3_NUMASSETS = "0xa46fe83b"  # numAssets()
CV3_USERCOLL  = "0x2b92a07d"  # userCollateral(address,address)->(uint128 balance, uint128 _)
CV3_BORROWBAL = "0x374c49b4"  # borrowBalanceOf(address)->uint256 (base 단위)
CV3_ASSETINFO = "0x3b3bec2e"  # getAssetInfoByAddress(address)->struct (word5=liquidateCF 1e18)
CV3_QID = "7650312"           # Dune: comet 담보 공급자 후보 (comet,asset,block,k)
S_DECIMALS_SEL = "0x313ce567"
S_SYMBOL_SEL   = "0x95d89b41"


def _dec(ctx, token):
    h = ctx["eth_call"](token, S_DECIMALS_SEL)
    return int(h, 16) if h and h != "0x" else 18

def _sym(ctx, token):
    h = ctx["eth_call"](token, S_SYMBOL_SEL)
    if not h or h == "0x": return None
    try:
        b = bytes.fromhex(h[2:])
        if len(b) >= 64:
            n = int.from_bytes(b[32:64], "big")
            if 0 < n <= 64: return b[64:64+n].decode("utf8", "ignore").strip("\x00") or None
        return b.rstrip(b"\x00").decode("utf8", "ignore") or None
    except Exception:
        return None


class CompoundV3(Adapter):
    """Compound III (Comet). 베이스자산(WETH 등) 공급 + 다중 담보자산 ledger.
       부모 토큰이 베이스면 → cToken 영수증 unwrap 위임("ERC20").
       부모 토큰이 담보자산이면 → 차입자(담보 포스터) 해석: userCollateral 로 검증.
       발견=Dune(supplycollateral) / 검증·환산=온체인 @block."""
    name = "compound_v3"
    def matches(self, addr, ctx):
        if not ctx["read_addr"](addr, CV3_BASETOKEN):
            return False
        return ctx["eth_call"](addr, CV3_NUMASSETS) not in (None, "0x")

    def expand(self, addr, block, ctx):
        token = (ctx.get("token") or "").lower()
        base = ctx["read_addr"](addr, CV3_BASETOKEN)
        if len(token) != 42 or not base:
            return None
        if token == base.lower():
            return "ERC20"  # 베이스 공급분 = cToken 홀더 → 제네릭 unwrap 에 위임
        K = ctx.get("K", 12); MINFRAC = ctx.get("MINFRAC", 0.01)
        ck = f"compound_v3_{addr}_{token}_{block}"
        cands = ctx["cache_get"]("ledger", ck)
        if cands is None:
            rows = ctx["dune"](CV3_QID, {"comet": addr, "asset": token, "block": str(block), "k": str(max(K*4, 40))})
            cands = [r.get("holder") for r in rows if isinstance(r.get("holder"), str) and r["holder"].startswith("0x")]
            ctx["cache_put"]("ledger", ck, cands)
        if not cands:
            return None
        dec = 10 ** _dec(ctx, token)
        base_dec = 10 ** _dec(ctx, base); base_sym = _sym(ctx, base)
        # 위험설정값: liquidateCollateralFactor (word5, 1e18)
        ai = ctx["eth_call"](addr, CV3_ASSETINFO + _a(token)); liqf = None
        if ai and ai != "0x" and len(ai) >= 2 + 64*6:
            liqf = int(ai[2+64*5:2+64*6], 16) / 1e18
        bh = ctx["eth_call"](token, S_BALANCEOF + _a(addr))
        phys = (int(bh, 16) if bh and bh != "0x" else 0) / dec
        if phys <= 0:
            return None
        out = []
        for acct in cands:
            uc = ctx["eth_call"](addr, CV3_USERCOLL + _a(acct) + _a(token))
            coll = int(uc[2:66], 16) / dec if uc and uc != "0x" else 0  # word0 balance(uint128)
            if coll <= 0 or coll / phys < MINFRAC:
                continue
            bb = ctx["eth_call"](addr, CV3_BORROWBAL + _a(acct))
            borrow = int(bb, 16) / base_dec if bb and bb != "0x" else 0
            out.append({"addr": acct, "amount": coll, "label": "",
                        "position": {"role": "collateral", "venue": addr,
                                     "detail": {"collateral": round(coll, 4),
                                                "base_token": base.lower(), "base_symbol": base_sym,
                                                "base_borrow": round(borrow, 4),
                                                "liq_factor": liqf},
                                     "verifiable_onchain": True, "confidence": "HIGH"}})
        out.sort(key=lambda x: -x["amount"])
        return out[:K] or None


S_LRTCONFIG = "0xf1650a46"  # Kelp NodeDelegator.lrtConfig()
RSETH       = "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7"  # Kelp rsETH (mainnet)


class KelpNodeDelegator(Adapter):
    """Kelp DAO NodeDelegator (rsETH 의 EigenLayer restaking 노드).
       여기 잠긴 자산은 rsETH 를 백킹 → 'transformed' 핸드오프: 한 단계 더 = rsETH 토큰으로 넘겨
       rsETH 홀더(Pendle/볼트/예치자)로 체인을 잇는다. (1:1 백킹 가정, 엣지 amount 그대로 전달)"""
    name = "kelp"
    def matches(self, addr, ctx):
        # lrtConfig() nonzero = Kelp 컨트랙트(노드·rsETH 토큰 둘 다 해당).
        # 단 rsETH 토큰은 ERC20(symbol 응답)이라 제외 → NodeDelegator 만(symbol revert).
        if not ctx["read_addr"](addr, S_LRTCONFIG):
            return False
        return ctx["eth_call"](addr, "0x95d89b41") in (None, "0x")
    def expand(self, addr, block, ctx):
        amt = ctx.get("amount")
        token = (ctx.get("token") or "").lower()
        if not amt:
            return None
        # transform 핸드오프는 "언더라잉 LST(stETH 등)가 rsETH 를 백킹"할 때만 의미.
        # 부모 토큰이 이미 rsETH 면(예: LRTWithdrawalManager·DepositPool 이 rsETH 보유) 순환 →
        # leaf(Kelp pool)로 둔다. (rsETH->Kelp->rsETH 자기참조 방지)
        if token == RSETH:
            return None
        return [{"addr": RSETH, "amount": amt, "label": "Kelp rsETH (transformed)"}]


REGISTRY = [AaveV3(), EigenLayerStrategy(), MorphoBlue(), MakerJoin(), KelpNodeDelegator(), CompoundV3()]


def match(addr, ctx):
    for a in REGISTRY:
        try:
            if a.matches(addr, ctx):
                return a
        except Exception:
            continue
    return None


def by_name(name):
    for a in REGISTRY:
        if a.name == name:
            return a
    return None
