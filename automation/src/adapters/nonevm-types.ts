/**
 * 비-EVM 렌딩 어댑터 공통 계약. 각 어댑터(Kamino·Solend·NAVI·Scallop·Suilend·Drift)는
 * 프로토콜 API/RPC 를 읽어 이 정규형 reserve 배열을 반환한다. 통합 러너가 이걸 EVM 과 동일한
 * detector 임계값(utilizationAbsolute·highLltv)으로 평가해 같은 alerts 계약으로 적재.
 */
export interface NonEvmReserve {
  protocol: string;        // 'kamino' | 'solend' | 'navi' | 'scallop' | 'suilend' | 'drift'
  chain: string;           // 'solana' | 'sui'
  market: string;          // 마켓/풀 이름
  symbol: string;          // 토큰 심볼
  maxLtv: number | null;   // 0..1 (없으면 null — 예: Drift util-only)
  utilization: number;     // 0..1 (borrow/supply)
  supplyUsd: number;
  borrowUsd: number;
  // 오라클 신선도(옵션 — 채우는 어댑터만). 피드 멈춤 = 가격 동결 → 청산 미발화 위험.
  oracleAgeSec?: number | null;     // 마지막 갱신 경과(초)
  oracleMaxAgeSec?: number | null;  // 프로토콜이 허용하는 최대 age(초)
  oracleName?: string | null;
}

/** 한 어댑터의 계약 — 실패 시 [] 반환(다른 프로토콜 비차단). */
export interface NonEvmLendingAdapter {
  protocol: string;
  fetchReserves: () => Promise<NonEvmReserve[]>;
}
