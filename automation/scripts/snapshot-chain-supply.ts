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
import { isActiveChain } from "@/config/chains";
import { closePool, query } from "@/db/client";
import { insertAlert } from "@/db/upsert";
import { getTokenPriceOnchainFirst } from "@/lib/prices";
import { classifySupplyDeviation, isStaleGap } from "@/snapshot/data-quality";
import { latestSampleTs, recentSupplySamples } from "@/snapshot/scanner-kit";
import { supplySpikeStats } from "@/snapshot/supply-spike";

// 베이스라인 stale 게이트(분) — 직전 chain_supply 샘플이 이만큼 오래됐으면 단일-tick z 가 무의미(USDe 3일 stale prev 대비
//   브릿지 유입 폭증=FP). 5분 폴 기준 6h 이상 갭이면 베이스라인 신선화 전까지 z 보류(다체인 누락/롱-아웃티지 누적 드리프트 차단).
const SUPPLY_STALE_GAP_MIN = 6 * 60;

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TS = RECOMMENDED_THRESHOLDS.totalSupply;
const DQ = RECOMMENDED_THRESHOLDS.dataQuality;
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


// 중앙 insertAlert(@/db/upsert) 사용 — FP필터·중앙 dedup 경유(로컬 우회 제거, 2026-06). chain 별 dedup 분리는
//   protocolNodeId=`chain:${chain}` 로 인코딩(중앙 dedup 키가 kind+token+protocol 이라 체인별 분리됨).

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
    // value_drift 입력(supply_usd)을 **온체인 가격**으로 — breadth(coins.llama) 대신. home(eth) 주소를 DB 에서 찾아 1회 가격(전 체인 공통 시장가). 실패 시 breadth supplyUsd 폴백.
    let onchainPrice: number | null = null;
    try {
      const nr = await query<{ address: string }>(`SELECT address FROM nodes WHERE node_id = $1 AND address IS NOT NULL LIMIT 1`, [`token:${sym}`]);
      const addr = nr.rows[0]?.address;
      if (addr) onchainPrice = await getTokenPriceOnchainFirst(addr as `0x${string}`, 1, Date.now());
    } catch { /* 폴백: breadth supplyUsd 유지 */ }
    const tokenNodeId = `token:${sym}`;
    let chainsForSym = 0;
    for (const [chain, s] of Object.entries(supplyByChain)) {
      if (!isActiveChain(chain)) continue; // 2026-06: eth/base/arb 만 지원(비활성 체인 스킵)
      const supply = s?.supply ?? 0;
      if (!(supply > 0)) continue;
      chainsForSym++;
      const supplyUsd = onchainPrice != null ? supply * onchainPrice : (s.supplyUsd ?? null); // 온체인 가격 우선(폴백 breadth)

      // 신뢰성 가드 — 최근 중앙값 대비 >35% 벗어난 read 처리.
      //   ⚠️ FN 수정(2026-06 감사): 종전엔 >35% 이면 INSERT·탐지를 둘 다 skip 했는데, 이 디텍터의 존재 이유인
      //   Kelp 식 단일이벤트 무단 대량민트(예 +35.66%)가 정확히 >35% 라 통째로 묵살됐다. 이제 **상향 급증**은
      //   탐지(z-score)를 수행하고 baseline INSERT 만 보류(quarantine — 폭증값으로 베이스라인 오염 방지),
      //   하향/양방향 flaky(redeem·결손)만 종전대로 전부 skip.
      let quarantine = false;
      const recent = await recentSupplySamples(tokenNodeId, chain, snapshotTs, TS.windowN); // 1회 조회(guard+z 공용)
      const guard = recent.slice(0, 6); // 최신 6 (recent 는 최신순) — 중복 쿼리 제거
      const sorted = guard.slice().sort((a, b) => a - b);
      if (sorted.length >= 3) {
        const med = sorted[Math.floor(sorted.length / 2)];
        const dev = classifySupplyDeviation(supply, med, DQ.supplyQuarantineDevPct);
        if (dev === "quarantine_up") {
          quarantine = true; // 상향 급증 = 무단민트 후보 → 탐지는 수행, baseline 적재만 보류
          console.warn(`[chainsupply] suspect-UP ${sym}@${chain}: ${supply.toLocaleString()} vs med ${med.toLocaleString()} — 탐지 수행, baseline 보류`);
        } else if (dev === "skip_down") {
          console.warn(`[chainsupply] suspect ${sym}@${chain}: ${supply.toLocaleString()} vs med ${med.toLocaleString()} — skip`);
          continue;
        }
      }

      if (!quarantine) {
        await query(
          `INSERT INTO chain_supply_samples (snapshot_ts, token_node_id, chain, block_number, total_supply, supply_usd)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (token_node_id, chain, snapshot_ts) DO UPDATE SET
             total_supply = EXCLUDED.total_supply, supply_usd = EXCLUDED.supply_usd`,
          [snapshotTs, tokenNodeId, chain, null, supply, supplyUsd],
        );
        samples++;
      }

      // robust z-score 스파이크 — diff.ts 와 공용 게이트(supplySpikeStats)로 단일화.
      // 연속 중복 read dedup(2026-06 FP): frozen/이중 read(소수 전체자리 동일 직전값)가 delta=0 을 만들어 MAD 를
      //   붕괴→z 폭증시키던 #724 차단. 베이스라인 무결성만 높이므로 TP 영향 없음.
      const dedup = recent.filter((v, i) => i === 0 || v !== recent[i - 1]);
      if (dedup.length >= TS.minSamples) {
        const asc = [...dedup].reverse(); // 오래된→최신
        const whitelisted = TS.autoMintWhitelist.includes(sym);
        // 체인-스파이크 relΔ 플로어 — near-flat baseline z폭발 차단. 일반 2% · whitelisted 네이티브발행(USDC/USDT
        //   Circle/Tether 가 한 폴 3~5% 정상발행) 5%. Kelp 식 무단민트(≈35%)는 둘 다 초과해 발화(info=WATCH).
        //   ⚠️ 브릿지 재분배(전체인 보존)까지 거르려면 per-chain netting 필요 — 정밀탐지는 supply_conservation 담당.
        const st = supplySpikeStats(asc, supply, TS, { whitelisted, minRel: whitelisted ? 0.05 : 0.02 });
        // staleGap: 직전 샘플이 폴주기를 크게 넘게 오래됐으면(다체인 누락/롱-아웃티지) 단일틱 z 는 누적 드리프트라 무의미 → 보류(#713 USDe 3일 stale).
        const lastTs = await latestSampleTs(tokenNodeId, chain, snapshotTs);
        const staleGap = isStaleGap(lastTs, snapshotTs, SUPPLY_STALE_GAP_MIN);
        // dip-recovery 억제: 상승(d>0)인데 curr 가 최근 윈도 최고점을 넘지 않으면(=과거에 도달했던 레벨로의 복귀/진동) 신규 mint 아님(#724 WETH).
        //   진짜 무단 대량 mint 는 윈도 최고점을 돌파(신규 고점)하므로 보존 — FN 안전.
        const recentMax = dedup.length ? Math.max(...dedup) : 0;
        const dipRecovery = !!st && st.fires && st.d > 0 && supply <= recentMax;
        if (st && st.fires && !staleGap && !dipRecovery) {
          const last = asc[asc.length - 1];
          const ok = await insertAlert({
            snapshotTs, severity: "info", kind: "chain_supply_spike", token: sym,
            protocolNodeId: `chain:${chain}`,
            message: `${chain} ${sym} — +${st.d.toFixed(2)} · z ${st.z.toFixed(1)}`,
            detail: { chain, supply, supplyUsd, prev: last, delta: Number(st.d.toFixed(2)), z: Number(st.z.toFixed(2)), baselineN: recent.length },
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
