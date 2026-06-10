import { type Address, encodeFunctionData, formatUnits } from "viem";

import { batch } from "@/lib/multicall";
import { rpc } from "@/lib/rpc";
import {
  DEFAULT_META,
  type EdgeAttrs,
  type EdgeRole,
  makeClassification,
} from "@/types/edge-schema";

import { oracleTypeForCollateral } from "@/config/alert-thresholds";
import type { AdapterContext, ProtocolAdapter } from "./types";

/**
 * Fluid 전용 어댑터 — balanceOf-only 였던 것을 실제 risk param 으로 교체.
 *
 * Fluid 구조: 모든 유동성이 단일 "Liquidity Layer"(0x52Aa…) 를 통과한다
 * (lending 공급 + vault 담보 모두). LiquidityResolver.getOverallTokenData(token)
 * 가 토큰별 총공급/총차입/이용률/exchange price 를 노출.
 *
 * 검증(verify-fluid.ts, on-chain): WBTC 재조정오차 0.45%, 이용률은 프로토콜
 * 자체 lastStoredUtilization 과 일치(WBTC 27.7% / wstETH 33.1% / USDC 91.0%).
 *
 * 반환 struct OverallTokenData 의 끝 필드가 중첩 struct(rateData) 라서
 * viem 전체 디코드는 하위 struct(RateDataV1/V2Params) ABI 가 필요 → 대신
 * 선행 16개 uint256 만 raw eth_call 결과에서 직접 슬라이스(전부 정적이라 안전).
 *
 *   [3]  lastStoredUtilization   (1e4 = 100%)
 *   [6]  supplyExchangePrice     (1e12 precision)
 *   [12] totalSupply (raw)       → actual = raw * exchPrice / 1e12
 *   [15] maxUtilization          (1e4 = 100%)
 *
 * NOTE: LTV/LT 는 Fluid vault 별로 다름(liquidity layer 차원엔 없음) → null 유지(정직).
 *       per-vault 집계는 VaultResolver(0xA5C3…) 필요 — 후속 작업.
 */

const LIQUIDITY_RESOLVER = "0xca13A15de31235A37134B4717021C35A3CF25C60" as Address;
const LIQUIDITY_LAYER = "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497" as Address;
const EXCH_PRECISION = 1_000_000_000_000n; // Fluid EXCHANGE_PRICES_PRECISION = 1e12
const UTIL_PRECISION = 10_000; // Fluid: 1e4 = 100%

const RESOLVER_ABI = [
  {
    inputs: [{ name: "token_", type: "address" }],
    name: "getOverallTokenData",
    outputs: [], // 수동 디코드 (중첩 struct 생략)
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_ABI = [
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

/** raw eth_call 결과 hex 에서 i 번째 32바이트 워드(uint256) 추출. */
function word(hex: string, i: number): bigint {
  const s = 2 + i * 64;
  return BigInt("0x" + hex.slice(s, s + 64));
}

export const fluidAdapter: ProtocolAdapter = {
  family: "fluid",
  protocolNodeId: "protocol:fluid",

  describeNode() {
    return {
      nodeId: "protocol:fluid",
      type: "DefiProtocol",
      label: "Fluid",
      address: LIQUIDITY_LAYER,
      metadata: {
        family: "fluid",
        architecture: "multi_asset_liquidity_layer",
        coreContract: LIQUIDITY_LAYER,
        governance: "Instadapp",
      },
    };
  },

  async fetchEdge(token: Address, ctx: AdapterContext): Promise<EdgeAttrs | null> {
    // decimals + 유동성레이어 실보유량(정확한 available) 배치
    const [dec, balRaw] = (await batch([
      { address: token, abi: ERC20_ABI, functionName: "decimals" },
      { address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [LIQUIDITY_LAYER] },
    ])) as [number | null, bigint | null];
    const decimals = dec ?? 18;

    // LiquidityResolver.getOverallTokenData(token) — 중첩 struct 때문에 raw 디코드
    let res: string;
    try {
      const data = encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: "getOverallTokenData",
        args: [token],
      });
      res = (await rpc().request({
        method: "eth_call",
        params: [{ to: LIQUIDITY_RESOLVER, data }, "latest"],
      })) as string;
    } catch {
      return null; // resolver revert → 미상장 토큰, 스킵
    }
    if (!res || res.length < 2 + 16 * 64) return null;

    const lastStoredUtilization = word(res, 3);
    const supplyExchangePrice = word(res, 6);
    const totalSupplyRaw = word(res, 12);
    const maxUtilizationRaw = word(res, 15);

    // 실제 총공급(= Fluid 에 예치된 해당 토큰 총량, suppliers 의 청구권)
    const totalSupplyActual = (totalSupplyRaw * supplyExchangePrice) / EXCH_PRECISION;
    const amountToken = Number(formatUnits(totalSupplyActual, decimals));
    if (amountToken === 0) return null; // Fluid 에 없음

    // available = 컨트랙트 실보유량(정확). 인출/차입 가능 유동성.
    const availableToken = Number(formatUnits(balRaw ?? BigInt(0), decimals));
    const utilization = Number(lastStoredUtilization) / UTIL_PRECISION; // 0-1 fraction
    void maxUtilizationRaw; // 스키마에 필드 없음 — 현재 미사용(후속 확장 시 추가)

    const role: EdgeRole = {
      edge_type: "deposit_supply",
      amount_token: amountToken,
      amount_usd: amountToken * ctx.tokenPriceUsd,
      pct_of_supply: ctx.tokenTotalSupply > 0 ? amountToken / ctx.tokenTotalSupply : null,
      pct_of_protocol_tvl: null,
    };
    const classification = makeClassification(role, "market", "lending");

    return {
      classification,
      edgeType: "deposit_supply",
      venueType: "market",
      protocolClass: "lending",
      core: {
        amountToken,
        amountUsd: amountToken * ctx.tokenPriceUsd,
        pctOfSupply: ctx.tokenTotalSupply > 0 ? amountToken / ctx.tokenTotalSupply : null,
        pctOfProtocolTvl: null,
      },
      oracle: {
        type: oracleTypeForCollateral(ctx.tokenSymbol),
        provider: "Fluid per-vault (liquidity layer aggregate)",
        address: null,
        depegSensitive: true,
      },
      lendingRisk: {
        ltv: null, // per-vault — liquidity layer 차원엔 없음 (VaultResolver 필요)
        lt: null,
        liquidationBonus: null,
        supplyCap: null,
        borrowCap: null,
        reserveFactor: null,
        utilization,
        liquidityUsd: availableToken * ctx.tokenPriceUsd,
        isFrozen: false,
        eModeCategory: null,
        irm: null,
      },
      dex: null,
      wrapper: null,
      topMarkets: null,
      topPools: null,
      meta: {
        ...DEFAULT_META,
        snapshotTs: ctx.snapshotTs,
        snapshotBlock: ctx.blockNumber,
        confidence: "HIGH",
        dataSource: "Fluid LiquidityResolver.getOverallTokenData (on-chain)",
      },
    };
  },
};
