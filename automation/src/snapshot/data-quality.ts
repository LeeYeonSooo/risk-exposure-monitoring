/**
 * 데이터 품질 가드 — 열화/결손 스냅샷일 때 행동을 보류하는 **술어 패밀리**.
 *
 * ⚠️ 설계 주의(2026-06): 이건 "통일된 단일 술어"가 아니다. 모니터링 4곳이 부분-스냅샷을
 *   각기 다른 신호로 감지해 각기 다른 행동을 억제한다 — 입력도, 억제대상도, 심지어 입력측(탐지)
 *   vs 출력측(해소)인지조차 다르다. 하나의 isSnapshotTrustworthy() 로 뭉치면 서로 다른 실패
 *   모드를 conflate 하는 lossy 추상화가 된다. 그래서 **개별 명명 술어**로 한 모듈에 모으되 의미는
 *   분리한다(발견성·테스트가능성만 취하고 의미는 보존). 각 사이트는 자기 술어를 호출한다.
 *
 *   | 술어 | 신호 | 억제 대상 | 성격 |
 *   |---|---|---|---|
 *   | isStaleGap                | prev↔curr 시간갭   | velocity 알림 발화(util_jump·liq_drop) | 입력측·시의성 |
 *   | hasLowChainCoverage       | latest 체인 수     | value_drift 알림 발화                  | 입력측·breadth |
 *   | classifySupplyDeviation   | 값 vs median       | baseline INSERT 만(탐지는 유지)        | baseline 무결성 |
 *   | isSuspectPartialScan      | row 수 / asserted비율 | auto-resolve(해소)                   | 출력측·cardinality |
 *
 * 순수 함수만 — DB/네트워크 IO 없음. 임계는 인자로 주입(도메인 config 의 단일 출처를 그대로 사용).
 */

// ── 1. staleGap (rates.ts: utilization_jump·liquidity_drop_dex) ──
// prev↔curr 스냅샷 간격이 기대 폴 주기를 크게 넘으면 "단일 tick 급변"이 아니라 커버리지 갭 누적
//   드리프트 → velocity 룰 억제. ISO 타임스탬프 둘 중 하나라도 없으면 갭 판정 불가 → false(억제 안 함).
export function isStaleGap(
  prevTsIso: string | null | undefined,
  currTsIso: string | null | undefined,
  maxStalenessMin: number,
): boolean {
  const prevTs = prevTsIso ? new Date(prevTsIso).getTime() : null;
  const currTs = currTsIso ? new Date(currTsIso).getTime() : null;
  const elapsedMin = prevTs != null && currTs != null ? (currTs - prevTs) / 60000 : null;
  return elapsedMin != null && elapsedMin > maxStalenessMin;
}

// ── 2. chain-coverage (value-drift.ts: value_drift) ──
// 일부 체인 누락 런(낮은 latestN)은 전-체인 정상 런(높은 maxN)과 합계가 달라 phantom drop 을 만든다.
//   maxN 이 0(이력 없음)이면 비교 기준이 없으니 통과(false). latestN 이 maxN×ratio 미만이면 결손 → true.
export function hasLowChainCoverage(latestNChains: number, maxNChains: number, minRatio: number): boolean {
  return maxNChains > 0 && latestNChains < maxNChains * minRatio;
}

// ── 3. supply baseline 무결성 (snapshot-chain-supply.ts) ──
// median 대비 devPct 초과 **상향** read = 무단민트 후보 → 탐지는 수행하되 baseline 적재 보류(quarantine_up).
//   하향 이탈 = flaky/redeem → 둘 다 skip(skip_down). median≤0 이거나 편차가 band 안이면 정상(normal).
//   ⚠️ 다른 3개와 달리 "탐지 억제"가 아니라 "baseline 오염 방지"가 목적 — 3분기라 boolean 이 아닌 분류.
export type SupplyDeviationClass = "normal" | "quarantine_up" | "skip_down";
export function classifySupplyDeviation(supply: number, median: number, devPct: number): SupplyDeviationClass {
  if (median > 0 && Math.abs(supply - median) / median > devPct) {
    return supply > median ? "quarantine_up" : "skip_down";
  }
  return "normal";
}

// ── 4. scan partial-read (scan-current-risks.ts: auto-resolve 보류) ──
// edges 부분 결손(어댑터 실패)으로 asserted 가 비정상 축소되면 지속 critical 을 글리치로 대량 resolve 한다.
//   row 가 너무 적거나(rowCount<minRows), active 충분(≥minActiveForRatio)한데 asserted 가 절반 미만이면 결손 의심.
export interface ScanPartialCfg { scanMinRows: number; scanMinActiveForRatio: number; scanAssertedRatio: number }
export function isSuspectPartialScan(
  rowCount: number,
  activeKeyCount: number,
  assertedCount: number,
  cfg: ScanPartialCfg,
): boolean {
  return rowCount < cfg.scanMinRows
    || (activeKeyCount >= cfg.scanMinActiveForRatio && assertedCount < activeKeyCount * cfg.scanAssertedRatio);
}
