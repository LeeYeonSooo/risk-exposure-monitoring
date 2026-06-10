import { type Address, formatUnits } from "viem";

import { batch } from "@/lib/multicall";
import { rpc } from "@/lib/rpc";
import { DEFAULT_META, type EdgeAttrs, type EdgeRole, makeClassification } from "@/types/edge-schema";

import { oracleTypeForCollateral } from "@/config/alert-thresholds";
import { introspectOracle } from "@/oracle/introspect";
import type { AdapterContext, ProtocolAdapter } from "./types";

const POOL_V2: Address = "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9";

const POOL_ABI = [
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveData",
    outputs: [
      {
        components: [
          { name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }] },
          { name: "liquidityIndex", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "id", type: "uint8" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_ABI = [
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalSupply", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

// Aave V2 가격 오라클 — addresses provider → getPriceOracle → getSourceOfAsset(자산) → Chainlink 소스.
const PROVIDER_V2: Address = "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5";
const PROVIDER_ABI = [{ inputs: [], name: "getPriceOracle", outputs: [{ type: "address" }], stateMutability: "view", type: "function" }] as const;
const V2_ORACLE_ABI = [{ inputs: [{ name: "asset", type: "address" }], name: "getSourceOfAsset", outputs: [{ type: "address" }], stateMutability: "view", type: "function" }] as const;
let _v2Oracle: Address | null = null;
async function v2OracleSource(token: Address): Promise<Address | null> {
  try {
    if (!_v2Oracle) _v2Oracle = (await rpc().readContract({ address: PROVIDER_V2, abi: PROVIDER_ABI, functionName: "getPriceOracle" })) as Address;
    if (!_v2Oracle) return null;
    return (await rpc().readContract({ address: _v2Oracle, abi: V2_ORACLE_ABI, functionName: "getSourceOfAsset", args: [token] })) as Address;
  } catch {
    return null;
  }
}

export const aaveV2Adapter: ProtocolAdapter = {
  family: "aave_v2",
  protocolNodeId: "protocol:aave_v2",

  describeNode() {
    return {
      nodeId: "protocol:aave_v2",
      type: "DefiProtocol",
      label: "Aave V2 (legacy)",
      address: POOL_V2,
      metadata: {
        family: "aave_v2",
        architecture: "mono_pool_legacy",
        coreContract: POOL_V2,
        governance: "Aave DAO",
      },
    };
  },

  async fetchEdge(token: Address, ctx: AdapterContext): Promise<EdgeAttrs | null> {
    const [reserve, dec] = (await batch([
      { address: POOL_V2, abi: POOL_ABI, functionName: "getReserveData", args: [token] },
      { address: token, abi: ERC20_ABI, functionName: "decimals" },
    ])) as [{ aTokenAddress: Address } | null, number | null];

    if (!reserve || reserve.aTokenAddress === "0x0000000000000000000000000000000000000000") return null;

    const decimals = dec ?? 18;
    const [aTotal] = (await batch([
      { address: reserve.aTokenAddress, abi: ERC20_ABI, functionName: "totalSupply" },
    ])) as [bigint | null];
    const amountToken = Number(formatUnits(aTotal ?? BigInt(0), decimals));

    if (amountToken === 0) return null;

    const role: EdgeRole = {
      edge_type: "collateral",
      amount_token: amountToken,
      amount_usd: amountToken * ctx.tokenPriceUsd,
      pct_of_supply: ctx.tokenTotalSupply > 0 ? amountToken / ctx.tokenTotalSupply : null,
    };
    const oracleSource = await v2OracleSource(token);
    const oracleIntro = oracleSource ? await introspectOracle(oracleSource, ctx.chainId ?? 1, ctx.tokenSymbol, token) : null;

    const classification = makeClassification(role, "market", "lending");

    return {
      classification,
      edgeType: "collateral",
      venueType: "market",
      protocolClass: "lending",
      core: {
        amountToken,
        amountUsd: amountToken * ctx.tokenPriceUsd,
        pctOfSupply: ctx.tokenTotalSupply > 0 ? amountToken / ctx.tokenTotalSupply : null,
        pctOfProtocolTvl: null,
      },
      oracle: {
        type: oracleIntro?.type ?? oracleTypeForCollateral(ctx.tokenSymbol),
        provider: oracleIntro?.verified ? oracleIntro.provider : "Chainlink (Aave V2 legacy oracle)",
        address: oracleSource,
        depegSensitive: oracleIntro?.depegSensitive ?? true,
        description: oracleIntro?.description ?? null,
        verified: oracleIntro?.verified ?? false,
      },
      lendingRisk: { ltv: null, lt: null, liquidationBonus: null, supplyCap: null, borrowCap: null, reserveFactor: null, utilization: null, liquidityUsd: null, isFrozen: null, eModeCategory: null, irm: null },
      dex: null,
      wrapper: null,
      topMarkets: null,
      topPools: null,
      meta: { ...DEFAULT_META, snapshotTs: ctx.snapshotTs, snapshotBlock: ctx.blockNumber, confidence: "MEDIUM", dataSource: "Aave V2 deprecated, partial data" },
    };
  },
};
