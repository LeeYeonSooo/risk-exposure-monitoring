/**
 * Rule 1·2·12 + 리저브 동결: new_market · collateral_adoption · bad_debt_threshold · reserve_frozen(전이).
 * (diff.ts 에서 분리. 전부 순수 함수 — 조회는 오케스트레이터가 미리 수행.)
 */
import { classifyAsset, type AlertThresholds, type Severity } from "@/config/alert-thresholds";
import { protoLabel } from "@/lib/proto-label";
import { baseProtoId, type DiffAlert, formatUsd, isUnresolvedToken, marketKey } from "@/snapshot/rules/shared";
import type { EdgeSnapshot } from "@/types/edge-schema";

// 다년 검증된 코어 담보 — major 렌딩이 이걸 채택하는 건 위험 신호가 아님(정보성). 이 allowlist 밖의
// 신규 담보(미검증 LRT·신규 RWA·알고/CDP 스테이블 포함)는 classifyAsset 가 lst/rwa/stable 로 분류해도
// fail-safe 로 발화해야 한다 — Kelp(rsETH)·Stream(xUSD) 류 "미검증 담보 대량 채택"이 정확히 이 클래스라
// classifyAsset==altcoin 만으로 exotic 판정하면 무음 처리되는 FN(2026-06 검증 적발)을 막기 위함.
const VERIFIED_CORE_COLLATERAL = new Set([
  "WETH", "ETH", "WSTETH", "STETH", "RETH", "CBETH",
  // 검증된 코어 LST/LRT(다년·광범위 통합·NAV 오라클): weETH=EtherFi 최대 LRT. rsETH/ezETH 등 신규·소형
  //   LRT 는 의도적으로 제외(Kelp 참조 인시던트 타깃 — 미검증 LRT 대량채택은 발화해야 함).
  "WEETH", "SFRXETH", "OSETH", "ETHX",
  "WBTC", "CBBTC", "TBTC",
  "USDC", "USDT", "DAI", "USDS", "SDAI", "GHO", "PYUSD", "RLUSD", "FRAX", "LUSD",
]);

export function checkNewMarkets(
  token: string,
  curr: EdgeSnapshot,
  prev: EdgeSnapshot | undefined,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  if (isUnresolvedToken(token)) return out;  // 미해석 토큰 — 유령노드 new_market FP(R6)
  const currMarkets = curr.attrs?.topMarkets ?? [];
  if (currMarkets.length === 0) return out;

  const prevMarkets = prev?.attrs?.topMarkets ?? [];
  // 부분폴 가드(2026-06 FP #114/#115): 직전 스냅샷에 이 프로토콜 마켓이 0개면(열화 폴) baseline 무결성이 없어
  //   전 마켓을 가짜 신규/급성장으로 오판한다. curr 엔 마켓이 있는데(위에서 보장) prev 가 비었으면 비교 skip —
  //   진짜 신규는 다음 정상-baseline 스냅샷에서 1틱 뒤 정상 발화(TP 손실 없음).
  if (prevMarkets.length === 0) return out;
  // 5요소 불변키(marketKey) — 2요소 `loanAsset@lltv` 키충돌(H1)로 별개 마켓 size 를 오매칭하던 것 차단.
  const prevKeys = new Set(prevMarkets.map((m) => marketKey(m)));

  for (const m of currMarkets) {
    const key = marketKey(m);
    // 기존 마켓 — 신규 마켓 알림 X. (market_fast_growth 제거 2026-06: UNCERTAIN·검증불가 —
    //   건강한 신규 성장과 비정상 유입을 성장률만으로는 구분 못 함. 신규 마켓 생성은 new_market 가 커버.)
    if (prevKeys.has(key)) continue;
    if (m.marketSizeUsd < t.newMarket.minMarketSizeUsd) continue;  // 먼지 마켓 무시

    // 담보 품질 인지(2026-06): severity 는 LLTV 만이 아니라 **담보 자산**도 본다. 검증 코어 담보(WETH/wstETH/
    //   WBTC/USDC 등)의 신규 마켓은 고-LLTV 라도 정보성(담보 신뢰) — 블루칩 마켓 생성마다 warning 스팸 방지.
    //   미검증 담보(신규·소형 LRT·알트·RWA)에서만 LLTV 기준 escalate(Kelp/Stream 식 미검증담보 고-LLTV 마켓 신호).
    const verifiedCore = VERIFIED_CORE_COLLATERAL.has((token ?? "").toUpperCase());
    let severity: Severity = "info";
    const reasons: string[] = [];

    if (verifiedCore) {
      if (m.lltv >= t.newMarket.highLltvWarning) reasons.push(`검증 코어`);
    } else if (m.lltv >= t.newMarket.highLltvCritical) {
      severity = "critical";
      reasons.push(`미검증 ${classifyAsset(token)}`);
    } else if (m.lltv >= t.newMarket.highLltvWarning) {
      severity = "warning";
      reasons.push(`미검증 ${classifyAsset(token)}`);
    }

    out.push({
      severity,
      kind: "new_market",
      token,
      protocolNodeId: curr.target,
      message: `${protoLabel(curr.target)} ${token}/${m.loanAsset} — LLTV ${(m.lltv * 100).toFixed(1)}% · ${formatUsd(m.marketSizeUsd)}${reasons.length ? " · " + reasons.join(" · ") : ""}`,
      detail: {
        loanAsset: m.loanAsset,
        lltv: m.lltv,
        marketSizeUsd: m.marketSizeUsd,
        vaultFunded: m.vaultFunded,
      },
    });
  }
  return out;
}

// 마켓 단위 부실채권 — collateral USD 보다 borrow USD 가 크면 underwater. deficit$ 기준(actionableUsd/highUsd).
//   (scan-current-risks 의 LLTV-거리 방식과 상보적: 이쪽은 "이미 깨진" 실손, 매 스냅샷 실시간.)
export function checkBadDebt(token: string, curr: EdgeSnapshot, t: AlertThresholds): DiffAlert[] {
  const out: DiffAlert[] = [];
  for (const m of curr.attrs?.topMarkets ?? []) {
    const collat = m.collateralUsd ?? null;
    const borrow = m.borrowUsd ?? null;
    if (collat == null || borrow == null || collat <= 0) continue;
    const deficit = borrow - collat; // 차입 USD > 담보 USD = underwater
    if (deficit < t.badDebt.actionableUsd) continue;
    out.push({
      severity: deficit >= t.badDebt.highUsd ? "critical" : "warning",
      kind: "bad_debt_threshold",
      token,
      protocolNodeId: curr.target,
      message: `${protoLabel(curr.target)} ${token}/${m.loanAsset} — deficit ${formatUsd(deficit)}`,
      detail: { loanAsset: m.loanAsset, collateralUsd: collat, borrowUsd: borrow, deficitUsd: deficit, lltv: m.lltv },
    });
  }
  return out;
}

export function checkCollateralAdoption(
  token: string,
  curr: EdgeSnapshot,
  t: AlertThresholds,
): DiffAlert[] {
  if (isUnresolvedToken(token)) return [];  // 미해석 토큰 — altcoin→critical 부풀림 + 유령노드 FP(R6)
  const proto = curr.target;
  const roles = curr.attrs?.classification?.roles ?? [];
  const isCollateral = roles.some(
    (r) => r.edge_type === "collateral" || r.edge_type === "collateral_isolated" || r.edge_type === "cdp_collateral",
  );
  if (!isCollateral) return [];

  // dust 노이즈 게이트 — 먼지 포지션 채택은 무시(risk_rules adoption_dust_usd). material = 절대 materiality floor.
  const amountUsd = curr.attrs?.core?.amountUsd ?? 0;
  if (amountUsd > 0 && amountUsd < t.collateralAdoption.dustUsd) return [];
  const material = amountUsd >= t.collateralAdoption.materialUsd;

  // ⚠️ baseProtoId 로 비교(2026-06 버그수정): 런타임 proto 는 체인 스코프(`protocol:aave_v3@ethereum`)인데
  //   majorProtocols 는 비-스코프(`protocol:aave_v3`)라 includes() 가 영구 false 였다 → MAJOR 채택이 전부
  //   minor 분기로 떨어져 (a) 블루칩 신규담보가 info 대신 warning/critical 스팸, (b) "MAJOR+미검증 담보 대량채택=critical"
  //   Kelp/Stream 사전신호가 영영 미발화(FN). base id 로 맞춰 둘 다 복구.
  const isMajor = t.collateralAdoption.majorProtocols.includes(baseProtoId(proto));
  const isLending = curr.attrs?.classification?.protocol_class === "lending"
    || curr.attrs?.classification?.protocol_class === "cdp";

  // long-tail/미분류 자산(altcoin) = 잠재적 "쓰레기 담보". 블루칩(stable/major/lst 등)은 아님.
  const assetClass = classifyAsset(token);
  const exoticCollateral = assetClass === "altcoin";

  // 검증된 코어 담보(WETH/wstETH/WBTC/USDC 등 다년 검증)만 "안전 채택" → info. 그 외는 미검증 신규 담보로 보고
  //   fail-safe 발화(classifyAsset==altcoin 만으로 판정하면 미검증 LRT/RWA/신규스테이블이 lst/rwa/stable 로
  //   분류돼 무음 처리되는 FN — Kelp rsETH 사전신호 누락 — 을 막음, 2026-06 검증 적발).
  const verifiedCore = VERIFIED_CORE_COLLATERAL.has((token ?? "").toUpperCase());
  let severity: Severity;
  let why: string;
  if (isMajor) {
    if (verifiedCore) {
      severity = "info";
      why = "메이저 + 검증 코어";
    } else if (material) {
      severity = "critical";
      why = `메이저 + 미검증 ${assetClass} 대량`;
    } else {
      severity = "warning";
      why = `메이저 + 미검증 ${assetClass}`;
    }
  } else if (isLending && t.collateralAdoption.minorLendingFlag) {
    // BACKLOG P1-5: 저신뢰(minor) 프로토콜이 long-tail 자산을 담보로 = 쓰레기담보 마켓 의심
    //   (UwU Lend / MEV Capital 류 — 신규 마켓이 일주일 뒤 터지는 선행 시그널, §7).
    if (exoticCollateral) {
      severity = "critical";
      why = `저신뢰 + 롱테일 ${assetClass}`;
    } else {
      severity = "warning";
      why = `저신뢰 + ${assetClass}`;
    }
  } else return [];

  return [{
    severity,
    kind: "collateral_adoption",
    token,
    protocolNodeId: proto,
    message: `${protoLabel(proto)} ${token} — ${why}${amountUsd > 0 ? ` · ${formatUsd(amountUsd)}` : ""}`,
    detail: {
      isMajor,
      material,
      assetClass,
      exoticCollateral,
      roles: roles.map((r) => r.edge_type),
      amountUsd,
    },
  }];
}

// 리저브 동결 전이 — 직전 스냅샷엔 안 얼었는데 이번에 얼음 = 방금 동결됨(거버넌스 긴급조치/사건 대응).
//   standing 동결(rsETH Kelp 2개월 전 류)은 scan-current-risks 가 info 로 담당. 여기선 **새 동결 이벤트**만,
//   대형 리저브($50M+) 급동결은 critical(Kelp 급 사건), 그 외 warning. 같은 kind(reserve_frozen) 라도
//   escalation-aware dedup 이 info standing 위로 통과시킨다.
export function checkReserveFreeze(token: string, curr: EdgeSnapshot, prev: EdgeSnapshot): DiffAlert[] {
  if (isUnresolvedToken(token)) return [];
  const prevFrozen = prev.attrs?.lendingRisk?.isFrozen;
  const currFrozen = curr.attrs?.lendingRisk?.isFrozen;
  // 명시적 false→true 만(undefined/null 은 데이터 결손이라 전이로 안 봄 — 결손→true 오발 방지).
  if (currFrozen !== true || prevFrozen !== false) return [];
  const exposure = curr.attrs?.core?.amountUsd ?? 0;
  const sev: Severity = exposure >= 50_000_000 ? "critical" : "warning";
  return [{
    severity: sev,
    kind: "reserve_frozen",
    token,
    protocolNodeId: curr.target,
    message: `${protoLabel(curr.target)} ${token} — 방금 동결 · ${formatUsd(exposure)}`,
    detail: { transition: true, exposedUsd: exposure, prevFrozen, currFrozen },
  }];
}
