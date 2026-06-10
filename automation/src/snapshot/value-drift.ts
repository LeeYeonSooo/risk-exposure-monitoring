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

export interface ValuePoint {
  /** epoch 초 */
  ts: number;
  /** 그 시점의 총가치 USD (Σchain supply_usd) */
  valueUsd: number;
}

export interface ValueDriftFinding {
  token: string;
  peakUsd: number;
  latestUsd: number;
  dropUsd: number;
  dropPct: number;
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

  // 윈도우 내 최고가치(자금 들어차 있던 시점) 대비 현재.
  const peak = inWindow.reduce((mx, p) => (p.valueUsd > mx.valueUsd ? p : mx), inWindow[0]);
  if (peak.ts >= latest.ts) return null; // peak 가 최신 = 하락 아님

  const dropUsd = peak.valueUsd - latest.valueUsd;
  if (dropUsd < cfg.minAbsUsd) return null; // 절대 규모 게이트(소형 노이즈 컷)
  const dropPct = peak.valueUsd > 0 ? dropUsd / peak.valueUsd : 0;
  const severity = severityForValue(dropPct, cfg.dropPct);
  if (!severity) return null;

  return {
    token, peakUsd: peak.valueUsd, latestUsd: latest.valueUsd,
    dropUsd, dropPct, severity, peakTs: peak.ts, latestTs: latest.ts, windowHours: cfg.windowHours,
  };
}
