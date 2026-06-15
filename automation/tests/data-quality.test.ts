/**
 * 데이터 품질 가드 술어 골든 테스트 — 부분-스냅샷 가드 추출(2026-06)의 동작 보존 고정.
 *
 * scan/chain-supply 가드는 종전 DB·네트워크 IO 스크립트 안에 인라인이라 테스트 불가였다. 순수 술어로
 *   추출하면서 각 사이트의 현재 동작(특히 경계값)을 여기서 못박는다. 임계는 RECOMMENDED_THRESHOLDS 실값.
 * 실행: npm test
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RECOMMENDED_THRESHOLDS as T } from "@/config/alert-thresholds";
import {
  classifySupplyDeviation, hasLowChainCoverage, isStaleGap, isSuspectPartialScan,
} from "@/snapshot/data-quality";

const MAX_STALE = T.utilizationLiquidity.maxStalenessMin; // 360
const COVER_RATIO = T.valueDrift.minChainCoverageRatio;   // 0.8
const DQ = T.dataQuality;                                  // {20, 5, 0.5, 0.35}

describe("isStaleGap (velocity 룰 시간갭)", () => {
  test("정확히 maxStalenessMin = 억제 안 함(> 만 발화)", () => {
    assert.equal(isStaleGap("2026-06-14T00:00:00Z", "2026-06-14T06:00:00Z", MAX_STALE), false); // 360min
  });
  test("maxStalenessMin 초과 → staleGap true", () => {
    assert.equal(isStaleGap("2026-06-14T00:00:00Z", "2026-06-14T06:01:00Z", MAX_STALE), true); // 361min
  });
  test("타임스탬프 결손 → 갭 판정 불가 → false", () => {
    assert.equal(isStaleGap(null, "2026-06-14T06:01:00Z", MAX_STALE), false);
    assert.equal(isStaleGap("2026-06-14T00:00:00Z", undefined, MAX_STALE), false);
  });
});

describe("hasLowChainCoverage (value_drift breadth)", () => {
  test("경계: latest = max×ratio 는 결손 아님(< 만 발화)", () => {
    assert.equal(hasLowChainCoverage(4, 5, COVER_RATIO), false); // 4 < 4.0 = false
  });
  test("latest < max×ratio → 결손 true", () => {
    assert.equal(hasLowChainCoverage(3, 5, COVER_RATIO), true); // 3 < 4.0
  });
  test("이력 없음(maxN=0) → 비교 기준 없음 → false", () => {
    assert.equal(hasLowChainCoverage(0, 0, COVER_RATIO), false);
  });
});

describe("classifySupplyDeviation (baseline 무결성)", () => {
  test("median 대비 상향 급증(>devPct) → quarantine_up(탐지 유지·적재 보류)", () => {
    assert.equal(classifySupplyDeviation(136, 100, DQ.supplyQuarantineDevPct), "quarantine_up");
  });
  test("median 대비 하향 급변(>devPct) → skip_down(전부 skip)", () => {
    assert.equal(classifySupplyDeviation(64, 100, DQ.supplyQuarantineDevPct), "skip_down");
  });
  test("band 내(<devPct) → normal", () => {
    assert.equal(classifySupplyDeviation(130, 100, DQ.supplyQuarantineDevPct), "normal");
  });
  test("경계: 정확히 devPct 는 normal(> 만 격리)", () => {
    assert.equal(classifySupplyDeviation(135, 100, DQ.supplyQuarantineDevPct), "normal"); // 0.35 not >0.35
  });
  test("median ≤ 0 → 비교 불가 → normal", () => {
    assert.equal(classifySupplyDeviation(100, 0, DQ.supplyQuarantineDevPct), "normal");
  });
});

describe("isSuspectPartialScan (auto-resolve 보류)", () => {
  test("row 부족(<minRows) → 결손 의심 true", () => {
    assert.equal(isSuspectPartialScan(19, 0, 0, DQ), true);
  });
  test("row 충분 + active 적음(<minActiveForRatio) → 비율 게이트 off → false", () => {
    assert.equal(isSuspectPartialScan(20, 4, 0, DQ), false);
  });
  test("active 충분 + asserted < active×ratio → 결손 의심 true", () => {
    assert.equal(isSuspectPartialScan(25, 5, 2, DQ), true); // 2 < 2.5
  });
  test("active 충분 + asserted ≥ active×ratio → 정상 → false", () => {
    assert.equal(isSuspectPartialScan(25, 5, 3, DQ), false); // 3 ≥ 2.5
  });
});
