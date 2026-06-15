/**
 * Rule 4 / 4b: 오라클 변경·정지·하드코딩 전환 + Chainlink 피드 staleness. (diff.ts 에서 분리.)
 */
import { classifyAsset, isIntentionalDiscountOracle, type AlertThresholds } from "@/config/alert-thresholds";
import { protoLabel } from "@/lib/proto-label";
import { type DiffAlert, hasImmutableMarkets, isUnresolvedToken } from "@/snapshot/rules/shared";
import type { EdgeSnapshot, TokenSnapshotResult } from "@/types/edge-schema";

export function checkOracleChange(
  token: string,
  curr: EdgeSnapshot,
  prev: EdgeSnapshot,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  if (isUnresolvedToken(token)) return out;  // 미해석 토큰 — 충돌노드 비교 불가(R6)
  // R5: Morpho/Euler 등 isolated 마켓은 마켓별 oracle 이 immutable. 엣지 헤드라인 oracle = 최대마켓
  // 대표 오라클이라 top-market 순위 변동 시 주소/타입/플래그가 전부 회전 → oracle_changed·
  // oracle_paused_suspect·oracle_hardcoded_switch·oracle_depeg_flag_flip 가 가짜 발화(활성 FP 23건).
  // 이 프로토콜군에서는 헤드라인-레벨 oracle 변경 판정 전체를 비활성(신규 마켓은 new_market 으로만).
  if (hasImmutableMarkets(curr.target)) return out;
  const prevOracle = prev.attrs?.oracle;
  const currOracle = curr.attrs?.oracle;
  if (!prevOracle || !currOracle) return out;

  // 오라클 introspection 분류 flap 가드(2026-06 FP 수정) — 같은 오라클 컨트랙트(주소 동일)인데 type/depeg-flag 만
  //   뒤집힌 건 introspection 노이즈다(예: Spark 고정 $1 오라클을 스냅샷마다 MARKET↔ORACLE_FREE 로 오분류 → 가짜
  //   하드코딩전환·디페그플래그변동·정지의심). 진짜 전환은 오라클 주소가 바뀐다 → 아래 type/flag 전환 detector 는
  //   주소 변화(oracleAddrChanged)가 동반될 때만 발화. (순수 주소 swap 은 oracle_changed 가 이미 담당.)
  const pa = prevOracle.address ? prevOracle.address.toLowerCase() : null;
  const ca = currOracle.address ? currOracle.address.toLowerCase() : null;
  const oracleAddrChanged = pa !== ca;

  // ⚠️ 중복 dedup(2026-06): 아래 특수화(paused/hardcoded)는 전부 oracleAddrChanged 조건이라 generic
  //   oracle_changed 와 같은 이벤트에 이중 발화하던 문제 → 특수화가 잡으면 oracle_changed 는 skip(가장 구체적 1건만).
  let specialized = false;

  // Type 변경 (MARKET → NONE = paused/freeze 의심) — critical(가격소스 소멸).
  if (prevOracle.type === "MARKET" && currOracle.type === "NONE" && oracleAddrChanged) {
    specialized = true;
    out.push({
      severity: "critical",
      kind: "oracle_paused_suspect",
      token,
      protocolNodeId: curr.target,
      message: `${protoLabel(curr.target)} — MARKET → NONE`,
      detail: { prev: prevOracle.type, curr: currOracle.type, oracleSwap: `${prevOracle.address} → ${currOracle.address}` },
    });
  }

  // 정상 라이브 피드 → 하드코딩(ORACLE_FREE) 전환 = critical (BACKLOG P1-4, §6.7 핵심 통찰).
  // 가격이 온체인에서 안 움직이면 디페그 시 청산이 안 걸려 bad debt 가 조용히 쌓인다 → Tier 0 "하드코딩오라클" 승격.
  const LIVE_ORACLE = new Set(["MARKET", "EXCHANGE_RATE"]);
  if (LIVE_ORACLE.has(prevOracle.type) && currOracle.type === "ORACLE_FREE" && oracleAddrChanged) {
    specialized = true;
    // BACKLOG P2-8: RWA(mF-ONE 류)는 NAV 대비 의도적 디스카운트 고정이 정상 설계 → critical 다운그레이드.
    const intentional = isIntentionalDiscountOracle(token, currOracle.type);
    out.push({
      severity: intentional ? "warning" : "critical",
      kind: "oracle_hardcoded_switch",
      token,
      protocolNodeId: curr.target,
      message: intentional
        ? `${protoLabel(curr.target)} — ${prevOracle.type} → ORACLE_FREE · RWA 디스카운트 확인 요`
        : `${protoLabel(curr.target)} — ${prevOracle.type} → ORACLE_FREE`,
      detail: { prev: prevOracle.type, curr: currOracle.type, rwaIntentional: intentional, oracleSwap: `${prevOracle.address} → ${currOracle.address}` },
    });
  }

  // 순수 주소 swap(특수화 아님)만 generic oracle_changed. (특수화가 잡았으면 그게 더 구체적이라 생략 = 이중발화 제거.)
  if (oracleAddrChanged && prevOracle.address && currOracle.address && !specialized) {
    out.push({
      severity: t.oracle.addressChange,
      kind: "oracle_changed",
      token,
      protocolNodeId: curr.target,
      message: `${protoLabel(curr.target)} — ${prevOracle.address}→${currOracle.address}`,
      detail: { prev: prevOracle.address, curr: currOracle.address },
    });
  }

  // (oracle_depeg_flag_flip 제거 2026-06: 주소변경 동반조건이라 oracle_changed/특수화가 이미 커버 + 플래그 토글은 저신호·flap-prone 중복.)

  return out;
}

// 토큰의 정식 Chainlink USD 피드(FeedRegistry, snapshot-token 이 캡처)가 멈추면(updatedAt 노후) 디페그가
//   온체인에 안 잡혀 청산 미발화 → silent bad debt. heartbeatByClass × stalenessFactor 초과 = frozen ·
//   answer≤0 = invalid · answeredInRound<roundId = 미완료 라운드. FeedRegistry 미등록 토큰(LST/exotic)이면 oracleFeed=null → skip.
// 자산클래스 heartbeat 가 부정확한 알려진 피드의 per-symbol override(초). 래핑 BTC·커머디티는
// 실제 일일(24h) 갱신 피드라 major(2h)로 두면 정상 갱신이 매 사이클 FROZEN 오발화(cbBTC #407 류).
const HEARTBEAT_OVERRIDE_SEC: Record<string, number> = {
  CBBTC: 86400, WBTC: 86400, TBTC: 86400, LBTC: 86400, PAXG: 86400, XAUT: 86400,
};

export function checkOracleStaleness(current: TokenSnapshotResult, nowSec: number, t: AlertThresholds): DiffAlert[] {
  const f = current.token.metadata.oracleFeed;
  if (!f || !(f.updatedAt > 0)) return [];
  const token = current.token.label;
  if (f.answer <= 0) {
    return [{ severity: "critical", kind: "oracle_stale", token,
      message: `${token} — 오라클 answer ≤ 0`,
      detail: { reason: "non_positive_answer", answer: f.answer } }];
  }
  if (f.roundStale) {
    return [{ severity: "critical", kind: "oracle_stale", token,
      message: `${token} — 오라클 미완료 라운드`,
      detail: { reason: "stale_round" } }];
  }
  const heartbeat = HEARTBEAT_OVERRIDE_SEC[(token ?? "").toUpperCase()] ?? t.oracle.heartbeatByClass[classifyAsset(token)];
  const maxAge = heartbeat * t.oracle.stalenessFactor;
  const age = nowSec - f.updatedAt;
  if (age > maxAge) {
    return [{ severity: "critical", kind: "oracle_stale", token,
      message: `${token} — 오라클 정지 ${(age / 3600).toFixed(1)}h / ${(maxAge / 3600).toFixed(1)}h`,
      detail: { reason: "stale", ageSec: age, maxAgeSec: maxAge, updatedAt: f.updatedAt } }];
  }
  return [];
}
