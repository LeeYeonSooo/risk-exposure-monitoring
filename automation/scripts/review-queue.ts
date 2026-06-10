/**
 * 검토 큐 관리 CLI.
 *
 *   npm run review                          → 제안된(미승인) 토큰 목록
 *   npm run review -- approve 0x<addr>       → 승인 (active=TRUE, 다음 스냅샷부터 추적)
 *   npm run review -- approve all            → 전부 승인
 *   npm run review -- reject  0x<addr>       → 거절 (삭제)
 */
import { closePool } from "@/db/client";
import {
  approveWatchlistCandidate,
  listProposedCandidates,
  rejectWatchlistCandidate,
} from "@/db/upsert";

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (!cmd || cmd === "list") {
    const rows = await listProposedCandidates();
    if (rows.length === 0) {
      console.log("검토 대기 토큰 없음 (제안 큐 비어있음).");
    } else {
      console.log(`검토 대기 ${rows.length}개 (담보 metric 내림차순):\n`);
      for (const r of rows) {
        console.log(
          `  ${r.symbol.padEnd(12)} ${fmtUsd(r.discovery_metric_usd).padStart(10)}  ` +
            `[${r.discovery_source ?? "?"}]  ${r.token_address}`,
        );
      }
      console.log(`\n승인:  npm run review -- approve 0x<addr>   (또는 approve all)`);
      console.log(`거절:  npm run review -- reject  0x<addr>`);
    }
    await closePool();
    return;
  }

  if (cmd === "approve") {
    if (arg === "all") {
      const rows = await listProposedCandidates();
      let n = 0;
      for (const r of rows) {
        if (await approveWatchlistCandidate(r.token_address)) {
          console.log(`  ✓ approved ${r.symbol} (${r.token_address})`);
          n++;
        }
      }
      console.log(`${n}개 승인 완료.`);
    } else if (arg && /^0x[a-fA-F0-9]{40}$/.test(arg)) {
      const ok = await approveWatchlistCandidate(arg);
      console.log(ok ? `✓ approved ${arg}` : `대상 없음 (이미 승인됐거나 제안 큐에 없음): ${arg}`);
    } else {
      console.error("Usage: npm run review -- approve 0x<addr> | all");
    }
    await closePool();
    return;
  }

  if (cmd === "reject") {
    if (arg && /^0x[a-fA-F0-9]{40}$/.test(arg)) {
      const ok = await rejectWatchlistCandidate(arg);
      console.log(ok ? `✓ rejected (deleted) ${arg}` : `대상 없음: ${arg}`);
    } else {
      console.error("Usage: npm run review -- reject 0x<addr>");
    }
    await closePool();
    return;
  }

  console.error(`Unknown command: ${cmd}. Use: list | approve | reject`);
  await closePool();
  process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
