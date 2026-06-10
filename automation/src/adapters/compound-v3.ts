import { type Address, formatUnits } from "viem";

import { batch } from "@/lib/multicall";
import { listFamily } from "@/registry/protocol-registry";
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

const COMET_ABI = [
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getAssetInfoByAddress",
    outputs: [
      {
        components: [
          { name: "offset", type: "uint8" },
          { name: "asset", type: "address" },
          { name: "priceFeed", type: "address" },
          { name: "scale", type: "uint64" },
          { name: "borrowCollateralFactor", type: "uint64" },
          { name: "liquidateCollateralFactor", type: "uint64" },
          { name: "liquidationFactor", type: "uint64" },
          { name: "supplyCap", type: "uint128" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [], name: "baseToken", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  // base 자산 supply/borrow/utilization (token 이 그 comet 의 base 일 때)
  { inputs: [], name: "totalSupply", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalBorrow", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "getUtilization", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const ERC20_ABI = [
  { inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

/**
 * Compound V3 — base-asset isolated. For each Comet (cUSDCv3, cUSDTv3, cWETHv3),
 * check if the token is a registered collateral asset.
 */
export const compoundV3Adapter: ProtocolAdapter = {
  family: "compound_v3",
  protocolNodeId: "protocol:compound_v3",

  describeNode() {
    return {
      nodeId: "protocol:compound_v3",
      type: "DefiProtocol",
      label: "Compound V3",
      address: "0xc3d688b66703497daa19211eedff47f25384cdc3",
      metadata: {
        family: "compound_v3",
        architecture: "base_asset_isolated",
        coreContract: "0xc3d688b66703497daa19211eedff47f25384cdc3",
        governance: "Compound DAO",
      },
    };
  },

  async fetchEdge(token: Address, ctx: AdapterContext): Promise<EdgeAttrs | null> {
    const comets = listFamily("compound_v3")
      .filter((e) => e.role === "comet")
      .map((e) => e.address as Address);
    if (comets.length === 0) return null;

    // 토큰이 어느 comet의 collateral 인지 — getAssetInfoByAddress 시도
    type AssetInfo = {
      asset: Address;
      priceFeed: Address;
      scale: bigint;
      borrowCollateralFactor: bigint;
      liquidateCollateralFactor: bigint;
      liquidationFactor: bigint;
      supplyCap: bigint;
    };
    const infos = (await batch(
      comets.map((c) => ({
        address: c,
        abi: COMET_ABI,
        functionName: "getAssetInfoByAddress",
        args: [token],
      })),
      { allowFailure: true },
    )) as Array<AssetInfo | null>;

    // 토큰 decimals + 각 comet 의 baseToken (token 이 base 인 comet 식별)
    const [dec] = (await batch([
      { address: token, abi: ERC20_ABI, functionName: "decimals" },
    ])) as [number | null];
    const decimals = dec ?? 18;

    const baseTokens = (await batch(
      comets.map((c) => ({ address: c, abi: COMET_ABI, functionName: "baseToken" })),
      { allowFailure: true },
    )) as Array<Address | null>;

    // collateral 잔액 (token 이 collateral 인 comet 의 balanceOf)
    const balances = (await batch(
      comets.map((c) => ({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [c] })),
      { allowFailure: true },
    )) as Array<bigint | null>;

    // ── collateral side 집계 ──
    let collateralAmount = 0;
    let bestInfo: AssetInfo | null = null;
    const baseCometIdx: number[] = [];
    for (let i = 0; i < comets.length; i++) {
      const isBase = baseTokens[i]?.toLowerCase() === token.toLowerCase();
      if (isBase) {
        baseCometIdx.push(i);
        continue; // base 잔액은 totalSupply/Borrow 로 따로 처리 (idle reserve 중복 방지)
      }
      const info = infos[i];
      if (info && info.asset.toLowerCase() === token.toLowerCase()) {
        if (!bestInfo) bestInfo = info;
        collateralAmount += Number(formatUnits(balances[i] ?? BigInt(0), decimals));
      }
    }

    // ── base side 집계 (token 이 base 인 comet: supply/borrow/utilization) ──
    let supplyAmount = 0;
    let borrowAmount = 0;
    let utilization: number | null = null;
    if (baseCometIdx.length > 0) {
      const baseComets = baseCometIdx.map((i) => comets[i]);
      const baseReads = (await batch(
        baseComets.flatMap((c) => [
          { address: c, abi: COMET_ABI, functionName: "totalSupply" },
          { address: c, abi: COMET_ABI, functionName: "totalBorrow" },
          { address: c, abi: COMET_ABI, functionName: "getUtilization" },
        ]),
        { allowFailure: true },
      )) as Array<bigint | null>;
      for (let k = 0; k < baseComets.length; k++) {
        const sup = baseReads[k * 3] ?? BigInt(0);
        const bor = baseReads[k * 3 + 1] ?? BigInt(0);
        const util = baseReads[k * 3 + 2];
        supplyAmount += Number(formatUnits(sup, decimals));
        borrowAmount += Number(formatUnits(bor, decimals));
        if (util != null) {
          const u = Number(formatUnits(util, 18));
          utilization = utilization == null ? u : Math.max(utilization, u);
        }
      }
    }

    // ── roles 구성 ──
    const roles: EdgeRole[] = [];
    const pct = (a: number) => (ctx.tokenTotalSupply > 0 ? a / ctx.tokenTotalSupply : null);
    if (collateralAmount > 0) {
      roles.push({ edge_type: "collateral", amount_token: collateralAmount, amount_usd: collateralAmount * ctx.tokenPriceUsd, pct_of_supply: pct(collateralAmount) });
    }
    if (supplyAmount > 0) {
      roles.push({ edge_type: "deposit_supply", amount_token: supplyAmount, amount_usd: supplyAmount * ctx.tokenPriceUsd, pct_of_supply: pct(supplyAmount) });
    }
    if (borrowAmount > 0) {
      roles.push({ edge_type: "loan_asset", amount_token: borrowAmount, amount_usd: borrowAmount * ctx.tokenPriceUsd, pct_of_supply: pct(borrowAmount) });
    }
    if (roles.length === 0) return null;

    const lcf = bestInfo ? Number(bestInfo.liquidateCollateralFactor) / 1e18 : null;
    const bcf = bestInfo ? Number(bestInfo.borrowCollateralFactor) / 1e18 : null;
    const supplyCap = bestInfo ? Number(formatUnits(bestInfo.supplyCap, decimals)) : null;
    const liquidityUsd = supplyAmount > 0 ? Math.max(0, supplyAmount - borrowAmount) * ctx.tokenPriceUsd : null;

    const pf = bestInfo?.priceFeed ?? null;
    const oracleIntro = pf ? await introspectOracle(pf, ctx.chainId ?? 1, ctx.tokenSymbol, token) : null;

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
        provider: oracleIntro?.verified ? oracleIntro.provider : "Chainlink composite",
        address: pf,
        depegSensitive: oracleIntro?.depegSensitive ?? true,
        description: oracleIntro?.description ?? null,
        verified: oracleIntro?.verified ?? false,
      },
      lendingRisk: {
        ltv: bcf,
        lt: lcf,
        liquidationBonus: null,
        supplyCap,
        borrowCap: null,
        reserveFactor: null,
        utilization,
        liquidityUsd,
        isFrozen: null,
        eModeCategory: null,
        irm: null,
      },
      dex: null,
      wrapper: null,
      topMarkets: null,
      topPools: null,
      meta: { ...DEFAULT_META, snapshotTs: ctx.snapshotTs, snapshotBlock: ctx.blockNumber },
    };
  },
};
