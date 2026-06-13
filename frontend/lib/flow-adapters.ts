/**
 * 흐름 귀속 어댑터 커버리지 — "이 프로토콜의 실제 흐름을 측정할 수단이 있는가"의 단일 판정원.
 *
 * 흐름맵의 프로토콜 노드는 **TVL/거래량(DeFiLlama)** 으로 생성되지만, 그 노드에 평소·실시간
 * 흐름을 칠하려면 별도의 **귀속 어댑터**가 필요하다:
 *   · 레지스트리(lib/counterparties.ts): Uniswap CREATE2 · Curve MetaRegistry · Aerodrome 팩토리
 *     · Aave/Spark aToken · Compound Comet · Morpho 싱글톤 · Convex Booster
 *   · 이벤트 수집기(lib/lending-events.ts): aave·spark·compound·fluid·morpho·euler·lido·sky·ethena·ether.fi
 *
 * 어댑터가 없는 프로토콜(예: beefy·solv·concrete·apyx 등 롱테일)은 노드는 떠도 흐름이
 * 회색으로만 남는다 — 그건 "조용해서"가 아니라 "측정 수단이 없어서"다. 이 둘을 노드 단에서
 * 구분 표기(meta.flowSupported)하고, 선별 충원에서 어댑터 없는 니치를 더 높은 컷으로 거르는 데
 * 같은 판정을 쓴다. 커버리지는 **체인 의존**이다(Curve=이더리움만, Aerodrome=Base만 등).
 *
 * ⚠ 어댑터를 새로 붙이면(레지스트리/이벤트) 반드시 이 표에도 같이 추가할 것 — 안 그러면 새로
 * 칠해지는 노드가 여전히 "미지원"으로 표기되는 불일치가 난다.
 */

const ALL: readonly string[] = ["ethereum", "base", "arbitrum"];

// 슬러그 정밀 매칭 — 버전 구분이 중요하다(compound-v3 O / compound-v2 X, curve-dex O / curve-llamalend X,
// fluid-lending·fluid-dex O, spark/sparklend(대출풀)·spark-savings(sDAI/sUSDC) 둘 다 O).
const COVERED: { test: (slug: string) => boolean; chains: readonly string[] }[] = [
  { test: (s) => /^uniswap-v[234]$/.test(s), chains: ALL },                 // V2/V3 CREATE2 + V4 PoolManager
  { test: (s) => s === "aave-v3", chains: ALL },                            // aToken(getReserveData) + 이벤트 (aave-v2/v4 미지원)
  { test: (s) => s === "compound-v3", chains: ALL },                        // Comet (compound-v2 미지원)
  { test: (s) => s === "morpho-blue", chains: ALL },                        // 싱글톤 + blue-api 이벤트(+볼트)
  { test: (s) => s === "fluid-lending", chains: ALL },                      // LogOperate 이벤트(user∉dexSet) — fluid-dex 는 아래 별도
  { test: (s) => s === "euler-v2" || s === "euler", chains: ALL },          // Goldsky 볼트 + 주소배열 getLogs (L2 포함)
  { test: (s) => s === "curve-dex" || s === "curve", chains: ALL },         // eth=MetaRegistry · arb/base=api.curve.finance (curve-llamalend 미지원)
  { test: (s) => s.startsWith("convex"), chains: ["ethereum"] },            // Booster 싱글톤
  // ── DEX 포크 (factory.getPool/getPair 온체인 — lib/dex-fork-pools.ts) — base·arbitrum 전용
  //    (이더리움은 uniswap/curve/balancer 가 커버 + 파생패밀리 폭증으로 콜드로드 보호 위해 미적용) ──
  { test: (s) => s === "pancakeswap-amm-v3", chains: ["base", "arbitrum"] },      // PancakeSwap V3 (fee 2500 티어)
  { test: (s) => s === "pancakeswap-amm", chains: ["base", "arbitrum"] },         // PancakeSwap V2
  { test: (s) => s === "sushiswap", chains: ["base", "arbitrum"] },               // Sushiswap V2
  { test: (s) => s === "sushiswap-v3", chains: ["base", "arbitrum"] },            // Sushiswap V3
  { test: (s) => s === "camelot-v2" || s === "camelot-v3", chains: ["arbitrum"] },// Camelot V2 + V3(Algebra)
  // ── 하드케이스 해결분 (2026-06-13 라이브 검증) ──
  { test: (s) => s === "gmx-v2-perps", chains: ["arbitrum"] },                    // GMX V2 OrderVault/Deposit/Withdraw 싱글톤
  { test: (s) => s === "mim-swap", chains: ["arbitrum"] },                        // Abracadabra MagicLPFactory 열거
  { test: (s) => s === "centrifuge-protocol", chains: ALL },                      // Centrifuge V3 풀별 Escrow (api.centrifuge.io)
  { test: (s) => s === "fluid-dex", chains: ALL },                                // Fluid DEX — LogOperate topic1∈dexSet 분기(이벤트)
  // ── ERC-4626 볼트 (lib/lending-events.ts ERC4626_SAVINGS + counterparties 큐레이트) ──
  { test: (s) => s === "maple", chains: ["ethereum"] },                     // syrupUSDC/syrupUSDT
  { test: (s) => s === "yo-protocol", chains: ["ethereum"] },               // yoUSD
  { test: (s) => s === "puffer-stake", chains: ["ethereum"] },              // pufETH
  // ── Compound-V2 포크 cToken (lib/lending-pools.ts compoundV2Markets) ──
  { test: (s) => s === "compound-v2", chains: ["ethereum"] },               // Compound V2 cToken
  { test: (s) => s === "moonwell-lending", chains: ["base"] },              // Moonwell (Compound-V2 fork)
  // ── LST/RWA 발행 (lib/lending-events.ts LST_ISSUERS — mint/burn 0x0 엣지를 프로토콜로 귀속) ──
  { test: (s) => s === "rocket-pool", chains: ["ethereum"] },               // rETH
  { test: (s) => s === "binance-staked-eth", chains: ["ethereum"] },        // wBETH
  { test: (s) => s === "kelp", chains: ["ethereum"] },                      // rsETH (LRT)
  { test: (s) => s === "lombard-lbtc", chains: ["ethereum"] },              // LBTC
  { test: (s) => s === "ondo-yield-assets", chains: ["ethereum"] },         // USDY·OUSG (RWA)
  { test: (s) => s === "usual-usd0", chains: ["ethereum"] },                // USD0
  { test: (s) => s === "meth-protocol", chains: ["ethereum"] },             // mETH
  { test: (s) => s === "stader", chains: ["ethereum"] },                    // ETHx
  // ── ERC4626 savings/vault (lib/lending-events.ts ERC4626_SAVINGS) ──
  { test: (s) => s === "spark-savings", chains: ["ethereum"] },             // sDAI·sUSDC
  { test: (s) => s === "yearn-finance", chains: ["ethereum"] },             // yvUSD·ysUSDC (V3)
  // ── 싱글톤 수탁 (lib/counterparties.ts addKnown) ──
  { test: (s) => s === "dolomite", chains: ["ethereum"] },                  // DolomiteMargin
  { test: (s) => s === "avantis", chains: ["base"] },                       // Avantis perps (TradingStorage·VaultManager)
  { test: (s) => s.startsWith("aerodrome"), chains: ["base"] },             // 팩토리 = Base 전용
  { test: (s) => s === "lido", chains: ["ethereum"] },                      // Submitted/WithdrawalRequested 이벤트
  { test: (s) => s === "spark" || s === "sparklend", chains: ["ethereum"] },// SparkLend 풀 이벤트 (spark-savings 미지원)
  { test: (s) => s === "sky-lending", chains: ["ethereum"] },               // sUSDS ERC-4626 이벤트
  { test: (s) => s.startsWith("ethena"), chains: ["ethereum"] },            // sUSDe ERC-4626 이벤트
  { test: (s) => s.startsWith("ether.fi") || s.startsWith("etherfi"), chains: ["ethereum"] }, // eETH 민트/소각 이벤트
  { test: (s) => s.startsWith("balancer"), chains: ALL },                   // V2/V3 Vault 싱글톤 (멀티체인)
  { test: (s) => s === "pendle", chains: ALL },                             // Router V4 싱글톤
];

/** 이 (프로토콜 슬러그, 체인)에 실제 흐름을 측정·귀속할 어댑터가 있는가. */
export function hasFlowAdapter(slug: string | null | undefined, chain: string): boolean {
  if (!slug) return false;
  const s = slug.toLowerCase();
  for (const c of COVERED) if (c.chains.includes(chain) && c.test(s)) return true;
  return false;
}
