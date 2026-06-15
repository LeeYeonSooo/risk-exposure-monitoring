/**
 * 이벤트형 알림 TTL 만료 스윕 — STATE 디텍터 제외, 이벤트형(util_jump·liquidity_drop·depeg·oracle 등)을
 *   severity 별 경과시간 초과 시 resolved 처리. 종료된 이벤트가 DB 에 영구 잔존하던 문제 정리(프론트 24h fade 정렬).
 * Usage: npm run resolve:expired   (cron 이 1h 마다 호출)
 * Env: DATABASE_URL.
 */
import process from "node:process";

import { closePool } from "@/db/client";
import { resolveExpiredEvents } from "@/db/upsert";

async function main() {
  if (!process.env.DATABASE_URL) { console.error("[expire] DATABASE_URL 필요"); process.exit(1); }
  const n = await resolveExpiredEvents();
  console.log(`[expire] 이벤트 TTL 만료 resolved: ${n}건 (critical 72h/warning 48h/info 24h, STATE 제외)`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
