import { type Address, formatUnits } from "viem";

import { batch } from "@/lib/multicall";
import { rpcFor } from "@/lib/rpc";
import {
  DEFAULT_META,
  type EdgeAttrs,
  type EdgeRole,
  makeMultiClassification,
  sumRolesToCore,
} from "@/types/edge-schema";

import { oracleTypeForCollateral } from "@/config/alert-thresholds";
import { introspectOracle } from "@/oracle/introspect";
import type { AdapterContext, ProtocolAdapter } from "./types";

/**
 * Aave V3 "family" 어댑터 팩토리 — Aave V3 와 그 포크(Spark 등)를 동일 로직으로 처리.
 *
 * PoolAddressesProvider 만 다르면 DataProvider/Oracle 을 동적으로 조회하므로,
 * 포크별로 코드 중복 없이 동일한 풍부함(멀티롤 collateral+loan_asset, oracle source,
 * IRM 주소, caps, utilization, liquidity)을 얻음.
 */

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const PAP_ABI = [
  { inputs: [], name: "getPoolDataProvider", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "getPriceOracle", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
] as const;

const DATA_PROVIDER_ABI = [
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
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveConfigurationData",
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveCaps",
    outputs: [
      { name: "borrowCap", type: "uint256" },
      { name: "supplyCap", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getInterestRateStrategyAddress",
    outputs: [{ name: "irs", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_ABI = [
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalSupply", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const AAVE_ORACLE_ABI = [
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getSourceOfAsset",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface AaveV3FamilyOpts {
  family: string;                  // "aave_v3" | "spark"
  nodeId: string;                  // "protocol:aave_v3"
  label: string;
  poolAddressesProvider: Address;
  pool: Address;
  architecture: string;
  governance: string;
  oracleProvider: string;          // 표시용 ("Chainlink composite (CAPO)")
}

export function makeAaveV3FamilyAdapter(opts: AaveV3FamilyOpts): ProtocolAdapter {
  // 인스턴스별 캐시 (Aave 와 Spark 의 PAP 가 다르므로 분리)
  let _dp: Address | null = null;
  let _oracle: Address | null = null;

  async function resolve(chainId?: number): Promise<{ dp: Address | null; oracle: Address | null }> {
    if (_dp) return { dp: _dp, oracle: _oracle };
    const [dp, oracle] = (await batch(
      [
        { address: opts.poolAddressesProvider, abi: PAP_ABI, functionName: "getPoolDataProvider" },
        { address: opts.poolAddressesProvider, abi: PAP_ABI, functionName: "getPriceOracle" },
      ],
      { allowFailure: true, chainId },
    )) as [Address | null, Address | null];
    _dp = dp;
    _oracle = oracle;
    return { dp, oracle };
  }

  return {
    family: opts.family,
    protocolNodeId: opts.nodeId,

    describeNode() {
      return {
        nodeId: opts.nodeId,
        type: "DefiProtocol",
        label: opts.label,
        address: opts.pool,
        metadata: {
          family: opts.family,
          architecture: opts.architecture,
          coreContract: opts.pool,
          governance: opts.governance,
        },
      };
    },

    async fetchEdge(token: Address, ctx: AdapterContext): Promise<EdgeAttrs | null> {
      const { dp: dataProvider, oracle } = await resolve(ctx.chainId);
      if (!dataProvider) return null;

      const [tokens, config, caps, dec, irm] = (await batch(
        [
          { address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveTokensAddresses", args: [token] },
          { address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveConfigurationData", args: [token] },
          { address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveCaps", args: [token] },
          { address: token, abi: ERC20_ABI, functionName: "decimals" },
          { address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getInterestRateStrategyAddress", args: [token] },
        ],
        { allowFailure: true, chainId: ctx.chainId },
      )) as [
        readonly [Address, Address, Address] | null,
        readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean] | null,
        readonly [bigint, bigint] | null,
        number | null,
        Address | null,
      ];

      if (!tokens || tokens[0] === ZERO) return null;

      const aTokenAddress = tokens[0];
      const variableDebtAddress = tokens[2];
      const decimals = dec ?? 18;

      const [aSupply, vSupply] = (await batch(
        [
          { address: aTokenAddress, abi: ERC20_ABI, functionName: "totalSupply" },
          { address: variableDebtAddress, abi: ERC20_ABI, functionName: "totalSupply" },
        ],
        { allowFailure: true, chainId: ctx.chainId },
      )) as [bigint | null, bigint | null];

      const supplied = Number(formatUnits(aSupply ?? BigInt(0), decimals));
      const borrowed = Number(formatUnits(vSupply ?? BigInt(0), decimals));

      let oracleSourceAddress: Address | null = null;
      if (oracle) {
        try {
          oracleSourceAddress = (await rpcFor(ctx.chainId ?? 1).readContract({
            address: oracle,
            abi: AAVE_ORACLE_ABI,
            functionName: "getSourceOfAsset",
            args: [token],
          })) as Address;
        } catch {
          oracleSourceAddress = null;
        }
      }

      // 오라클 주소를 온체인 introspection 으로 실제 종류/제공자/설명까지 확정(실패 시 휴리스틱 fallback).
      const oracleIntro = oracleSourceAddress ? await introspectOracle(oracleSourceAddress, ctx.chainId ?? 1, ctx.tokenSymbol, token) : null;

      const ltv = config ? Number(config[1]) / 10000 : null;
      const lt = config ? Number(config[2]) / 10000 : null;
      const liqBonus = config ? (Number(config[3]) - 10000) / 10000 : null;
      const reserveFactor = config ? Number(config[4]) / 10000 : null;
      const isFrozen = config ? config[9] : null;
      const supplyCap = caps && caps[1] > BigInt(0) ? Number(caps[1]) : null;
      const borrowCap = caps && caps[0] > BigInt(0) ? Number(caps[0]) : null;

      const liquidityToken = Math.max(0, supplied - borrowed);
      const utilization = supplied > 0 ? borrowed / supplied : null;
      const liquidityUsd = liquidityToken * ctx.tokenPriceUsd;

      const roles: EdgeRole[] = [];
      if (supplied > 0) {
        roles.push({
          edge_type: "collateral",
          amount_token: supplied,
          amount_usd: supplied * ctx.tokenPriceUsd,
          pct_of_supply: ctx.tokenTotalSupply > 0 ? supplied / ctx.tokenTotalSupply : null,
        });
      }
      if (borrowed > 0) {
        roles.push({
          edge_type: "loan_asset",
          amount_token: borrowed,
          amount_usd: borrowed * ctx.tokenPriceUsd,
          pct_of_supply: ctx.tokenTotalSupply > 0 ? borrowed / ctx.tokenTotalSupply : null,
        });
      }
      if (roles.length === 0) return null;

      const classification = makeMultiClassification(roles, "market", "lending");
      const core = sumRolesToCore(roles);

      return {
        classification,
        edgeType: classification.primary_role,
        venueType: "market",
        protocolClass: "lending",
        core,
        oracle: {
          type: oracleIntro?.type ?? oracleTypeForCollateral(ctx.tokenSymbol),
          provider: oracleIntro?.verified ? oracleIntro.provider : opts.oracleProvider,
          address: oracleSourceAddress,
          depegSensitive: oracleIntro?.depegSensitive ?? true,
          description: oracleIntro?.description ?? null,
          verified: oracleIntro?.verified ?? false,
        },
        lendingRisk: {
          ltv,
          lt,
          liquidationBonus: liqBonus,
          supplyCap,
          borrowCap,
          reserveFactor,
          utilization,
          liquidityUsd,
          isFrozen,
          eModeCategory: null,
          irm: { address: irm ?? null, family: null, baseRate: null, kink: null },
        },
        dex: null,
        wrapper: null,
        topMarkets: null,
        topPools: null,
        meta: { ...DEFAULT_META, snapshotTs: ctx.snapshotTs, snapshotBlock: ctx.blockNumber },
      };
    },
  };
}
