/**
 * Snapshot ONE token end-to-end. Writes to DB + dumps JSON to output/.
 * Usage:  npm run snapshot:one -- 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import type { Address } from "viem";

import { env } from "@/config/chains";
import { closePool } from "@/db/client";
import { markWatchlistSnapshotted, persistSnapshot } from "@/db/upsert";
import { diffAndAlert } from "@/snapshot/diff";
import { snapshotToken } from "@/snapshot/snapshot-token";

async function main() {
  const addr = process.argv[2];
  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    console.error("Usage: npm run snapshot:one -- 0x<token-address>");
    process.exit(1);
  }
  const priceArg = process.argv[3];
  const tokenPriceUsd = priceArg ? Number(priceArg) : undefined;

  console.log(`[snapshot] ${addr}${tokenPriceUsd ? ` (price=${tokenPriceUsd})` : " (price=1 default)"}`);
  const start = Date.now();

  const result = await snapshotToken(addr as Address, { tokenPriceUsd, topN: env.TOP_HOLDERS_LIMIT });

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`[snapshot] ${result.token.label}: ${result.protocols.length} protocols, ${result.edges.length} edges, ${result.unknownAddresses.length} unknowns (${elapsed}s)`);

  // Dump to JSON
  mkdirSync(env.OUTPUT_DIR, { recursive: true });
  const file = resolve(env.OUTPUT_DIR, `${result.token.label}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(result, jsonReplacer, 2));
  console.log(`[snapshot] wrote ${file}`);

  // Write to DB + run diff
  if (env.DATABASE_URL) {
    await persistSnapshot(result);
    await markWatchlistSnapshotted(addr, result.snapshotTs);
    console.log("[snapshot] persisted to DB");

    const alerts = await diffAndAlert(result).catch((e) => {
      console.warn("[diff] failed:", (e as Error).message);
      return [];
    });
    if (alerts.length > 0) {
      console.log(`[diff] ${alerts.length} alert(s):`);
      for (const a of alerts) console.log(`  ${a.severity === "critical" ? "🔴" : a.severity === "warning" ? "🟡" : "  "} ${a.kind}: ${a.message}`);
    }
  } else {
    console.log("[snapshot] DATABASE_URL not set, skipping DB write + diff");
  }

  await closePool().catch(() => {});
}

/** BigInt isn't JSON-serializable by default. */
function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  return v;
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
