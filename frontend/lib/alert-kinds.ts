/**
 * 알림 kind 단일 출처 — 백엔드(automation)가 실제 발화하는 전 kind 의 한국어 라벨 + 카테고리.
 * 프론트 여러 표면(홈 피드·AlertDock·AlertPanel)이 이 파일을 공유해 매핑 드리프트를 막는다.
 * 백엔드 kind 추가 시 여기 한 곳만 갱신.
 */

export type AlertCategory = "minting" | "depeg" | "contract" | "liquidity";

/** 백엔드 발화 kind 전수 → 한국어 라벨. 미등록 kind 는 KIND_LABEL[k] ?? k 로 폴백(원문 노출). */
// 라벨 스타일(2026-06 단순화): 칩에 들어갈 **짧은 명사구**로 통일. 수식어(가중/한계/통계/의심 등)는 제거하고
//   본질만 — 상세는 KIND_DESC·본문 message 가 담당. 영문 통용어(depeg·utilization)는 그대로 둔다(사용자 라벨 정책).
export const KIND_LABEL: Record<string, string> = {
  // 민팅/공급 무결성
  supply_spike: "공급 이상",
  supply_single_mint: "대량 민트",
  chain_supply_spike: "체인 공급 이상",
  unmatched_mint: "무담보 민트",
  supply_conservation: "무담보 발행",
  // 디페그
  depeg: "depeg",
  // 부실/청산
  bad_debt_threshold: "부실채권",
  near_liquidation: "청산 위험",
  // 컨트랙트/구조
  new_market: "신규 마켓",
  collateral_adoption: "담보 채택",
  oracle_changed: "오라클 변경",
  oracle_stale: "오라클 정지",
  oracle_paused_suspect: "오라클 정지 의심",
  oracle_hardcoded_switch: "오라클 하드코딩",
  irm_changed: "IRM 변경",
  irm_base_rate_jump: "금리 급변",
  reserve_frozen: "리저브 동결",
  high_lltv_market: "고 LLTV",
  // 유동성/자금흐름
  high_utilization: "utilization 높음",
  utilization_jump: "utilization 급등",
  liquidity_drop_dex: "DEX 유동성 급감",
  whale_unwind: "고래 이탈",
  curator_derisk: "큐레이터 디리스킹",
  value_drift: "총가치 급락",
};

/**
 * 사문 라벨 — 백엔드가 더 이상 발화하지 않는 kind. 2026-06 정리. KIND_LABEL 활성에서 분리하되 과거 resolved
 *   알림이 raw kind 로 깨지지 않게 kindLabel 폴백용으로만 보존. 신규 발화 없음. "구 " 접두로 표시.
 *   unbacked_supply 는 supply_conservation 에 흡수. oracle_depeg_flag_flip·liquidity_drop_lending·
 *   market_fast_growth·unverified_large_exposure 제거. wallet_value_drop 제거 — 미식별 지갑 단순 급감은 비행동가능.
 */
const DEPRECATED_KIND_LABEL: Record<string, string> = {
  unbacked_supply: "구 무담보 공급",
  oracle_depeg_flag_flip: "구 오라클 디페그플래그 변동",
  liquidity_drop_lending: "구 대출 유동성 급감",
  market_fast_growth: "구 마켓 급성장",
  unverified_large_exposure: "구 미검증 대형노출",
  wallet_value_drop: "구 지갑 밸류 급감",
};

/** kind → 카테고리(4분류). 미등록은 catOf 에서 contract 폴백 + dev 경고. */
export const CATEGORY: Record<string, AlertCategory> = {
  // 민팅/공급
  supply_spike: "minting",
  supply_single_mint: "minting",
  chain_supply_spike: "minting",
  unmatched_mint: "minting",
  supply_conservation: "minting",
  // 디페그
  depeg: "depeg",
  // 부실/청산은 렌딩 리스크 → liquidity(디페깅 분류는 의미상 어색)
  bad_debt_threshold: "liquidity",
  near_liquidation: "liquidity",
  // 컨트랙트/구조
  new_market: "contract",
  collateral_adoption: "contract",
  oracle_changed: "contract",
  oracle_stale: "contract",
  oracle_paused_suspect: "contract",
  oracle_hardcoded_switch: "contract",
  irm_changed: "contract",
  irm_base_rate_jump: "contract",
  reserve_frozen: "contract",
  high_lltv_market: "contract",
  // 유동성/자금흐름
  high_utilization: "liquidity",
  utilization_jump: "liquidity",
  liquidity_drop_dex: "liquidity",
  whale_unwind: "liquidity",
  curator_derisk: "liquidity",
  value_drift: "liquidity",
};

const _warned = new Set<string>();
export function catOf(kind: string): AlertCategory {
  const c = CATEGORY[kind];
  if (!c) {
    if (process.env.NODE_ENV !== "production" && !_warned.has(kind)) {
      _warned.add(kind);
      console.warn(`[alert-kinds] 미매핑 kind "${kind}" → contract 폴백. lib/alert-kinds.ts 에 추가 필요.`);
    }
    return "contract";
  }
  return c;
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? DEPRECATED_KIND_LABEL[kind] ?? kind;
}

/**
 * kind → 핵심 상세설명. 한눈에 "지금 무슨 상황인지". 알림 펼침·툴팁용. 2026-06 라벨 리뷰 산출.
 * 스타일: 괄호 없이 1줄 상황 + 1줄 의미·판단포인트. 구체 수치는 백엔드 message 가 보완.
 */
export const KIND_DESC: Record<string, string> = {
  // 민팅/공급 무결성
  supply_spike: "이더리움 totalSupply 시계열에서 통계적으로 튄 공급 변동. 단독은 관찰 등급 — 단일 대량 민트와 같이 뜨면 무담보 발행 의심으로 승격.",
  supply_single_mint: "한 트랜잭션이나 블록에서 공급의 5% 이상을 단일 발행, 10% 이상이면 critical — 비인가 수신자로 가는 무담보 무한민팅 의심. Kelp 패턴.",
  chain_supply_spike: "특정 체인의 토큰 공급이 통계적으로 급증 — 비정상 민팅이나 브릿지 유입 의심. 단독은 관찰 등급, 브릿지 재분배 가능성 있어 교차체인 검증은 별도 신호가 담당.",
  unmatched_mint: "크로스체인 mint인데 짝이 될 소스 체인 burn이 없음 — 담보 없이 찍힌 발행 의심. backing 불일치까지 겹치면 critical 로 Kelp 시그니처.",
  supply_conservation: "L2 관측 공급이 홈 체인 escrow 잠금분을 초과하거나 escrow 가 무단 급락 — 담보 없는 크로스체인 발행 의심. Kelp 정조준 디텍터.",
  // 디페그
  depeg: "토큰 시장가가 peg 아래로 이탈 — USD 는 $1, LST 는 ETH×NAV, BTC 래퍼는 BTC 기준. 판단 포인트는 담보를 어느 오라클로 평가하나다. NAV·CAPO 면 청산위험 낮음, 자가보고·하드코딩 오라클 노출 크면 청산 미발화로 부실 누적.",
  // 부실/청산
  bad_debt_threshold: "마켓 차입액이 담보액을 초과 — 이미 실현된 부실채권으로 손실 확정. deficit 이 클수록 위험, $50M 이상이면 critical.",
  near_liquidation: "마켓의 큰 개별 차입 포지션이 청산임계에 근접 — 담보 −3% 위험권, −1.5% 면 critical. 집계 평균이 아니라 차입 ≥$1M 개별 포지션의 헬스팩터 기준. 그 포지션 청산 시 마켓에 부실 전파.",
  // 컨트랙트/구조
  new_market: "신규 렌딩 마켓 생성 — 미검증 담보에 고LLTV 면 위험해서 critical, 블루칩 담보 신규는 정보성.",
  collateral_adoption: "프로토콜이 새 자산을 담보로 상장 — 메이저 렌딩이 미검증 담보를 대량 채택하면 critical. Kelp·Stream 식 사전신호.",
  oracle_changed: "프로토콜 오라클 컨트랙트 주소가 교체됨 — 거버넌스 업그레이드일 수도 악성일 수도. 어떤 피드로 바뀌었는지 확인 필요.",
  oracle_stale: "Chainlink 가격피드가 멈춤 — 갱신 노후나 answer 0 이하. 가격 동결로 청산이 안 걸려 부실이 조용히 쌓임.",
  oracle_paused_suspect: "오라클 가격소스 타입이 MARKET 에서 NONE 으로 사라짐 — 일시정지나 동결 의심. 청산 평가 불가 상태일 수 있음.",
  oracle_hardcoded_switch: "오라클이 라이브 피드에서 고정가 하드코딩으로 전환 — 가격이 안 움직여 청산 미발화. RWA 의도적 할인이면 정상이라 warning.",
  irm_changed: "금리모델 IRM 컨트랙트가 교체됨 — 보통 거버넌스 정상 업데이트라 info. 실제 금리 변화는 기준금리 급변에서 확인.",
  irm_base_rate_jump: "렌딩 기준금리가 크게 점프 — 8pp 이상이면 거버넌스 긴급 조정 의심. 차입자 비용과 인출 압력 변화 신호.",
  reserve_frozen: "렌딩 리저브가 동결됨 — 방금 동결된 전이면 사건 대응 의심, 기존 동결은 방어적 봉쇄라 info. 대형 노출 신규동결은 critical.",
  high_lltv_market: "비-EVM 렌딩의 고LTV 담보 마켓, LTV 90% 이상 — 담보 급락 시 청산 여유가 작은 구조적 위험 상태. 정보성.",
  // 유동성/자금흐름
  high_utilization: "마켓 이용률이 한계권 98% 이상 — 공급자 인출이 어렵거나 사실상 봉쇄. 99.5% 이상 대형마켓이면 critical, 차입규모 클수록 전염 위험.",
  utilization_jump: "단기간 이용률이 급등, 12pp 이상이고 70% 이상 안착 — 차입 폭증이나 인출 러시 전조 가능. 정상 대형차입과 구분 불가라 확인 필요.",
  liquidity_drop_dex: "토큰의 DEX 유동성이 최근 윈도 최저점을 깨고 급감, 25% 이상이고 $1M 이상 — 매도나 청산 시 슬리피지 급증. 정상 LP 이탈과 구분 불가라 확인 필요.",
  curator_derisk: "Morpho 큐레이터가 특정 담보를 vault 에서 인출하거나 회수, 순AUM −10% 이상 동반 — 큐레이터가 그 담보를 위험으로 판단. 완전회수일수록 강한 이탈.",
  value_drift: "토큰 총가치가 24h peak 대비 급감하고 공급 자체도 감소 동반 — 25% 이상이고 $10M 이상이면 대량 인출이나 리뎀션런 의심. 가격 하락만이 아닌 실자금 이탈.",
  whale_unwind: "상위 보유자 고래가 보유 토큰을 대량 인출, $1M 이상이고 $50M 이상이면 critical — 매도압과 신뢰이탈 신호. 청산 직전 선제 이탈일 수 있음.",
};

/** kind → 상세설명. 없으면 빈 문자열. 알림 펼침·툴팁에서 "이 알림이 뭔가" 표시용. */
export function kindDesc(kind: string): string {
  return KIND_DESC[kind] ?? "";
}

/**
 * 표시용 메시지 정리 — 백엔드 message 의 가장 거슬리는 누출만 정리(전체 재작성 아님):
 *  · `protocol:`·`token:` 노드 id 접두사 제거  · 0x 풀주소 → 0x1234…abcd 축약
 * (언어 혼용·숫자 포맷은 백엔드 message 스타일 가이드 영역 — 별도 과제)
 */
const CHAIN_SUFFIX_RE = /@(?:ethereum|arbitrum|arb|optimism|opt|base|polygon|avalanche|avax|bsc|gnosis|scroll|linea|mantle|metis|unichain|worldchain|zksync|sonic|celo|soneium|plasma)\b/gi;

// 본문 맨 앞 kind 라벨 접두 제거용 — 라벨은 칩으로 이미 표시되므로 본문에 또 쓰면 중복(예: "청산 임박 · …").
//   현재 라벨(KIND_LABEL[kind]) + 과거/영문 변형 별칭이 `·`·`:`·`—`·`→` 구분자와 함께 맨 앞에 오면 그 접두만 제거.
//   라벨로 시작하지 않는 본문은 손대지 않음(오제거 방지).
const KIND_LEAD_ALIASES = ["근청산", "청산 임박", "청산위험(집계)", "고LLTV 마켓", "High-LLTV", "New market", "신규 마켓", "리저브 동결"];
function escapeReg(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function stripKindLead(s: string, kind?: string): string {
  const leads = [kind ? KIND_LABEL[kind] : null, ...KIND_LEAD_ALIASES].filter(Boolean) as string[];
  for (const L of leads) {
    const pat = escapeReg(L).replace(/\\?\s+/g, "\\s*");   // 라벨 내부 공백 차이 허용("고 LLTV 마켓" ↔ "고LLTV 마켓")
    const re = new RegExp(`^\\s*${pat}\\s*(?:·|:|—|→)\\s*`, "i");
    if (re.test(s)) return s.replace(re, "");
  }
  return s;
}

/** 표시용 메시지 정리. kind 를 넘기면 본문 맨 앞의 중복 kind 라벨 접두도 제거. */
export function prettyMessage(msg: string, kind?: string): string {
  const cleaned = (msg ?? "")
    .replace(/\b(?:protocol|token):/g, "")
    .replace(CHAIN_SUFFIX_RE, "")              // `USDC@arbitrum`·`morpho_blue@arbitrum` 의 @체인 제거(체인은 칩으로 표시)
    .replace(/0x[a-fA-F0-9]{6,}/g, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`);
  return stripKindLead(cleaned, kind).trim();
}

/**
 * 상태형 kind — 조건이 지속되는 동안 active 이고 백엔드 scan 이 해소 시 auto-resolve 한다. 따라서 알림이
 * 오래돼도(예: 30일째 동결) "현재 상태"라 stale 아님. 그 외(이벤트형: 유동성급감·디페그·점프 등)는
 * 시점 사건이라, 백엔드가 지속 중이면 쿨다운마다 재발화하므로 오래된 채 안 갱신 = 사건 종료(stale)로 본다.
 */
export const STATE_KINDS = new Set([
  "high_utilization", "reserve_frozen", "high_lltv_market", "near_liquidation",
  "supply_conservation", // 조건 지속형 — backend resolveStaleAlerts 로 해소되므로 24h fade 제외
]);
const STALE_EVENT_MS = 24 * 3600 * 1000;
/** 이벤트형 알림이 24h 넘게 안 갱신됐는지 = 사건 종료 추정(피드에서 뒤로·흐리게). 상태형은 항상 false. */
export function isStaleEvent(kind: string, eventTimeMs: number): boolean {
  if (STATE_KINDS.has(kind)) return false;
  return Number.isFinite(eventTimeMs) && Date.now() - eventTimeMs > STALE_EVENT_MS;
}

/** 표시용 토큰명 — `USDC@arbitrum` 의 체인 접미사 제거(체인은 별도 칩으로 표시). */
export function displayToken(token: string): string {
  return (token ?? "").split("@")[0] || token;
}

// 현재 지원 체인 (2026-06: eth/base/arb 3체인만). 백엔드 config/chains.ts ACTIVE_CHAINS 와 일치 유지.
//   확장 시 여기에 추가하면 체인 칩·필터가 따라감(다른 체인 알림은 숨김).
export const ACTIVE_CHAINS = ["ethereum", "base", "arbitrum"];
export function isActiveChain(chain: string | null | undefined): boolean {
  return !!chain && ACTIVE_CHAINS.includes(chain.toLowerCase());
}

export const CAT_LABEL: Record<AlertCategory | "all", string> = {
  all: "전체",
  minting: "민팅/공급",
  depeg: "디페깅",
  contract: "컨트랙트",
  liquidity: "유동성",
};
