/**
 * Fork reader — 사건 시점(타임스탬프)으로 체인을 "fork"(아카이브 히스토리컬 읽기)해서, 프로덕션 데이터 캡처와
 * 동일한 방식으로 그 블록 시점 온체인 상태를 읽어 `TokenSnapshotResult`(프로덕션 디텍터 입력 타입)로 조립한다.
 *
 *   · 블록 해석: ts → block (latest 앵커 + 평균블록시간 추정 후 getBlock 으로 refine). 아카이브(Alchemy) 가정.
 *   · 공급: ERC20 totalSupply @block (decimals/symbol 은 불변이라 토큰당 1회 캐시). multicall3 미의존(2021 등
 *           Multicall3 미배포 블록도 읽게 개별 readContract).
 *   · 가격: getDexQuote(@block) — 프로덕션 DEX-우선 경로 그대로. 풀 없으면 coins.llama **히스토리컬**(시점 고정,
 *           프로덕션 폴백과 동일 소스)로. 둘 다 실패 시 priceCovered=false(1 로 위조 안 함 — 프로덕션 규약).
 *
 * 무료 RPC rate-limit(429) 대비: latest 캐시 + 블록 캐시 + 429 백오프 재시도 + 호출 간 throttle.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { erc20Abi, getAddress, type PublicClient } from "viem";

import { getDexQuote } from "@/lib/dex-onchain";
import { rpcFor } from "@/lib/rpc";
import type { Incident, Poll } from "@/backtest/incidents";
import type { TokenSnapshotResult } from "@/types/edge-schema";

export const CHAIN_ID: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161 };
const SEC_PER_BLOCK: Record<number, number> = { 1: 12, 8453: 2, 42161: 0.25 };

const _blockCache = new Map<string, bigint>();                       // `${chainId}:${ts}` → block
const _latestCache = new Map<number, { block: bigint; ts: number }>(); // chainId → latest (run 1회)
const _metaCache = new Map<string, { decimals: number; symbol: string }>(); // `${chainId}:${token}` → 불변 메타

// ── 디스크 스냅샷 캐시 ──────────────────────────────────────────────────────
// 온체인 read 는 (주소, ts→block)에 대해 **결정론적**(과거 블록 상태는 불변)이므로, 메시지/포맷/디텍터만 바꾸는
//   재실행은 fork 를 다시 read 할 이유가 없다. 비싼 read(escrow forcePrecise 이진탐색·다체인 totalSupply·Aave 멀티콜)
//   결과를 (reader, 주소/풀, ts) 키로 디스크에 캐시 → 재실행은 캐시 히트로 즉시(온체인 read 0). fetch 로직이 바뀌면
//   키에 그 파라미터가 들어가 자동 무효화되며, `--refetch` 로 전체 무효화.
const _CACHE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "backtest", "fork-cache.json");
let _diskCache: Record<string, string> | null = null;
let _diskCacheDirty = false;
const _REFETCH = process.argv.includes("--refetch");
function _cacheStore(): Record<string, string> {
  if (_diskCache) return _diskCache;
  // ⚠️ --refetch 라도 기존 파일은 **항상 로드**(다른 사건 캐시 보존). 무효화는 읽기(cacheGet)에서만 — 그래야
  //   `--refetch --only X` 가 X 만 다시 읽어 덮어쓰고, 나머지 사건 캐시는 그대로 유지된다(이전: 파일 무시→flush 시 소실).
  try { _diskCache = JSON.parse(readFileSync(_CACHE_PATH, "utf8")) as Record<string, string>; } catch { _diskCache = {}; }
  return _diskCache;
}
function cacheGet<T>(key: string): T | null { if (_REFETCH) return null; const s = _cacheStore()[key]; return s ? (JSON.parse(s) as T) : null; }
function cacheSet(key: string, val: unknown): void { _cacheStore()[key] = JSON.stringify(val); _diskCacheDirty = true; }
/** 캐시를 디스크에 기록(run.ts 가 사건 처리 후 호출). */
export function flushForkCache(): void {
  if (_diskCache && _diskCacheDirty) { mkdirSync(dirname(_CACHE_PATH), { recursive: true }); writeFileSync(_CACHE_PATH, JSON.stringify(_diskCache)); _diskCacheDirty = false; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 429/타임아웃 등 일시 오류 백오프 재시도(아카이브 무료 RPC rate-limit 대비 — cron 과 동시 구동 시 충돌 흡수). */
async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 8): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = (e as Error)?.message ?? "";
      const transient = /429|rate limit|timeout|ETIMEDOUT|ECONNRESET|fetch failed|503|502/i.test(msg);
      if (!transient || i === tries - 1) throw e;
      await sleep(Math.min(30_000, 1000 * 2 ** i)); // 1,2,4,8,16,30,30s — cron burst 도 타고 넘김
    }
  }
  throw lastErr;
}

async function getLatest(client: PublicClient, chainId: number): Promise<{ block: bigint; ts: number }> {
  const c = _latestCache.get(chainId);
  if (c) return c;
  const blk = await withRetry(() => client.getBlock(), "latest");
  const v = { block: blk.number!, ts: Number(blk.timestamp) };
  _latestCache.set(chainId, v);
  return v;
}

/**
 * 타임스탬프(초) → 그 시점 이하 가장 큰 블록. latest 앵커에서 평균블록시간으로 추정 후 getBlock 으로 ±보정.
 * 아카이브 RPC 가정. throttle 로 rate-limit 회피.
 */
export async function blockAtTimestamp(client: PublicClient, chainId: number, targetSec: number, forcePrecise = false): Promise<bigint> {
  const key = `${chainId}:${targetSec}`;
  // forcePrecise: 시드(산술추정) 캐시 무시하고 이진탐색 — escrow lockbox 처럼 한 poll 내 ~100% 변하는 불연속 read 용
  //   (산술추정 ±수블록이 드레인 경계를 넘나들어 가짜값 읽던 것 방지). 정확값은 다시 캐시(이후 같은 ts 재사용).
  if (!forcePrecise) {
    const cached = _blockCache.get(key);
    if (cached != null) return cached;
  }

  const spb = SEC_PER_BLOCK[chainId] ?? 12;
  const latest = await getLatest(client, chainId);
  if (targetSec >= latest.ts) { _blockCache.set(key, latest.block); return latest.block; }

  let guess = latest.block - BigInt(Math.floor((latest.ts - targetSec) / spb));
  if (guess < 1n) guess = 1n;
  let lastGood = guess;
  for (let i = 0; i < 8; i++) {
    if (guess < 1n) guess = 1n;
    const blk = await withRetry(() => client.getBlock({ blockNumber: guess }), "getBlock");
    await sleep(250);
    const blkTs = Number(blk.timestamp);
    lastGood = guess;
    const diff = blkTs - targetSec;
    if (Math.abs(diff) <= spb * 2) {
      const result = blkTs > targetSec ? guess - 1n : guess;
      _blockCache.set(key, result);
      return result;
    }
    guess = guess - BigInt(Math.round(diff / spb));
  }
  _blockCache.set(key, lastGood);
  return lastGood;
}

/**
 * 5분 간격 등 촘촘한 ts 시퀀스의 블록을 효율 해석 — 첫 ts 만 이진탐색(blockAtTimestamp), 나머지는 평균블록시간으로
 * 산술 추정해 _blockCache 에 시딩. 이후 readForkSnapshot/readConservation 의 blockAtTimestamp 호출이 캐시 히트(이진탐색 0).
 * (블록타임은 거의 일정 → 수 시간 윈도 내 ±수블록 오차는 공급/가격 read 에 무영향. rate-limit·시간 대폭 절감.)
 */
export async function seedBlockCache(chainId: number, tsList: number[]): Promise<void> {
  if (!tsList.length) return;
  const spb = SEC_PER_BLOCK[chainId] ?? 12;
  const sorted = [...new Set(tsList)].sort((a, b) => a - b);
  // ⚠️ 단일 앵커 산술추정은 장기 윈도(수십 h)서 수분 드리프트 → escrow 같은 **불연속 read** 에 ±수십블록 오차(가짜 드레인/회복 jitter).
  //   ~1h 간격으로 **다중 앵커를 이진탐색**하고 그 사이만 보간 → 세그먼트당 드리프트 ≤±2~3블록(≈수십초)로 억제(정확도↑, 이진탐색 횟수↓).
  const ANCHOR_SEC = 3600;
  const anchors: { ts: number; blk: bigint }[] = [];
  let lastTs = -Infinity;
  for (const t of sorted) {
    if (t - lastTs >= ANCHOR_SEC) { anchors.push({ ts: t, blk: await blockAtTimestamp(rpcFor(chainId), chainId, t) }); lastTs = t; }
  }
  if (!anchors.length) return;
  for (const t of sorted) {
    const key = `${chainId}:${t}`;
    if (_blockCache.has(key)) continue;
    let a = anchors[0];
    for (const an of anchors) { if (an.ts <= t) a = an; else break; } // t 이하 가장 가까운 앵커
    let est = a.blk + BigInt(Math.round((t - a.ts) / spb));
    if (est < 1n) est = 1n;
    _blockCache.set(key, est);
  }
}

/** decimals/symbol 은 불변 → 토큰당 1회(latest 블록) 읽고 캐시. multicall3 미의존(개별 read). */
async function getTokenMeta(client: PublicClient, chainId: number, token: `0x${string}`): Promise<{ decimals: number; symbol: string }> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const c = _metaCache.get(key);
  if (c) return c;
  const [dec, sym] = await Promise.all([
    withRetry(() => client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }), "decimals"),
    withRetry(() => client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => ""), "symbol"),
  ]);
  const v = { decimals: Number(dec), symbol: String(sym ?? "") };
  _metaCache.set(key, v);
  return v;
}

async function coinsLlamaHistorical(chain: string, address: string, ts: number): Promise<number | null> {
  // ⚠️ coins.llama 는 **대개** 케이스 무관이나, 일부 토큰(예: Elixir deUSD)은 **체크섬 키로만** 조회된다(소문자=빈 결과).
  //   과거 readForkSnapshot 이 address.toLowerCase() 로 호출 → deUSD 등은 가격 항상 null → 디페그 미발화(FN)였다.
  //   따라서 as-given(레지스트리 주소) 우선, 빈 결과면 체크섬으로 재시도(둘은 보통 동일이라 단발 호출).
  const variants = [address];
  try { const cs = getAddress(address as `0x${string}`); if (cs.toLowerCase() !== address.toLowerCase() || cs !== address) variants.push(cs); } catch { /* 비정상 주소 → as-given 만 */ }
  for (const addr of [...new Set(variants)]) {
    const url = `https://coins.llama.fi/prices/historical/${ts}/${chain}:${addr}?searchWidth=6h`;
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (res.status === 429 || res.status >= 500) { await sleep(700 * 2 ** i); continue; }
        if (!res.ok) break; // 이 variant 실패 → 다음 케이스 시도
        const j = (await res.json()) as { coins?: Record<string, { price?: number }> };
        const p = j.coins?.[`${chain}:${addr}`]?.price;
        if (typeof p === "number" && p > 0) return p;
        break; // 빈 결과 → 다음 케이스 variant 시도
      } catch { await sleep(700 * 2 ** i); }
    }
  }
  return null;
}

// ── Uniswap V4 온체인 가격(StateView.getSlot0) ──────────────────────────────
// V4 는 싱글톤(PoolManager)이라 factory 풀 주소가 없어 dex-onchain 의 V3/V2 자동발견이 못 잡는다.
//   죽은/얇은 토큰(예: Stream xUSD)이 V3/V2 엔 풀이 없고 **V4 에만 유동성**이 있는 경우, 그리고 coins.llama 가
//   사후 pruning 한 경우의 **온체인 시장가 복구용**: poolId 로 직접 slot0 를 읽어 시장가를 산출(가격 수학은 V3 와 동일).
//   ⚠️ getLiquidity=0(빈/미초기화 블록)이면 slot0 가 stale → null(가짜가격 가드). decimals/ordering 은 V3 규칙 동일.
const V4_STATEVIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227" as const;
const V4_SV_ABI = [
  { name: "getSlot0", stateMutability: "view", type: "function", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
  { name: "getLiquidity", stateMutability: "view", type: "function", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint128" }] },
] as const;

async function readV4Price(
  client: PublicClient, poolId: `0x${string}`, token: `0x${string}`, quote: `0x${string}`,
  decToken: number, decQuote: number, quoteUsd: number, blockNumber: bigint,
): Promise<number | null> {
  try {
    const [slot0, liq] = await Promise.all([
      withRetry(() => client.readContract({ address: V4_STATEVIEW, abi: V4_SV_ABI, functionName: "getSlot0", args: [poolId], blockNumber }), "v4slot0"),
      withRetry(() => client.readContract({ address: V4_STATEVIEW, abi: V4_SV_ABI, functionName: "getLiquidity", args: [poolId], blockNumber }), "v4liq"),
    ]);
    if ((liq as bigint) <= 0n) return null; // 유동성 0 = stale/미초기화 → 신뢰불가
    const Q = (slot0 as readonly bigint[])[0]; // sqrtPriceX96
    if (Q <= 0n) return null;
    const tokenIsToken0 = token.toLowerCase() < quote.toLowerCase(); // Uniswap: token0 = 주소 작은 쪽
    const TWO192 = 1n << 192n;
    const S = 10n ** 18n;
    const priceTokenInQuote = tokenIsToken0
      ? Number((Q * Q * S * 10n ** BigInt(decToken)) / (TWO192 * 10n ** BigInt(decQuote))) / 1e18
      : Number((TWO192 * S * 10n ** BigInt(decToken)) / (Q * Q * 10n ** BigInt(decQuote))) / 1e18;
    return priceTokenInQuote * quoteUsd;
  } catch { return null; }
}

/** 사건의 V4 가격 풀 오버라이드 — V3/V2·coins.llama 로 못 구하는 토큰(xUSD)의 온체인 시장가. */
export interface V4PoolRef { poolId: `0x${string}`; quote: `0x${string}`; quoteDecimals: number; quoteUsd?: number }

export interface ForkSnapshot {
  snap: TokenSnapshotResult;
  block: bigint;
  tsSec: number;
  price: number | null;
  priceSource: string;
  symbolOnchain: string;
  supplyHuman: number;
}

/**
 * 임의 토큰의 한 시점 fork 스냅샷 — 프로덕션 캡처 그대로(공급 온체인 + 가격 DEX→llama 히스토리컬).
 * 사건 토큰(readForkSnapshot)·연관 토큰(relatedTokens contagion) 공용. decimals 는 온체인 decimals() 를 읽으므로
 *   레지스트리에 6/18 을 박을 필요 없음(예: xUSD=6, deUSD=18 자동 처리).
 */
export async function readTokenAt(
  chain: string, address: `0x${string}`, label: string, tsSec: number, opts?: { skipDex?: boolean; v4Pool?: V4PoolRef },
): Promise<ForkSnapshot> {
  const chainId = CHAIN_ID[chain] ?? 1;
  // 캐시 — (체인,주소,ts,skipDex,v4풀) 결정론적. 히트 시 fork read 0(블록해석·공급·가격 전부 스킵).
  const ckey = `tok|${chainId}|${address.toLowerCase()}|${tsSec}|${opts?.skipDex ? 1 : 0}|${opts?.v4Pool?.poolId ?? ""}`;
  const hit = cacheGet<{ snap: TokenSnapshotResult; block: string; price: number | null; priceSource: string; symbolOnchain: string; supplyHuman: number }>(ckey);
  if (hit) return { snap: hit.snap, block: BigInt(hit.block), tsSec, price: hit.price, priceSource: hit.priceSource, symbolOnchain: hit.symbolOnchain, supplyHuman: hit.supplyHuman };
  const client = rpcFor(chainId);

  const block = await blockAtTimestamp(client, chainId, tsSec);
  const { decimals, symbol: symbolOnchain } = await getTokenMeta(client, chainId, address);

  // 공급 @block (개별 read — multicall3 미배포 과거블록도 OK).
  const supRaw = await withRetry(
    () => client.readContract({ address, abi: erc20Abi, functionName: "totalSupply", blockNumber: block }),
    "totalSupply",
  );
  await sleep(250);
  const supplyHuman = Number(supRaw as bigint) / 10 ** decimals;

  // 가격: (V4 풀 오버라이드) → DEX(@block) 자동발견 → coins.llama 히스토리컬 폴백.
  //   skipDex: conservation 사건(rsETH)은 가격이 신호가 아니라 표시용이라 DEX 풀발견(무거움) 생략, llama 만 → RPC 버스트 감소.
  let price: number | null = null;
  let priceSource = "none";
  // V4 풀 오버라이드(예: xUSD — V3/V2 풀 없음 + coins.llama pruning) — 온체인 시장가 우선. liq=0 블록은 null 반환→폴백.
  if (opts?.v4Pool) {
    const p = await readV4Price(client, opts.v4Pool.poolId, address, opts.v4Pool.quote, decimals, opts.v4Pool.quoteDecimals, opts.v4Pool.quoteUsd ?? 1, block);
    if (p != null && p > 0) { price = p; priceSource = "univ4:onchain"; }
  }
  if (price == null && !opts?.skipDex) {
    try {
      const dq = await getDexQuote(address, chainId, decimals, tsSec * 1000, block);
      if (dq && dq.priceUsd > 0) { price = dq.priceUsd; priceSource = dq.source; }
    } catch { /* DEX read 실패(예: 과거블록 multicall3 미배포) → llama 폴백 */ }
  }
  if (price == null) {
    // 주소는 **레지스트리 형태 그대로**(보통 체크섬) 전달 — coins.llama 가 일부 토큰(deUSD)을 체크섬으로만 키잉(소문자 빈 결과).
    const lp = await coinsLlamaHistorical(chain, address, tsSec);
    if (lp != null) { price = lp; priceSource = "llama:historical"; }
  }
  const priceCovered = price != null && price > 0;
  const marketCapUsd = priceCovered ? supplyHuman * (price as number) : null;

  const snapshotTs = new Date(tsSec * 1000).toISOString();
  const snap: TokenSnapshotResult = {
    token: {
      nodeId: `token:${address.toLowerCase()}`,
      type: "Token",
      label,
      address,
      metadata: {
        symbol: label,
        decimals,
        totalSupply: supplyHuman,
        holders: null,
        marketCapUsd,
        priceCovered,
        paused: false,
        bridges: {},
      },
    },
    protocols: [],
    edges: [],
    unknownAddresses: [],
    snapshotTs,
    blockNumber: Number(block),
  };

  cacheSet(ckey, { snap, block: block.toString(), price, priceSource, symbolOnchain, supplyHuman });
  return { snap, block, tsSec, price, priceSource, symbolOnchain, supplyHuman };
}

/**
 * 한 poll 시점의 사건 토큰 fork 스냅샷. (readTokenAt 위임 — 연관 토큰과 동일 경로.)
 */
export async function readForkSnapshot(incident: Incident, poll: Poll, opts?: { skipDex?: boolean }): Promise<ForkSnapshot> {
  const tsSec = Math.floor(new Date(poll.at).getTime() / 1000);
  // 사건에 V4 가격 풀이 지정돼 있으면(xUSD 처럼 V3/V2·llama 로 못 구하는 토큰) primary 토큰 가격을 그 풀에서 온체인 산출.
  return readTokenAt(incident.chain, incident.token.address, incident.token.symbol, tsSec, { ...opts, v4Pool: incident.priceV4Pool });
}

// ── Aave V3 마켓 가동률(연관 토큰 contagion) — getReserveData → aToken/varDebt totalSupply → util ──
const AAVE_GRD_ABI = [{
  name: "getReserveData", stateMutability: "view", type: "function", inputs: [{ type: "address" }],
  outputs: [{ type: "tuple", components: [
    { name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }] },
    { name: "liquidityIndex", type: "uint128" }, { name: "currentLiquidityRate", type: "uint128" },
    { name: "variableBorrowIndex", type: "uint128" }, { name: "currentVariableBorrowRate", type: "uint128" },
    { name: "currentStableBorrowRate", type: "uint128" }, { name: "lastUpdateTimestamp", type: "uint40" },
    { name: "id", type: "uint16" }, { name: "aTokenAddress", type: "address" },
    { name: "stableDebtTokenAddress", type: "address" }, { name: "variableDebtTokenAddress", type: "address" },
    { name: "interestRateStrategyAddress", type: "address" }, { name: "accruedToTreasury", type: "uint128" },
    { name: "unbacked", type: "uint128" }, { name: "isolationModeTotalDebt", type: "uint128" },
  ] }],
}] as const;
const _aaveTok = new Map<string, { aToken: `0x${string}`; vDebt: `0x${string}` }>(); // 불변 → 캐시

export interface MarketUtil { symbol: string; util: number; }

/** Aave V3 연관 마켓들의 그 블록 가동률(util=variableDebt/aToken supply). aToken/varDebt 주소는 불변이라 캐시, supply 는 멀티콜 배칭. block 도 반환(알림 앵커용). */
export async function readAaveUtils(pool: `0x${string}`, tokens: { symbol: string; address: `0x${string}` }[], tsSec: number): Promise<{ block: number; utils: MarketUtil[] }> {
  const ckey = `aave|${pool.toLowerCase()}|${tokens.map((t) => t.address.toLowerCase()).join(",")}|${tsSec}`;
  const hit = cacheGet<{ block: number; utils: MarketUtil[] }>(ckey);
  if (hit) return hit;
  const c = rpcFor(1);
  const blk = await blockAtTimestamp(c, 1, tsSec);
  const resolved: { symbol: string; aToken: `0x${string}`; vDebt: `0x${string}` }[] = [];
  for (const t of tokens) {
    const key = `${pool}:${t.address}`.toLowerCase();
    let tk = _aaveTok.get(key);
    if (!tk) {
      try {
        const rd = await withRetry(() => c.readContract({ address: pool, abi: AAVE_GRD_ABI, functionName: "getReserveData", args: [t.address] }), "getReserveData") as { aTokenAddress: `0x${string}`; variableDebtTokenAddress: `0x${string}` };
        tk = { aToken: rd.aTokenAddress, vDebt: rd.variableDebtTokenAddress };
        _aaveTok.set(key, tk);
      } catch { continue; }
    }
    resolved.push({ symbol: t.symbol, ...tk });
  }
  if (!resolved.length) { const r = { block: Number(blk), utils: [] }; cacheSet(ckey, r); return r; }
  const calls = resolved.flatMap((r) => [
    { address: r.aToken, abi: erc20Abi, functionName: "totalSupply" as const },
    { address: r.vDebt, abi: erc20Abi, functionName: "totalSupply" as const },
  ]);
  const res = await withRetry(() => c.multicall({ contracts: calls, allowFailure: true, blockNumber: blk }), "aaveMulti");
  await sleep(250);
  const out: MarketUtil[] = [];
  resolved.forEach((r, i) => {
    const sup = res[i * 2], bor = res[i * 2 + 1];
    if (sup.status === "success") {
      const s = Number(sup.result as bigint), b = bor.status === "success" ? Number(bor.result as bigint) : 0;
      out.push({ symbol: r.symbol, util: s > 0 ? b / s : 0 });
    }
  });
  const result = { block: Number(blk), utils: out };
  cacheSet(ckey, result);
  return result;
}

export interface ConservationRead {
  backingRaw: bigint;  // 홈 escrow 에 잠긴 canonical(raw) = 정당 backing
  remoteSumRaw: bigint; // Σ remote 발행(raw)
  backing: number; remoteSum: number; // 표시용 human
  breakdown: Record<string, number>;  // 체인별 remote 공급(human)
  homeBlock: number;   // escrow 읽은 ethereum 블록(알림 앵커·검증용)
}

/**
 * 교차체인 무담보 발행 입력 — escrow balanceOf(canonical)@홈블록 + 각 remote totalSupply@그체인블록.
 * 각 체인은 같은 타임스탬프의 자기 블록으로 fork(체인마다 블록고가 다름). evaluateBacking 의 backing/remoteSum 으로 그대로 투입.
 */
export async function readConservationAtTime(
  cons: { canonical: `0x${string}`; decimals: number; escrow: `0x${string}`; remotes: { chain: string; token: `0x${string}` }[] },
  tsSec: number,
): Promise<ConservationRead> {
  const dec = cons.decimals;
  // 캐시 — escrow forcePrecise 이진탐색이 가장 비싼 read 라 여기 히트가 재실행을 가장 크게 줄인다. bigint 은 문자열로 저장.
  const ckey = `cons|${cons.escrow.toLowerCase()}|${cons.canonical.toLowerCase()}|${cons.decimals}|${cons.remotes.map((r) => `${r.chain}:${r.token.toLowerCase()}`).join(",")}|${tsSec}`;
  const hit = cacheGet<{ backingRaw: string; remoteSumRaw: string; backing: number; remoteSum: number; breakdown: Record<string, number>; homeBlock: number }>(ckey);
  if (hit) return { ...hit, backingRaw: BigInt(hit.backingRaw), remoteSumRaw: BigInt(hit.remoteSumRaw) };
  // 홈(ethereum) escrow 잠금분 — ⚠️ forcePrecise: escrow 는 한 poll 내 ~100% 변하므로 산술추정 블록(±수블록)이
  //   드레인 경계를 넘나들어 가짜값(예: 116.7K↔224) 을 읽는다 → 정확 이진탐색으로 ts-이하 정확 블록 사용.
  const homeC = rpcFor(1);
  const homeBlk = await blockAtTimestamp(homeC, 1, tsSec, true);
  const balRaw = await withRetry(
    () => homeC.readContract({ address: cons.canonical, abi: erc20Abi, functionName: "balanceOf", args: [cons.escrow], blockNumber: homeBlk }),
    "escrowBal",
  ) as bigint;
  await sleep(250);

  let remoteSumRaw = 0n;
  const breakdown: Record<string, number> = {};
  for (const r of cons.remotes) {
    const cid = CHAIN_ID[r.chain] ?? 1;
    const c = rpcFor(cid);
    const blk = await blockAtTimestamp(c, cid, tsSec);
    const sRaw = await withRetry(
      () => c.readContract({ address: r.token, abi: erc20Abi, functionName: "totalSupply", blockNumber: blk }),
      "remoteSup",
    ) as bigint;
    await sleep(250);
    remoteSumRaw += sRaw;
    breakdown[r.chain] = Number(sRaw) / 10 ** dec;
  }
  const result: ConservationRead = {
    backingRaw: balRaw, remoteSumRaw,
    backing: Number(balRaw) / 10 ** dec, remoteSum: Number(remoteSumRaw) / 10 ** dec,
    breakdown, homeBlock: Number(homeBlk),
  };
  cacheSet(ckey, { ...result, backingRaw: balRaw.toString(), remoteSumRaw: remoteSumRaw.toString() });
  return result;
}
