import { type Address, formatUnits } from "viem";

import { batch } from "@/lib/multicall";
import { rpc } from "@/lib/rpc";

import { selectByCoverage } from "./coverage";
import { isExcludedRwa } from "./rwa-filter";

/**
 * Aave V3 reserve discovery.
 *
 * Ranking criterion: aToken total supply (= supplied liquidity / collateral)
 * valued in USD via the Aave price oracle. 이게 Aave 쪽 "담보 순위" 에 해당.
 *
 * 모든 읽기는 Multicall3 배치. PoolAddressesProvider 에서 DataProvider 와
 * PriceOracle 주소를 동적으로 조회 (하드코딩 회피, aave-v3.ts 와 동일 패턴).
 */

const POOL_ADDRESSES_PROVIDER: Address = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const PAP_ABI = [
  { inputs: [], name: "getPoolDataProvider", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "getPriceOracle", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
] as const;

const DATA_PROVIDER_ABI = [
  {
    inputs: [],
    name: "getAllReservesTokens",
    outputs: [
      {
        components: [
          { name: "symbol", type: "string" },
          { name: "tokenAddress", type: "address" },
        ],
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveTokensAddresses",
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_ABI = [
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalSupply", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const ORACLE_ABI = [
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getAssetPrice",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface DiscoveredReserve {
  address: string;
  symbol: string;
  decimals: number;
  collateralUsd: number; // aToken supply valued in USD (ranking metric)
  source: "aave_reserve";
}

const ORACLE_BASE_DECIMALS = 8; // Aave V3 mainnet oracle base currency = USD with 8 decimals

export async function fetchAaveTopReserves(
  topN = 100,
  minUsd = 1_000_000,
  coverageTarget = 0.95,
): Promise<DiscoveredReserve[]> {
  // 1) DataProvider + Oracle 주소
  const [dataProvider, oracle] = (await batch(
    [
      { address: POOL_ADDRESSES_PROVIDER, abi: PAP_ABI, functionName: "getPoolDataProvider" },
      { address: POOL_ADDRESSES_PROVIDER, abi: PAP_ABI, functionName: "getPriceOracle" },
    ],
    { allowFailure: true },
  )) as [Address | null, Address | null];

  if (!dataProvider) {
    console.warn("[discover:aave] getPoolDataProvider failed");
    return [];
  }

  // 2) 전체 reserve 목록 (단일 호출)
  const reserves = (await rpc().readContract({
    address: dataProvider,
    abi: DATA_PROVIDER_ABI,
    functionName: "getAllReservesTokens",
  })) as ReadonlyArray<{ symbol: string; tokenAddress: Address }>;

  if (!reserves || reserves.length === 0) return [];

  // 3) reserve 별 aToken 주소 (배치)
  const tokenAddrs = reserves.map((r) => r.tokenAddress);
  const aTokenResults = (await batch(
    tokenAddrs.map((asset) => ({
      address: dataProvider,
      abi: DATA_PROVIDER_ABI,
      functionName: "getReserveTokensAddresses",
      args: [asset],
    })),
    { allowFailure: true },
  )) as Array<readonly [Address, Address, Address] | null>;

  // 4) aToken.totalSupply + asset.decimals + oracle price (한 배치로 묶음)
  const calls: Array<Record<string, unknown>> = [];
  const idx: Array<{ reserveIdx: number; kind: "supply" | "decimals" | "price" }> = [];
  for (let i = 0; i < reserves.length; i++) {
    const aToken = aTokenResults[i]?.[0];
    if (!aToken || aToken === ZERO) continue;
    calls.push({ address: aToken, abi: ERC20_ABI, functionName: "totalSupply" });
    idx.push({ reserveIdx: i, kind: "supply" });
    calls.push({ address: tokenAddrs[i], abi: ERC20_ABI, functionName: "decimals" });
    idx.push({ reserveIdx: i, kind: "decimals" });
    if (oracle) {
      calls.push({ address: oracle, abi: ORACLE_ABI, functionName: "getAssetPrice", args: [tokenAddrs[i]] });
      idx.push({ reserveIdx: i, kind: "price" });
    }
  }

  const res = (await batch(calls, { allowFailure: true })) as Array<bigint | number | null>;

  // 5) 조립
  const acc = new Map<number, { supply?: bigint; decimals?: number; price?: bigint }>();
  for (let k = 0; k < idx.length; k++) {
    const { reserveIdx, kind } = idx[k];
    const v = res[k];
    const cur = acc.get(reserveIdx) ?? {};
    if (kind === "supply") cur.supply = (v as bigint) ?? BigInt(0);
    else if (kind === "decimals") cur.decimals = (v as number) ?? 18;
    else if (kind === "price") cur.price = (v as bigint) ?? BigInt(0);
    acc.set(reserveIdx, cur);
  }

  // 먼저 reserve 별 USD 계산 → 총합 → 상대 floor
  const rows: Array<{ reserveIdx: number; decimals: number; usd: number }> = [];
  for (const [reserveIdx, v] of acc) {
    const decimals = v.decimals ?? 18;
    const supplyToken = Number(formatUnits(v.supply ?? BigInt(0), decimals));
    const priceUsd = v.price != null ? Number(formatUnits(v.price, ORACLE_BASE_DECIMALS)) : 0;
    rows.push({ reserveIdx, decimals, usd: supplyToken * priceUsd });
  }
  // RWA 제외 후보 → 누적 커버리지 선택
  const candidates: DiscoveredReserve[] = rows
    .map(({ reserveIdx, decimals, usd }) => {
      const r = reserves[reserveIdx];
      return {
        address: r.tokenAddress.toLowerCase(),
        symbol: r.symbol,
        decimals,
        collateralUsd: usd,
        source: "aave_reserve" as const,
      };
    })
    .filter((x) => !isExcludedRwa(x.symbol, x.address));

  return selectByCoverage(candidates, {
    coverageTarget,
    minUsd,
    topN,
    label: "discover:aave",
  });
}
