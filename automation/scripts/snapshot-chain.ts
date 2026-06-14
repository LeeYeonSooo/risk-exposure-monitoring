/**
 * 멀티체인 스냅샷 (Morpho GraphQL 기반) — Base / Arbitrum 등 비-메인넷 체인.
 *
 * 왜 Morpho API: chainId 만 바꾸면 멀티체인이고 마켓별 LLTV·오라클·IRM·공급/차입을
 * 전부 줌 → 체인별 RPC/컨트랙트주소 없이 견고하게 토큰↔프로토콜 그래프를 만든다.
 * (메인넷은 기존 온체인 어댑터 파이프라인 그대로, 이건 새 체인용 보강.)
 *
 * 노드 ID 는 체인 스코프: token:SYMBOL@base, protocol:morpho_blue@base
 * → 같은 심볼이 여러 체인에 있어도 충돌 없음 + 프론트에서 chain 별 "섬"으로 묶음.
 *
 * Usage: npm run snapshot:chain -- base    (또는 arbitrum)
 */
import { GraphQLClient, gql } from "graphql-request";
import { type Address, getAddress } from "viem";
import process from "node:process";

import { makeAaveV3FamilyAdapter } from "@/adapters/aave-v3-family";
import { introspectOracle } from "@/oracle/introspect";
import type { OracleInfo } from "@/types/edge-schema";
import { closePool, pool } from "@/db/client";
import { recordSnapshotRun } from "@/db/upsert";
import { selectByCoverage } from "@/discovery/coverage";
import { fetchLlamaPoolsForChain, fetchProtocolCategories, poolContainsToken } from "@/lib/defillama";
import { getTokenPricesUsd } from "@/lib/prices";
import { rpcFor } from "@/lib/rpc";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

// Aave reserve self-discovery — pap→DataProvider→전 reserve 목록. Morpho 없는 체인도 커버.
const PAP_DP_ABI = [{ inputs: [], name: "getPoolDataProvider", outputs: [{ type: "address" }], stateMutability: "view", type: "function" }] as const;
const DP_RESERVES_ABI = [{ inputs: [], name: "getAllReservesTokens", outputs: [{ components: [{ name: "symbol", type: "string" }, { name: "tokenAddress", type: "address" }], name: "", type: "tuple[]" }], stateMutability: "view", type: "function" }] as const;

// pap = Aave V3 PoolAddressesProvider (getPoolDataProvider() 온체인 검증됨). 없으면 Morpho 만.
// 2026-06-12 스코프 축소: base·arbitrum 만 (이더리움은 snapshot-all 온체인 어댑터 담당).
// 다른 EVM 체인은 3체인 완성 후 여기 + config/chains.ts EVM_CHAINS 에 추가하면 된다.
const CHAINS: Record<string, { chainId: number; label: string; llama: string; pap?: string }> = {
  base: { chainId: 8453, label: "Base", llama: "Base", pap: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D" },
  arbitrum: { chainId: 42161, label: "Arbitrum", llama: "Arbitrum", pap: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb" },
};

const BREADTH_MIN_USD = 1_000_000;
function classOfCategory(cat: string): string {
  const c = cat.toLowerCase();
  if (c.includes("lending")) return "lending";
  if (c.includes("cdp")) return "cdp";
  if (c.includes("dex")) return "dex";
  if (c.includes("yield") || c.includes("farm") || c.includes("basis")) return "yield";
  return "other";
}

// L2 는 절대 규모가 메인넷보다 작아 $1M 하한이면 원이 비어 보임(Base 19개).
// $250K 로 낮춰 의미있는 포지션을 더 채움(Base 27 / ETH 비교 시 91). 먼지(<$250K)는 계속 제외.
const MIN_USD = 250_000;
// 체인 원(circle)은 의미있는 토큰을 다 보여주는 게 목표 → 누적 커버리지 컷 대신
// "≥하한 전부"(coverage 1.0 = topN 까지 다 포함). 한두 토큰이 TVL을 독식해도 원이 채워짐.
const COVERAGE = 1.0;
const TOP_N = 80;

const MARKETS = gql`
  query Markets($chainId: Int!, $first: Int!, $skip: Int!) {
    markets(first: $first, skip: $skip, where: { chainId_in: [$chainId] }, orderBy: SupplyAssetsUsd, orderDirection: Desc) {
      items {
        lltv
        oracleAddress
        irmAddress
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
        state { supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd utilization }
      }
      pageInfo { countTotal }
    }
  }
`;

interface Market {
  lltv: string | null;
  oracleAddress: string | null;
  irmAddress: string | null;
  loanAsset: { address: string; symbol: string; decimals: number } | null;
  collateralAsset: { address: string; symbol: string; decimals: number } | null;
  state: {
    supplyAssetsUsd: number | null;
    borrowAssetsUsd: number | null;
    collateralAssetsUsd: number | null;
    utilization: number | null;
  };
}

interface TokenAgg {
  address: string;
  symbol: string;
  decimals: number;
  collateralUsd: number; // 담보로 쓰인 USD
  supplyUsd: number; // loan asset 공급 USD
  borrowUsd: number;
  lltvWSum: number; // collateralUsd 가중 LLTV 합
  lltvW: number;
  utilWSum: number; // supplyUsd 가중 utilization 합
  utilW: number;
  oracle: string | null; // 최대 담보 마켓의 오라클
  oracleUsd: number;
  irm: string | null;
  markets: Market[]; // 이 토큰이 담보로 쓰인 마켓들(마켓별 오라클 topMarkets 빌드용)
}

async function main() {
  const chainArg = process.argv[2];
  const chain = chainArg && CHAINS[chainArg];
  if (!chain) {
    console.error(`Usage: npm run snapshot:chain -- <${Object.keys(CHAINS).join("|")}>`);
    process.exit(1);
  }
  const { chainId, label } = chain;
  const snapshotTs = new Date().toISOString();
  console.log(`[snapshot:chain] ${chainArg} (chainId=${chainId}) @ ${snapshotTs}`);

  const gqlc = new GraphQLClient(MORPHO_API);
  // 전체 마켓 페이지네이션 — Base 는 마켓이 4천+개라 first:1000 한 번이면 잘림(silent truncation).
  // supply 낮지만 담보 큰 마켓이 누락되면 토큰 집계가 과소계상되므로 끝까지 긁는다.
  const PAGE = 1000;
  const markets: Market[] = [];
  let countTotal = Infinity;
  // Morpho 미배포 체인(avax/bsc/gnosis/scroll/metis)은 query 가 throw → empty 로 흡수하고 Aave 경로로 진행.
  try {
    for (let skip = 0; skip < countTotal && skip < 20_000; skip += PAGE) {
      const data = await gqlc.request<{ markets: { items: Market[]; pageInfo: { countTotal: number } } }>(
        MARKETS,
        { chainId, first: PAGE, skip },
      );
      markets.push(...data.markets.items);
      countTotal = data.markets.pageInfo?.countTotal ?? markets.length;
      if (data.markets.items.length < PAGE) break;
    }
  } catch (e) {
    console.warn(`[snapshot:chain] Morpho 미지원/실패 (chainId=${chainId}): ${(e as Error).message.slice(0, 80)} — Aave 경로로 진행`);
  }
  console.log(`[snapshot:chain] ${markets.length} Morpho markets (countTotal=${countTotal === Infinity ? 0 : countTotal})`);

  // 토큰별 집계
  const agg = new Map<string, TokenAgg>();
  const get = (a: { address: string; symbol: string; decimals: number }): TokenAgg => {
    const k = a.address.toLowerCase();
    let t = agg.get(k);
    if (!t) {
      t = { address: k, symbol: a.symbol, decimals: a.decimals, collateralUsd: 0, supplyUsd: 0, borrowUsd: 0, lltvWSum: 0, lltvW: 0, utilWSum: 0, utilW: 0, oracle: null, oracleUsd: 0, irm: null, markets: [] };
      agg.set(k, t);
    }
    return t;
  };

  for (const m of markets) {
    const cUsd = m.state.collateralAssetsUsd ?? 0;
    const sUsd = m.state.supplyAssetsUsd ?? 0;
    const bUsd = m.state.borrowAssetsUsd ?? 0;
    const lltv = m.lltv ? Number(m.lltv) / 1e18 : 0; // LLTV wad → fraction
    if (m.collateralAsset && cUsd > 0) {
      const t = get(m.collateralAsset);
      t.collateralUsd += cUsd;
      t.markets.push(m); // 마켓별 오라클 빌드용 보존
      if (lltv > 0) { t.lltvWSum += lltv * cUsd; t.lltvW += cUsd; }
      if (cUsd > t.oracleUsd) { t.oracle = m.oracleAddress; t.oracleUsd = cUsd; t.irm = m.irmAddress; }
    }
    if (m.loanAsset && sUsd > 0) {
      const t = get(m.loanAsset);
      t.supplyUsd += sUsd;
      t.borrowUsd += bUsd;
      const u = m.state.utilization ?? 0;
      if (u > 0) { t.utilWSum += u * sUsd; t.utilW += sUsd; }
    }
  }

  // 커버리지/하한 필터 — 토큰 총 규모(담보+공급) 기준
  const candidates = [...agg.values()].map((t) => ({
    address: t.address,
    symbol: t.symbol,
    decimals: t.decimals,
    collateralUsd: t.collateralUsd + t.supplyUsd, // selectByCoverage 가 이 키로 정렬/누적
    source: "morpho_collateral" as const,
    _agg: t,
  }));
  const selected = selectByCoverage(candidates, { coverageTarget: COVERAGE, minUsd: MIN_USD, topN: TOP_N, label: `chain:${chainArg}` });
  console.log(`[snapshot:chain] ${selected.length}/${agg.size} tokens pass coverage/min-USD`);

  const protoId = `protocol:morpho_blue@${chainArg}`;
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    // 프로토콜 노드 (체인 스코프) — Morpho 마켓이 있는 체인만(Aave-only 체인 orphan 노드 방지)
    if (markets.length > 0) {
      await client.query(
        `INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
         VALUES ($1,'DefiProtocol',$2,$3,$4,$5::jsonb, now())
         ON CONFLICT (node_id) DO UPDATE SET label=EXCLUDED.label, metadata=EXCLUDED.metadata, updated_at=now()`,
        [protoId, `Morpho Blue (${label})`, null, chainArg, JSON.stringify({ family: "morpho_blue", architecture: "isolated_markets", governance: "Morpho", chain: chainArg })],
      );
    }

    for (const c of selected) {
      const t = (c as typeof candidates[number])._agg;
      const tokenId = `token:${t.symbol}@${chainArg}`;
      const sizeUsd = t.collateralUsd + t.supplyUsd;

      // 토큰 노드
      await client.query(
        `INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
         VALUES ($1,'Token',$2,$3,$4,$5::jsonb, now())
         ON CONFLICT (node_id) DO UPDATE SET label=EXCLUDED.label, address=EXCLUDED.address, metadata=EXCLUDED.metadata, updated_at=now()`,
        [tokenId, t.symbol, t.address, chainArg, JSON.stringify({ symbol: t.symbol, decimals: t.decimals, chain: chainArg, sizeUsd })],
      );

      // 역할(roles) 구성
      const roles: Array<{ edge_type: string; amount_usd: number; amount_token: number | null; pct_of_supply: number | null }> = [];
      if (t.collateralUsd > 0) roles.push({ edge_type: "collateral", amount_usd: t.collateralUsd, amount_token: null, pct_of_supply: null });
      if (t.supplyUsd > 0) roles.push({ edge_type: "loan_asset", amount_usd: t.supplyUsd, amount_token: null, pct_of_supply: null });
      const primary = t.collateralUsd >= t.supplyUsd ? "collateral" : "loan_asset";
      const coreUsd = Math.max(t.collateralUsd, t.supplyUsd);

      // ── 마켓별 오라클 — Morpho 는 마켓마다 다른 오라클 주소를 넣을 수 있으므로 각 마켓을 개별 introspect.
      //    (메인넷 morpho-blue 와 동일 로직, chainId 라우팅). introspectOracle 은 주소 캐시 → 공유 오라클은 1회만.
      //    비용가드: 토큰당 상위 MKT_CAP 마켓만 topMarkets 로 노출, 서로 다른 오라클 주소 최대 ORACLE_CAP 개만 신규 introspect.
      const MKT_CAP = 12;
      const ORACLE_CAP = 12;
      const oracleByAddr = new Map<string, OracleInfo>();
      let introspectAttempts = 0;
      const tokenMarkets = [...t.markets]
        .sort((a, b) => (b.state.supplyAssetsUsd ?? 0) - (a.state.supplyAssetsUsd ?? 0))
        .slice(0, MKT_CAP);
      const topMarkets: Record<string, unknown>[] = [];
      for (const m of tokenMarkets) {
        let mOracle: OracleInfo | null = null;
        if (m.oracleAddress) {
          const key = m.oracleAddress.toLowerCase();
          mOracle = oracleByAddr.get(key) ?? null;
          if (!mOracle) {
            const fb = m.collateralAsset?.symbol ?? t.symbol;
            let oi = null;
            if (introspectAttempts < ORACLE_CAP) { oi = await introspectOracle(getAddress(m.oracleAddress), chainId, fb, t.address); introspectAttempts++; }
            mOracle = {
              type: oi?.type ?? "MARKET",
              provider: oi?.verified ? oi.provider : "Morpho per-market",
              address: m.oracleAddress,
              depegSensitive: oi?.depegSensitive ?? true,
              description: oi?.description ?? null,
              verified: oi?.verified ?? false,
            };
            oracleByAddr.set(key, mOracle);
          }
        }
        topMarkets.push({
          loanAsset: m.loanAsset?.symbol,
          collateralAsset: m.collateralAsset?.symbol,
          lltv: m.lltv ? Number(m.lltv) / 1e18 : 0,
          marketSizeUsd: m.state.supplyAssetsUsd ?? 0,
          oracleAddress: m.oracleAddress ?? undefined,
          oracle: mOracle ?? undefined,
          irmAddress: m.irmAddress ?? undefined,
          ouroborosRisk: false,
          utilization: m.state.utilization ?? undefined,
          collateralUsd: m.state.collateralAssetsUsd ?? null,
          borrowUsd: m.state.borrowAssetsUsd ?? null,
          vaultFunded: false,      // L2 멀티체인은 큐레이터 볼트 미수집(메인넷만) — 오라클이 목적
          fundingVaults: null,
          vaultFundedShareOfSupply: null,
        });
      }
      // 엣지 헤드라인 오라클 = 최대 마켓의 오라클(대표). per-market 값은 topMarkets[].oracle 에 보존.
      const repOracle = (topMarkets.filter((m) => m.oracle).sort((a, b) => (b.marketSizeUsd as number) - (a.marketSizeUsd as number))[0]?.oracle as OracleInfo | undefined) ?? null;

      const attrs = {
        classification: { roles, primary_role: primary, venue_type: "market", protocol_class: "lending" },
        core: { amountUsd: coreUsd, amountToken: null, pctOfSupply: null, pctOfProtocolTvl: null },
        edgeType: primary,
        venueType: "market",
        protocolClass: "lending",
        lendingRisk: {
          lt: t.lltvW > 0 ? t.lltvWSum / t.lltvW : null,
          ltv: null,
          liquidationBonus: null,
          supplyCap: null,
          borrowCap: null,
          reserveFactor: null,
          utilization: t.utilW > 0 ? t.utilWSum / t.utilW : null,
          liquidityUsd: Math.max(0, t.supplyUsd - t.borrowUsd),
          isFrozen: false,
          eModeCategory: null,
          irm: t.irm ? { address: t.irm, kink: null, family: null, baseRate: null } : null,
        },
        oracle: repOracle ?? {
          type: "MARKET",
          provider: "Morpho per-market",
          address: t.oracle,
          depegSensitive: true,
          description: null,
          verified: false,
        },
        dex: null,
        wrapper: null,
        topMarkets: topMarkets.length ? topMarkets : null,
        topPools: null,
        meta: { confidence: "HIGH", dataSource: `Morpho GraphQL API (chainId ${chainId})`, snapshotTs, snapshotBlock: null, verifiableOnchain: true },
      };

      await client.query(
        `INSERT INTO edges (snapshot_ts, token_node_id, protocol_node_id, edge_type, weight, attrs, block_number)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT (snapshot_ts, token_node_id, protocol_node_id) DO UPDATE SET
           edge_type=EXCLUDED.edge_type, weight=EXCLUDED.weight, attrs=EXCLUDED.attrs`,
        [snapshotTs, tokenId, protoId, primary, coreUsd, JSON.stringify(attrs), null],
      );
    }
    // ── breadth: DeFiLlama 풀로 Morpho 외 프로토콜 추가 (체인 원 풍부하게, 점선 표시) ──
    let breadthEdges = 0;
    try {
      const [pools, cats] = await Promise.all([
        fetchLlamaPoolsForChain(chain.llama),
        fetchProtocolCategories(),
      ]);
      const upserted = new Set<string>([protoId]);
      for (const c of selected) {
        const t = (c as typeof candidates[number])._agg;
        const tokenId = `token:${t.symbol}@${chainArg}`;
        const byProject = new Map<string, number>();
        for (const p of pools) {
          if (!poolContainsToken(p.symbol, t.symbol)) continue;
          if (/morpho/i.test(p.project)) continue; // Morpho 는 이미 정밀 노드
          byProject.set(p.project, (byProject.get(p.project) ?? 0) + (p.tvlUsd ?? 0));
        }
        const top = [...byProject.entries()].filter(([, v]) => v >= BREADTH_MIN_USD).sort((a, b) => b[1] - a[1]).slice(0, 8);
        for (const [project, tvl] of top) {
          const pid = `protocol:dl:${project}@${chainArg}`;
          const cls = classOfCategory(cats.get(project) ?? "DeFi");
          if (!upserted.has(pid)) {
            await client.query(
              `INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
               VALUES ($1,'DefiProtocol',$2,$3,$4,$5::jsonb, now())
               ON CONFLICT (node_id) DO UPDATE SET metadata=EXCLUDED.metadata, updated_at=now()`,
              [pid, project, null, chainArg, JSON.stringify({ family: project, category: cats.get(project) ?? "DeFi", chain: chainArg, breadth: true })],
            );
            upserted.add(pid);
          }
          const role = { edge_type: "deposit_supply", amount_usd: tvl, amount_token: null, pct_of_supply: null };
          const attrs = {
            classification: { roles: [role], primary_role: "deposit_supply", venue_type: "market", protocol_class: cls },
            core: { amountUsd: tvl, amountToken: null, pctOfSupply: null, pctOfProtocolTvl: null },
            edgeType: "deposit_supply", venueType: "market", protocolClass: cls,
            lendingRisk: null, oracle: null, dex: null, wrapper: null, topMarkets: null, topPools: null,
            meta: { confidence: "LOW", dataSource: "defillama-yields", snapshotTs, snapshotBlock: null, verifiableOnchain: false },
          };
          await client.query(
            `INSERT INTO edges (snapshot_ts, token_node_id, protocol_node_id, edge_type, weight, attrs, block_number)
             VALUES ($1,$2,$3,'deposit_supply',$4,$5::jsonb,$6)
             ON CONFLICT (snapshot_ts, token_node_id, protocol_node_id) DO UPDATE SET attrs=EXCLUDED.attrs, weight=EXCLUDED.weight`,
            [snapshotTs, tokenId, pid, tvl, JSON.stringify(attrs), null],
          );
          breadthEdges++;
        }
      }
    } catch (e) {
      console.warn(`[snapshot:chain] breadth skip: ${(e as Error).message}`);
    }

    // ── Aave V3 온체인 — pap→DataProvider→getAllReservesTokens 로 전 reserve self-discovery.
    //    Morpho 없는 체인(avax/bsc/gnosis/scroll/metis)도 커버 + Morpho 체인은 Aave reserve 까지 완전히.
    //    토큰 노드는 여기서 보장(ON CONFLICT) — Aave-only 체인은 Morpho 루프서 안 만들어지므로. ──
    let aaveEdges = 0;
    if (chain.pap) {
      try {
        const evm = rpcFor(chainId);
        const dp = (await evm.readContract({ address: getAddress(chain.pap), abi: PAP_DP_ABI, functionName: "getPoolDataProvider" })) as Address;
        const reserves = (await evm.readContract({ address: dp, abi: DP_RESERVES_ABI, functionName: "getAllReservesTokens" })) as readonly { symbol: string; tokenAddress: Address }[];
        const prices = await getTokenPricesUsd(reserves.map((r) => getAddress(r.tokenAddress)), chainArg); // DeFiLlama coins (체인별)
        const aaveId = `protocol:aave_v3@${chainArg}`;
        const aave = makeAaveV3FamilyAdapter({
          family: "aave_v3", nodeId: aaveId, label: `Aave V3 (${label})`,
          poolAddressesProvider: getAddress(chain.pap), pool: getAddress(chain.pap),
          architecture: "pool_v3", governance: "Aave DAO", oracleProvider: "Chainlink",
        });
        const nd = aave.describeNode();
        await client.query(
          `INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
           VALUES ($1,'DefiProtocol',$2,$3,$4,$5::jsonb, now())
           ON CONFLICT (node_id) DO UPDATE SET metadata=EXCLUDED.metadata, updated_at=now()`,
          [aaveId, nd.label, nd.address, chainArg, JSON.stringify({ ...nd.metadata, chain: chainArg })],
        );
        for (const r of reserves) {
          const addr = getAddress(r.tokenAddress);
          let attrs;
          try {
            attrs = await aave.fetchEdge(addr, {
              chainId, tokenPriceUsd: prices.get(addr.toLowerCase()) ?? 1, tokenTotalSupply: 0, tokenSymbol: r.symbol, snapshotTs, blockNumber: null,
            });
          } catch { attrs = null; }
          if (!attrs) continue;
          const tokenId = `token:${r.symbol}@${chainArg}`;
          // 토큰 노드 보장 — Aave-only 체인은 Morpho 루프서 안 만들어짐.
          await client.query(
            `INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
             VALUES ($1,'Token',$2,$3,$4,$5::jsonb, now())
             ON CONFLICT (node_id) DO UPDATE SET address=EXCLUDED.address, updated_at=now()`,
            [tokenId, r.symbol, addr.toLowerCase(), chainArg, JSON.stringify({ symbol: r.symbol, chain: chainArg })],
          );
          await client.query(
            `INSERT INTO edges (snapshot_ts, token_node_id, protocol_node_id, edge_type, weight, attrs, block_number)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
             ON CONFLICT (snapshot_ts, token_node_id, protocol_node_id) DO UPDATE SET attrs=EXCLUDED.attrs, weight=EXCLUDED.weight`,
            [snapshotTs, tokenId, aaveId, attrs.edgeType, attrs.core?.amountUsd ?? 0, JSON.stringify(attrs), null],
          );
          aaveEdges++;
        }
        console.log(`[snapshot:chain] aave reserves=${reserves.length} edges=${aaveEdges}`);
      } catch (e) {
        console.warn(`[snapshot:chain] aave skip: ${(e as Error).message}`);
      }
    }

    await client.query("COMMIT");
    console.log(`[snapshot:chain] ${chainArg}: ${selected.length} tokens, ${breadthEdges} breadth, ${aaveEdges} aave edges`);
    // 감사로그(snapshot_runs) — 이 체인 런 1행. token_address="chain:<name>" 로 스코프 표기.
    await recordSnapshotRun({ startedAt: snapshotTs, status: "ok", tokenAddress: `chain:${chainArg}`, edgesWritten: breadthEdges + aaveEdges, unknownsAdded: 0 }).catch(() => {});
  } catch (e) {
    await client.query("ROLLBACK");
    await recordSnapshotRun({ startedAt: snapshotTs, status: "error", tokenAddress: `chain:${chainArg}`, errorMessage: (e as Error).message }).catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await closePool().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
