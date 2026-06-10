/**
 * 관리자 워치리스트 오버라이드 — 자동 임계 발굴 위에 수동 의도.
 *
 *   npm run watchlist                      → 현재 워치리스트 상태
 *   npm run watchlist -- pin 0x<addr> SYM  → 핀(임계 무관 항상 추적, discover 가 안 내림)
 *   npm run watchlist -- exclude 0x<addr>  → 제외(임계 통과해도 추적 안 함)
 *   npm run watchlist -- unpin 0x<addr>    → 핀/제외 해제 (자동 규칙 복귀)
 */
import { closePool, query } from "@/db/client";
import { excludeWatchlist, pinWatchlist, unpinWatchlist } from "@/db/upsert";

async function list() {
  const r = await query<{
    symbol: string;
    token_address: string;
    active: boolean;
    excluded: boolean;
    reason: string | null;
    discovery_metric_usd: number | null;
  }>(`SELECT symbol, token_address, active, excluded, reason, discovery_metric_usd
      FROM watchlist ORDER BY active DESC, excluded DESC, discovery_metric_usd DESC NULLS LAST`);
  const active = r.rows.filter((x) => x.active);
  const pinned = active.filter((x) => x.reason === "manual");
  const excluded = r.rows.filter((x) => x.excluded);
  console.log(`\n워치리스트: active ${active.length} (핀 ${pinned.length}) · 제외 ${excluded.length}\n`);
  console.log("상태  토큰          출처          metric        주소");
  console.log("─".repeat(76));
  for (const x of r.rows.filter((y) => y.active || y.excluded)) {
    const st = x.excluded ? "🚫" : x.reason === "manual" ? "📌" : "✓ ";
    const m = x.discovery_metric_usd ? `$${(x.discovery_metric_usd / 1e6).toFixed(1)}M` : "—";
    console.log(`${st}   ${x.symbol.padEnd(13)} ${(x.reason ?? "").padEnd(13)} ${m.padStart(10)}   ${x.token_address}`);
  }
  console.log("\n📌 핀(항상추적)  🚫 제외  ✓ 자동(임계통과)");
}

async function main() {
  const [cmd, addr, sym] = process.argv.slice(2);
  const isAddr = (a?: string) => a && /^0x[a-fA-F0-9]{40}$/.test(a);

  if (!cmd || cmd === "list") {
    await list();
  } else if (cmd === "pin" && isAddr(addr)) {
    await pinWatchlist(addr, sym ?? addr.slice(0, 8));
    console.log(`📌 pinned ${sym ?? addr} (임계 무관 항상 추적)`);
  } else if (cmd === "exclude" && isAddr(addr)) {
    await excludeWatchlist(addr);
    console.log(`🚫 excluded ${addr} (임계 통과해도 추적 안 함)`);
  } else if (cmd === "unpin" && isAddr(addr)) {
    await unpinWatchlist(addr);
    console.log(`✓ unpinned ${addr} (자동 임계 규칙 복귀)`);
  } else {
    console.error("Usage: npm run watchlist -- [list | pin 0x.. SYM | exclude 0x.. | unpin 0x..]");
    process.exitCode = 1;
  }
  await closePool().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
