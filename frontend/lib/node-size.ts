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

/** log2 정규화: sizeUsd → 0..1 */
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
 * 토큰 분포 비율(share) 기반 프로토콜 지름 — **한 토큰 맵 안에서 상대적으로**.
 *   maxExposureUsd = 그 맵의 최대 프로토콜 노출(=share 1.0) → 항상 풀 레인지를 써서 차이가 직관적.
 *   절대 log2(protoDiameterPx)는 대형 프로토콜들을 좁은 밴드(80~104)에 뭉쳐 차이가 안 보였음 → 이걸로 교체.
 *   frac^0.62: 면적보다 약간 강하게(지름 차이 체감 ↑) but 과하지 않게.
 */
export const PROTO_SHARE_DIAMETER_MIN = 96;
export const PROTO_SHARE_DIAMETER_MAX = 264;
export function protoShareDiameterPx(exposureUsd: number, maxExposureUsd: number): number {
  const frac = maxExposureUsd > 0 ? Math.max(0, Math.min(1, exposureUsd / maxExposureUsd)) : 0;
  return Math.round(PROTO_SHARE_DIAMETER_MIN + (PROTO_SHARE_DIAMETER_MAX - PROTO_SHARE_DIAMETER_MIN) * Math.pow(frac, 0.62));
}

/**
 * d3-force 충돌 반경(px) — 시각 크기에 여유 마진.
 * 토큰: 원 반지름 + 라벨 여유. 프로토콜: 카드 반폭 * scale + 여유.
 */
export function collisionRadiusPx(isToken: boolean, sizeUsd: number | null | undefined): number {
  if (isToken) return tokenDiameterPx(sizeUsd) / 2 + 34; // 라벨/간격 여유
  return 100 * protoScale(sizeUsd) + 26; // 카드 반폭(≈100) * scale + 여유
}
