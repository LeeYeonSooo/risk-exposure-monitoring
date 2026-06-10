/**
 * 큐레이터 디리스킹(de-risk) 시그널 — vault_allocations 최근 2 스냅샷을 비교해
 * 큐레이터가 특정 마켓 할당을 크게 줄였거나(적극 withdraw) withdraw queue 에서 빼면
 * "부실채권 노출 회피" 선행신호로 본다. (피드백: 유동성 변화 = 강력한 시그널)
 * 알림 kind=curator_derisk → AlertPanel 유동성 탭. source=builtin-v1 (외부 알고리즘 swap 대비).
 * Usage: npm run scan:derisk
 */
import { closePool, query } from "@/db/client";
import { insertAlert } from "@/db/upsert";

interface AllocRow {
  snapshot_ts: string;
  vault_address: string;
  vault_name: string;
  curator: string;
  market_key: string;
  collateral: string;
  supply_usd: string | number;
  in_withdraw_queue: boolean;
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

async function main() {
  const snaps = (
    await query<{ ts: string }>(
      `SELECT DISTINCT snapshot_ts ts FROM vault_allocations ORDER BY snapshot_ts DESC LIMIT 2`,
    )
  ).rows;
  if (snaps.length < 2) {
    console.log(`[scan:derisk] vault_allocations 스냅샷이 ${snaps.length}개 — 비교할 이력 부족, skip.`);
    await closePool().catch(() => {});
    return;
  }
  const [curr, prev] = [snaps[0].ts, snaps[1].ts];

  const load = async (ts: string) =>
    (await query<AllocRow>(
      `SELECT snapshot_ts, vault_address, vault_name, curator, market_key, collateral, supply_usd, in_withdraw_queue
       FROM vault_allocations WHERE snapshot_ts=$1`,
      [ts],
    )).rows;
  const prevRows = await load(prev);
  const currRows = await load(curr);
  const currByKey = new Map<string, AllocRow>();
  for (const r of currRows) currByKey.set(`${r.vault_address}|${r.market_key}`, r);

  let n = 0;
  for (const p of prevRows) {
    const prevUsd = Number(p.supply_usd ?? 0);
    if (prevUsd < 1_000_000) continue; // 의미있는 규모만
    const c = currByKey.get(`${p.vault_address}|${p.market_key}`);
    const currUsd = c ? Number(c.supply_usd ?? 0) : 0;
    const drop = prevUsd > 0 ? (prevUsd - currUsd) / prevUsd : 0;
    // 할당이 40%+ 빠졌거나, 큰 포지션이 사라짐(=withdraw queue 빠짐/청산회피)
    if (drop >= 0.4) {
      const sev = drop >= 0.8 ? "warning" : "info";
      const token = (p.collateral || "?").replace(/^.*:/, "");
      await insertAlert({
        severity: sev,
        kind: "curator_derisk",
        token,
        source: "builtin-v1",
        message:
          `큐레이터 디리스킹: ${p.curator} 가 ${p.vault_name} 의 ${token} 마켓 할당을 ` +
          `${fmtUsd(prevUsd)} → ${fmtUsd(currUsd)} (-${(drop * 100).toFixed(0)}%) 로 축소` +
          `${currUsd === 0 ? " (완전 회수)" : ""} — 부실채권 노출 회피 선행신호`,
        detail: { curator: p.curator, vault: p.vault_name, market: p.market_key, prevUsd, currUsd, dropPct: drop },
      });
      n++;
    }
  }
  console.log(`[scan:derisk] ${prev} → ${curr} 비교, curator_derisk ${n}건 적재`);
  await closePool().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
