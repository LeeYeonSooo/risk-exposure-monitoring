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
import { fmtUsd } from "@/snapshot/scanner-kit";
import { computeValueDrift, type ValuePoint } from "@/snapshot/value-drift";

const DRY = process.argv.includes("--dry");

async function main() {
  if (!process.env.DATABASE_URL) { console.error("[valuedrift] DATABASE_URL 필요"); process.exit(1); }

  // 토큰별 총가치 시계열: snapshot_ts 마다 체인 supply_usd 합산.
  //   ★ 윈도(+6h 버퍼)만 조회 — 전체 테이블 풀스캔 방지(perf). idx(token,chain,snapshot_ts DESC) 활용.
  const sinceSec = Math.floor(Date.now() / 1000) - (RECOMMENDED_THRESHOLDS.valueDrift.windowHours + 6) * 3600;
  const rows = (await query<{ token_node_id: string; ts: string; v: string; n_chains: string; supply_units: string | null }>(`
    SELECT token_node_id, extract(epoch from snapshot_ts)::bigint AS ts, sum(supply_usd) AS v,
           count(*) AS n_chains, sum(total_supply) AS supply_units
    FROM chain_supply_samples
    WHERE supply_usd IS NOT NULL AND snapshot_ts > to_timestamp($1)
    GROUP BY token_node_id, snapshot_ts
  `, [sinceSec]).catch(() => ({ rows: [] }))).rows;

  const byToken = new Map<string, ValuePoint[]>();
  for (const r of rows) {
    const arr = byToken.get(r.token_node_id) ?? [];
    arr.push({ ts: Number(r.ts), valueUsd: Number(r.v), nChains: Number(r.n_chains), supplyUnits: r.supply_units != null ? Number(r.supply_units) : null });
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
    const supTxt = finding.supplyDropPct != null ? ` · 공급 −${(finding.supplyDropPct * 100).toFixed(0)}%` : "";
    const msg = `${sym} −${pctTxt}% · ${fmtUsd(finding.peakUsd)}→${fmtUsd(finding.latestUsd)}${supTxt}`;
    console.log(`  ${finding.severity === "critical" ? "🔴" : finding.severity === "warning" ? "🟡" : "🔵"} ${msg}`);
    if (!DRY) {
      await insertAlert({
        severity: finding.severity,
        kind: "value_drift",
        token: sym,
        message: msg,
        detail: { peakUsd: finding.peakUsd, latestUsd: finding.latestUsd, dropUsd: finding.dropUsd, dropPct: finding.dropPct, supplyDropPct: finding.supplyDropPct, windowHours: finding.windowHours, peakTs: finding.peakTs, latestTs: finding.latestTs },
        source: "valuedrift-v1",
      });
    }
  }
  console.log(`[valuedrift] 완료: ${fired}건 발화${DRY ? " (DRY — 미적재)" : ""}. 쿨다운(critical ${cooldownSecondsFor("critical" as Severity)}s)`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
