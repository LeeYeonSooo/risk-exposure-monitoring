import { type Address, formatUnits } from "viem";

import { balanceOfBatch, batch } from "@/lib/multicall";
import {
  DEFAULT_META,
  type EdgeAttrs,
  type EdgeRole,
  makeClassification,
} from "@/types/edge-schema";

import { oracleTypeForCollateral } from "@/config/alert-thresholds";
import { getDexQuote } from "@/lib/dex-onchain";
import type { AdapterContext, ProtocolAdapter } from "./types";

const ERC20_ABI = [
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

/**
 * Generic balance-based adapter — for protocols where parameter fetching
 * is non-standard or expensive, just record token balance at the contract.
 *
 * Used for: Fluid, f(x), Maker (gem joins), Ether.fi BoringVault, Curve pools,
 * Uniswap pools, Aster, Yield Basis, etc.
 *
 * Constructed via the factory below.
 */
export function makeGenericBalanceAdapter(opts: {
  family: string;
  protocolNodeId: string;
  label: string;
  address: Address;
  architecture: string;
  governance: string;
  edgeType: EdgeAttrs["edgeType"];
  venueType: EdgeAttrs["venueType"];
  protocolClass: EdgeAttrs["protocolClass"];
  /** all contract addresses to sum balances over (e.g. multiple pools / gem joins) */
  watchAddresses: Address[];
  wrapper?: EdgeAttrs["wrapper"];
}): ProtocolAdapter {
  return {
    family: opts.family,
    protocolNodeId: opts.protocolNodeId,

    describeNode() {
      return {
        nodeId: opts.protocolNodeId,
        type: "DefiProtocol",
        label: opts.label,
        address: opts.address,
        metadata: {
          family: opts.family,
          architecture: opts.architecture,
          coreContract: opts.address,
          governance: opts.governance,
        },
      };
    },

    async fetchEdge(token: Address, ctx: AdapterContext): Promise<EdgeAttrs | null> {
      // 1) decimals
      const [dec] = (await batch([
        { address: token, abi: ERC20_ABI, functionName: "decimals" },
      ])) as [number | null];
      const decimals = dec ?? 18;

      // 2) balanceOf for each watched address, summed
      const balances = await balanceOfBatch(token, opts.watchAddresses);
      const totalRaw = balances.reduce((s, b) => s + b, BigInt(0));
      const amountToken = Number(formatUnits(totalRaw, decimals));

      if (amountToken === 0) return null;

      // DEX 유동성 — 한쪽 balanceOf(amountToken×price)는 실풀 TVL 과 무관(거의 $0). **getDexQuote 의 deepest-pool TVL**(온체인 Uni V2/V3)로 교체, 폴백=종전 balanceOf.
      const dexLiqUsd = opts.protocolClass === "dex"
        ? ((await getDexQuote(token, ctx.chainId ?? 1, decimals, Date.now()).catch(() => null))?.liquidityUsd ?? amountToken * ctx.tokenPriceUsd)
        : null;

      const role: EdgeRole = {
        edge_type: opts.edgeType,
        amount_token: amountToken,
        amount_usd: amountToken * ctx.tokenPriceUsd,
        pct_of_supply: ctx.tokenTotalSupply > 0 ? amountToken / ctx.tokenTotalSupply : null,
        pct_of_protocol_tvl: null,
      };
      const classification = makeClassification(role, opts.venueType, opts.protocolClass);

      return {
        classification,
        edgeType: opts.edgeType,
        venueType: opts.venueType,
        protocolClass: opts.protocolClass,
        core: {
          amountToken,
          amountUsd: amountToken * ctx.tokenPriceUsd,
          pctOfSupply: ctx.tokenTotalSupply > 0 ? amountToken / ctx.tokenTotalSupply : null,
          pctOfProtocolTvl: null,
        },
        oracle: {
          type: opts.protocolClass === "dex" ? "NONE" : oracleTypeForCollateral(ctx.tokenSymbol),
          provider: opts.protocolClass === "dex" ? "Pool spot price" : "unknown / per-vault",
          address: null,
          depegSensitive: opts.protocolClass !== "dex",
        },
        lendingRisk: opts.protocolClass === "lending" || opts.protocolClass === "cdp" ? {
          ltv: null, lt: null, liquidationBonus: null,
          supplyCap: null, borrowCap: null, reserveFactor: null,
          utilization: null, liquidityUsd: null,
          isFrozen: null, eModeCategory: null, irm: null,
        } : null,
        dex: opts.protocolClass === "dex" ? {
          poolCount: opts.watchAddresses.length,
          liquidityUsd: dexLiqUsd,
          depthAt1pctUsd: null,
          depthAt5pctUsd: null,
          topPairs: null,
        } : null,
        wrapper: opts.wrapper ?? null,
        topMarkets: null,
        topPools: null,
        meta: { ...DEFAULT_META, snapshotTs: ctx.snapshotTs, snapshotBlock: ctx.blockNumber, confidence: "MEDIUM", dataSource: "balanceOf only — parameter detail pending dedicated adapter" },
      };
    },
  };
}
