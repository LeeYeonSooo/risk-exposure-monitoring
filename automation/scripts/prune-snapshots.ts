/**
 * 스냅샷 보존 정리 — 토큰별 최근 N개 snapshot_ts 만 남기고 옛 것 삭제.
 *
 * edges 는 TimescaleDB hypertable 이라 기본적으로 모든 스냅샷을 무제한 보존함.
 * diff 는 현재 vs 직전을 비교하지만, "현재·이전·전전" 3개만 유지하고 싶을 때 사용.
 *
 * 비파괴 기본: 이 스크립트를 직접 실행할 때만 삭제. 파이프라인 기본은 전부 보존.
 *
 * Usage:
 *   npm run prune            # 토큰별 최근 3개 유지 (기본)
 *   npm run prune -- 5       # 최근 5개 유지
 *   npm run prune -- 3 --dry # 삭제 안 하고 대상만 출력
 */
import { closePool, query } from "@/db/client";

async function main() {
  const args = process.argv.slice(2);
  const keep = Number(args.find((a) => /^\d+$/.test(a)) ?? 3);
  const dry = args.includes("--dry") || args.includes("--dry-run");

  if (keep < 1) {
    console.error("keep 는 1 이상이어야 함");
    process.exit(1);
  }

  // 토큰별 보존할 최근 N개 snapshot_ts 집합을 구하고, 그 밖을 삭제.
  const cntBefore = await query<{ n: string }>(`SELECT count(*) n FROM edges`);
  console.log(`[prune] 현재 edges 행: ${cntBefore.rows[0].n}, 토큰별 최근 ${keep}개 유지`);

  // 토큰별 cutoff(보존 경계) 미만 삭제
  const sql = `
    WITH ranked AS (
      SELECT token_node_id, snapshot_ts,
             dense_rank() OVER (PARTITION BY token_node_id ORDER BY snapshot_ts DESC) AS rnk
      FROM (SELECT DISTINCT token_node_id, snapshot_ts FROM edges) s
    )
    SELECT token_node_id, snapshot_ts FROM ranked WHERE rnk > $1
  `;
  const toDelete = await query<{ token_node_id: string; snapshot_ts: string }>(sql, [keep]);

  if (toDelete.rows.length === 0) {
    console.log("[prune] 삭제 대상 없음 (모든 토큰이 N개 이하).");
    await closePool();
    return;
  }

  // 토큰별 삭제 개수 요약
  const byToken = new Map<string, number>();
  for (const r of toDelete.rows) byToken.set(r.token_node_id, (byToken.get(r.token_node_id) ?? 0) + 1);
  for (const [tk, n] of byToken) console.log(`  ${tk}: 오래된 스냅샷 ${n}개 ${dry ? "(dry)" : "삭제"}`);

  if (dry) {
    console.log("[prune] --dry: 삭제 생략.");
    await closePool();
    return;
  }

  // 실제 삭제 — 토큰별 최근 N개 밖의 행 제거
  const del = await query(
    `
    DELETE FROM edges e
    USING (
      WITH ranked AS (
        SELECT token_node_id, snapshot_ts,
               dense_rank() OVER (PARTITION BY token_node_id ORDER BY snapshot_ts DESC) AS rnk
        FROM (SELECT DISTINCT token_node_id, snapshot_ts FROM edges) s
      )
      SELECT token_node_id, snapshot_ts FROM ranked WHERE rnk > $1
    ) old
    WHERE e.token_node_id = old.token_node_id AND e.snapshot_ts = old.snapshot_ts
    `,
    [keep],
  );
  console.log(`[prune] 삭제 완료: ${del.rowCount ?? 0} 행`);
  await closePool();
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
