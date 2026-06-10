/**
 * Create / migrate Postgres schema.
 * Usage: npm run init-db
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { closePool, query } from "@/db/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const schemaPath = resolve(__dirname, "..", "src", "db", "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");

  console.log("[init-db] applying schema…");
  // schema.sql 은 DO $$ … $$; 달러쿼팅 블록을 포함하므로 ';' 로 쪼개면 깨짐.
  // pg 는 파라미터 없는 멀티-스테이트먼트를 한 번의 query 로 실행 가능 → 통째 실행.
  try {
    await query(sql);
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes("already exists")) {
      console.warn(`[init-db] schema apply warning:`, msg);
    }
  }

  // Apply migrations in lexical order (002, 003, …) — idempotent.
  const migrationsDir = resolve(__dirname, "..", "src", "db", "migrations");
  let migrationFiles: string[] = [];
  try {
    migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    /* no migrations dir */
  }
  for (const f of migrationFiles) {
    console.log(`[init-db] applying migration ${f}…`);
    const msql = readFileSync(resolve(migrationsDir, f), "utf8");
    // migrations 는 DO $$ … $$ 블록을 포함할 수 있어 statement split 하지 않고 통째로 실행
    try {
      await query(msql);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("already exists")) continue;
      console.warn(`[init-db] migration ${f} failed (continuing):`, msg);
    }
  }

  // watchlist 는 하드코딩 seed 없음 — `npm run discover` 가 임계 통과 토큰을
  // 자동으로 active=TRUE 로 채움. (init-db 는 스키마/마이그레이션만)
  console.log("[init-db] 스키마 준비 완료. 다음: npm run discover → npm run snapshot:all");

  await closePool();
  console.log("[init-db] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
