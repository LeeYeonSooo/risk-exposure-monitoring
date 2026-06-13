/**
 * 흐름 귀속 어댑터 커버리지 — "이 프로토콜의 실제 흐름을 측정할 수단이 있는가"의 단일 판정원.
 *
 * 흐름맵의 프로토콜 노드는 **TVL/거래량(DeFiLlama)** 으로 생성되지만, 그 노드에 평소·실시간
 * 흐름을 칠하려면 별도의 **귀속 어댑터**가 필요하다:
 *   · 레지스트리(lib/counterparties.ts): Uniswap CREATE2 · Curve MetaRegistry · Aerodrome 팩토리
 *     · Aave/Spark aToken · Compound Comet · Morpho 싱글톤 · Convex Booster
 *   · 이벤트 수집기(lib/lending-events.ts): aave·spark·compound·fluid·morpho·euler·lido·sky·ethena·ether.fi
 *
 * 어댑터가 없는 프로토콜(예: pendle·balancer·sushiswap·maple·yearn)은 노드는 떠도 흐름이
 * 회색으로만 남는다 — 그건 "조용해서"가 아니라 "측정 수단이 없어서"다. 이 둘을 노드 단에서
 * 구분 표기(meta.flowSupported)하고, 선별 충원에서 어댑터 없는 니치를 더 높은 컷으로 거르는 데
 * 같은 판정을 쓴다. 커버리지는 **체인 의존**이다(Curve=이더리움만, Aerodrome=Base만 등).
 *
 * ⚠ 어댑터를 새로 붙이면(레지스트리/이벤트) 반드시 이 표에도 같이 추가할 것 — 안 그러면 새로
 * 칠해지는 노드가 여전히 "미지원"으로 표기되는 불일치가 난다.
 */

const ALL: readonly string[] = ["ethereum", "base", "arbitrum"];

// 슬러그 정밀 매칭 — 버전 구분이 중요하다(compound-v3 O / compound-v2 X, curve-dex O / curve-llamalend X,
// fluid-lending O / fluid-dex X, spark/sparklend O / spark-savings X).
const COVERED: { test: (slug: string) => boolean; chains: readonly string[] }[] = [
  { test: (s) => /^uniswap-v[234]$/.test(s), chains: ALL },                 // V2/V3 CREATE2 + V4 PoolManager
  { test: (s) => s === "aave-v3", chains: ALL },                            // aToken(getReserveData) + 이벤트 (aave-v2/v4 미지원)
  { test: (s) => s === "compound-v3", chains: ALL },                        // Comet (compound-v2 미지원)
  { test: (s) => s === "morpho-blue", chains: ALL },                        // 싱글톤 + blue-api 이벤트(+볼트)
  { test: (s) => s === "fluid-lending", chains: ALL },                      // LogOperate 이벤트 (fluid-dex/lite 미지원)
  { test: (s) => s === "euler-v2" || s === "euler", chains: ALL },          // Goldsky 볼트 + 주소배열 getLogs (L2 포함)
  { test: (s) => s === "curve-dex" || s === "curve", chains: ["ethereum"] },// MetaRegistry = 메인넷 전용 (curve-llamalend 미지원)
  { test: (s) => s.startsWith("convex"), chains: ["ethereum"] },            // Booster 싱글톤
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
