/**
 * 큐레이터 볼트 스냅샷 + 디리스킹 신호 탐지.
 *
 * Morpho MetaMorpho 볼트의 마켓 할당을 시계열로 저장하고, 직전 스냅샷과 비교해
 * 큐레이터의 "디리스킹"을 알림으로:
 *   - withdraw queue 에서 마켓 제거 (인출 큐에서 빠짐 — 해당 마켓 인출 차단/회피 신호)
 *   - 특정 마켓에서 적극적 인출 (supply USD 급감)
 * 둘 다 큐레이터가 그 담보를 위험하다고 본다는 신호.
 *
 * Usage: npm run snapshot:curators
 */
import { GraphQLClient, gql } from "graphql-request";
import process from "node:process";

import { closePool, pool } from "@/db/client";
import { insertAlert } from "@/db/upsert";

const MORPHO_API = "https://blue-api.morpho.org/graphql";
const CHAINS: { id: number; name: string }[] = [
  { id: 1, name: "ethereum" },
  { id: 8453, name: "base" },
  { id: 42161, name: "arbitrum" },
];
const MIN_AUM_USD = 5_000_000;
const DERISK_MIN_USD = 1_000_000; // 이 미만 할당은 노이즈 — 디리스킹 알림 제외
// supply USD 는 시점값이라 정상 리밸런싱과 디리스킹 구분이 모호 → warning 으로만(크리티컬 X).
// 구조적 신호(withdraw queue 제거)가 더 강함. 임계 60%로 둬 잔잔한 변동 제외.
const DROP_WARN = 0.6;

const VAULTS = gql`
  query Vaults($c: Int!, $min: Float!) {
    vaults(first: 100, where: { chainId_in: [$c], totalAssetsUsd_gte: $min }, orderBy: TotalAssetsUsd, orderDirection: Desc) {
      items {
        address name asset { symbol }
        state {
          totalAssetsUsd
          curators { name }
          allocation {
            supplyAssetsUsd withdrawQueueIndex
            market { collateralAsset { symbol } loanAsset { symbol } lltv state { utilization } }
          }
        }
      }
    }
  }
`;

interface AllocRow {
  chain: string;
  vaultAddress: string;
  vaultName: string;
  curator: string;
  marketKey: string;
  collateral: string;
  supplyUsd: number;
  inWithdrawQueue: boolean;
  utilization: number | null;
}

async function main() {
  const snapshotTs = new Date().toISOString();
  const gqlc = new GraphQLClient(MORPHO_API);
  const rows: AllocRow[] = [];

  for (const ch of CHAINS) {
    try {
      const d = await gqlc.request<{ vaults: { items: Array<{ address: string; name: string; asset: { symbol: string } | null; state: { curators: { name: string }[] | null; allocation: Array<{ supplyAssetsUsd: number | null; withdrawQueueIndex: number | null; market: { collateralAsset: { symbol: string } | null; loanAsset: { symbol: string } | null; lltv: string | null; state: { utilization: number | null } | null } | null }> | null } | null }> } }>(
        VAULTS,
        { c: ch.id, min: MIN_AUM_USD },
      );
      for (const v of d.vaults.items) {
        const curator = v.state?.curators?.[0]?.name ?? "Unknown";
        for (const a of v.state?.allocation ?? []) {
          if (!a.market || (a.supplyAssetsUsd ?? 0) <= 0) continue;
          const coll = a.market.collateralAsset?.symbol ?? "—";
          const loan = a.market.loanAsset?.symbol ?? v.asset?.symbol ?? "—";
          const marketKey = `${coll}|${loan}|${a.market.lltv ?? "0"}`;
          rows.push({
            chain: ch.name,
            vaultAddress: v.address,
            vaultName: v.name,
            curator,
            marketKey,
            collateral: coll,
            supplyUsd: a.supplyAssetsUsd ?? 0,
            inWithdrawQueue: (a.withdrawQueueIndex ?? -1) >= 0,
            utilization: a.market.state?.utilization ?? null,
          });
        }
      }
    } catch (e) {
      console.warn(`[curators] ${ch.name} fetch failed:`, (e as Error).message);
    }
  }
  console.log(`[curators] ${rows.length} vault-allocations @ ${snapshotTs}`);

  const client = await pool().connect();
  let derisk = 0;
  try {
    // 직전 스냅샷의 할당 로드 (vault+market 별 최신)
    const prev = await client.query<{
      vault_address: string;
      market_key: string;
      supply_usd: number;
      in_withdraw_queue: boolean;
    }>(
      `SELECT DISTINCT ON (vault_address, market_key) vault_address, market_key, supply_usd, in_withdraw_queue
       FROM vault_allocations ORDER BY vault_address, market_key, snapshot_ts DESC`,
    );
    const prevByKey = new Map(prev.rows.map((r) => [`${r.vault_address}::${r.market_key}`, r]));

    const alerts: Array<{ severity: "warning" | "critical"; token: string; message: string; detail: Record<string, unknown> }> = [];
    for (const r of rows) {
      const p = prevByKey.get(`${r.vaultAddress}::${r.marketKey}`);
      if (!p) continue;
      // 신호 1: withdraw queue 에서 제거
      if (p.in_withdraw_queue && !r.inWithdrawQueue && p.supply_usd >= DERISK_MIN_USD) {
        alerts.push({
          severity: "warning",
          token: r.collateral,
          message: `${r.curator} removed ${r.collateral} market from ${r.vaultName} withdraw queue — de-risking signal`,
          detail: { curator: r.curator, vault: r.vaultName, chain: r.chain, marketKey: r.marketKey, prevSupplyUsd: p.supply_usd },
        });
      }
      // 신호 2: 적극적 인출 (supply 급감)
      if (p.supply_usd >= DERISK_MIN_USD && r.supplyUsd < p.supply_usd) {
        const drop = (p.supply_usd - r.supplyUsd) / p.supply_usd;
        if (drop >= DROP_WARN) {
          alerts.push({
            severity: "warning",
            token: r.collateral,
            message: `${r.curator} withdrew ${(drop * 100).toFixed(0)}% from ${r.collateral} market in ${r.vaultName}: ${fmt(p.supply_usd)} → ${fmt(r.supplyUsd)} — de-risking signal`,
            detail: { curator: r.curator, vault: r.vaultName, chain: r.chain, dropPct: drop, prevSupplyUsd: p.supply_usd, currSupplyUsd: r.supplyUsd },
          });
        }
      }
    }

    // 현재 스냅샷 적재
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `INSERT INTO vault_allocations (snapshot_ts, chain, vault_address, vault_name, curator, market_key, collateral, supply_usd, in_withdraw_queue, utilization)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (snapshot_ts, vault_address, market_key) DO NOTHING`,
        [snapshotTs, r.chain, r.vaultAddress, r.vaultName, r.curator, r.marketKey, r.collateral, r.supplyUsd, r.inWithdrawQueue, r.utilization],
      );
    }
    await client.query("COMMIT");

    for (const a of alerts) {
      await insertAlert({
        severity: a.severity,
        kind: "curator_derisk",
        token: a.token,
        message: a.message,
        detail: a.detail,
        snapshotTs,
      });
      derisk++;
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  console.log(`[curators] ${rows.length} allocations stored, ${derisk} de-risking alerts`);
  await closePool();
}

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
