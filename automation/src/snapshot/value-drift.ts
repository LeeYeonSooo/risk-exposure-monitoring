/**
 * NAV×supply 가치-드리프트 (BACKLOG P2-6, 전문가 §3.2).
 *
 * 총가치 = price(NAV) × supply. 토큰의 **체인 합산 총가치 시계열**(chain_supply_samples.supply_usd)에서
 * 최근 윈도우 내 peak 대비 급락하면 "밸류 유출"(자금이 빠짐 — 뱅크런/리뎀션런/대량 인출)로 본다.
 *
 * 순수 함수 — 시계열을 받아 finding 만 계산(러너가 DB IO + insertAlert). 백테스트/재사용 가능.
 * 정상 변동(소폭 출렁임)과 분리: dropPct 임계 + **minAbsUsd 절대 게이트**(소형 토큰 노이즈 컷).
 */
import { type AlertThresholds, RECOMMENDED_THRESHOLDS, severityForValue, type Severity } from "@/config/alert-thresholds";
import { hasLowChainCoverage } from "@/snapshot/data-quality";

export interface ValuePoint {
  /** epoch 초 */
  ts: number;
  /** 그 시점의 총가치 USD (Σchain supply_usd) */
  valueUsd: number;
  /** 그 스냅샷에 합산된 체인 수 — 부분-스냅샷(결손 런) 식별용. */
  nChains: number;
  /** 그 시점의 총공급 units (Σchain total_supply) — 가치낙폭의 유출(units↓) vs 가격마크다운(units 유지) 분해용. 없으면 미분해. */
  supplyUnits?: number | null;
}

export interface ValueDriftFinding {
  token: string;
  peakUsd: number;
  latestUsd: number;
  dropUsd: number;
  dropPct: number;
  /** 가치낙폭 중 공급 감소가 설명한 비율(peak→latest). null=공급 데이터 결손(미분해, 보수적 발화). */
  supplyDropPct: number | null;
  severity: Severity;
  peakTs: number;
  latestTs: number;
  windowHours: number;
}

/**
 * 윈도우 내 peak 대비 최신값 낙폭. peak 가 최신이면(상승/평탄) null.
 * dropPct ≥ 임계 AND dropUsd ≥ minAbsUsd 일 때만 finding.
 */
export function computeValueDrift(
  token: string,
  series: ValuePoint[],
  t: AlertThresholds = RECOMMENDED_THRESHOLDS,
): ValueDriftFinding | null {
  const cfg = t.valueDrift;
  if (series.length < cfg.minSamples) return null;
  const sorted = [...series].filter((p) => Number.isFinite(p.valueUsd) && p.valueUsd > 0).sort((a, b) => a.ts - b.ts);
  if (sorted.length < cfg.minSamples) return null;

  const latest = sorted[sorted.length - 1];
  const windowStart = latest.ts - cfg.windowHours * 3600;
  const inWindow = sorted.filter((p) => p.ts >= windowStart);
  if (inWindow.length < cfg.minSamples) return null;

  // ★ 부분-스냅샷(결손 런) 가드 — 비-ETH read 일시실패 등으로 일부 체인이 누락된 런(낮은 nChains)은
  //   전 체인 정상 런(높은 nChains)과 합계가 달라 "가짜 급락"을 만든다(peak=전체인 vs latest=결손 = phantom drop).
  //   latest 커버리지가 윈도 최대 대비 부족하면 비교 불가로 skip → 다음 풀-커버리지 런에서 재평가(TP는 보존:
  //   진짜 유출이면 체인은 양쪽에 존재해 nChains 가 유지된다). 결손 런은 value 가 낮아 peak 으로도 안 뽑힘.
  const maxChains = inWindow.reduce((m, p) => Math.max(m, p.nChains ?? 0), 0);
  if (hasLowChainCoverage(latest.nChains ?? 0, maxChains, cfg.minChainCoverageRatio)) return null;

  // 윈도우 내 최고가치(자금 들어차 있던 시점) 대비 현재.
  const peak = inWindow.reduce((mx, p) => (p.valueUsd > mx.valueUsd ? p : mx), inWindow[0]);
  if (peak.ts >= latest.ts) return null; // peak 가 최신 = 하락 아님

  const dropUsd = peak.valueUsd - latest.valueUsd;
  if (dropUsd < cfg.minAbsUsd) return null; // 절대 규모 게이트(소형 노이즈 컷)
  const dropPct = peak.valueUsd > 0 ? dropUsd / peak.valueUsd : 0;
  const severity = severityForValue(dropPct, cfg.dropPct);
  if (!severity) return null;

  // ★ 유출(units↓) vs 가격 마크다운(units 유지) 분해(2026-06 FP 수정): valueUsd=supply×price 라 가격만 폭락해도
  //   Σsupply_usd 가 무너진다(illiquid 토큰 stale 시세 보정 등). 진짜 "대량 인출/유출"은 units 가 빠진다 → peak→latest
  //   공급 감소가 가치낙폭의 minSupplyShareOfDrop 미만이면 가격 마크다운으로 보고 발화 안 함(유출 오판 차단).
  //   ⚠️ 공급 데이터 결손(peak/latest supplyUnits 없음)이면 분해 불가 → 보수적으로 발화 유지(supplyDropPct=null).
  let supplyDropPct: number | null = null;
  if (peak.supplyUnits != null && peak.supplyUnits > 0 && latest.supplyUnits != null && latest.supplyUnits >= 0) {
    supplyDropPct = (peak.supplyUnits - latest.supplyUnits) / peak.supplyUnits;
    if (supplyDropPct < dropPct * cfg.minSupplyShareOfDrop) return null; // 공급 거의 유지 = 가격 마크다운, 유출 아님
  }

  return {
    token, peakUsd: peak.valueUsd, latestUsd: latest.valueUsd,
    dropUsd, dropPct, supplyDropPct, severity, peakTs: peak.ts, latestTs: latest.ts, windowHours: cfg.windowHours,
  };
}
