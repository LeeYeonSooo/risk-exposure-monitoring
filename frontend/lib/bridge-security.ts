/**
 * 브릿지 구조특성 분류 — authType + meta 로 "이 브릿지가 어떻게 신뢰되나"를 결정론적으로 산출한다.
 *
 * 목적: 브릿지 hover 에 신뢰모델·검증자 구성·임계(1-of-1 DVN 등)·파이널리티·업그레이드 위험을 자동 표기.
 * 설계: 1단계는 메커니즘(authType) 기반 결정론적 분류(RPC 0). 2·3단계의 "라이브 실측"은
 *   meta.live(예: { dvnRequired, dvnOptional, dvnThreshold, attesters } )를 채워 넣으면
 *   threshold/verifier 문구가 실측값으로 대체된다(아래 mergeLive). 분류는 그대로 폴백이 됨.
 *
 * 표기는 전부 순수 한글(앱 UI 규약). 추측 금지: 모르면 "구성 실측 필요"로 둔다(지어내지 않음).
 */

export type BridgeRiskTier = "low" | "med" | "high" | "varies";

export interface BridgeLiveConfig {
  // LayerZero ULN(DVN) 실측 — 3단계가 온체인 getConfig 로 채움
  dvnRequired?: number | null;   // 필수 DVN 수
  dvnOptional?: number | null;   // 선택 DVN 수
  dvnThreshold?: number | null;  // 선택 DVN 임계(optional 중 몇 개 필요)
  dvnNames?: string[];           // 알려진 DVN 이름(있으면)
  attesters?: number | null;     // CCTP attester 수 (n)
  attesterThreshold?: number | null; // CCTP 서명 임계 (m of n)
  confirmations?: number | null; // 요구 컨펌 수
}

export interface BridgeStructuralProfile {
  kind: string;          // 정규화 메커니즘 키 (cctp|ccip|canonical|oft|xerc20|polygon|unknown)
  mechanism: string;     // 사람이 읽는 메커니즘명
  trustModel: string;    // 신뢰 모델 한 줄
  verifier: string;      // 누가 검증하나
  threshold: string;     // 임계(예: "1-of-1 (Circle)", "2-of-3 DVN") — 실측 없으면 구조적 기본
  finality: string;      // 파이널리티/지연
  upgradeRisk: string;   // 업그레이드/권한 위험
  tier: BridgeRiskTier;  // 구조적 위험 등급
  tierLabel: string;     // 등급 한글 라벨
  measured: boolean;     // threshold/verifier 가 라이브 실측값인가(true) 아니면 분류 기본(false)
  notes: string[];       // 핵심 캐비엇(한 줄씩)
}

/** authType 정규화 — 탐지기의 세부 변형을 메커니즘 군으로 묶는다. */
export function normalizeAuthType(authType?: string): string {
  const a = (authType ?? "").toLowerCase();
  if (a === "cctp") return "cctp";
  if (a.startsWith("ccip")) return "ccip";                 // ccip_pool · ccip_remote
  if (a === "op_bridge" || a === "l2_canonical") return "canonical";
  if (a === "oft_peer" || a.startsWith("oft")) return "oft";
  if (a === "xerc20_lockbox" || a.startsWith("xerc20")) return "xerc20";
  if (a === "polygon_pos") return "polygon";
  return "unknown";
}

const TIER_LABEL: Record<BridgeRiskTier, string> = {
  low: "구조 위험 낮음",
  med: "구조 위험 중간",
  high: "구조 위험 높음",
  varies: "구성에 따라 다름",
};

/** 분류 기본 프로파일(RPC 0). live 가 있으면 mergeLive 가 수치를 덮어쓴다. */
function classify(kind: string, meta?: Record<string, unknown>): Omit<BridgeStructuralProfile, "tierLabel" | "measured"> {
  switch (kind) {
    case "cctp":
      return {
        kind, mechanism: "Circle CCTP · 번&민트",
        trustModel: "발행사 권한형 — 출발 체인에서 소각, 도착 체인에서 민트",
        verifier: "Circle Attestation Service (오프체인 서명자)",
        threshold: "1-of-1 (Circle 단독 증명)",
        finality: "출발 체인 파이널리티 후 Circle 증명 (~수 분)",
        upgradeRisk: "Circle 가 발행·일시중지·블랙리스트 가능(중앙 권한)",
        tier: "med",
        notes: ["검증 주체가 Circle 하나 — Circle 중단 시 전 경로 정지", "단일 신뢰점이지만 운영 이력 안정적"],
      };
    case "ccip":
      return {
        kind, mechanism: "Chainlink CCIP 토큰풀",
        trustModel: "외부 검증 네트워크 — 락/번 후 도착 체인 민트/해제",
        verifier: "Chainlink DON(오라클 합의) + RMN(독립 리스크망 거부권)",
        threshold: "DON 다수 합의 + RMN blessing (이중 검증)",
        finality: "출발 파이널리티 + DON 합의 (~분 단위)",
        upgradeRisk: "토큰풀 admin(발행자/멀티시그)이 레이트·연결 변경 가능",
        tier: "med",
        notes: ["DON+RMN 이중 검증이라 단일 attester(CCTP)보다 분산적", "RMN 이 이상 전송에 거부권 보유"],
      };
    case "canonical": {
      const to = String(meta?.toChain ?? "");
      const from = String(meta?.fromChain ?? "");
      const l2 = [to, from].find((c) => c && c !== "ethereum") ?? "L2";
      return {
        kind, mechanism: "정식 롤업 브릿지 · 락&민트(래핑)",
        trustModel: "롤업 보안 상속 — L1 에 잠그고 L2 가 래핑본 민트(트러스트리스 메시지)",
        verifier: `${l2} 정식 브릿지 컨트랙트 (옵티미스틱 롤업: 사기증명 기반)`,
        threshold: "해당 없음 (외부 검증자 없이 L1 검증)",
        finality: "입금 ~분 / 출금은 챌린지 ~7일(옵티미스틱 롤업)",
        upgradeRisk: "Security Council 멀티시그가 브릿지·증명 시스템 업그레이드 가능",
        tier: "low",
        notes: ["가장 트러스트리스 — 외부 검증자 없음", "최종 신뢰점은 업그레이드 권한(Security Council)"],
      };
    }
    case "oft":
      return {
        kind, mechanism: "LayerZero OFT · 번&민트",
        trustModel: "메시징 + 설정형 검증자 — 보안이 발행자가 고른 DVN 구성에 달림",
        verifier: "LayerZero DVN (Decentralized Verifier Network)",
        threshold: "X-of-Y DVN (구성 실측 필요)",
        finality: "출발 파이널리티 + DVN 검증 + Executor 전달",
        upgradeRisk: "OApp 소유자가 DVN 셋·Executor 변경 가능(= 보안 구성 변경 가능)",
        tier: "varies",
        notes: [
          "보안이 전적으로 발행자 DVN 구성에 의존 — 1-of-1 이면 사실상 단일 검증자",
          "DVN 수·임계가 실측 핵심 신호(아래 실측값 참조)",
        ],
      };
    case "xerc20":
      return {
        kind, mechanism: "xERC20 락박스",
        trustModel: "발행자 화이트리스트 — 브릿지별 mint 한도(rate limit) 설정",
        verifier: "화이트리스트된 브릿지들(각자 자체 검증 메커니즘)",
        threshold: "발행자 설정 (브릿지별 한도)",
        finality: "연결된 브릿지에 따라 상이",
        upgradeRisk: "발행자가 브릿지 추가/한도 변경 가능",
        tier: "varies",
        notes: ["보안이 화이트리스트된 각 브릿지의 검증력에 좌우됨", "한도(rate limit)가 사고 시 피해를 제한"],
      };
    case "polygon":
      return {
        kind, mechanism: "Polygon PoS 브릿지 · 락&민트",
        trustModel: "PoS 검증자 셋 + L1 체크포인트",
        verifier: "Heimdall 검증자 셋(스테이크 가중) + 체크포인트 제출",
        threshold: "검증자 2/3+ 스테이크 합의",
        finality: "체크포인트 주기 (~수십 분~수 시간)",
        upgradeRisk: "브릿지 거버넌스/멀티시그 업그레이드 가능",
        tier: "med",
        notes: ["검증자 셋 합의 기반 — 검증자 담합이 위험 벡터"],
      };
    default:
      return {
        kind: "unknown", mechanism: "미분류 브릿지",
        trustModel: "메커니즘 미식별",
        verifier: "구성 실측 필요",
        threshold: "구성 실측 필요",
        finality: "구성 실측 필요",
        upgradeRisk: "구성 실측 필요",
        tier: "varies",
        notes: ["authType 미인식 — 탐지기에 메커니즘 추가 필요"],
      };
  }
}

/** 라이브 실측(meta.live)이 있으면 threshold/verifier/등급을 실측값으로 덮어쓴다(3단계). */
function mergeLive(base: Omit<BridgeStructuralProfile, "tierLabel" | "measured">, live?: BridgeLiveConfig): { profile: Omit<BridgeStructuralProfile, "tierLabel" | "measured">; measured: boolean } {
  if (!live) return { profile: base, measured: false };
  const p = { ...base };
  let measured = false;

  // LayerZero DVN 실측 — "필수 R개 + 선택 O개 중 T개" → 사람이 읽는 X-of-Y + 위험등급 재산정.
  if (base.kind === "oft" && (live.dvnRequired != null || live.dvnOptional != null)) {
    const req = live.dvnRequired ?? 0;
    const opt = live.dvnOptional ?? 0;
    const thr = live.dvnThreshold ?? 0;
    const total = req + opt;
    const effective = req + thr; // 실제로 검증에 필요한 최소 DVN 수
    const parts: string[] = [];
    if (req > 0) parts.push(`필수 ${req}`);
    if (opt > 0) parts.push(`선택 ${opt} 중 ${thr}`);
    p.threshold = `${effective}-of-${total} DVN` + (parts.length ? ` (${parts.join(" · ")})` : "");
    if (live.dvnNames?.length) p.verifier = `LayerZero DVN: ${live.dvnNames.slice(0, 4).join(" · ")}`;
    // 위험등급: 유효 검증자 1 = 단일점(high), 2 = 중간, 3+ = 낮음.
    p.tier = effective <= 1 ? "high" : effective === 2 ? "med" : "low";
    if (effective <= 1) p.notes = ["⚠ 유효 검증자 1 = 단일 DVN 신뢰점(1-of-1) — 그 DVN 손상 시 위조 전송 가능", ...base.notes.filter((n) => !n.includes("실측"))];
    measured = true;
  }

  // CCTP attester 셋 실측 (m-of-n)
  if (base.kind === "cctp" && live.attesters != null) {
    const n = live.attesters;
    const m = live.attesterThreshold ?? n;
    p.threshold = `${m}-of-${n} attester (Circle)`;
    p.verifier = `Circle Attestation · attester ${n}명`;
    p.tier = n <= 1 ? "med" : "low"; // 단일 attester = 중간 위험, 다중 = 낮음
    if (n <= 1) p.notes = ["⚠ Circle 단일 attester — Circle 손상 시 위조 민트 가능", ...base.notes.filter((x) => !x.includes("이력"))];
    measured = true;
  }

  return { profile: p, measured };
}

/**
 * 브릿지 노드의 구조특성 프로파일. authType + meta(+ meta.live 실측)로 산출.
 * @param authType 탐지기 authType (cctp · ccip_pool · op_bridge · l2_canonical · oft_peer · xerc20_lockbox · polygon_pos …)
 * @param meta     브릿지 노드 meta (fromChain/toChain + 3단계의 live 실측)
 */
export function bridgeStructuralProfile(authType?: string, meta?: Record<string, unknown>): BridgeStructuralProfile {
  const kind = normalizeAuthType(authType);
  const base = classify(kind, meta);
  const live = (meta?.live as BridgeLiveConfig | undefined) ?? undefined;
  const { profile, measured } = mergeLive(base, live);
  return { ...profile, tierLabel: TIER_LABEL[profile.tier], measured };
}
