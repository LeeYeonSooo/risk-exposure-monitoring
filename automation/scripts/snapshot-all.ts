/**
 * Snapshot ALL watched tokens. Pulls watchlist from DB, runs snapshotToken for each.
 * Usage: npm run snapshot:all
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Address } from "viem";

import { env } from "@/config/chains";
import { closePool } from "@/db/client";
import { listActiveWatchlist, markWatchlistSnapshotted, persistSnapshot, recordSnapshotRun } from "@/db/upsert";
import { getTokenPricesUsd } from "@/lib/prices";
import { diffAndAlert } from "@/snapshot/diff";
import { snapshotToken } from "@/snapshot/snapshot-token";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 일시적 RPC 실패(HTTP request failed 등)에 백오프 재시도. */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(800 * (i + 1)); // 0.8s, 1.6s 백오프
    }
  }
  throw lastErr;
}

async function main() {
  if (!env.DATABASE_URL) {
    console.error("[snapshot:all] DATABASE_URL required to read watchlist");
    process.exit(1);
  }

  const watchlist = await listActiveWatchlist();
  console.log(`[snapshot:all] ${watchlist.length} tokens active`);

  // 가격 배치 조회 — 토큰당 1콜(57번) 대신 한 번에 (rate-limit 회피 + 속도)
  const prices = await getTokenPricesUsd(
    watchlist.map((r) => r.token_address as Address),
  ).catch(() => new Map<string, number>());
  console.log(`[snapshot:all] prices: ${prices.size}/${watchlist.length} 조회됨 (batch)`);

  mkdirSync(env.OUTPUT_DIR, { recursive: true });

  let successCount = 0;
  let errorCount = 0;
  let totalEdges = 0;
  let totalUnknowns = 0;
  const runStartedAt = new Date().toISOString();

  for (const row of watchlist) {
    const start = Date.now();
    try {
      const price = prices.get(row.token_address.toLowerCase());
      const result = await withRetry(() =>
        snapshotToken(row.token_address as Address, {
          topN: env.TOP_HOLDERS_LIMIT,
          tokenPriceUsd: price,
        }),
      );
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      console.log(`  ✓ ${result.token.label}: ${result.edges.length} edges, ${result.unknownAddresses.length} unknowns (${elapsed}s)`);

      // 디버그 덤프 — 기본 off(DB가 source of truth). 켜려면 SNAPSHOT_JSON_DUMP=1.
      if (process.env.SNAPSHOT_JSON_DUMP === "1") {
        const file = resolve(env.OUTPUT_DIR, `${result.token.label}-${Date.now()}.json`);
        writeFileSync(file, JSON.stringify(result, jsonReplacer, 2));
      }

      await persistSnapshot(result);
      await markWatchlistSnapshotted(row.token_address, result.snapshotTs);
      totalEdges += result.edges.length;
      totalUnknowns += result.unknownAddresses.length;

      const alerts = await diffAndAlert(result).catch(() => []);
      if (alerts.length > 0) {
        const crit = alerts.filter((a) => a.severity === "critical").length;
        const warn = alerts.filter((a) => a.severity === "warning").length;
        console.log(`    🔴 ${crit} critical, 🟡 ${warn} warning`);
      }
      successCount++;
    } catch (e) {
      console.error(`  ✗ ${row.symbol} (${row.token_address}):`, (e as Error).message);
      errorCount++;
    }
  }

  console.log(`[snapshot:all] complete — ${successCount} ok, ${errorCount} errors`);
  // 감사로그(snapshot_runs) — 이 cron 실행 1행. token_address=null(ethereum 배치 전체).
  await recordSnapshotRun({
    startedAt: runStartedAt,
    status: errorCount > 0 && successCount === 0 ? "error" : "ok",
    tokenAddress: null,
    edgesWritten: totalEdges,
    unknownsAdded: totalUnknowns,
    errorMessage: errorCount > 0 ? `${errorCount} token(s) failed` : null,
  }).catch((e) => console.error("[snapshot:all] snapshot_runs insert failed:", (e as Error).message));
  await closePool().catch(() => {});
}

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
