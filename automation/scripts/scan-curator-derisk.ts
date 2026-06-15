/**
 * 큐레이터 디리스킹(de-risk) 시그널 — vault_allocations 최근 2 스냅샷을 비교해
 * 큐레이터가 특정 마켓 할당을 크게 줄였거나(적극 withdraw) withdraw queue 에서 빼면
 * "부실채권 노출 회피" 선행신호로 본다. (피드백: 유동성 변화 = 강력한 시그널)
 * 알림 kind=curator_derisk → AlertPanel 유동성 탭. source=builtin-v1 (외부 알고리즘 swap 대비).
 * Usage: npm run scan:derisk
 */
import { closePool, query } from "@/db/client";
import { insertAlert } from "@/db/upsert";

interface AllocRow {
  snapshot_ts: string;
  vault_address: string;
  vault_name: string;
  curator: string;
  market_key: string;
  collateral: string;
  supply_usd: string | number;
  in_withdraw_queue: boolean;
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

async function main() {
  // ⚠️ DEPRECATED (2026-06 감사 A6): 이 DB-vs-DB 디텍터는 market_key=coll|loan|lltv 2요소라 H1 키충돌로
  //   별개 Morpho 마켓을 한 키로 합쳐 split-rotation 을 총액과 비교 → 가짜 curator_derisk(#261) 발화.
  //   curator_derisk 는 snapshot-curators.ts 가 라이브 담당: marketId(uniqueKey) 키 + vault net-outflow 게이트
  //   + 신호1(큐 제거)·신호2(≥60% 인출)·신호3(100% 완전회수 prev 역순회) 으로 이 스크립트가 잡던 케이스를 커버.
  //   (민감도는 의도적으로 낮음: 인출 floor 0.4→0.6 + vault 순유출 동반 요구 = FP 감소.) cron 미등록·비활성.
  console.warn("[scan:derisk] DEPRECATED — snapshot-curators.ts(marketId 키 + net-outflow) 가 대체. 알림 미발화로 종료.");
  await closePool().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
