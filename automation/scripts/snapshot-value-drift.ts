/**
 * 가치-드리프트 러너 (BACKLOG P2-6) — chain_supply_samples 의 토큰별 총가치(Σchain supply_usd)
 * 시계열을 윈도우로 평가해 급락(밸류 유출) 시 alerts(kind=value_drift, source=valuedrift-v1) 적재.
 *
 * Usage: npm run snapshot:valuedrift   [-- --dry]
 * Env: DATABASE_URL(필수). (온체인 read 없음 — DB 시계열만 본다.)
 *
 * 데이터 출처: chainSupplyLoop(snapshot:chainsupply, cron 1h)이 쌓는 supply_usd. 시계열이 길수록 정확.
 */
import process from "node:process";

import { RECOMMENDED_THRESHOLDS, cooldownSecondsFor, type Severity } from "@/config/alert-thresholds";
import { closePool, query } from "@/db/client";
import { insertAlert } from "@/db/upsert";
import { computeValueDrift, type ValuePoint } from "@/snapshot/value-drift";

const DRY = process.argv.includes("--dry");
const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${(n / 1e3).toFixed(0)}K`);

async function main() {
  if (!process.env.DATABASE_URL) { console.error("[valuedrift] DATABASE_URL 필요"); process.exit(1); }

  // 토큰별 총가치 시계열: snapshot_ts 마다 체인 supply_usd 합산.
  const rows = (await query<{ token_node_id: string; ts: string; v: string }>(`
    SELECT token_node_id, extract(epoch from snapshot_ts)::bigint AS ts, sum(supply_usd) AS v
    FROM chain_supply_samples
    WHERE supply_usd IS NOT NULL
    GROUP BY token_node_id, snapshot_ts
  `).catch(() => ({ rows: [] }))).rows;

  const byToken = new Map<string, ValuePoint[]>();
  for (const r of rows) {
    const arr = byToken.get(r.token_node_id) ?? [];
    arr.push({ ts: Number(r.ts), valueUsd: Number(r.v) });
    byToken.set(r.token_node_id, arr);
  }
  console.log(`[valuedrift] 토큰 ${byToken.size}개 시계열 평가 (window ${RECOMMENDED_THRESHOLDS.valueDrift.windowHours}h · 게이트 ${fmtUsd(RECOMMENDED_THRESHOLDS.valueDrift.minAbsUsd)})${DRY ? " [DRY]" : ""}`);

  let fired = 0;
  for (const [tokenNodeId, series] of byToken) {
    const sym = tokenNodeId.replace(/^token:/, "");
    const finding = computeValueDrift(sym, series);
    if (!finding) continue;
    fired++;
    const pctTxt = (finding.dropPct * 100).toFixed(1);
    const msg = `${sym} 총가치 ${pctTxt}% 급락 — ${fmtUsd(finding.peakUsd)} → ${fmtUsd(finding.latestUsd)} (유출 ${fmtUsd(finding.dropUsd)}, ${finding.windowHours}h) — 밸류 유출/대량 인출 의심`;
    console.log(`  ${finding.severity === "critical" ? "🔴" : finding.severity === "warning" ? "🟡" : "🔵"} ${msg}`);
    if (!DRY) {
      await insertAlert({
        severity: finding.severity,
        kind: "value_drift",
        token: sym,
        message: msg,
        detail: { peakUsd: finding.peakUsd, latestUsd: finding.latestUsd, dropUsd: finding.dropUsd, dropPct: finding.dropPct, windowHours: finding.windowHours, peakTs: finding.peakTs, latestTs: finding.latestTs },
        source: "valuedrift-v1",
      });
    }
  }
  console.log(`[valuedrift] 완료: ${fired}건 발화${DRY ? " (DRY — 미적재)" : ""}. 쿨다운(critical ${cooldownSecondsFor("critical" as Severity)}s)`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
