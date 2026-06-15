/**
 * 실시간 모니터링 관찰 — 매 실행마다 직전 윈도(기본 65분) 동안 생성·해소된 알림을 집계해
 * fp-audit/observe.jsonl 에 한 줄(JSON) 추가. 24h 돌려두면 FP/FN 후보(스톰·신규 kind·재발화 폭증)가 쌓인다.
 *
 *  · storm: 한 kind 가 윈도 내 STORM_N(기본 15) 이상 생성 → FP 스톰 의심 플래그
 *  · newKind: 그간 본 적 없는 kind 첫 출현
 *  · refire: 같은 (kind,token) 가 윈도 내 3회+ 생성 → 재발화/미해소 의심
 *  · activeBySeverity / resolvedInWindow: 추세
 * Usage: npm run observe   (cron observeLoop 이 1시간마다 호출)
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, query } from "@/db/client";

const WINDOW_MIN = Number(process.env.OBSERVE_WINDOW_MIN ?? 65);
const STORM_N = Number(process.env.OBSERVE_STORM_N ?? 15);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "fp-audit", "observe.jsonl");

async function main() {
  const now = new Date().toISOString();
  // 윈도 내 생성된 알림
  const created = await query<{ kind: string; severity: string; source: string; token: string; n: number }>(
    `SELECT kind, severity, source, token, count(*)::int n FROM alerts
     WHERE created_at > now() - make_interval(mins => $1::int)
     GROUP BY kind, severity, source, token`,
    [WINDOW_MIN],
  ).catch(() => ({ rows: [] as { kind: string; severity: string; source: string; token: string; n: number }[] }));

  const createdByKind: Record<string, number> = {};
  const refire: Array<{ kind: string; token: string; n: number }> = [];
  for (const r of created.rows) {
    createdByKind[r.kind] = (createdByKind[r.kind] ?? 0) + r.n;
    if (r.n >= 3) refire.push({ kind: r.kind, token: r.token, n: r.n });
  }
  const storms = Object.entries(createdByKind).filter(([, n]) => n >= STORM_N).map(([kind, n]) => ({ kind, n }));

  // 활성 분포 + 윈도 내 해소 + 신규 kind
  const activeSev = await query<{ severity: string; n: number }>(
    `SELECT severity, count(*)::int n FROM alerts WHERE acknowledged IS NOT TRUE AND resolved_at IS NULL GROUP BY severity`,
  ).catch(() => ({ rows: [] as { severity: string; n: number }[] }));
  const resolvedN = await query<{ n: number }>(
    `SELECT count(*)::int n FROM alerts WHERE resolved_at > now() - make_interval(mins => $1::int)`, [WINDOW_MIN],
  ).catch(() => ({ rows: [{ n: 0 }] }));

  // 신규 kind — 과거 observe 기록에 없던 kind
  let seenKinds = new Set<string>();
  try {
    const prev = readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean);
    for (const line of prev) for (const k of (JSON.parse(line).kindsSeen ?? [])) seenKinds.add(k);
  } catch { /* 첫 실행 */ }
  const nowKinds = Object.keys(createdByKind);
  const newKinds = nowKinds.filter((k) => !seenKinds.has(k));
  for (const k of nowKinds) seenKinds.add(k);

  const rec = {
    ts: now, windowMin: WINDOW_MIN,
    createdTotal: created.rows.reduce((s, r) => s + r.n, 0),
    createdByKind,
    storms,                                   // ⚠️ FP 스톰 의심
    refire: refire.sort((a, b) => b.n - a.n).slice(0, 10),
    newKinds,                                 // 신규 kind 첫 출현
    resolvedInWindow: resolvedN.rows[0]?.n ?? 0,
    activeBySeverity: Object.fromEntries(activeSev.rows.map((r) => [r.severity, r.n])),
    kindsSeen: [...seenKinds],
  };
  appendFileSync(OUT, JSON.stringify(rec) + "\n");
  const flag = storms.length ? ` 🚨 STORM ${storms.map((s) => `${s.kind}×${s.n}`).join(",")}` : "";
  console.log(`[observe] ${now} created=${rec.createdTotal} resolved=${rec.resolvedInWindow} active=${JSON.stringify(rec.activeBySeverity)}${flag}${newKinds.length ? ` newKinds=${newKinds.join(",")}` : ""}`);
  await closePool().catch(() => {});
}
main();
