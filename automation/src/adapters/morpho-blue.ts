import type { Address } from "viem";

import {
  fetchMarketsByCollateral,
  fetchMarketsByLoan,
  fetchVaultsByCollateralExposure,
  type MorphoMarket,
  type MorphoVault,
} from "@/lib/morpho-api";
import {
  DEFAULT_META,
  type EdgeAttrs,
  type EdgeRole,
  type FundingVault,
  type MarketEntry,
  type OracleInfo,
  makeMultiClassification,
  sumRolesToCore,
} from "@/types/edge-schema";

import { oracleTypeForCollateral } from "@/config/alert-thresholds";
import { introspectOracle } from "@/oracle/introspect";
import type { AdapterContext, ProtocolAdapter } from "./types";

const MORPHO_BLUE: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

/**
 * Morpho Blue adapter — collateral-side isolated markets.
 *
 * Important: vault funding info is fetched separately via Morpho GraphQL and
 * INLINED into each MarketEntry.fundingVaults (bipartite invariant).
 */
export const morphoBlueAdapter: ProtocolAdapter = {
  family: "morpho_blue",
  protocolNodeId: "protocol:morpho_blue",

  describeNode() {
    return {
      nodeId: "protocol:morpho_blue",
      type: "DefiProtocol",
      label: "Morpho Blue",
      address: MORPHO_BLUE,
      metadata: {
        family: "morpho_blue",
        architecture: "isolated_markets",
        coreContract: MORPHO_BLUE,
        governance: "immutable (governance-less)",
      },
    };
  },

  async fetchEdge(token: Address, ctx: AdapterContext): Promise<EdgeAttrs | null> {
    const [collMarkets, loanMarkets, vaults] = await Promise.all([
      fetchMarketsByCollateral(token).catch(() => [] as MorphoMarket[]),
      fetchMarketsByLoan(token).catch(() => [] as MorphoMarket[]),
      fetchVaultsByCollateralExposure(token).catch(() => [] as MorphoVault[]),
    ]);

    if (collMarkets.length === 0 && loanMarkets.length === 0) return null;

    // ── Build MarketEntry[] with inline funding vaults ────────────
    const topMarkets: MarketEntry[] = collMarkets.map((m) => {
      const fundingVaults = buildFundingVaults(m.uniqueKey, vaults);
      const lltvFloat = Number(m.lltv) / 1e18;
      const sizeUsd = m.state.supplyAssetsUsd ?? 0;

      // 동일패밀리 재담보(ouroboros) = "같은 계열이면 레버리지 가능"이라는 약한 추정 휴리스틱이라 제외(항상 false).
      const ouroboros = false;

      const totalFundedUsd = fundingVaults.reduce((s, v) => s + v.allocationUsd, 0);
      const shareOfSupply = sizeUsd > 0 ? totalFundedUsd / sizeUsd : null;

      return {
        loanAsset: m.loanAsset.symbol,
        collateralAsset: m.collateralAsset?.symbol,
        lltv: lltvFloat,
        marketSizeUsd: sizeUsd,
        oracleAddress: m.oracleAddress ?? undefined,
        irmAddress: m.irmAddress ?? undefined,
        utilization: m.state.utilization ?? undefined,
        ouroborosRisk: ouroboros,
        // 부실채권 임계용 aggLTV 재료 (담보 예치 USD / 차입 USD)
        collateralUsd: m.state.collateralAssetsUsd ?? null,
        borrowUsd: m.state.borrowAssetsUsd ?? null,
        vaultFunded: fundingVaults.length > 0,
        fundingVaults: fundingVaults.length > 0 ? fundingVaults : null,
        vaultFundedShareOfSupply: shareOfSupply,
      };
    });

    // 마켓별 오라클 introspection — Morpho 는 마켓마다 다른 오라클 주소를 넣을 수 있으므로 각 마켓을 개별 검증.
    //   introspectOracle 은 주소 캐시 → 같은 오라클 공유 마켓은 1회만 호출. 비용 가드로 서로 다른 주소 최대
    //   ORACLE_CAP 개까지만 신규 introspect(나머지는 주소만 보존). 결과는 각 MarketEntry.oracle 에 per-market 로 저장.
    const ORACLE_CAP = 16;
    const oracleByAddr = new Map<string, OracleInfo>();
    let introspectAttempts = 0;
    for (const m of [...topMarkets].sort((a, b) => b.marketSizeUsd - a.marketSizeUsd)) {
      if (!m.oracleAddress) continue;
      const key = m.oracleAddress.toLowerCase();
      let info = oracleByAddr.get(key);
      if (!info) {
        const fb = m.collateralAsset ?? ctx.tokenSymbol;
        let oi = null;
        if (introspectAttempts < ORACLE_CAP) {
          oi = await introspectOracle(m.oracleAddress as Address, ctx.chainId ?? 1, fb, token);
          introspectAttempts++;
        }
        info = {
          type: oi?.type ?? oracleTypeForCollateral(fb),
          provider: oi?.verified ? oi.provider : "Morpho per-market",
          address: m.oracleAddress,
          depegSensitive: oi?.depegSensitive ?? true,
          description: oi?.description ?? null,
          verified: oi?.verified ?? false,
        };
        oracleByAddr.set(key, info);
      }
      m.oracle = info;
    }
    // 엣지 헤드라인 오라클 = 최대 마켓의 오라클(대표). per-market 값은 topMarkets[].oracle 에 보존.
    const repOracle = [...topMarkets].filter((m) => m.oracle).sort((a, b) => b.marketSizeUsd - a.marketSizeUsd)[0]?.oracle ?? null;

    // ── 집계 risk 값 — 마켓별 데이터에서 가중평균/합산 유도 ──────────
    //    (Morpho 는 per-market 라 단일 값이 없지만, 큐레이터가 한눈에 보게 유도)
    let wLltvNum = 0, wLltvDen = 0;   // 담보 가중 평균 LLTV(=청산임계)
    let wUtilNum = 0, wUtilDen = 0;   // supply 가중 평균 가동률
    let availLiqUsd = 0;              // 마켓별 가용 유동성 합
    for (const m of collMarkets) {
      const cUsd = m.state.collateralAssetsUsd ?? 0;
      const sUsd = m.state.supplyAssetsUsd ?? 0;
      const lltvF = Number(m.lltv) / 1e18;
      const util = m.state.utilization ?? 0;
      if (cUsd > 0) { wLltvNum += lltvF * cUsd; wLltvDen += cUsd; }
      if (sUsd > 0) { wUtilNum += util * sUsd; wUtilDen += sUsd; availLiqUsd += sUsd * (1 - util); }
    }
    const aggLltv = wLltvDen > 0 ? wLltvNum / wLltvDen : null;
    const aggUtil = wUtilDen > 0 ? wUtilNum / wUtilDen : null;

    // ── Aggregate collateral side amount ───────────────────────────
    // collateralAssetsUsd = 실제 담보(WBTC 등) 예치 USD. supplyAssetsUsd(=loan 공급액) 아님!
    const collateralUsd = collMarkets.reduce((s, m) => s + (m.state.collateralAssetsUsd ?? 0), 0);
    const collateralToken = ctx.tokenPriceUsd > 0 ? collateralUsd / ctx.tokenPriceUsd : 0;

    // ── Aggregate loan side amount (token used as loan asset in another market) ──
    const loanUsd = loanMarkets.reduce((s, m) => s + (m.state.borrowAssetsUsd ?? 0), 0);
    const loanToken = ctx.tokenPriceUsd > 0 ? loanUsd / ctx.tokenPriceUsd : 0;

    // ── Build multi-role classification ───────────────────────────
    const roles: EdgeRole[] = [];
    if (collateralToken > 0) {
      roles.push({
        edge_type: "collateral_isolated",
        amount_token: collateralToken,
        amount_usd: collateralUsd,
        pct_of_supply: ctx.tokenTotalSupply > 0 ? collateralToken / ctx.tokenTotalSupply : null,
      });
    }
    if (loanToken > 0) {
      roles.push({
        edge_type: "loan_asset",
        amount_token: loanToken,
        amount_usd: loanUsd,
        pct_of_supply: ctx.tokenTotalSupply > 0 ? loanToken / ctx.tokenTotalSupply : null,
      });
    }
    if (roles.length === 0) return null;

    const classification = makeMultiClassification(roles, "isolated_market", "lending");
    const core = sumRolesToCore(roles);

    return {
      classification,
      edgeType: classification.primary_role,
      venueType: "isolated_market",
      protocolClass: "lending",
      core,
      oracle: repOracle ?? {
        type: oracleTypeForCollateral(ctx.tokenSymbol),
        provider: "per-market Chainlink composite (varies)",
        address: null,
        depegSensitive: true,
        description: null,
        verified: false,
      },
      lendingRisk: {
        ltv: null, // Morpho 엔 별도 LTV 없음(LLTV=청산임계)
        lt: aggLltv, // 담보 가중평균 LLTV (per-market 값은 topMarkets 참조)
        // 라이브 파생 — Morpho LIF = min(1.15, 1/(1−0.3·(1−LLTV))), bonus = LIF−1.
        // (하드코딩 0.0438 제거: 그건 LLTV≈0.86 한 케이스 값이었음. 이제 aggLLTV 따라 변동.)
        liquidationBonus: aggLltv != null ? Math.min(1.15, 1 / (1 - 0.3 * (1 - aggLltv))) - 1 : null,
        supplyCap: null, // Morpho 불변 마켓 — cap 없음(정상)
        borrowCap: null,
        reserveFactor: null, // Morpho 엔 reserve factor 없음(정상)
        utilization: aggUtil, // supply 가중평균 가동률
        liquidityUsd: availLiqUsd > 0 ? availLiqUsd : null, // 마켓별 가용 유동성 합
        isFrozen: false, // Morpho Blue 마켓은 불변(동결 불가)
        eModeCategory: null, // Morpho 엔 e-mode 없음(정상)
        irm: null, // per-market — topMarkets 의 irmAddress 참조
      },
      dex: null,
      wrapper: null,
      topMarkets,
      topPools: null,
      meta: {
        ...DEFAULT_META,
        snapshotTs: ctx.snapshotTs,
        snapshotBlock: ctx.blockNumber,
        confidence: "HIGH",
        dataSource: "Morpho GraphQL API",
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function buildFundingVaults(
  marketUniqueKey: string,
  vaults: MorphoVault[],
): FundingVault[] {
  const out: FundingVault[] = [];
  for (const v of vaults) {
    const allocation = v.state.allocation?.find((a) => a.market.uniqueKey === marketUniqueKey);
    if (!allocation || !allocation.supplyAssetsUsd || allocation.supplyAssetsUsd <= 0) continue;
    out.push({
      vaultName: v.name,
      vaultAddress: v.address,
      // Morpho API 의 state.curator 는 주소(보통 0x0). 볼트 이름이 큐레이터 브랜드를
      // 담음(예: "Steakhouse Ethena USDtb") → 이름의 첫 토큰을 큐레이터 라벨로.
      curator: v.name?.split(/\s+/)[0] ?? "unknown",
      depositAsset: v.asset.symbol,
      allocationUsd: allocation.supplyAssetsUsd,
    });
  }
  // sort desc by allocation
  return out.sort((a, b) => b.allocationUsd - a.allocationUsd);
}

// (isOuroborosPair / 자산 패밀리 Set 제거 — 동일패밀리 재담보 신호 전면 제외)
