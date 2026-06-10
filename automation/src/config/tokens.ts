// 하드코딩 seed 없음 — watchlist 는 `npm run discover` 가 임계(scope %) 통과 토큰을
// 자동 active 로 채움. (수동 추가가 필요하면 upsertWatchlist(addr, sym, 'manual'))

/**
 * 잘 알려진 ERC20 토큰 — 라벨링·심볼 자동 매칭용 (주소→심볼/decimals).
 * 이건 seed 가 아니라 symbol() 실패/bytes32 폴백용 사전.
 */
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18 },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18 },
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": { symbol: "WBTC", decimals: 8 },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC", decimals: 8 },
  "0x8236a87084f8b84306f72007f36f2618a5634494": { symbol: "LBTC", decimals: 8 },
  "0x35fa164735182de50811e8e2e824cfb9b6118ac2": { symbol: "eETH", decimals: 18 },
  "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee": { symbol: "weETH", decimals: 18 },
  "0x9d39a5de30e57443bff2a8307a4256c8797a3497": { symbol: "sUSDe", decimals: 18 },
  "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": { symbol: "USDe", decimals: 18 },
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": { symbol: "wstETH", decimals: 18 },
  "0x6c3ea9036406852006290770bedfcaba0e23a0e8": { symbol: "PYUSD", decimals: 6 },
};
