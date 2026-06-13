/**
 * 파생토큰·수용처 열거자 — 전부 키리스 공개 소스 (RPC·공개 API), Dune 없음.
 *
 *  Pendle  : api-v2.pendle.finance /core/v1/{chainId}/markets/active — underlying → PT/YT/LP(=market)
 *  Morpho  : blue-api.morpho.org GraphQL markets(collateralAssetAddress_in) — "이 주소를 담보로 받는 마켓"
 *  Curve   : MetaRegistry.find_pools_for_coins(token, quote) + get_lp_token(pool) — 이더리움만
 *  Convex  : Booster.poolLength/poolInfo 전수 스캔 — Curve LP → Convex 등재 여부
 *  Aave V3 : Pool.getReserveData(asset) word8 = aToken — 예치 영수증 토큰
 * 모든 결과는 evidence(메서드·원자료)를 달고 나간다. 2026-06-12 라이브 검증:
 * sUSDe→PT-sUSDE-13AUG2026→Morpho(PYUSD·RLUSD), stETH/ETH pool→steCRV→Convex pid25.
 */
import { toFunctionSelector, type Address } from "viem";

import { rpcFor } from "@/lib/rpc";
import { getTokenPricesUsd } from "@/lib/prices";
import { CHAIN_IDS } from "./types";
import { decodeAddressWord, ethCall } from "./onchain";

// ── Pendle ──
export interface PendleMarket {
  name: string; market: string; pt: string; yt: string; sy: string;
  underlying: string; expiry: string; liquidityUsd: number;
}
const _pendleCache = new Map<number, PendleMarket[]>();
async function pendleActive(chainId: number): Promise<PendleMarket[]> {
  const hit = _pendleCache.get(chainId);
  if (hit) return hit;
  let out: PendleMarket[] = [];
  try {
    const r = await fetch(`https://api-v2.pendle.finance/core/v1/${chainId}/markets/active`);
    if (r.ok) {
      const j = (await r.json()) as { markets?: { name?: string; address?: string; pt?: string; yt?: string; sy?: string; underlyingAsset?: string; expiry?: string; details?: { liquidity?: number } }[] };
      const strip = (s?: string) => (s ?? "").split("-").pop()?.toLowerCase() ?? "";
      out = (j.markets ?? [])
        .filter((m) => m.address && m.pt && m.underlyingAsset)
        .map((m) => ({
          name: m.name ?? "?",
          market: (m.address ?? "").toLowerCase(),
          pt: strip(m.pt), yt: strip(m.yt), sy: strip(m.sy),
          underlying: strip(m.underlyingAsset),
          expiry: (m.expiry ?? "").slice(0, 10),
          liquidityUsd: m.details?.liquidity ?? 0,
        }));
    }
  } catch { /* Pendle 미지원 체인/일시 실패 → 빈 배열 (없는 걸 지어내지 않음) */ }
  _pendleCache.set(chainId, out);
  return out;
}
/** underlying 주소가 일치하는 Pendle 마켓들. */
export async function pendleMarketsFor(chain: string, tokenAddr: string): Promise<PendleMarket[]> {
  const id = CHAIN_IDS[chain];
  if (!id) return [];
  const all = await pendleActive(id);
  const want = tokenAddr.toLowerCase();
  return all.filter((m) => m.underlying === want);
}

// ── Morpho — 이 주소들을 담보로 받는 마켓 ──
export interface MorphoAccepting {
  collateral: string; loanSymbol: string; loanAddress: string;
  lltv: number | null; supplyUsd: number; collateralUsd: number;
  curators: string[]; // 이 마켓을 펀딩하는 MetaMorpho 볼트(큐레이터) — 연쇄청산 시 부실채권 책임자 (멘토 §3·§6)
}
interface MorphoMarketItem { lltv?: string; loanAsset?: { symbol?: string; address?: string }; collateralAsset?: { address?: string }; state?: { supplyAssetsUsd?: number; collateralAssetsUsd?: number }; supplyingVaults?: { name?: string }[] }
export async function morphoAccepting(chain: string, collateralAddrs: string[]): Promise<MorphoAccepting[]> {
  const id = CHAIN_IDS[chain];
  const addrs = [...new Set(collateralAddrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (!id || !addrs.length) return [];
  // 페이지네이션: first/skip + pageInfo.countTotal 로 전건 수집. 안전 상한 1000(=20페이지)으로 폭주 방지.
  const PAGE = 50, MAX = 1000; // MAX 도달 시 중단(이론상 한 담보의 수용 마켓이 1000 넘는 일은 없음)
  const items: MorphoMarketItem[] = [];
  try {
    for (let skip = 0; skip < MAX; skip += PAGE) {
      const q = `{ markets(first: ${PAGE}, skip: ${skip}, where: { collateralAssetAddress_in: ${JSON.stringify(addrs)}, chainId_in: [${id}] }) {
        pageInfo { countTotal } items { lltv loanAsset { symbol address } collateralAsset { address } state { supplyAssetsUsd collateralAssetsUsd } supplyingVaults { name } } } }`;
      const r = await fetch("https://blue-api.morpho.org/graphql", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
      });
      if (!r.ok) break;
      const j = (await r.json()) as { data?: { markets?: { pageInfo?: { countTotal?: number }; items?: MorphoMarketItem[] } } };
      const page = j.data?.markets?.items ?? [];
      items.push(...page);
      const total = j.data?.markets?.pageInfo?.countTotal ?? items.length;
      if (page.length < PAGE || items.length >= total) break; // 마지막 페이지 도달
    }
  } catch { /* 일시 실패 → 그때까지 모은 것만 (부분이라도 추측보다 낫다) */ }
  return items
    .filter((m) => m.collateralAsset?.address)
    .map((m) => ({
      collateral: (m.collateralAsset?.address ?? "").toLowerCase(),
      loanSymbol: m.loanAsset?.symbol ?? "?",
      loanAddress: (m.loanAsset?.address ?? "").toLowerCase(),
      lltv: m.lltv ? Number(m.lltv) / 1e18 : null,
      supplyUsd: m.state?.supplyAssetsUsd ?? 0,
      collateralUsd: m.state?.collateralAssetsUsd ?? 0,
      curators: [...new Set((m.supplyingVaults ?? []).map((v) => v.name).filter((n): n is string => !!n))],
    }));
}

// ── MetaMorpho 볼트 — 이 토큰을 기초자산으로 하는 ERC-4626 큐레이터 볼트 (전염 주경로: 볼트 쉐어가 다시 담보로 돈다) ──
//   Morpho GraphQL vaults(assetAssetAddress_in + chainId_in) — morphoAccepting 과 동일 엔드포인트·체인 id 매핑 재사용.
//   쉐어(steakUSDC·gtUSDC 등)를 wrapper 파생으로 적재 → 그 쉐어 주소를 다시 수용처 질의에 넣어 "쉐어가 어디 담보로 쓰이나" 추적.
export interface MetaMorphoVault {
  address: string;            // 볼트(=쉐어 ERC-4626) 주소 (lowercase)
  symbol: string | null;      // API symbol (steakUSDC 등)
  name: string | null;        // 사람이 읽는 이름 (Steakhouse USDC 등)
  totalAssetsUsd: number;     // 볼트 TVL (issues 엣지 evidence + 캡/필터 기준)
}
export async function metamorphoVaultsFor(chain: string, assetAddr: string): Promise<MetaMorphoVault[]> {
  const id = CHAIN_IDS[chain];
  const asset = assetAddr.toLowerCase();
  if (!id || !/^0x[0-9a-f]{40}$/.test(asset)) return [];
  // TVL 내림차순 정렬 → 폭주 방지: TVL 100만 달러 이상 + 상위 12개만(코드 캡). 큐레이터 대형 볼트만 잡는다.
  const q = `{ vaults(first: 50, orderBy: TotalAssetsUsd, orderDirection: Desc, where: { assetAddress_in: ["${asset}"], chainId_in: [${id}] }) {
    items { address symbol name state { totalAssetsUsd } } } }`;
  try {
    const r = await fetch("https://blue-api.morpho.org/graphql", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: { vaults?: { items?: { address?: string; symbol?: string; name?: string; state?: { totalAssetsUsd?: number } }[] } } };
    const MIN_TVL_USD = 1_000_000; // 100만 달러 미만 볼트는 제외(소형/테스트 볼트 폭주 방지)
    const CAP = 12;                // TVL 상위 12개 캡
    return (j.data?.vaults?.items ?? [])
      .filter((v) => v.address && /^0x[0-9a-f]{40}$/.test(v.address.toLowerCase()))
      .map((v) => ({
        address: (v.address ?? "").toLowerCase(),
        symbol: v.symbol ?? null,
        name: v.name ?? null,
        totalAssetsUsd: v.state?.totalAssetsUsd ?? 0,
      }))
      .filter((v) => v.totalAssetsUsd >= MIN_TVL_USD)
      .slice(0, CAP);
  } catch { return []; } // API 불가/일시 실패 → 빈 배열 (볼트 노드만 빠짐, 추측 적재 안 함)
}

// ── Euler v2 — 이 토큰을 담보로 받는 마켓 (멘토 §8: PT 가 Morpho 외 Euler 에도 대량) ──
//   Euler v2 = 볼트별 모델. 각 대출볼트(eulerVault)의 collaterals[] = 받아주는 담보볼트들.
//   "D 를 담보로 받는 마켓" = D 를 asset 으로 가진 담보볼트를 collaterals 에 넣은 대출볼트들.
//   체인별 서브그래프 1회 bulk → 체인별 캐시 → 전 토큰 재사용.
//   엔드포인트: Euler 공식 docs(docs.euler.finance/developers/data-querying/subgraphs) 의 Goldsky 호스팅 목록 —
//   같은 project id 에 euler-v2-{mainnet|base|arbitrum} 서브그래프명. 2026-06-13 curl 로 base/arbitrum eulerVaults 응답 실검증.
const EULER_SUBGRAPHS: Record<string, string> = {
  ethereum: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn",
  base: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-base/latest/gn",
  arbitrum: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-arbitrum/latest/gn",
};
interface EulerData { vaultMeta: Map<string, { asset: string; symbol: string }>; acceptorsOf: Map<string, { loanAsset: string; loanSym: string }[]> }
const _euler = new Map<string, Promise<EulerData>>(); // chain → 데이터 (체인별 캐시)
function eulerData(chain: string): Promise<EulerData> {
  const hit = _euler.get(chain);
  if (hit) return hit;
  const p = (async () => {
    const vaultMeta = new Map<string, { asset: string; symbol: string }>();
    const acceptorsOf = new Map<string, { loanAsset: string; loanSym: string }[]>(); // 담보볼트id → 그걸 받는 대출볼트들
    const endpoint = EULER_SUBGRAPHS[chain];
    if (!endpoint) return { vaultMeta, acceptorsOf }; // 미지원 체인 → 빈 데이터
    try {
      const r = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ eulerVaults(first: 1000){ id asset symbol collaterals } }` }),
      });
      if (r.ok) {
        const j = (await r.json()) as { data?: { eulerVaults?: { id: string; asset: string; symbol: string; collaterals: string[] }[] } };
        const vaults = j.data?.eulerVaults ?? [];
        for (const v of vaults) vaultMeta.set(v.id.toLowerCase(), { asset: (v.asset || "").toLowerCase(), symbol: v.symbol || "" });
        for (const v of vaults) {
          const loanSym = (v.symbol || "").replace(/^e/, "").replace(/-\d+$/, ""); // eUSDC-64 → USDC, ePT-USDS-14AUG2025-2 → PT-USDS-14AUG2025
          for (const cv of v.collaterals ?? []) {
            const k = cv.toLowerCase();
            (acceptorsOf.get(k) ?? acceptorsOf.set(k, []).get(k)!).push({ loanAsset: (v.asset || "").toLowerCase(), loanSym });
          }
        }
      }
    } catch { /* 서브그래프 불가 → 빈 데이터(Euler 엣지만 빠짐) */ }
    return { vaultMeta, acceptorsOf };
  })();
  _euler.set(chain, p);
  return p;
}
export interface EulerAccepting { collateral: string; loanSymbol: string; loanAddress: string }
export async function eulerAccepting(chain: string, collateralAddrs: string[]): Promise<EulerAccepting[]> {
  if (!EULER_SUBGRAPHS[chain]) return []; // 서브그래프 있는 체인만 (ethereum·base·arbitrum)
  const want = new Set(collateralAddrs.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
  if (!want.size) return [];
  const { vaultMeta, acceptorsOf } = await eulerData(chain);
  const out: EulerAccepting[] = [];
  const seen = new Set<string>();
  for (const [vid, meta] of vaultMeta) {
    if (!want.has(meta.asset)) continue;        // 이 볼트가 파생 D 의 담보볼트
    for (const b of acceptorsOf.get(vid) ?? []) {
      const key = `${meta.asset}|${b.loanAsset}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ collateral: meta.asset, loanSymbol: b.loanSym || "?", loanAddress: b.loanAsset });
    }
  }
  return out;
}

// ── Fluid (Instadapp) — 이 토큰을 담보로 받는 vault (멘토 §8 류: PT·sUSDe 가 Fluid 에도 담보) ──
//   Fluid 공개 API: api.fluid.instadapp.io/v2/{chainId}/vaults → vault 배열.
//   각 vault: supplyToken(담보) {token0, token1} + borrowToken(부채) {token0, token1} + 리스크 파라미터.
//     type 1 = 단일담보/단일부채, type 2 = 스마트담보(token0+token1)/단일부채,
//     type 3 = 단일담보/스마트부채, type 4 = 스마트담보/스마트부채.
//   "D 를 담보로 받는 vault" = supplyToken.token0 또는 token1 이 D 인 vault.
//   체인별 1회 bulk fetch → 체인별 캐시. 2026-06-13 curl 실검증: eth 116·base 33·arbitrum 57 vault,
//   sUSDe 담보 vault(id 7·8·17·18·56 …) 실존, collateralFactor/liquidationThreshold(bps) 응답.
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
interface FluidToken { address?: string; symbol?: string; decimals?: number; price?: string }
interface FluidVault {
  id?: string; type?: string; address?: string;
  supplyToken?: { token0?: FluidToken; token1?: FluidToken };
  borrowToken?: { token0?: FluidToken; token1?: FluidToken };
  totalSupply?: string;       // 담보 토큰 raw 잔액 (단일담보면 token0 수량, 스마트담보면 LP/쉐어 — 단일담보만 USD 환산)
  collateralFactor?: number;  // bps (8800 = 88%)
  liquidationThreshold?: number; // bps
  liquidationPenalty?: number;   // bps
}
const _fluid = new Map<string, Promise<FluidVault[]>>(); // chain → vault 목록 (체인별 캐시)
function fluidVaults(chain: string): Promise<FluidVault[]> {
  const hit = _fluid.get(chain);
  if (hit) return hit;
  const p = (async () => {
    const id = CHAIN_IDS[chain];
    if (!id) return []; // 미지원 체인
    try {
      const r = await fetch(`https://api.fluid.instadapp.io/v2/${id}/vaults`);
      if (!r.ok) return [];
      const j = (await r.json()) as FluidVault[];
      return Array.isArray(j) ? j : [];
    } catch { return []; } // API 불가/일시 실패 → 빈 배열 (Fluid 엣지만 빠짐, 추측 적재 안 함)
  })();
  _fluid.set(chain, p);
  return p;
}
export interface FluidAccepting {
  collateral: string;     // 담보 토큰 주소 (lowercase) — derivNodeId 매칭용
  vaultId: string;        // marketKey (legomkt:fluid:{vaultId}@chain)
  vaultAddress: string;   // vault 컨트랙트 주소 (evidence)
  loanSymbol: string;     // 부채 토큰0 심볼 (라벨)
  loanAddress: string;    // 부채 토큰0 주소
  loanSymbol1: string | null; // 스마트부채 토큰1 심볼 (있으면 meta 표기)
  smartCollateral: boolean;   // 담보가 token0+token1 페어(스마트담보)인지
  cf: number | null;      // collateralFactor (0~1, null 허용)
  lt: number | null;      // liquidationThreshold (0~1)
  penalty: number | null; // liquidationPenalty (0~1)
  sizeUsd: number | null; // 단일담보 vault 만: totalSupply/10^dec × price. 스마트담보는 null(토큰별 안분 불가 — 지어내지 않음)
}
/** collateralAddrs 중 Fluid (해당 체인) vault 가 담보로 받는 것들. ethereum/base/arbitrum. */
export async function fluidAccepting(chain: string, collateralAddrs: string[]): Promise<FluidAccepting[]> {
  if (!CHAIN_IDS[chain]) return [];
  const want = new Set(collateralAddrs.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
  if (!want.size) return [];
  const vaults = await fluidVaults(chain);
  const out: FluidAccepting[] = [];
  const seen = new Set<string>();
  for (const v of vaults) {
    if (!v.id) continue;
    const c0 = (v.supplyToken?.token0?.address ?? "").toLowerCase();
    const c1 = (v.supplyToken?.token1?.address ?? "").toLowerCase();
    const smartCollateral = !!c1 && c1 !== ZERO_ADDR; // token1 도 실주소면 스마트담보(LP 담보)
    const loan0 = v.borrowToken?.token0;
    const loan1 = v.borrowToken?.token1;
    const loanAddr1 = (loan1?.address ?? "").toLowerCase();
    // 이 vault 의 담보 후보 = token0(+스마트담보면 token1). 요청 목록과 교집합만.
    const collats = [c0, ...(smartCollateral ? [c1] : [])].filter((a) => a && a !== ZERO_ADDR && want.has(a));
    for (const collateral of collats) {
      const key = `${v.id}|${collateral}`;
      if (seen.has(key)) continue; seen.add(key);
      // sizeUsd: 단일담보 vault 만 totalSupply × token0 가격으로 환산(스마트담보는 LP 쉐어라 토큰별 안분 불가 → null)
      let sizeUsd: number | null = null;
      if (!smartCollateral && v.totalSupply) {
        const dec = v.supplyToken?.token0?.decimals ?? 18;
        const price = Number(v.supplyToken?.token0?.price);
        try {
          const amt = Number(BigInt(v.totalSupply)) / 10 ** dec;
          if (isFinite(amt) && isFinite(price) && price > 0) sizeUsd = amt * price;
        } catch { /* totalSupply 파싱 실패 → null */ }
      }
      out.push({
        collateral, vaultId: v.id, vaultAddress: (v.address ?? "").toLowerCase(),
        loanSymbol: loan0?.symbol ?? "?", loanAddress: (loan0?.address ?? "").toLowerCase(),
        loanSymbol1: loanAddr1 && loanAddr1 !== ZERO_ADDR ? (loan1?.symbol ?? null) : null,
        smartCollateral,
        cf: typeof v.collateralFactor === "number" ? v.collateralFactor / 1e4 : null,
        lt: typeof v.liquidationThreshold === "number" ? v.liquidationThreshold / 1e4 : null,
        penalty: typeof v.liquidationPenalty === "number" ? v.liquidationPenalty / 1e4 : null,
        sizeUsd,
      });
    }
  }
  return out;
}

// ── Curve (이더리움 MetaRegistry) ──
const CURVE_META_REGISTRY = "0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC";
const SEL_FIND_POOLS = toFunctionSelector("function find_pools_for_coins(address,address)");
const SEL_GET_LP = toFunctionSelector("function get_lp_token(address)");
// 쿼트 파트너 — 의미있는 커브 페어의 반대편 (이더리움 정식 주소, 네이티브 ETH 센티널 포함)
const CURVE_QUOTES = [
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // native ETH
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
  "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", // crvUSD
  "0x853d955acef822db058eb8505911ed77f175b99e", // FRAX
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", // stETH
];
/** 토큰이 들어간 Curve 풀 + LP 토큰 (이더리움만 — MetaRegistry 가 메인넷 전용). */
export async function curveLpsFor(tokenAddr: string): Promise<{ pool: string; lp: string; quote: string }[]> {
  const token = tokenAddr.toLowerCase();
  const out: { pool: string; lp: string; quote: string }[] = [];
  const seenPool = new Set<string>();
  for (const quote of CURVE_QUOTES) {
    if (quote === token) continue;
    const data = (SEL_FIND_POOLS + token.slice(2).padStart(64, "0") + quote.slice(2).padStart(64, "0")) as `0x${string}`;
    const res = await ethCall("ethereum", CURVE_META_REGISTRY, data);
    if (!res || res.length < 2 + 64 * 2) continue;
    // address[] 디코드: word0 offset, word1 length, 이후 주소들
    const len = parseInt(res.slice(2 + 64, 2 + 128), 16);
    for (let i = 0; i < Math.min(len, 16); i++) {
      const pool = decodeAddressWord(res, 2 + i);
      if (!pool || seenPool.has(pool)) continue;
      seenPool.add(pool);
      const lpRes = await ethCall("ethereum", CURVE_META_REGISTRY, (SEL_GET_LP + pool.slice(2).padStart(64, "0")) as `0x${string}`);
      const lp = decodeAddressWord(lpRes) ?? pool; // 신형 풀은 풀 자신이 LP
      out.push({ pool, lp, quote });
    }
  }
  return out;
}

// ── Convex Booster — Curve LP → Convex 등재 맵 (이더리움) ──
const CONVEX_BOOSTER = "0xF403C135812408BFbE8713b5A23a04b3D48AAE31";
const BOOSTER_ABI = [
  { name: "poolLength", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "poolInfo", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
    { type: "address", name: "lptoken" }, { type: "address", name: "token" }, { type: "address", name: "gauge" },
    { type: "address", name: "crvRewards" }, { type: "address", name: "stash" }, { type: "bool", name: "shutdown" },
  ] },
] as const;
let _convexMap: Promise<Map<string, { pid: number; depositToken: string }>> | null = null;
/** lptoken(lowercase) → Convex pid. 전수 1회 스캔 후 프로세스 캐시. shutdown 풀 제외. */
export function convexLpMap(): Promise<Map<string, { pid: number; depositToken: string }>> {
  if (_convexMap) return _convexMap;
  _convexMap = (async () => {
    const map = new Map<string, { pid: number; depositToken: string }>();
    try {
      const c = rpcFor(1);
      const len = Number(await c.readContract({ address: CONVEX_BOOSTER as Address, abi: BOOSTER_ABI, functionName: "poolLength" }));
      const res = await c.multicall({
        contracts: Array.from({ length: len }, (_, i) => ({
          address: CONVEX_BOOSTER as Address, abi: BOOSTER_ABI, functionName: "poolInfo" as const, args: [BigInt(i)] as const,
        })),
        allowFailure: true,
        batchSize: 4096,
      });
      res.forEach((r, i) => {
        if (r.status !== "success") return;
        const [lptoken, token, , , , shutdown] = r.result as readonly [string, string, string, string, string, boolean];
        if (shutdown) return;
        map.set(lptoken.toLowerCase(), { pid: i, depositToken: token.toLowerCase() });
      });
    } catch { /* Booster 스캔 실패 → 빈 맵 (Convex 엣지만 빠짐) */ }
    return map;
  })();
  return _convexMap;
}

// ── Aave V3 — asset → aToken ──
const AAVE_V3_POOL: Record<string, string> = {
  ethereum: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  base: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
  arbitrum: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
};
const SEL_GET_RESERVE_DATA = toFunctionSelector("function getReserveData(address)");
/** getReserveData 리턴 word8 = aTokenAddress. 리저브 미등재면 null. */
export async function aaveATokenFor(chain: string, tokenAddr: string): Promise<string | null> {
  const pool = AAVE_V3_POOL[chain];
  if (!pool) return null;
  const data = (SEL_GET_RESERVE_DATA + tokenAddr.toLowerCase().slice(2).padStart(64, "0")) as `0x${string}`;
  const res = await ethCall(chain, pool, data);
  return decodeAddressWord(res, 8);
}

// ── Aave v3 수용처 — 이 토큰을 "담보로 받는" 리저브 (멘토 §8: PT 가 Morpho·Euler 외 Aave 에도 대량) ──
//   Aave 는 풀형이라 마켓 = 해당 파생의 리저브 1개(대출자산 구분 없음 — e-mode/금리모드는 스코프 밖).
//   getReserveData(asset) 한 콜로 word0=ReserveConfigurationMap, word8=aToken 을 동시에 디코드.
//   ReserveConfigurationMap 비트맵(aave-v3-origin ReserveConfiguration.sol):
//     bit 0–15 = LTV, bit 56 = active, bit 57 = frozen.
//   담보 수용 판정: 리저브 존재(aToken≠0) ∧ LTV>0 ∧ frozen 아님. LTV=0(차입전용/격리)은 담보 불가 → 제외.
const SEL_TOTAL_SUPPLY = toFunctionSelector("function totalSupply()");
const SEL_DECIMALS = toFunctionSelector("function decimals()");
export interface AaveReserveAccepting {
  collateral: string;   // 담보 파생 주소 (lowercase)
  aToken: string;       // 예치 영수증 토큰 (weightUsd 산출 + evidence)
  ltvBps: number;       // LTV (basis points, 0~10000)
  ltBps: number;        // 청산 임계치 (basis points) — evidence 용
  sizeUsd: number | null; // aToken totalSupply × 가격 (산출 실패 시 null — 지어내지 않음)
}
/** collateralAddrs 중 Aave v3 (해당 체인 Core Pool) 가 담보로 받는 것들. ethereum/base/arbitrum. */
export async function aaveAccepting(chain: string, collateralAddrs: string[]): Promise<AaveReserveAccepting[]> {
  const pool = AAVE_V3_POOL[chain];
  const addrs = [...new Set(collateralAddrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (!pool || !addrs.length) return [];
  const out: AaveReserveAccepting[] = [];
  for (const asset of addrs) {
    const data = (SEL_GET_RESERVE_DATA + asset.slice(2).padStart(64, "0")) as `0x${string}`;
    const res = await ethCall(chain, pool, data);
    if (!res || res.length < 2 + 64 * 9) continue;        // 리저브 미등재/짧은 응답
    const config = BigInt("0x" + res.slice(2, 2 + 64));   // word0 = ReserveConfigurationMap
    const aToken = decodeAddressWord(res, 8);             // word8 = aToken
    if (!aToken) continue;                                // 리저브 없음
    const ltvBps = Number(config & 0xffffn);
    const frozen = ((config >> 57n) & 1n) === 1n;
    if (ltvBps <= 0 || frozen) continue;                  // LTV=0(차입전용) 또는 동결 → 담보 불가
    const ltBps = Number((config >> 16n) & 0xffffn);
    // weightUsd = aToken totalSupply × 가격 (실패 시 null). aToken 잔액 = 그 자산의 Aave 예치 총량.
    let sizeUsd: number | null = null;
    try {
      const supRes = await ethCall(chain, aToken, SEL_TOTAL_SUPPLY);
      const price = (await getTokenPricesUsd([asset as Address], chain)).get(asset);
      if (supRes && price) {
        const decRes = await ethCall(chain, asset, SEL_DECIMALS);
        const dec = decRes ? Number(BigInt("0x" + decRes.slice(2)) & 0xffn) : 18;
        const supply = Number(BigInt(supRes)) / 10 ** dec;
        if (isFinite(supply)) sizeUsd = supply * price;
      }
    } catch { /* 규모 산출 실패 → null (담보 사실 자체는 유효) */ }
    out.push({ collateral: asset, aToken, ltvBps, ltBps, sizeUsd });
  }
  return out;
}
