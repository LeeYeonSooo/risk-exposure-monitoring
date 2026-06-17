/**
 * diff 룰 공용 — 여러 디텍터가 공유하는 타입·순수 헬퍼. (god-file 축소 2026-06: diff.ts 에서 분리.)
 * 의존성은 alert-thresholds(Severity)·lib/fmt 뿐 — diff.ts 와 순환 없음.
 */
import type { Severity } from "@/config/alert-thresholds";

// USD 포맷터는 단일 출처(lib/fmt)에서. 기존 import 부 호환 위해 formatUsd 이름으로 재노출.
export { fmtUsd as formatUsd } from "@/lib/fmt";

// UNCERTAIN 디텍터 정책 상수(2026-06): util_jump·liquidity_drop_dex 등 "전조인지 정상인지 확정 불가"
//   신호는 critical 승격 없이 '인지용 경고'(warning) 고정. 의도를 코드로 명시해 실수로 critical 승격 방지.
export const UNCERTAIN_SEVERITY: Severity = "warning";

const _SEV_RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 };
/** 두 severity 중 높은 것. (검출기들이 제각기 재구현하던 rank-merge 단일화.) */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return _SEV_RANK[a] >= _SEV_RANK[b] ? a : b;
}

// 프로토콜 노드 id 정규화 — 런타임 id 는 체인 스코프(`protocol:aave_v3@ethereum`)지만 config(majorProtocols 등)는
//   비-스코프(`protocol:aave_v3`)로 비교한다. `@chain` 접미를 벗겨 base id 로 맞춘다(protoLabel 과 동일 규칙).
//   이 불일치가 collateral_adoption.isMajor 영구 false 의 근본원인이었음(2026-06 감사).
export function baseProtoId(nodeId: string | null | undefined): string {
  return (nodeId ?? "").replace(/@[a-z0-9-]+$/i, "");
}

export interface DiffAlert {
  severity: Severity;
  kind: string;
  token: string;
  protocolNodeId?: string;
  message: string;
  detail?: Record<string, unknown>;
}

// 심볼 미해석 토큰 — 한 노드(token:UNKNOWN)로 충돌 적재돼 서로 다른 자산의 oracle/IRM/신규성을
// 비교하게 만든다(가짜 oracle_changed/collateral_adoption/new_market). 검증도 불가 → 신규성·구조 알림 제외.
export function isUnresolvedToken(token: string | null | undefined): boolean {
  const s = (token ?? "").trim().toUpperCase();
  return s === "" || s === "UNKNOWN";
}

// Morpho Blue 등 isolated-market 프로토콜은 마켓 생성 후 oracle/IRM 이 **immutable**.
// 그런데 엣지 헤드라인 오라클 = "최대 마켓의 대표 오라클"이라 top-market 순위가 바뀌면 주소가 회전 →
// 가짜 oracle_changed/irm_changed/oracle_paused_suspect/depeg_flag_flip 가 매시간 발화(H1 실제 발현 경로).
// 이 프로토콜군에서는 헤드라인-레벨 oracle/IRM swap 판정을 비활성(신규 마켓은 new_market 으로만 다룸).
const IMMUTABLE_MARKET_PROTOCOLS = new Set([
  "protocol:morpho_blue", "protocol:euler_v2", "protocol:euler",
]);
export function hasImmutableMarkets(protocolNodeId: string | null | undefined): boolean {
  // baseProtoId 로 체인스코프 제거 — L2 엣지 id 는 `protocol:morpho_blue@base` 라 raw 매칭이 빗나가
  //   immutable 가드가 우회되던 버그(isMajor 와 동형). 체인 무관하게 base id 로 판정.
  return IMMUTABLE_MARKET_PROTOCOLS.has(baseProtoId(protocolNodeId).toLowerCase());
}

// Morpho 마켓 불변 식별키 — collateral|loan|oracle|irm|lltv 5요소(레퍼런스 top_market_key 동형).
// 기존 `loanAsset@lltv` 2요소는 oracle/IRM/담보만 다른 별개 immutable 마켓을 한 키로 병합해
// dust 마켓 size(prev) ↔ 대형 마켓 size(curr) 를 오매칭 → 가짜 market_fast_growth/new_market.
export function marketKey(m: { collateralAsset?: string; loanAsset?: string; oracleAddress?: string; irmAddress?: string; lltv: number }): string {
  return [
    m.collateralAsset ?? "",
    m.loanAsset ?? "",
    (m.oracleAddress ?? "").toLowerCase(),
    (m.irmAddress ?? "").toLowerCase(),
    m.lltv,
  ].join("|");
}

