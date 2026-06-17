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
import { fmtUsd as fmt } from "@/lib/fmt";

const MORPHO_API = "https://blue-api.morpho.org/graphql";
// Morpho vaults GraphQL 지원 체인 — 라이브 프로브로 확인(2026-06-10). fraxtal·ink·gnosis·avax 는
// "unsupported chainId" 반환이라 제외. unichain 은 현재 ≥$5M 볼트 0이지만 쿼리 지원 → 생기면 자동 포착.
const CHAINS: { id: number; name: string }[] = [
  { id: 1, name: "ethereum" },
  { id: 8453, name: "base" },
  { id: 42161, name: "arbitrum" },
  { id: 10, name: "optimism" },
  { id: 137, name: "polygon" },
  { id: 130, name: "unichain" },
  { id: 480, name: "worldchain" },
  { id: 747474, name: "katana" },
];
const MIN_AUM_USD = 5_000_000;
const DERISK_MIN_USD = 1_000_000; // 이 미만 할당은 노이즈 — 디리스킹 알림 제외
// vault 총 AUM 이 이 비율 이상 빠질 때만 "진짜 디리스킹"으로 인정. 한 마켓에서 빼서 같은 vault 의
// 다른 마켓으로 옮기는 일상 리밸런싱(총액 불변)을 디리스킹으로 오발화하던 R9 FP(5건) 차단.
const VAULT_NET_DROP_MIN = 0.10;
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
            market { uniqueKey: marketId collateralAsset { symbol } loanAsset { symbol } lltv state { utilization } }
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
      const d = await gqlc.request<{ vaults: { items: Array<{ address: string; name: string; asset: { symbol: string } | null; state: { curators: { name: string }[] | null; allocation: Array<{ supplyAssetsUsd: number | null; withdrawQueueIndex: number | null; market: { uniqueKey: string | null; collateralAsset: { symbol: string } | null; loanAsset: { symbol: string } | null; lltv: string | null; state: { utilization: number | null } | null } | null }> | null } | null }> } }>(
        VAULTS,
        { c: ch.id, min: MIN_AUM_USD },
      );
      for (const v of d.vaults.items) {
        const curator = v.state?.curators?.[0]?.name ?? "Unknown";
        for (const a of v.state?.allocation ?? []) {
          if (!a.market || (a.supplyAssetsUsd ?? 0) <= 0) continue;
          const coll = a.market.collateralAsset?.symbol ?? "—";
          const loan = a.market.loanAsset?.symbol ?? v.asset?.symbol ?? "—";
          // FP 검증 2026-06: 충돌 방지 — Morpho marketId(uniqueKey)를 키로 사용. coll|loan|lltv 는 오라클/IRM 만
          // 다른 별개 마켓을 한 키로 합쳐 split 행을 총액과 비교 → 가짜 "완전 회수"(curator_derisk ~17건 오탐).
          // idle 마켓(담보 없음 "—")은 디리스킹 신호가 아니므로 제외(#155 류 FP).
          if (coll === "—") continue;
          const marketKey = a.market.uniqueKey ?? `${coll}|${loan}|${a.market.lltv ?? "0"}`;
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
    // ⚠️ 직전 **단일 스냅샷**만 로드 (현재 스냅샷은 아래 INSERT 전이라 MAX = 직전). 종전 `DISTINCT ON 최신값`은
    //   역사상 모든 마켓의 마지막값 union 이라 — 과거에 있던 마켓이 이번 스냅샷에 없으면 전부 "사라짐"으로 잡혀
    //   prevTot 부풀림 + 신호3 완전회수 폭주(2026-06 적발). 연속 스냅샷 비교로 통일.
    const prev = await client.query<{
      vault_address: string;
      market_key: string;
      supply_usd: number;
      in_withdraw_queue: boolean;
      collateral: string;
      vault_name: string;
      curator: string;
      chain: string;
      snapshot_ts: string;
    }>(
      `SELECT vault_address, market_key, supply_usd, in_withdraw_queue, collateral, vault_name, curator, chain, snapshot_ts
       FROM vault_allocations WHERE snapshot_ts = (SELECT MAX(snapshot_ts) FROM vault_allocations)`,
    );
    const prevByKey = new Map(prev.rows.map((r) => [`${r.vault_address}::${r.market_key}`, r]));
    // stale-prev 가드(2026-06 FP, 28건): 직전 스냅샷이 2h+ 전이면 커버리지갭 → 그 사이 marketId 키 포맷 마이그레이션/
    //   내부 로테이션을 가짜 디리스킹·완전회수로 오발한다. velocity 룰의 staleness 억제와 동일 패턴 — 신호 보류.
    const prevSnapMs = prev.rows[0]?.snapshot_ts ? new Date(prev.rows[0].snapshot_ts as unknown as string).getTime() : null;
    const prevStale = prevSnapMs == null || (Date.now() - prevSnapMs) > 2 * 60 * 60 * 1000;

    // vault 총 AUM(직전 스냅샷 vs 현재) — 마켓별 급감이 리밸런싱인지 진짜 순유출인지 판정.
    const prevTotByVault = new Map<string, number>();
    for (const p of prev.rows) prevTotByVault.set(p.vault_address, (prevTotByVault.get(p.vault_address) ?? 0) + (p.supply_usd ?? 0));
    const currTotByVault = new Map<string, number>();
    for (const r of rows) currTotByVault.set(r.vaultAddress, (currTotByVault.get(r.vaultAddress) ?? 0) + (r.supplyUsd ?? 0));
    const vaultNetDrop = (vault: string): number => {
      const pt = prevTotByVault.get(vault) ?? 0;
      const ct = currTotByVault.get(vault) ?? 0;
      return pt > 0 ? (pt - ct) / pt : 0;
    };
    // partial-read 가드: 한 체인 fetch 실패로 curr 가 직전보다 vault 수가 크게 적으면(불완전 수집) 신호3(완전회수)
    //   전체를 건너뛴다 — 결손을 가짜 완전이탈로 오발하는 폭주 방지.
    const prevVaultCount = new Set(prev.rows.map((p) => p.vault_address)).size;
    const currVaultCount = currTotByVault.size;
    const partialRead = prevVaultCount > 0 && currVaultCount < prevVaultCount * 0.7;

    const alerts: Array<{ severity: "warning" | "critical"; token: string; message: string; detail: Record<string, unknown> }> = [];
    for (const r of rows) {
      const p = prevByKey.get(`${r.vaultAddress}::${r.marketKey}`);
      if (!p) continue;
      const netDrop = vaultNetDrop(r.vaultAddress);
      const realDerisk = netDrop >= VAULT_NET_DROP_MIN;  // vault 총액이 의미있게 빠졌을 때만 진짜 디리스킹
      // 신호 1: withdraw queue 에서 제거 — vault 순유출 동반일 때만(단순 큐 재구성 제외)
      if (p.in_withdraw_queue && !r.inWithdrawQueue && p.supply_usd >= DERISK_MIN_USD && realDerisk && !prevStale) {
        alerts.push({
          severity: "warning",
          token: r.collateral,
          message: `${r.vaultName} ${r.collateral} — 인출큐 제거 · AUM −${(netDrop * 100).toFixed(0)}%`,
          detail: { curator: r.curator, vault: r.vaultName, vaultAddress: r.vaultAddress, chain: r.chain, marketKey: r.marketKey, prevSupplyUsd: p.supply_usd, vaultNetDropPct: netDrop },
        });
      }
      // 신호 2: 적극적 인출 (supply 급감) — vault 순유출 동반일 때만(내부 리밸런싱 제외)
      if (p.supply_usd >= DERISK_MIN_USD && r.supplyUsd < p.supply_usd && realDerisk && !prevStale) {
        const drop = (p.supply_usd - r.supplyUsd) / p.supply_usd;
        if (drop >= DROP_WARN) {
          alerts.push({
            severity: "warning",
            token: r.collateral,
            message: `${r.vaultName} ${r.collateral} — −${(drop * 100).toFixed(0)}% · ${fmt(p.supply_usd)}→${fmt(r.supplyUsd)}`,
            detail: { curator: r.curator, vault: r.vaultName, vaultAddress: r.vaultAddress, chain: r.chain, dropPct: drop, prevSupplyUsd: p.supply_usd, currSupplyUsd: r.supplyUsd, vaultNetDropPct: netDrop },
          });
        }
      }
    }

    // 신호 3: 완전 회수(100% 인출) — 직전 스냅샷엔 있던 할당이 curr 에서 사라짐 = 가장 강한 디리스킹 신호.
    //   위 루프는 현존 rows 만 순회해 사라진 마켓을 놓친다(2026-06 검증 FN). prev(직전 스냅샷) 역순회로 보강.
    const currKeys = new Set(rows.map((r) => `${r.vaultAddress}::${r.marketKey}`));
    if (partialRead) console.warn(`[curators] partial-read 의심(vault ${currVaultCount}/${prevVaultCount}) — 신호3(완전회수) skip`);
    if (prevStale) console.warn(`[curators] stale-prev(직전 스냅샷 2h+ 전) — 신호3(완전회수) skip`);
    for (const [key, p] of prevByKey) {
      if (partialRead || prevStale) break;                   // 불완전 수집 / stale prev — 완전회수 판정 보류
      if (currKeys.has(key)) continue;                       // 현존 마켓은 위 루프가 처리
      if (p.market_key.includes("|")) continue;              // legacy '|' 키(marketId 마이그레이션 잔재) — 0x 키와 비교 무의미
      // ⚠️ vault 잔존 가드(2026-06 재검증): vault 가 curr 에서 통째로 사라진 경우(체인 fetch 실패·AUM<$5M
      //   필터아웃·whole-vault 청산)는 netDrop=1.0 이 되어 게이트를 무조건 통과 → 전 마켓 가짜 완전회수 폭주.
      //   진짜 단일마켓 완전이탈은 vault 가 다른 마켓으로 curr 에 잔존하므로, vault 가 currTotByVault 에 있을 때만 발화.
      if (!currTotByVault.has(p.vault_address)) continue;
      if (!(p.supply_usd >= DERISK_MIN_USD)) continue;       // 의미있는 규모만
      const netDrop = vaultNetDrop(p.vault_address);
      if (netDrop < VAULT_NET_DROP_MIN) continue;            // vault 순유출 동반일 때만(내부 리밸런싱 제외)
      const tok = p.collateral || "?";
      alerts.push({
        severity: "warning",
        token: tok,
        message: `${p.vault_name} ${tok} — 전량 이탈 · ${fmt(p.supply_usd)}→$0`,
        detail: { curator: p.curator, vault: p.vault_name, vaultAddress: p.vault_address, chain: p.chain, marketKey: p.market_key, prevSupplyUsd: p.supply_usd, currSupplyUsd: 0, dropPct: 1, vaultNetDropPct: netDrop, fullExit: true },
      });
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
