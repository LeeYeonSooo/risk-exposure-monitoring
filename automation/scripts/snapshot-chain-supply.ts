/**
 * 체인별 totalSupply 스냅샷 + 무한민팅(체인 단위) 감시.
 *
 * 왜: 기존 supply_samples 는 토큰당 totalSupply 1개(사실상 이더리움)만 추적 →
 *   "어느 체인에서든 비정상 민팅"(전문가 #1 시그널)을 체인 단위로 못 잡았다. L2/사이드체인에
 *   브릿지로 들어온 양이 갑자기 튀는 것도 위험 신호. 이 스크립트는 프론트 breadth API
 *   (/api/breadth/SYM — 전 체인 eth_call totalSupply)로 체인별 공급을 받아 chain_supply_samples 에
 *   append 하고, (token,chain) 별 robust z-score(diff 의 supply_spike 와 동일 로직)로
 *   chain_supply_spike 알림을 만든다.
 *
 * Usage:
 *   npm run snapshot:chainsupply                  # /api/tokens 상위 N개
 *   npm run snapshot:chainsupply -- wstETH USDe    # 특정 토큰만
 * Env: DATABASE_URL, BASE_URL(기본 http://localhost:3000), CHAINSUPPLY_MAX(기본 12)
 *
 * cron.ts 의 chainSupplyLoop 가 1시간마다 호출 (규모순 상위 CHAINSUPPLY_MAX 토큰 — RPC 부하 제어).
 */
import process from "node:process";

import { RECOMMENDED_THRESHOLDS } from "@/config/alert-thresholds";
import { closePool, query } from "@/db/client";
import { robustZ } from "@/lib/stats";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TS = RECOMMENDED_THRESHOLDS.totalSupply;
const MAX_TOKENS = Number(process.env.CHAINSUPPLY_MAX ?? 12);

interface BreadthResp { supplyByChain?: Record<string, { supply: number; supplyUsd: number }> }

async function symbolsToScan(): Promise<string[]> {
  const argv = process.argv.slice(2).filter((s) => !s.startsWith("-"));
  if (argv.length) return argv;
  // 규모(엣지 USD 합)순 — /api/tokens 는 알파벳순이라 톱N 컷이 USDT/USDC 같은 핵심 토큰을 잘랐다
  // (USDT@tron $89B 무한민팅 감시가 빠지는 구멍). DB 에서 직접 규모순으로 뽑고, 실패 시 API 폴백.
  try {
    const r = await query<{ sym: string }>(
      `SELECT split_part(replace(e.token_node_id, 'token:', ''), '@', 1) AS sym, sum(e.weight) AS w
       FROM edges e
       WHERE e.snapshot_ts > now() - interval '3 days'
       GROUP BY 1 ORDER BY w DESC NULLS LAST LIMIT $1`,
      [MAX_TOKENS],
    );
    if (r.rows.length) return r.rows.map((x) => x.sym);
  } catch { /* DB 실패 → API 폴백 */ }
  try {
    const d = (await fetch(`${BASE}/api/tokens`).then((r) => r.json())) as { tokens?: string[] };
    return [...new Set((d.tokens ?? []).map((t) => t.split("@")[0]))].slice(0, MAX_TOKENS);
  } catch {
    return ["wstETH"];
  }
}

async function recentSamples(tokenNodeId: string, chain: string, beforeTs: string, n: number): Promise<number[]> {
  const r = await query<{ total_supply: string }>(
    `SELECT total_supply FROM chain_supply_samples
     WHERE token_node_id=$1 AND chain=$2 AND snapshot_ts < $3
     ORDER BY snapshot_ts DESC LIMIT $4`,
    [tokenNodeId, chain, beforeTs, n],
  );
  return r.rows.map((x) => Number(x.total_supply)).filter((v) => v > 0); // 최신순
}

async function insertAlert(a: {
  snapshotTs: string; severity: string; kind: string; token: string;
  message: string; detail: Record<string, unknown>; source: string;
}): Promise<boolean> {
  // 26h 중복 억제 (kind+token+chain) — chain 은 detail 에 있으므로 message 로도 구분되게 kind+token+chain 키
  const dup = await query<{ n: number }>(
    `SELECT count(*)::int n FROM alerts
     WHERE kind=$1 AND token=$2 AND detail->>'chain' = $3 AND created_at > now() - interval '26 hours'`,
    [a.kind, a.token, String(a.detail.chain ?? "")],
  ).catch(() => ({ rows: [{ n: 0 }] }) as { rows: { n: number }[] });
  if ((dup.rows[0]?.n ?? 0) > 0) return false;
  await query(
    `INSERT INTO alerts (snapshot_ts, severity, kind, token, protocol_node_id, message, detail, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [a.snapshotTs, a.severity, a.kind, a.token, null, a.message, JSON.stringify(a.detail), a.source],
  );
  return true;
}

async function main() {
  const symbols = await symbolsToScan();
  const snapshotTs = new Date().toISOString();
  let samples = 0, alerts = 0, chainsSeen = 0;
  console.log(`[chainsupply] ${symbols.length}개 토큰 · base=${BASE} · ts=${snapshotTs}`);

  for (const sym of symbols) {
    let supplyByChain: Record<string, { supply: number; supplyUsd: number }> = {};
    try {
      const resp = (await fetch(`${BASE}/api/breadth/${encodeURIComponent(sym)}`).then((r) => r.json())) as BreadthResp;
      supplyByChain = resp.supplyByChain ?? {};
    } catch (e) {
      console.warn(`[chainsupply] ${sym} breadth 실패:`, (e as Error).message);
      continue;
    }
    const tokenNodeId = `token:${sym}`;
    let chainsForSym = 0;
    for (const [chain, s] of Object.entries(supplyByChain)) {
      const supply = s?.supply ?? 0;
      if (!(supply > 0)) continue;
      chainsForSym++;

      // 신뢰성 가드 — 최근 중앙값 대비 >35% 벗어난 flaky read 는 베이스라인 오염 방지 위해 skip.
      const guard = await recentSamples(tokenNodeId, chain, snapshotTs, 6);
      const sorted = guard.slice().sort((a, b) => a - b);
      if (sorted.length >= 3) {
        const med = sorted[Math.floor(sorted.length / 2)];
        if (med > 0 && Math.abs(supply - med) / med > 0.35) {
          console.warn(`[chainsupply] suspect ${sym}@${chain}: ${supply.toLocaleString()} vs med ${med.toLocaleString()} — skip`);
          continue;
        }
      }

      await query(
        `INSERT INTO chain_supply_samples (snapshot_ts, token_node_id, chain, block_number, total_supply, supply_usd)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (token_node_id, chain, snapshot_ts) DO UPDATE SET
           total_supply = EXCLUDED.total_supply, supply_usd = EXCLUDED.supply_usd`,
        [snapshotTs, tokenNodeId, chain, null, supply, s.supplyUsd ?? null],
      );
      samples++;

      // robust z-score — diff.ts 의 supply_spike 와 동일 로직(연속 델타의 median/MAD).
      const recent = await recentSamples(tokenNodeId, chain, snapshotTs, TS.windowN);
      if (recent.length >= TS.minSamples) {
        const asc = [...recent].reverse(); // 오래된→최신
        const last = asc[asc.length - 1];
        const d = supply - last;
        const baseline: number[] = [];
        for (let i = 1; i < asc.length; i++) baseline.push(asc[i] - asc[i - 1]);
        const z = robustZ(d, baseline);
        if (d > 0 && Math.abs(d) >= TS.minAbsDeltaTokens && Math.abs(z) >= TS.zscore) {
          const ok = await insertAlert({
            snapshotTs, severity: "info", kind: "chain_supply_spike", token: sym,
            message: `${chain} totalSupply 급증: +${d.toFixed(2)} ${sym} (robust z=${z.toFixed(1)}, ${recent.length}샘플) — 체인 단위 비정상 민팅/브릿지 유입 의심`,
            detail: { chain, supply, supplyUsd: s.supplyUsd ?? null, prev: last, delta: Number(d.toFixed(2)), z: Number(z.toFixed(2)), baselineN: recent.length },
            source: "chain-supply",
          });
          if (ok) alerts++;
        }
      }
    }
    chainsSeen += chainsForSym;
    console.log(`[chainsupply] ${sym}: ${chainsForSym}개 체인 공급 기록`);
  }

  console.log(`[chainsupply] 완료 — 샘플 ${samples} · 체인합 ${chainsSeen} · 신규알림 ${alerts} @ ${snapshotTs}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
