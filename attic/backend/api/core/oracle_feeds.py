"""
oracle_feeds.py — shared-oracle (common-mode) dependency registry.

WHY this exists (the gap it fills):
  The per-asset lending model shocks ONE collateral asset at a time. But a price
  feed is a SHARED dependency: if one feed fails (manipulation, staleness, a bad
  push), EVERY asset priced through it mis-prices SIMULTANEOUSLY. That correlated,
  single-point-of-failure shock is the `shared_oracle_risk` channel — a systemic
  path the single-asset model structurally cannot represent.

GROUNDING (why these mappings, not guesses):
  - Aave CAPO (Correlated-Asset Price Oracle): an LST/LRT USD price is built as
        price_USD = (Chainlink ETH/USD)  ×  (capped exchange-rate)
    So Chainlink ETH/USD sits UPSTREAM of WETH *and* every ETH-denominated
    LST/LRT at once. Same logic puts BTC/USD upstream of every wrapped-BTC token.
  - Exchange-rate adapters (Lido wstETH↔stETH, etherFi weETH↔eETH) are shared
    WITHIN a token family.
  - Single-stable feeds (USDC/USD, USDT/USD, DAI/USD) are narrow (the stable + its
    staked form) — a USDC feed fault does NOT move DAI (different feed).

MODEL — denomination-derived (C2):
  Instead of hand-listing every symbol per feed, a BROAD feed declares a
  `denom` ("eth" | "btc"); its asset set is DERIVED as `_DENOM[denom] ∩ live`, so a
  newly-listed LST automatically joins ETH/USD with no edit. Narrow feeds (stables,
  rate adapters) keep an explicit `assets` map. transmission_factor ∈ (0,1] = how much
  of the feed's δ shows in the asset's USD price (≈1 when denominated in the feed unit).
  The shock applies effective_delta = δ_feed × factor, then the EXISTING lending /
  DebtRank propagation runs from every affected asset at once.
"""
from __future__ import annotations

ORACLE_PREFIX = "oracle:"

# Pricing denomination — what each collateral's USD price is BUILT FROM. Drives the
# broad common-mode feeds (ETH/USD, BTC/USD). Add a token here and it auto-joins.
_DENOM: dict[str, set[str]] = {
    "eth": {
        "WETH", "ETH", "wstETH", "stETH", "weETH", "eETH", "rsETH", "wrsETH",
        "ezETH", "weETHs", "cbETH", "rETH", "osETH", "mETH", "ETHx", "pufETH",
        "sfrxETH", "frxETH", "wbETH", "uniETH", "rswETH", "ETHFI",
    },
    "btc": {
        "WBTC", "cbBTC", "tBTC", "LBTC", "eBTC", "kBTC", "pumpBTC", "solvBTC",
        "FBTC", "swBTC", "uniBTC", "enzoBTC",
    },
}

# oracle_id -> metadata.
#   broad feed:  has "denom" → assets derived from _DENOM[denom] ∩ live (factor 1.0)
#   narrow feed: has "assets" → {symbol: transmission_factor}
ORACLES: dict[str, dict] = {
    "oracle:chainlink_eth_usd": {
        "label": "Chainlink ETH/USD", "provider": "Chainlink", "kind": "base_feed",
        "denom": "eth",
        "note": ("ETH/USD 기준 피드. CAPO LST/LRT 가격 = ETH/USD × 교환비 → "
                 "거의 모든 ETH-denominated 담보의 공통 상류. 단일 장애가 ETH 담보 전체를 동시에 흔든다."),
    },
    "oracle:chainlink_btc_usd": {
        "label": "Chainlink BTC/USD", "provider": "Chainlink", "kind": "base_feed",
        "denom": "btc",
        "note": ("BTC/USD 기준 피드. 모든 wrapped/staked BTC(WBTC·cbBTC·LBTC·tBTC…) 의 공통 상류."),
    },
    "oracle:chainlink_usdc_usd": {
        "label": "Chainlink USDC/USD", "provider": "Chainlink", "kind": "stable_feed",
        "note": ("USDC/USD 피드. USDC 및 USDC 기반 가격 자산의 공통 상류 (DAI 등 타 스테이블엔 무관)."),
        "assets": {"USDC": 1.0, "aUSDC": 1.0, "USDe": 0.5, "sUSDe": 0.5},
    },
    "oracle:chainlink_usdt_usd": {
        "label": "Chainlink USDT/USD", "provider": "Chainlink", "kind": "stable_feed",
        "note": ("USDT/USD 피드. USDT 및 USDT 기반 마켓의 공통 상류."),
        "assets": {"USDT": 1.0, "aUSDT": 1.0},
    },
    "oracle:chainlink_dai_usd": {
        "label": "Chainlink DAI/USD", "provider": "Chainlink", "kind": "stable_feed",
        "note": ("DAI/USD 피드. DAI·sDAI·USDS(Sky) 의 공통 상류."),
        "assets": {"DAI": 1.0, "sDAI": 1.0, "USDS": 1.0, "sUSDS": 1.0},
    },
    "oracle:lido_wsteth_rate": {
        "label": "Lido wstETH 교환비 (CAPO)", "provider": "Lido", "kind": "exchange_rate",
        "note": ("wstETH↔stETH 교환비 어댑터. 검증인 슬래싱·인덱스 조작 시 Lido 토큰군이 함께 mis-price."),
        "assets": {"wstETH": 1.0, "stETH": 1.0},
    },
    "oracle:etherfi_weeth_rate": {
        "label": "etherFi weETH 교환비 (CAPO)", "provider": "etherFi", "kind": "exchange_rate",
        "note": ("weETH↔eETH 교환비 어댑터. etherFi 토큰군(weETH/eETH)의 공통 상류."),
        "assets": {"weETH": 1.0, "eETH": 1.0},
    },
}


def is_oracle(asset_id: str) -> bool:
    """True if `asset_id` names an oracle shock target (vs a plain collateral asset)."""
    return bool(asset_id) and asset_id.startswith(ORACLE_PREFIX)


def assets_for_oracle(oracle_id: str, live_symbols: set[str] | None = None) -> dict[str, float]:
    """{asset_symbol: transmission_factor} for `oracle_id`.
    Broad feeds derive their set from the denomination class (auto-includes new LSTs);
    narrow feeds use their explicit map. If `live_symbols` is given, restrict to assets
    that actually have live exposure."""
    meta = ORACLES.get(oracle_id)
    if not meta:
        return {}
    if "denom" in meta:
        base = {s: 1.0 for s in _DENOM.get(meta["denom"], set())}
    else:
        base = dict(meta.get("assets", {}))
    if live_symbols is not None:
        return {s: f for s, f in base.items() if s in live_symbols}
    return base
