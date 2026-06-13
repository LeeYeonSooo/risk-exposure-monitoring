import { toFunctionSelector } from "viem";

import { gateFor } from "./rpc-gate";

/**
 * Lending-protocol receipt/escrow addresses, resolved LIVE on-chain — so deposits/withdrawals
 * match on every chain, not just ethereum.
 *
 *  · Aave V3 / Spark: a deposit transfers the underlying to the aToken contract. The aToken
 *    address is read from the official Pool's getReserveData(asset) (eth_call, keyless RPC) —
 *    the only constants are the official Pool deployment addresses (registry-grade infra).
 *  · Morpho Blue: ONE canonical singleton holds all market funds (same CREATE2 address across
 *    its chains). A transfer to/from it is a Morpho supply/withdraw.
 *
 * Wrong/absent deployments are safe by construction: a bad address simply never appears as a
 * transfer counterparty (false negatives only, never false labels).
 */

const PUBLICNODE: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com", base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com", optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com", gnosis: "https://gnosis-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com", avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
  linea: "https://linea-rpc.publicnode.com", scroll: "https://scroll-rpc.publicnode.com",
  mantle: "https://mantle-rpc.publicnode.com", unichain: "https://unichain-rpc.publicnode.com",
  berachain: "https://berachain-rpc.publicnode.com",
};
// 레지스트리/파생 프로브 eth_call 은 **Alchemy 우선**(키 있을 때) — 무료 publicnode 보다 안정적
// (eth_call 은 Alchemy 레이트리밋 거의 없음). 1차 전송 실패 시 publicnode 로 폴백(_FALLBACK).
const _AK = process.env.ALCHEMY_API_KEY;
const _ALCHEMY_NET: Record<string, string> = { ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet" };
const RPC: Record<string, string> = { ...PUBLICNODE };
const _FALLBACK: Record<string, string> = {}; // primaryUrl → publicnodeUrl (폴백)
if (_AK) for (const [c, net] of Object.entries(_ALCHEMY_NET)) {
  const a = `https://${net}.g.alchemy.com/v2/${_AK}`;
  _FALLBACK[a] = PUBLICNODE[c];
  RPC[c] = a;
}

/** official Aave V3 Pool deployments (docs.aave.com) */
const AAVE_V3_POOL: Record<string, string> = {
  ethereum: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  base: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
  arbitrum: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
  optimism: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
  polygon: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
  avalanche: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
  gnosis: "0xb50201558b00496a145fe76f7424749556e326d8",
  bsc: "0x6807dc923806fe8fd134338eabca509979a7e0cb",
  scroll: "0x11fcfe756c05ad438e312a7fd934381537d3cffe",
};
/** SparkLend (Aave V3 fork, same Pool ABI) — mainnet */
const SPARK_POOL_ETHEREUM = "0xc13e21b648a5ee794902342038ff3adab66be987";

/**
 * Morpho Blue singleton — VERIFIED deployments only (eth_getCode 확인: 0xbbbb… 주소는 이더리움·
 * 베이스에만 코드가 있음). 다른 체인의 모르포는 체인별 다른 주소라 여기 없으면 라벨 없이
 * "전송"으로 표시될 뿐(가짜 라벨 0) — 검증 후에만 추가할 것.
 */
export const MORPHO_BLUE: Record<string, string> = {
  ethereum: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
  base: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
};

/** official Uniswap V4 PoolManager singletons (docs.uniswap.org deployments) */
export const UNISWAP_V4_POOL_MANAGER: Record<string, string> = {
  ethereum: "0x000000000004444c5dc75cb358380d2e3de08a90",
  base: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  arbitrum: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
  optimism: "0x9a13f98cb987694c9f086b1f5eb990eea8264ec3",
  polygon: "0x67366782805870060151383f4bbff9dab53e5cd6",
  unichain: "0x1f98400000000000000000000000000000000004",
};

/**
 * Compound V3 Comet candidates (official Compound deployments). Each entry is sanity-checked
 * on-chain before use: baseToken() must return an address-shaped non-zero word. NOTE this check
 * filters dead/typo addresses but is NOT proof-of-Comet — other contracts also expose baseToken(),
 * so this list must contain ONLY official Comet deployment addresses (treat it like the V4
 * PoolManager registry). Comet holds base+collateral itself → transfer to/from it is a real
 * supply/withdraw(또는 차입 지급).
 */
const COMPOUND_COMET_CANDIDATES: Record<string, string[]> = {
  ethereum: [
    "0xc3d688b66703497daa19211eedff47f25384cdc3", // cUSDCv3
    "0xa17581a9e3356d9a858b789d68b4d866e593ae94", // cWETHv3
    "0x3afdc9bca9213a35503b077a6072f3d0d5ab0840", // cUSDTv3
  ],
  base: [
    "0xb125e6687d4313864e53df431d5425969c15eb2f", // cUSDCv3
    "0x46e6b214b524310239732d51387075e0e70970bf", // cWETHv3
    "0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf", // cUSDbCv3
  ],
  arbitrum: [
    "0xa5edbdd9646f8dff606d7448e414884c7d905dca", // cUSDC.e v3
  ],
};

// selectors COMPUTED from the signatures (not hand-derived) — cannot silently be wrong.
const SEL_GET_RESERVE_DATA = toFunctionSelector("function getReserveData(address)");
const SEL_BASE_TOKEN = toFunctionSelector("function baseToken()");
const SEL_ASSET = toFunctionSelector("function asset()");   // ERC-4626 wrapper → underlying
const SEL_STETH = toFunctionSelector("function stETH()");   // wstETH-style wrapper getter
const SEL_EETH = toFunctionSelector("function eETH()");     // weETH-style wrapper getter
const ZERO40 = "0x0000000000000000000000000000000000000000";
const PAD24 = "0".repeat(24);

/** decode a single returned address word; REQUIRES the 12 padding bytes to be zero (가짜 주소 차단). */
function decodeAddressWord(hex: string, wordIdx = 0): string | null {
  const start = 2 + wordIdx * 64;
  if (hex.length < start + 64) return null;
  if (hex.slice(start, start + 24) !== PAD24) return null; // not an address-shaped word → reject
  const a = "0x" + hex.slice(start + 24, start + 64).toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) && a !== ZERO40 ? a : null;
}

/**
 * eth_call — 반환 3종을 구별한다 (캐시 오염 방지의 핵심):
 *   string    = 결과 수신
 *   null      = 노드가 응답했지만 값 없음/리버트 (= "이 컨트랙트엔 이 함수가 없다"는 **결론**)
 *   undefined = 전송 실패·레이트리밋 (= 결론 아님 — 음성으로 캐시하면 안 됨)
 * 콜드스타트의 프로브 버스트가 publicnode 429 를 맞으면 모든 결과가 null 로 영구 캐시돼
 * 파생 가족 확장이 프로세스 수명 내내 전멸하던 버그(그래프 109→47 노드 조용한 축소)의 수정.
 */
// 공용 호스트 게이트로 감싼다 — 동시 ethCall 버스트가 RPC 를 레이트리밋해 (3-state 의 undefined 가
// 양산되거나) 결과가 빠지는 것을 막는다.
async function ethCallOne(rpc: string, to: string, data: string): Promise<string | null | undefined> {
  return gateFor(rpc)(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(rpc, {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        });
        if (!r.ok) { if (attempt === 0) { await new Promise((res) => setTimeout(res, 300)); continue; } return undefined; }
        const j = (await r.json()) as { result?: string; error?: { message?: string } };
        // JSON-RPC error 중 실행 리버트만 "결론"(null) — 레이트리밋 등 나머지 에러는 비결론(undefined)
        if (j.error) {
          const msg = (j.error.message ?? "").toLowerCase();
          if (msg.includes("revert") || msg.includes("execution")) return null;
          if (attempt === 0) { await new Promise((res) => setTimeout(res, 300)); continue; }
          return undefined;
        }
        return j.result ?? null;
      } catch { if (attempt === 0) { await new Promise((res) => setTimeout(res, 300)); continue; } return undefined; }
    }
    return undefined;
  });
}
// 1차(Alchemy 등) 전송 실패(undefined)면 폴백(publicnode)으로 1회 더 — 한 엔드포인트의 일시 장애가
// 레지스트리/파생 해석을 통째로 비우지 않게(무료 RPC 100% 보장 불가의 보강).
async function ethCall(rpc: string, to: string, data: string): Promise<string | null | undefined> {
  const r = await ethCallOne(rpc, to, data);
  if (r !== undefined) return r; // string(성공) 또는 null(결론적 리버트)
  const fb = _FALLBACK[rpc];
  return fb ? await ethCallOne(fb, to, data) : undefined;
}

async function rpcCall(rpc: string, method: string, params: unknown[]): Promise<string | null | undefined> {
  try {
    const r = await fetch(rpc, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!r.ok) return undefined; // 전송 실패 = 비결론 (ethCall 과 동일 — 음성 캐시 오염 방지)
    const j = (await r.json()) as { result?: string; error?: unknown };
    if (j.error) return undefined;
    return j.result ?? null;
  } catch { return undefined; }
}

// contract-ness is immutable for deployed code → process-lifetime cache
const _codeCache = new Map<string, boolean>();
/** true iff the address has deployed code (EOA 프로브 낭비 방지). */
export async function isContract(chain: string, addr: string): Promise<boolean> {
  const rpc = RPC[chain];
  if (!rpc) return false;
  const key = `${chain}|${addr.toLowerCase()}`;
  if (_codeCache.has(key)) return _codeCache.get(key)!;
  const code = await rpcCall(rpc, "eth_getCode", [addr, "latest"]);
  if (code === undefined) return false; // 비결론 — 미캐시 (이번엔 EOA 취급, 다음 호출이 재확인)
  const ok = !!code && code !== "0x";
  _codeCache.set(key, ok);
  return ok;
}

const SEL_SYMBOL = toFunctionSelector("function symbol()");
const _symCache = new Map<string, string | null>();
/** on-chain symbol() (dynamic string or legacy bytes32) — 라벨도 추측 없이 컨트랙트가 말한 대로. */
export async function erc20Symbol(chain: string, addr: string): Promise<string | null> {
  const rpc = RPC[chain];
  if (!rpc) return null;
  const key = `${chain}|${addr.toLowerCase()}`;
  if (_symCache.has(key)) return _symCache.get(key)!;
  let out: string | null = null;
  const hex = await ethCall(rpc, addr, SEL_SYMBOL);
  if (hex === undefined) return null; // 전송 실패 = 비결론 — 캐시하지 않는다 (다음 호출이 재시도)
  if (hex && hex.length >= 2 + 64) {
    try {
      // dynamic-string 경로는 표준 오프셋(0x20)일 때만 — 비표준 인코딩이 그럴듯한 오독 라벨이 되는 것 차단
      if (hex.length >= 2 + 3 * 64 && parseInt(hex.slice(2, 2 + 64), 16) === 0x20) {
        const len = parseInt(hex.slice(2 + 64, 2 + 128), 16);
        if (len > 0 && len <= 32) out = Buffer.from(hex.slice(2 + 128, 2 + 128 + len * 2), "hex").toString("utf8");
      } else if (hex.length === 2 + 64) {
        out = Buffer.from(hex.slice(2).replace(/(00)+$/, ""), "hex").toString("utf8"); // legacy bytes32 symbol
      }
      if (out) { out = out.replace(/[^\x20-\x7E]/g, "").trim(); if (!out || out.length > 24) out = null; }
    } catch { out = null; }
  }
  _symCache.set(key, out);
  return out;
}

// wrapper→underlying relations are immutable → process-lifetime cache
const _wrapCache = new Map<string, string | null>();
/**
 * On-chain-verified wrapper→underlying address (asset()/stETH()/eETH() must return a real address).
 * null = NOT a verified wrapper. 랩 라벨은 이 검증을 통과한 쌍에만 붙는다 — 추측 금지.
 */
export async function wrappedUnderlying(chain: string, wrapper: string): Promise<string | null> {
  const rpc = RPC[chain];
  if (!rpc) return null;
  const key = `${chain}|${wrapper.toLowerCase()}`;
  if (_wrapCache.has(key)) return _wrapCache.get(key)!;
  let out: string | null = null;
  let inconclusive = false; // 한 셀렉터라도 전송 실패면 음성 결론을 내릴 수 없다
  for (const sel of [SEL_ASSET, SEL_STETH, SEL_EETH]) {
    const hex = await ethCall(rpc, wrapper, sel);
    if (hex === undefined) { inconclusive = true; continue; }
    if (hex && hex.length === 2 + 64) { const a = decodeAddressWord(hex); if (a) { out = a; break; } }
  }
  if (out === null && inconclusive) return null; // 비결론 — 미캐시 (영구 음성 오염이 가족 확장을 전멸시켰던 버그)
  _wrapCache.set(key, out);
  return out;
}

// aToken addresses are immutable per (pool, asset) → process-lifetime cache, no TTL needed.
const _aTokenCache = new Map<string, string | null>();

async function readAToken(rpc: string, pool: string, asset: string): Promise<string | null> {
  const key = `${rpc}|${pool}|${asset}`;
  if (_aTokenCache.has(key)) return _aTokenCache.get(key)!;
  // ReserveData word 8 = aTokenAddress (static struct, returned inline). decodeAddressWord enforces
  // the 12 zero-padding bytes — a non-V3 struct layout (rate/uint128 in word 8) cannot slip through.
  const hex = await ethCall(rpc, pool, SEL_GET_RESERVE_DATA + asset.slice(2).padStart(64, "0"));
  if (hex === undefined) return null; // 전송 실패 = 비결론 — 미캐시
  const out = hex && hex.length >= 2 + 9 * 64 ? decodeAddressWord(hex, 8) : null;
  _aTokenCache.set(key, out);
  return out;
}

// comet verification result is immutable → process-lifetime cache
const _cometCache = new Map<string, boolean>();

/** on-chain-verified Compound V3 comets for a chain → counterparty entries (label compound-v3). */
export async function compoundComets(chain: string): Promise<{ addr: string; label: string }[]> {
  const rpc = RPC[chain];
  const candidates = COMPOUND_COMET_CANDIDATES[chain];
  if (!rpc || !candidates?.length) return [];
  const out: { addr: string; label: string }[] = [];
  await Promise.all(candidates.map(async (comet) => {
    const key = `${chain}|${comet}`;
    if (!_cometCache.has(key)) {
      const hex = await ethCall(rpc, comet, SEL_BASE_TOKEN);
      // address-shaped word required (12 zero-pad bytes checked) — dead/typo addresses self-eliminate.
      // 전송 실패(undefined)는 비결론 — 미캐시(다음 빌드가 재검증), 이번 빌드에선 제외만.
      if (hex !== undefined) _cometCache.set(key, !!(hex && hex.length === 2 + 64 && decodeAddressWord(hex)));
    }
    if (_cometCache.get(key)) out.push({ addr: comet, label: "compound-v3" });
  }));
  return out;
}

/** receipt-token addresses for the given underlyings on one chain → {addr, label} counterparty entries. */
export async function lendingReceiptAddrs(chain: string, tokenAddrs: string[]): Promise<{ addr: string; label: string }[]> {
  const rpc = RPC[chain];
  if (!rpc) return [];
  const pools: { pool: string; label: string }[] = [];
  if (AAVE_V3_POOL[chain]) pools.push({ pool: AAVE_V3_POOL[chain], label: "aave-v3" });
  if (chain === "ethereum") pools.push({ pool: SPARK_POOL_ETHEREUM, label: "spark" });
  if (!pools.length) return [];
  const uniq = [...new Set(tokenAddrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const out: { addr: string; label: string }[] = [];
  await Promise.all(uniq.flatMap((asset) => pools.map(async ({ pool, label }) => {
    const aToken = await readAToken(rpc, pool, asset);
    if (aToken) out.push({ addr: aToken, label });
  })));
  return out;
}
