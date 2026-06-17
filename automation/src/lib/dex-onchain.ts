/**
 * 온체인 DEX 가격·유동성 리더 — coins.llama(시세)·DefiLlama(DEX 유동성)를 RPC 직접읽기로 대체.
 *
 * 왜: 리스크 모니터가 오프체인 API(staleness·조작·다운·블록귀속 불가)에 의존하는 걸 제거.
 *   특히 depeg 는 **DEX 시장가**가 필요한데(Chainlink/렌딩오라클은 NAV라 디페그 때 안 움직임 → 그걸로 대체하면 탐지 침묵),
 *   여기서 DEX 풀 리저브를 직접 읽어 시장가를 만든다.
 *
 * 방식:
 *   · 풀 자동발견 — Uni V3 factory.getPool(token, quote, fee[]) + Uni V2 factory.getPair(token, quote). quote ∈ {USDC, WETH}.
 *   · 가격 — V3 slot0(sqrtPriceX96) 수학 / V2 getReserves 비율. WETH 견적은 Chainlink ETH/USD numeraire 로 USD 환산.
 *   · 유동성 — 풀의 quote-side 잔액 × quoteUsd × 2 (TVL 근사). 가장 깊은(quote-side 최대) 풀을 대표로.
 *   · 미커버(풀 없음) → null → 호출부가 coins.llama 폴백.
 *
 * 전부 eth_call(Alchemy, multicall3 배칭) — getLogs 아님이라 빠르고 한도 여유. 토큰당 ~10 발견콜 + 대표풀 2~3 읽기.
 */
import type { Address, PublicClient } from "viem";

import { rpcFor } from "@/lib/rpc";

// ─────────────────────────────────────────────────────────────
// 체인별 상수 (eth/base/arb) — quote 토큰·DEX 팩토리·Chainlink ETH/USD
// ─────────────────────────────────────────────────────────────
interface ChainDex {
  weth: Address; usdc: Address; usdcDecimals: number;
  v3Factory: Address; v2Factory: Address | null; ethUsdFeed: Address;
}
const CHAIN_DEX: Record<number, ChainDex> = {
  1: {
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", usdcDecimals: 6,
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    v2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    ethUsdFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  },
  8453: {
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usdcDecimals: 6,
    v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    v2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    ethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  },
  42161: {
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", usdcDecimals: 6,
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    v2Factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
    ethUsdFeed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  },
};
const V3_FEES = [500, 3000, 10000, 100] as const; // 발견 대상 fee tier(흔한 순)
// 얇은 풀 가격은 신뢰불가 — 소액 거래로도 spot 이 크게 흔들려 depeg 오탐(실측: LBTC $0 풀→$49k, tBTC $20k 풀→$62k).
//   이 미만이면 null 반환 → coins.llama 폴백(전 venue 집계라 Curve/Balancer 유동성도 반영). 깊은 풀(WBTC $64M·USDe $1.8M)은 통과.
const MIN_DEX_LIQUIDITY_USD = 500_000;

// ─────────────────────────────────────────────────────────────
// ABIs (최소)
// ─────────────────────────────────────────────────────────────
const V3_FACTORY_ABI = [{ name: "getPool", stateMutability: "view", type: "function", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] }] as const;
const V2_FACTORY_ABI = [{ name: "getPair", stateMutability: "view", type: "function", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }] }] as const;
const V3_POOL_ABI = [{ name: "slot0", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }] as const;
const V2_PAIR_ABI = [{ name: "getReserves", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] }] as const;
const ERC20_BAL_ABI = [{ name: "balanceOf", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const FEED_ABI = [
  { name: "latestRoundData", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  { name: "decimals", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

// ─────────────────────────────────────────────────────────────
// ETH/USD numeraire (Chainlink) — WETH 견적 풀을 USD 로 환산. 캐시(체인별, 5분).
// ⚠️ Chainlink 는 여기서 **numeraire(ETH/USD, 깊고 신뢰)** 로만 씀 — depeg 대상 토큰 가격에는 안 씀(그건 DEX 시장가).
// ─────────────────────────────────────────────────────────────
const _ethUsd = new Map<number, { v: number; ts: number }>();
// blockNumber 지정 시(백테스트 히스토리컬 fork) 캐시 우회 + 그 블록 시점 ETH/USD 읽기. live 경로는 종전대로 5분 캐시.
export async function ethUsd(chainId: number, nowMs: number, blockNumber?: bigint): Promise<number | null> {
  const cfg = CHAIN_DEX[chainId];
  if (!cfg) return null;
  if (blockNumber == null) {
    const c = _ethUsd.get(chainId);
    if (c && nowMs - c.ts < 5 * 60_000) return c.v;
  }
  try {
    const client = rpcFor(chainId);
    const opt = blockNumber == null ? {} : { blockNumber };
    const [round, dec] = await Promise.all([
      client.readContract({ address: cfg.ethUsdFeed, abi: FEED_ABI, functionName: "latestRoundData", ...opt }),
      client.readContract({ address: cfg.ethUsdFeed, abi: FEED_ABI, functionName: "decimals", ...opt }),
    ]);
    const answer = (round as readonly bigint[])[1];
    if (answer <= 0n) return null;
    const v = Number(answer) / 10 ** Number(dec);
    if (!(v > 0)) return null;
    if (blockNumber == null) _ethUsd.set(chainId, { v, ts: nowMs });
    return v;
  } catch { return null; }
}

export interface DexQuote { priceUsd: number; liquidityUsd: number; source: string; pool: string; }

interface Candidate { pool: Address; quote: Address; quoteUsd: number; quoteDec: number; kind: "v3" | "v2"; }

/**
 * 토큰의 온체인 DEX 시장가 + 유동성. 풀 없으면 null(→ coins.llama 폴백).
 * @param token  토큰 주소  @param chainId  체인  @param tokenDecimals  토큰 decimals
 * @param blockNumber  지정 시 그 블록 시점 상태를 읽음(백테스트 히스토리컬 fork). 미지정=latest(라이브).
 */
export async function getDexQuote(token: Address, chainId: number, tokenDecimals: number, nowMs: number, blockNumber?: bigint): Promise<DexQuote | null> {
  const cfg = CHAIN_DEX[chainId];
  if (!cfg) return null;
  const client = rpcFor(chainId);
  const blk = blockNumber == null ? {} : { blockNumber };
  const tkn = token.toLowerCase();
  const eth = await ethUsd(chainId, nowMs, blockNumber);

  // quote 후보: USDC($1), WETH(ETH/USD). 토큰 자신이 quote 면 그 quote 는 스킵(자기참조 방지).
  const quotes: { addr: Address; usd: number; dec: number }[] = [];
  if (tkn !== cfg.usdc.toLowerCase()) quotes.push({ addr: cfg.usdc, usd: 1, dec: cfg.usdcDecimals });
  if (tkn !== cfg.weth.toLowerCase() && eth) quotes.push({ addr: cfg.weth, usd: eth, dec: 18 });
  if (quotes.length === 0) return null;

  // ── 1) 풀 자동발견 (multicall 배칭) ──
  const discovery: { call: { address: Address; abi: typeof V3_FACTORY_ABI | typeof V2_FACTORY_ABI; functionName: "getPool" | "getPair"; args: unknown[] }; quote: typeof quotes[0]; kind: "v3" | "v2" }[] = [];
  for (const q of quotes) {
    for (const fee of V3_FEES) discovery.push({ call: { address: cfg.v3Factory, abi: V3_FACTORY_ABI, functionName: "getPool", args: [token, q.addr, fee] }, quote: q, kind: "v3" });
    if (cfg.v2Factory) discovery.push({ call: { address: cfg.v2Factory, abi: V2_FACTORY_ABI, functionName: "getPair", args: [token, q.addr] }, quote: q, kind: "v2" });
  }
  let found: { addr: Address; quote: typeof quotes[0]; kind: "v3" | "v2" }[];
  try {
    const res = await client.multicall({ contracts: discovery.map((d) => d.call), allowFailure: true, ...blk });
    found = [];
    res.forEach((r, i) => {
      const addr = (r.status === "success" ? (r.result as string) : ZERO) ?? ZERO;
      if (addr && addr !== ZERO) found.push({ addr: addr as Address, quote: discovery[i].quote, kind: discovery[i].kind });
    });
  } catch { return null; }
  if (found.length === 0) return null;

  // ── 2) 후보별 quote-side + token-side 잔액 읽기(가장 깊은 풀 선택 + 양면 유동성). 한 multicall 에 두 side 배칭. ──
  const bals = await client.multicall({
    contracts: found.flatMap((f) => [
      { address: f.quote.addr, abi: ERC20_BAL_ABI, functionName: "balanceOf" as const, args: [f.addr] },
      { address: token, abi: ERC20_BAL_ABI, functionName: "balanceOf" as const, args: [f.addr] },
    ]),
    allowFailure: true,
    ...blk,
  }).catch(() => null);
  if (!bals) return null;
  const cands: (Candidate & { quoteSideUsd: number; tokenBal: bigint })[] = [];
  found.forEach((f, i) => {
    const qb = bals[i * 2], tb = bals[i * 2 + 1];
    if (qb.status !== "success") return;
    const quoteSideUsd = (Number(qb.result as bigint) / 10 ** f.quote.dec) * f.quote.usd;
    const tokenBal = tb.status === "success" ? (tb.result as bigint) : 0n;
    if (quoteSideUsd > 0) cands.push({ pool: f.addr, quote: f.quote.addr, quoteUsd: f.quote.usd, quoteDec: f.quote.dec, kind: f.kind, quoteSideUsd, tokenBal });
  });
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.quoteSideUsd - a.quoteSideUsd); // quote-side 깊은 풀 = 시장가 신뢰도 대표
  const best = cands[0];

  // ── 3) 대표 풀에서 시장가 산출 (양면 유동성 환산에 필요해 floor 체크보다 먼저) ──
  const priceUsd = best.kind === "v3"
    ? await priceFromV3(client, best.pool, token, best.quote, tokenDecimals, best.quoteDec, best.quoteUsd, blockNumber)
    : await priceFromV2(client, best.pool, token, best.quote, tokenDecimals, best.quoteDec, best.quoteUsd, blockNumber);
  if (priceUsd == null || !(priceUsd > 0)) return null;

  // 양면 유동성 = quoteSide + tokenSide. quoteSide×2(50:50 가정)는 V3 집중유동성·비대칭 풀(가격 이동으로 한 토큰 소진)에서
  //   실TVL 을 체계적 과소산정 → 비대칭화가 가짜 liquidity_drop 을 유발하던 FP(#723 cbBTC −97.6%). 토큰-side 를 priceUsd 로
  //   환산해 합산하면 실 양면 TVL 에 근접(균형 풀이면 ≈ quoteSide×2 로 동등). 진짜 드레인(양쪽 동반 인출)은 그대로 잡힘.
  const tokenSideUsd = (Number(best.tokenBal) / 10 ** tokenDecimals) * priceUsd;
  const liquidityUsd = best.quoteSideUsd + tokenSideUsd;
  if (liquidityUsd < MIN_DEX_LIQUIDITY_USD) return null; // 얇은 풀 → spot 신뢰불가(depeg 오탐) → null → coins.llama 폴백

  return { priceUsd, liquidityUsd, source: `dex:${best.kind}`, pool: best.pool };
}

/** Uni V3 slot0(sqrtPriceX96) → 토큰의 USD 시장가. token0=주소 작은 쪽(Uniswap 규칙). */
async function priceFromV3(client: PublicClient, pool: Address, token: Address, quote: Address, decToken: number, decQuote: number, quoteUsd: number, blockNumber?: bigint): Promise<number | null> {
  try {
    const slot0 = await client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0", ...(blockNumber == null ? {} : { blockNumber }) });
    const Q = (slot0 as readonly bigint[])[0]; // sqrtPriceX96
    if (Q <= 0n) return null;
    const tokenIsToken0 = token.toLowerCase() < quote.toLowerCase();
    // price0in1_human = (Q^2 / 2^192) × 10^(dec0-dec1).  1e18 스케일로 BigInt 정밀 유지 후 float.
    const TWO192 = 1n << 192n;
    const S = 10n ** 18n;
    let priceTokenInQuote: number;
    if (tokenIsToken0) {
      // token=token0, quote=token1 : priceTokenInQuote = (Q^2/2^192)×10^(decToken-decQuote)
      const num = Q * Q * S * 10n ** BigInt(decToken);
      const den = TWO192 * 10n ** BigInt(decQuote);
      priceTokenInQuote = Number(num / den) / 1e18;
    } else {
      // token=token1, quote=token0 : priceTokenInQuote = (2^192/Q^2)×10^(decToken-decQuote)
      const num = TWO192 * S * 10n ** BigInt(decToken);
      const den = Q * Q * 10n ** BigInt(decQuote);
      priceTokenInQuote = Number(num / den) / 1e18;
    }
    return priceTokenInQuote * quoteUsd;
  } catch { return null; }
}

/** Uni V2 getReserves 비율 → 토큰의 USD 시장가. */
async function priceFromV2(client: PublicClient, pool: Address, token: Address, quote: Address, decToken: number, decQuote: number, quoteUsd: number, blockNumber?: bigint): Promise<number | null> {
  try {
    const r = await client.readContract({ address: pool, abi: V2_PAIR_ABI, functionName: "getReserves", ...(blockNumber == null ? {} : { blockNumber }) });
    const [r0, r1] = r as readonly [bigint, bigint, number];
    const tokenIsToken0 = token.toLowerCase() < quote.toLowerCase();
    const tokenReserve = tokenIsToken0 ? r0 : r1;
    const quoteReserve = tokenIsToken0 ? r1 : r0;
    if (tokenReserve <= 0n || quoteReserve <= 0n) return null;
    // price = (quoteReserve/10^decQuote) / (tokenReserve/10^decToken) × quoteUsd
    const S = 10n ** 18n;
    const num = quoteReserve * S * 10n ** BigInt(decToken);
    const den = tokenReserve * 10n ** BigInt(decQuote);
    const priceTokenInQuote = Number(num / den) / 1e18;
    return priceTokenInQuote * quoteUsd;
  } catch { return null; }
}
