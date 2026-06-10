"""체인 메타데이터 자동 로드 — CCIP 레지스트리·체인별 RPC·selector/eid 이름.

기준 데이터는 모두 실행 시 네트워크에서 받아와 1회 캐시한다(로컬 DB 불필요).
"""

import re
import requests

from ..alchemy import alchemy_url

# chainId → Alchemy 서브도메인 (각 엔드포인트에 eth_chainId 질의로 실측 검증한 매핑).
# ALCHEMY_KEY 가 .env 에 있으면 이 체인들은 Alchemy(전용 회선)로 조회 → getLogs 안정화.
ALCHEMY_SUBDOMAINS = {
    1: "eth-mainnet", 10: "opt-mainnet", 25: "cronos-mainnet", 30: "rootstock-mainnet",
    56: "bnb-mainnet", 100: "gnosis-mainnet", 130: "unichain-mainnet", 137: "polygon-mainnet",
    143: "monad-mainnet", 146: "sonic-mainnet", 196: "xlayer-mainnet", 204: "opbnb-mainnet",
    232: "lens-mainnet", 252: "frax-mainnet", 288: "boba-mainnet", 324: "zksync-mainnet",
    747: "flow-mainnet",   # Flow EVM (eth_chainId=0x2eb 실측)
    360: "shape-mainnet", 480: "worldchain-mainnet", 510: "synd-mainnet", 592: "astar-mainnet",
    869: "worldmobilechain-mainnet", 988: "stable-mainnet", 999: "hyperliquid-mainnet",
    1088: "metis-mainnet", 1101: "polygonzkevm-mainnet", 1284: "moonbeam-mainnet",
    1329: "sei-mainnet", 1514: "story-mainnet", 1672: "pharos-mainnet", 1776: "injective-mainnet",
    1868: "soneium-mainnet", 2020: "ronin-mainnet", 2741: "abstract-mainnet", 3343: "edge-mainnet",
    3637: "botanix-mainnet", 4114: "citrea-mainnet", 4153: "rise-mainnet", 4158: "crossfi-mainnet",
    4217: "tempo-mainnet", 4326: "megaeth-mainnet", 5000: "mantle-mainnet", 5330: "superseed-mainnet",
    5371: "settlus-mainnet", 7000: "zetachain-mainnet", 8217: "kaia-mainnet", 8453: "base-mainnet",
    9745: "plasma-mainnet", 33139: "apechain-mainnet", 34443: "mode-mainnet", 36900: "adi-mainnet",
    42018: "mythos-mainnet", 42161: "arb-mainnet", 42220: "celo-mainnet", 43114: "avax-mainnet",
    57073: "ink-mainnet", 59144: "linea-mainnet", 60808: "bob-mainnet", 69000: "anime-mainnet",
    80094: "berachain-mainnet", 81457: "blast-mainnet", 510525: "clankermon-mainnet",
    534352: "scroll-mainnet", 613419: "galactica-mainnet", 685689: "gensyn-mainnet",
    747474: "katana-mainnet", 5734951: "jovay-mainnet", 6985385: "humanity-mainnet",
    7777777: "zora-mainnet", 666666666: "degen-mainnet",
}

# CCIP 레지스트리는 런타임 자동 로드(ccip_registries). 아래는 폴백/검증값.
CCIP_REGISTRY_FALLBACK = {
    1: "0xb22764f98dD05c789929716D677382Df22C05Cb6",   # Ethereum mainnet (검증됨)
}

# 신뢰도 높은 큐레이션 RPC. 없는 체인은 chainid.network 에서 자동 해결.
DEFAULT_READ_RPC = {
    1:     "https://ethereum-rpc.publicnode.com",
    10:    "https://optimism-rpc.publicnode.com",
    8453:  "https://base-rpc.publicnode.com",
    42161: "https://arbitrum-one-rpc.publicnode.com",
    59144: "https://linea-rpc.publicnode.com",
    43114: "https://avalanche-c-chain-rpc.publicnode.com",
    # 신생/소형 체인 (ChainList 보강, Score 녹색)
    25:     "https://evm.cronos.org",                    # Cronos
    14:     "https://flare-api.flare.network/ext/C/rpc", # Flare
    143:    "https://rpc.monad.xyz",                     # Monad
    98866:  "https://rpc.plume.org",                     # Plume
    747474: "https://rpc.katanarpc.com",                 # Katana
}

_CCIP_REGISTRIES = None
_CHAIN_RPCS = None
_SELECTOR_NAMES = None
_LZ_EIDS = None


def _chainid_by_selector():
    """chain-selectors.yml: {selector(str): chainId(int)}"""
    out = {}
    try:
        txt = requests.get(
            "https://raw.githubusercontent.com/smartcontractkit/chain-selectors/main/selectors.yml",
            timeout=40).text
        cur = None
        for line in txt.splitlines():
            m = re.match(r"\s*(\d+):\s*$", line)
            if m:
                cur = int(m.group(1)); continue
            m = re.search(r"selector:\s*(\d+)", line)
            if m and cur is not None:
                out[m.group(1)] = cur
    except Exception:
        pass
    return out


def ccip_registries():
    """{chainId(int): TokenAdminRegistry 주소} — Chainlink 공식 설정에서 자동 로드. 1회 캐시."""
    global _CCIP_REGISTRIES
    if _CCIP_REGISTRIES is not None:
        return _CCIP_REGISTRIES
    reg = dict(CCIP_REGISTRY_FALLBACK)
    try:
        sel2cid = _chainid_by_selector()
        cj = requests.get("https://raw.githubusercontent.com/smartcontractkit/documentation"
                          "/main/src/config/data/ccip/v1_2_0/mainnet/chains.json", timeout=40).json()
        for _, e in cj.items():
            sel = str(e.get("chainSelector"))
            tar = (e.get("tokenAdminRegistry") or {}).get("address")
            cid = sel2cid.get(sel)
            if cid and tar:
                reg[cid] = tar
    except Exception:
        pass
    _CCIP_REGISTRIES = reg
    return reg


def resolve_rpc(chain_id, user_rpc=None):
    """읽기 RPC 결정: 사용자 지정 > Alchemy(ALCHEMY_KEY) > 큐레이션 공개 > chainid.network 자동."""
    if user_rpc:
        return user_rpc
    al = alchemy_url(ALCHEMY_SUBDOMAINS.get(chain_id))   # ALCHEMY_KEY 있으면 전용 회선 우선
    if al:
        return al
    if chain_id in DEFAULT_READ_RPC:
        return DEFAULT_READ_RPC[chain_id]
    global _CHAIN_RPCS
    if _CHAIN_RPCS is None:
        _CHAIN_RPCS = {}
        PREFER = ("publicnode", "drpc.org", "llamarpc", "blockpi", "1rpc.io",
                  "blastapi", "tenderly", "meowrpc", "nodereal", "onfinality")
        try:
            data = requests.get("https://chainid.network/chains.json", timeout=40).json()
            for c in data:
                rpcs = [u for u in c.get("rpc", [])
                        if u.startswith("https://") and "${" not in u
                        and "API_KEY" not in u.upper() and "your-" not in u.lower()]
                if not rpcs:
                    continue
                pref = [u for u in rpcs if any(p in u for p in PREFER)]
                _CHAIN_RPCS[c["chainId"]] = (pref or rpcs)[0]
        except Exception:
            pass
    return _CHAIN_RPCS.get(chain_id)


def selector_names():
    """Chainlink chain-selectors: {selector(int): 짧은 체인명} (CCIP 용). 1회 캐시."""
    global _SELECTOR_NAMES
    if _SELECTOR_NAMES is not None:
        return _SELECTOR_NAMES
    _SELECTOR_NAMES = {}
    try:
        txt = requests.get(
            "https://raw.githubusercontent.com/smartcontractkit/chain-selectors/main/selectors.yml",
            timeout=30).text
        cur = None
        for line in txt.splitlines():
            m = re.search(r"selector:\s*(\d+)", line)
            if m:
                cur = int(m.group(1)); continue
            m = re.search(r'name:\s*"([^"]+)"', line)
            if m and cur is not None:
                nm = m.group(1).replace("ethereum-mainnet-", "").replace("-1", "")
                nm = nm.replace("ethereum-mainnet", "ethereum")
                _SELECTOR_NAMES[cur] = nm
                cur = None
    except Exception:
        pass
    return _SELECTOR_NAMES


def lz_eid_names():
    """LayerZero 메타데이터: {eid(int): 체인명} (V2 메인넷). 1회 캐시."""
    global _LZ_EIDS
    if _LZ_EIDS is not None:
        return _LZ_EIDS
    _LZ_EIDS = {}
    try:
        j = requests.get("https://metadata.layerzero-api.com/v1/metadata", timeout=40).json()
        for key, entry in j.items():
            if not isinstance(entry, dict):
                continue
            name = entry.get("chainName") or entry.get("chainKey") or key
            for dep in entry.get("deployments", []) or []:
                try:
                    eid = int(dep.get("eid"))
                except (TypeError, ValueError):
                    continue
                if dep.get("stage") == "mainnet" and 30000 <= eid < 40000:  # V2 mainnet
                    _LZ_EIDS[eid] = name
    except Exception:
        pass
    return _LZ_EIDS
