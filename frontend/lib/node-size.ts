/**
 * 노드 크기 = log2(USD 규모) 스케일.
 *
 * 사용자 요구: TVL/노출 규모를 노드 크기로 보여주되, 1 vs 100 처럼 선형으로
 * 극단적으로 벌어지지 않게 log_2 를 씌워 "차이는 나지만 과하지 않게".
 *
 * sizeUsd 의미:
 *   - 토큰 노드: 연결된 모든 (token→protocol) 엣지 amountUsd 합 = 디파이 총 노출
 *   - 프로토콜 노드: 들어오는 모든 엣지 amountUsd 합 = 프로토콜이 보유한 토큰 TVL
 *   (둘 다 "그 노드에 걸린 USD 규모" 라는 동일 개념 → 같은 스케일로 비교 가능)
 */

const FLOOR_USD = 1_000_000; // $1M 이하는 최소 크기
const CEIL_USD = 20_000_000_000; // $20B 이상은 최대 크기 (Aave 급)

const L_MIN = Math.log2(FLOOR_USD); // ≈ 19.9
const L_MAX = Math.log2(CEIL_USD); // ≈ 34.2

/** 토큰 원 노드 지름 px 범위 — 프로토콜 카드(≈176×64)보다 확실히 작게. */
export const TOKEN_DIAMETER_MIN = 40;
export const TOKEN_DIAMETER_MAX = 92;

/** 프로토콜 카드 스케일 배율 범위 (1.0 = 기본 카드) */
export const PROTO_SCALE_MIN = 0.82;
export const PROTO_SCALE_MAX = 1.5;

/**
 * log2 정규화: sizeUsd → 0..1
 *
 * sizeUsd 가 null/0("금액 미상" — 무료 소스로 못 구한 Euler·Convex 마켓 포함)이면 FLOOR_USD 로 클램프 →
 * 항상 최소 크기. "금액 미상"을 큰 노드로 부풀리지 않아 크기·집중허브 인코딩이 왜곡되지 않는다(추측 금지).
 * 미상과 진짜 작은 마켓의 시각 구분은 RiskNode/HoverTooltip 의 "금액 미상" 배지가 담당(크기 인코딩과 분리).
 */
export function sizeNorm(sizeUsd: number | null | undefined): number {
  const usd = typeof sizeUsd === "number" && sizeUsd > 0 ? sizeUsd : FLOOR_USD;
  const l = Math.log2(usd);
  const t = (l - L_MIN) / (L_MAX - L_MIN);
  return Math.max(0, Math.min(1, t));
}

/** 토큰 원 지름(px) */
export function tokenDiameterPx(sizeUsd: number | null | undefined): number {
  return TOKEN_DIAMETER_MIN + sizeNorm(sizeUsd) * (TOKEN_DIAMETER_MAX - TOKEN_DIAMETER_MIN);
}

/** 프로토콜 카드 스케일 배율 */
export function protoScale(sizeUsd: number | null | undefined): number {
  return PROTO_SCALE_MIN + sizeNorm(sizeUsd) * (PROTO_SCALE_MAX - PROTO_SCALE_MIN);
}

/** 프로토콜 원형 노드 지름(px) — 로고만 든 원(이름은 아래). 노출 규모 비례. */
export const PROTO_DIAMETER_MIN = 58;
export const PROTO_DIAMETER_MAX = 104;
export function protoDiameterPx(sizeUsd: number | null | undefined): number {
  return Math.round(PROTO_DIAMETER_MIN + sizeNorm(sizeUsd) * (PROTO_DIAMETER_MAX - PROTO_DIAMETER_MIN));
}

/**
 * 프로토콜 지름 — **한 토큰 맵 안에서 노출 규모의 log 위치(min~max)** 로 [MIN,MAX] 보간.
 *   프로토콜 노출은 $769M(Aave)~$1K(군소)로 5~6자릿수 차 → 선형 비율(frac)이면 지배 프로토콜만 거대하고
 *   나머지는 전부 최소에 뭉친다. log10 정규화로 "가장 큰 것과 작은 것의 지름 차이"를 압축(사용자 2026-06-13).
 *   minExposureUsd = 그 맵의 최소 프로토콜 노출(없으면 1) → min=MIN, max=MAX, 중간은 log 비례.
 */
export const PROTO_SHARE_DIAMETER_MIN = 104;
export const PROTO_SHARE_DIAMETER_MAX = 196;
export function protoShareDiameterPx(exposureUsd: number, maxExposureUsd: number, minExposureUsd = 0): number {
  const lg = (v: number) => Math.log10(Math.max(1, v));
  const hi = lg(maxExposureUsd), lo = lg(Math.max(1, minExposureUsd));
  const t = hi > lo ? Math.max(0, Math.min(1, (lg(exposureUsd) - lo) / (hi - lo))) : 0.5;
  return Math.round(PROTO_SHARE_DIAMETER_MIN + (PROTO_SHARE_DIAMETER_MAX - PROTO_SHARE_DIAMETER_MIN) * t);
}

/**
 * 프로토콜 노드 지름 — 3요소 복합(사용자 요청): TVL(노출) 0.5 + 트랜잭션 수 0.25 + 거래 규모 0.25.
 *   각 축을 그 맵의 최대값 대비 정규화(frac^0.6)해 가중합. 트랜잭션/규모(Dune lending.supply/borrow)가
 *   없는 프로토콜은 tx=vol=0 → TVL 비중만 반영(추측 없이 자연 축소).
 */
export function protoCompositeDiameterPx(
  exposureUsd: number, maxExposureUsd: number,
  txCount: number, maxTxCount: number,
  volumeUsd: number, maxVolumeUsd: number,
): number {
  const norm = (v: number, max: number) => (max > 0 ? Math.pow(Math.max(0, v) / max, 0.6) : 0);
  const composite = 0.5 * norm(exposureUsd, maxExposureUsd) + 0.25 * norm(txCount, maxTxCount) + 0.25 * norm(volumeUsd, maxVolumeUsd);
  return Math.round(PROTO_SHARE_DIAMETER_MIN + (PROTO_SHARE_DIAMETER_MAX - PROTO_SHARE_DIAMETER_MIN) * composite);
}

/**
 * d3-force 충돌 반경(px) — 시각 크기에 여유 마진.
 * 토큰: 원 반지름 + 라벨 여유. 프로토콜: 카드 반폭 * scale + 여유.
 */
export function collisionRadiusPx(isToken: boolean, sizeUsd: number | null | undefined): number {
  if (isToken) return tokenDiameterPx(sizeUsd) / 2 + 34; // 라벨/간격 여유
  return 100 * protoScale(sizeUsd) + 26; // 카드 반폭(≈100) * scale + 여유
}
