"""체인 계열 판별 공통 헬퍼.

라우터가 (토큰 주소, 체인 식별자)를 보고 어느 계열(evm/solana/cosmos)인지 정한다.
주소 형식과 체인 힌트를 함께 사용해 견고하게 분류한다.
"""

import re

# ── 체인 힌트(문자열)로 계열을 바로 정하는 키워드 ──
SOLANA_NAMES = {"solana", "sol", "eclipse"}
TRON_NAMES = {"tron", "trx"}
APTOS_NAMES = {"aptos", "apt", "move", "movement"}  # Aptos Move VM
SUI_NAMES = {"sui"}  # Sui Move VM — Aptos 와 코인타입 형식이 같아 'sui' 힌트로만 구분
STARKNET_NAMES = {"starknet", "cairo", "sn"}  # Cairo VM — 0x+felt 라 'starknet' 힌트로 구분
STELLAR_NAMES = {"stellar", "xlm", "soroban"}  # Stellar — CODE:ISSUER(G…) 형식

# Cosmos 계열 체인명(소문자). rest.cosmos.directory 의 chain name 기준 + 별칭.
COSMOS_NAMES = {
    "cosmoshub", "cosmos", "osmosis", "osmo", "injective", "inj", "celestia", "tia",
    "noble", "neutron", "kava", "axelar", "stargaze", "juno", "akash", "secret",
    "stride", "dydx", "kujira", "sei-cosmos", "persistence", "evmos", "dymension",
}

# Base58 알파벳 (0, O, I, l 제외) — Solana 주소 판별용
_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {ch: i for i, ch in enumerate(_B58_ALPHABET)}

_EVM_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

# Aptos: Coin 타입태그(0x…::mod::Struct) 또는 Fungible Asset 객체주소(0x + 41~64 hex).
#   EVM 은 정확히 40hex 라, FA 는 길이로 구분(40 초과). 40hex 이하 FA 는 chain='aptos' 힌트 필요.
_APTOS_COIN_RE = re.compile(r"^0x[0-9a-fA-F]{1,64}::[A-Za-z0-9_]+::[A-Za-z0-9_]+")
_APTOS_FA_RE = re.compile(r"^0x[0-9a-fA-F]{41,64}$")

# Stellar classic 자산: CODE:ISSUER (발행자는 G + 55 base32). 단일 ':' 라 Aptos/Sui('::')와 구분.
_STELLAR_ASSET_RE = re.compile(r"^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$")


def is_evm_address(token):
    """0x + 40 hex → EVM 주소."""
    return bool(_EVM_RE.match(token.strip()))


def is_aptos_address(token):
    """Aptos Coin 타입태그(::포함) 또는 FA 객체주소(0x + 41~64 hex)."""
    t = token.strip()
    return bool(_APTOS_COIN_RE.match(t) or _APTOS_FA_RE.match(t))


def is_stellar_asset(token):
    """Stellar classic 자산 'CODE:ISSUER'(발행자 G+55base32)."""
    return bool(_STELLAR_ASSET_RE.match(token.strip()))


def b58decode(s):
    """Base58 디코드. 실패하면 None."""
    num = 0
    for ch in s:
        if ch not in _B58_INDEX:
            return None
        num = num * 58 + _B58_INDEX[ch]
    # 앞쪽 '1'(=0) 개수만큼 leading zero 바이트
    n_pad = len(s) - len(s.lstrip("1"))
    body = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    return b"\x00" * n_pad + body


def is_solana_address(token):
    """Base58 로 디코드 시 정확히 32바이트 → Solana 퍼블릭키(민트 주소)."""
    t = token.strip()
    if not (32 <= len(t) <= 44):
        return False
    if any(ch not in _B58_INDEX for ch in t):
        return False
    decoded = b58decode(t)
    return decoded is not None and len(decoded) == 32


def is_cosmos_ibc_denom(token):
    """ibc/<64 hex> 형식의 IBC 토큰."""
    t = token.strip()
    return bool(re.match(r"^ibc/[0-9A-Fa-f]{64}$", t))


def classify_family(token, chain=None):
    """(토큰, 체인) → 'evm' | 'solana' | 'cosmos' | None.

    우선순위:
      1) 체인 힌트가 명확하면 그걸 신뢰 (정수/숫자=EVM, 알려진 계열명)
      2) 그래도 모르면 토큰 주소 형식으로 판별
    """
    token = (token or "").strip()

    # 1) 체인 힌트 우선
    if isinstance(chain, int):
        return "evm"
    if chain is not None:
        cs = str(chain).strip().lower()
        if cs.isdigit():
            return "evm"
        if cs in SOLANA_NAMES:
            return "solana"
        if cs in TRON_NAMES:
            return "tron"
        if cs in SUI_NAMES:           # Aptos 와 형식 동일 → 'sui' 힌트 우선 검사
            return "sui"
        if cs in STARKNET_NAMES:      # 0x+felt → 'starknet' 힌트로만 구분
            return "starknet"
        if cs in STELLAR_NAMES:
            return "stellar"
        if cs in APTOS_NAMES:
            return "aptos"
        if cs in COSMOS_NAMES:
            return "cosmos"
        # 알 수 없는 체인명 → 주소 형식으로 폴백

    # 2) 토큰 주소 형식으로 판별
    if is_evm_address(token):       # 정확히 40hex (Aptos FA 보다 먼저: EVM 우선)
        return "evm"
    if is_tron_address(token):
        return "tron"
    if is_aptos_address(token):     # ::포함 Coin 타입 또는 41~64hex FA
        return "aptos"
    if is_stellar_asset(token):     # CODE:ISSUER (단일 ':' + G발행자)
        return "stellar"
    if is_cosmos_ibc_denom(token):
        return "cosmos"
    if is_solana_address(token):
        return "solana"

    return None


def is_tron_address(token):
    """Tron base58 주소: 'T' 로 시작하는 34자."""
    t = token.strip()
    if not (t.startswith("T") and len(t) == 34):
        return False
    return all(ch in _B58_INDEX for ch in t)
