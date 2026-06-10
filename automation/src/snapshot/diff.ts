import { rpc } from "@/lib/rpc";
import { query } from "@/db/client";
import { insertAlert } from "@/db/upsert";
import { robustZ } from "@/lib/stats";
import {
  classifyAsset,
  depegSeverity,
  isIntentionalDiscountOracle,
  RECOMMENDED_THRESHOLDS,
  severityForValue,
  shouldSuppress,
  type AlertContext,
  type AlertThresholds,
  type Severity,
} from "@/config/alert-thresholds";
import type { EdgeSnapshot, TokenSnapshotResult } from "@/types/edge-schema";

/**
 * Diff engine — 7 dynamic risk factors (rule-based, threshold-driven).
 *
 *   1. new_market              — 새 마켓 생성 (Morpho/Aave topMarkets diff)
 *   2. collateral_adoption     — 주요 랜딩 프로토콜에 신규 collateral 등장
 *   3. irm_changed             — IRM 컨트랙트 swap / baseRate jump
 *   4. oracle_changed          — 오라클 주소 변경 / paused / depeg flag flip
 *   5. total_supply_jump       — 블록 또는 1h 사이 totalSupply 급변
 *   6. whale_unwind            — top holder 잔액 급감
 *   7. liquidity_drop          — utilization 급증 또는 liquidity 급감
 *
 * 각 룰 → threshold 미달이면 null. 미달 이상이면 severity 부여 → exception
 * hook 통과 → insertAlert(Discord 등 채널 발송 포함). 예외 hook 은 추후 에이전트가 채워나감.
 */

export interface DiffAlert {
  severity: Severity;
  kind: string;
  token: string;
  protocolNodeId?: string;
  message: string;
  detail?: Record<string, unknown>;
}

export async function diffAndAlert(
  current: TokenSnapshotResult,
  thresholds: AlertThresholds = RECOMMENDED_THRESHOLDS,
): Promise<DiffAlert[]> {
  const alerts: DiffAlert[] = [];
  const token = current.token.label;
  const tokenNodeId = current.token.nodeId;
  const nowSec = Math.floor(new Date(current.snapshotTs).getTime() / 1000); // D04b 오라클 staleness 기준 시각

  // Load reference data (totalSupply 시계열 윈도, 직전 엣지, top holders, 직전-블록 supply)
  const [recentSupplySamples, prevEdges, prevTopHolders, prevTotalSupplyAtPrevBlock] =
    await Promise.all([
      fetchRecentSupplySamples(tokenNodeId, current.snapshotTs, thresholds.totalSupply.windowN),
      fetchPrevEdges(tokenNodeId),
      fetchPrevTopHolders(tokenNodeId),
      fetchTotalSupplyAtBlock(current.token.address, (current.blockNumber ?? 1) - 1, current.token.metadata.decimals),
    ]);

  const prevByKey = new Map(prevEdges.map((e) => [edgeKey(e), e]));
  const currByKey = new Map(current.edges.map((e) => [edgeKey(e), e]));

  // Cold start 판정 — 직전 스냅샷이 전혀 없으면(첫 실행) 기준선이 없어서
  // 모든 엣지가 "신규"로 보임. 이 경우 신규성 알림(new_edge/collateral_adoption/
  // new_market)을 전부 발화하면 알림 폭탄이 됨 → baseline 만 기록하고 skip.
  const coldStart = prevEdges.length === 0 && recentSupplySamples.length === 0;
  if (coldStart) {
    console.log(`[diff] cold start (no prior snapshot for ${tokenNodeId}) — baseline 기록, 신규성 알림 skip`);
  }

  // ── Rule 5: total supply (먼저 — 무한민팅 가장 critical) ────
  alerts.push(...checkTotalSupply(current, prevTotalSupplyAtPrevBlock, recentSupplySamples, thresholds));

  // ── Rule 8: 디페깅 (USD 페그 이탈) — 토큰 레벨 (엣지 무관) ────
  alerts.push(...checkDepeg(current, thresholds));

  // ── Rule 4b: 오라클 freeze/staleness (D04b) — 토큰 레벨 (정식 Chainlink USD 피드) ────
  alerts.push(...checkOracleStaleness(current, nowSec, thresholds));

  // ── Rule 1: 새 마켓 ────────────────────────────────────────
  // ── Rule 2: 주요 프로토콜에 신규 collateral 채택 ───────────
  // ── Rule 3: IRM 변경 ─────────────────────────────────────
  // ── Rule 4: 오라클 변경 ──────────────────────────────────
  // ── Rule 7: utilization / liquidity ──────────────────────
  for (const [key, curr] of currByKey) {
    const prev = prevByKey.get(key);
    // breadth(DeFiLlama 미검증) 엣지는 TVL 임계 넘나들며 켜졌다 꺼졌다 해서
    // 신규성 알림 노이즈의 주범 → 신규 exposure/market 알림에서 제외(검증된 온체인만).
    const isBreadth = (curr.attrs?.meta?.dataSource ?? "").startsWith("defillama");

    // Rule 2: 새 protocol edge — 주요 프로토콜이고 collateral 역할 등장
    if (!prev) {
      if (!coldStart && !isBreadth) alerts.push(...checkCollateralAdoption(token, curr, thresholds));
    } else {
      // Rule 3: IRM 변경
      alerts.push(...checkIrmChange(token, curr, prev, thresholds));
      // Rule 4: 오라클 변경
      alerts.push(...checkOracleChange(token, curr, prev, thresholds));
      // Rule 7: utilization / liquidity 변동
      alerts.push(...checkUtilizationLiquidity(token, curr, prev, thresholds));
    }

    // Rule 1: 새 마켓 (topMarkets diff) — cold start/breadth 면 baseline 만
    if (!coldStart && !isBreadth) alerts.push(...checkNewMarkets(token, curr, prev, thresholds));
    // Rule 12: bad-debt (마켓 deficit = 차입 > 담보) — 검증 온체인 엣지만(breadth 제외)
    if (!isBreadth) alerts.push(...checkBadDebt(token, curr, thresholds));
  }

  // ── Rule 6: 고래 unwind ──────────────────────────────────
  alerts.push(...checkWhaleUnwind(current, prevTopHolders, thresholds));

  // ── Exception hooks + insertAlert(채널 발송 포함) ─────────────────────────
  const final: DiffAlert[] = [];
  for (const a of alerts) {
    const ctx: AlertContext = {
      token: a.token,
      protocolNodeId: a.protocolNodeId,
      kind: a.kind,
      severity: a.severity,
      detail: a.detail,
    };
    if (shouldSuppress(ctx)) {
      console.log(`[diff] suppressed by exception rule: ${a.kind} (${a.token})`);
      continue;
    }
    final.push(a);
    // DB 적재 (프론트 패널) — info 포함 전부. 채널 발송(Discord 등)은 insertAlert 내부에서
    // dispatchAlert 가 severity별 쿨다운을 적용해 처리 → 여기서 별도 post 하면 중복/쿨다운 우회라 제거.
    await insertAlert({
      severity: a.severity,
      kind: a.kind,
      token: a.token,
      protocolNodeId: a.protocolNodeId,
      message: a.message,
      detail: a.detail,
      snapshotTs: current.snapshotTs,
    });
  }
  return final;
}

// ─────────────────────────────────────────────────────────────
// Rule 1: 새 마켓 (Morpho topMarkets, Maker ilks)
// ─────────────────────────────────────────────────────────────

function checkNewMarkets(
  token: string,
  curr: EdgeSnapshot,
  prev: EdgeSnapshot | undefined,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  const currMarkets = curr.attrs?.topMarkets ?? [];
  if (currMarkets.length === 0) return out;

  const prevMarkets = prev?.attrs?.topMarkets ?? [];
  const prevKeys = new Set(prevMarkets.map((m) => `${m.loanAsset ?? ""}@${m.lltv}`));
  const prevSizeByKey = new Map(prevMarkets.map((m) => [`${m.loanAsset ?? ""}@${m.lltv}`, m.marketSizeUsd]));

  for (const m of currMarkets) {
    const key = `${m.loanAsset ?? ""}@${m.lltv}`;
    if (prevKeys.has(key)) {
      // 기존 마켓 급성장 — fastGrowthUsd($5M) 이상 유입 = novelty 신호(risk_rules new_market_fast_growth).
      const growth = m.marketSizeUsd - (prevSizeByKey.get(key) ?? m.marketSizeUsd);
      if (growth >= t.newMarket.fastGrowthUsd) {
        out.push({
          severity: "warning",
          kind: "market_fast_growth",
          token,
          protocolNodeId: curr.target,
          message: `Market ${token}/${m.loanAsset} grew +${formatUsd(growth)} → ${formatUsd(m.marketSizeUsd)} on ${curr.target} — fast inflow`,
          detail: { loanAsset: m.loanAsset, lltv: m.lltv, prevSizeUsd: prevSizeByKey.get(key) ?? null, currSizeUsd: m.marketSizeUsd, growthUsd: growth },
        });
      }
      continue;                                            // 이미 있던 마켓 — 신규 마켓 알림 X
    }
    if (m.marketSizeUsd < t.newMarket.minMarketSizeUsd) continue;  // 먼지 마켓 무시

    let severity: Severity = "info";
    const reasons: string[] = [];

    if (m.lltv >= t.newMarket.highLltvCritical) {
      severity = "critical";
      reasons.push(`LLTV ${(m.lltv * 100).toFixed(1)}% (≥ ${(t.newMarket.highLltvCritical * 100).toFixed(1)}% critical)`);
    } else if (m.lltv >= t.newMarket.highLltvWarning) {
      severity = "warning";
      reasons.push(`LLTV ${(m.lltv * 100).toFixed(1)}% (≥ ${(t.newMarket.highLltvWarning * 100).toFixed(1)}% warning)`);
    }

    out.push({
      severity,
      kind: "new_market",
      token,
      protocolNodeId: curr.target,
      message: `New market: ${token}/${m.loanAsset} @ LLTV ${(m.lltv * 100).toFixed(2)}% (${formatUsd(m.marketSizeUsd)}) — ${reasons.join("; ") || "size below high-risk thresholds"}`,
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

// ─────────────────────────────────────────────────────────────
// Rule 12: bad debt (마켓 deficit $ = 차입 > 담보가치, risk_rules D12)
// ─────────────────────────────────────────────────────────────

// 마켓 단위 부실채권 — collateral USD 보다 borrow USD 가 크면 underwater. deficit$ 기준(actionableUsd/highUsd).
//   (scan-current-risks 의 LLTV-거리 방식과 상보적: 이쪽은 "이미 깨진" 실손, 매 스냅샷 실시간.)
function checkBadDebt(token: string, curr: EdgeSnapshot, t: AlertThresholds): DiffAlert[] {
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
      message: `Bad debt on ${curr.target} (${token}/${m.loanAsset}): deficit ${formatUsd(deficit)} — borrow ${formatUsd(borrow)} > collateral ${formatUsd(collat)}`,
      detail: { loanAsset: m.loanAsset, collateralUsd: collat, borrowUsd: borrow, deficitUsd: deficit, lltv: m.lltv },
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Rule 2: 주요 프로토콜에 신규 collateral 채택
// ─────────────────────────────────────────────────────────────

function checkCollateralAdoption(
  token: string,
  curr: EdgeSnapshot,
  t: AlertThresholds,
): DiffAlert[] {
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

  const isMajor = t.collateralAdoption.majorProtocols.includes(proto);
  const isLending = curr.attrs?.classification?.protocol_class === "lending"
    || curr.attrs?.classification?.protocol_class === "cdp";

  // long-tail/미분류 자산(altcoin) = 잠재적 "쓰레기 담보". 블루칩(stable/major/lst 등)은 아님.
  const assetClass = classifyAsset(token);
  const exoticCollateral = assetClass === "altcoin";

  let severity: Severity;
  let why: string;
  if (isMajor) {
    severity = "critical"; // 블루칩 렌딩(Aave/Morpho 등)이 채택 = 큰 노출 변화
    why = "MAJOR 렌딩 프로토콜 채택";
  } else if (isLending && t.collateralAdoption.minorLendingFlag) {
    // BACKLOG P1-5: 저신뢰(minor) 프로토콜이 long-tail 자산을 담보로 = 쓰레기담보 마켓 의심
    //   (UwU Lend / MEV Capital 류 — 신규 마켓이 일주일 뒤 터지는 선행 시그널, §7).
    if (exoticCollateral) {
      severity = "critical";
      why = `저신뢰 프로토콜 + long-tail 담보(${assetClass}) — 쓰레기담보 마켓 의심(UwU/MEV류 선행 시그널)`;
    } else {
      severity = "warning";
      why = `minor 렌딩 프로토콜 채택(${assetClass})`;
    }
  } else return [];

  return [{
    severity,
    kind: "collateral_adoption",
    token,
    protocolNodeId: proto,
    message: `${token} newly listed as collateral on ${proto} — ${why}`,
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

// ─────────────────────────────────────────────────────────────
// Rule 3: IRM 변경
// ─────────────────────────────────────────────────────────────

function checkIrmChange(
  token: string,
  curr: EdgeSnapshot,
  prev: EdgeSnapshot,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  const prevIrm = prev.attrs?.lendingRisk?.irm;
  const currIrm = curr.attrs?.lendingRisk?.irm;
  if (!prevIrm || !currIrm) return out;

  if (prevIrm.address && currIrm.address && prevIrm.address.toLowerCase() !== currIrm.address.toLowerCase()) {
    out.push({
      severity: t.irmChange.addressChange,
      kind: "irm_changed",
      token,
      protocolNodeId: curr.target,
      message: `IRM contract swap on ${curr.target}: ${prevIrm.address} → ${currIrm.address}`,
      detail: { prev: prevIrm.address, curr: currIrm.address },
    });
  }

  if (prevIrm.baseRate != null && currIrm.baseRate != null) {
    const delta = Math.abs(currIrm.baseRate - prevIrm.baseRate);
    const sev = severityForValue(delta, t.irmChange.baseRateDelta);
    if (sev) {
      out.push({
        severity: sev,
        kind: "irm_base_rate_jump",
        token,
        protocolNodeId: curr.target,
        message: `IRM base rate moved ${(delta * 100).toFixed(2)}pp on ${curr.target}: ${(prevIrm.baseRate * 100).toFixed(2)}% → ${(currIrm.baseRate * 100).toFixed(2)}%`,
        detail: { prevRate: prevIrm.baseRate, currRate: currIrm.baseRate, deltaPp: delta },
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Rule 4: 오라클 변경 / paused
// ─────────────────────────────────────────────────────────────

function checkOracleChange(
  token: string,
  curr: EdgeSnapshot,
  prev: EdgeSnapshot,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  const prevOracle = prev.attrs?.oracle;
  const currOracle = curr.attrs?.oracle;
  if (!prevOracle || !currOracle) return out;

  if (prevOracle.address && currOracle.address && prevOracle.address.toLowerCase() !== currOracle.address.toLowerCase()) {
    out.push({
      severity: t.oracle.addressChange,
      kind: "oracle_changed",
      token,
      protocolNodeId: curr.target,
      message: `Oracle swap on ${curr.target}: ${prevOracle.address} → ${currOracle.address}`,
      detail: { prev: prevOracle.address, curr: currOracle.address },
    });
  }

  // Type 변경 (예: MARKET → NONE = paused 의심)
  if (prevOracle.type === "MARKET" && currOracle.type === "NONE") {
    out.push({
      severity: "critical",
      kind: "oracle_paused_suspect",
      token,
      protocolNodeId: curr.target,
      message: `Oracle type changed MARKET → NONE on ${curr.target} — possible pause / freeze`,
      detail: { prev: prevOracle.type, curr: currOracle.type },
    });
  }

  // 정상 라이브 피드 → 하드코딩(ORACLE_FREE) 전환 = critical (BACKLOG P1-4, §6.7 핵심 통찰).
  // 가격이 온체인에서 안 움직이면 디페그 시 청산이 안 걸려 bad debt 가 조용히 쌓인다 → Tier 0 "하드코딩오라클" 승격.
  const LIVE_ORACLE = new Set(["MARKET", "EXCHANGE_RATE"]);
  if (LIVE_ORACLE.has(prevOracle.type) && currOracle.type === "ORACLE_FREE") {
    // BACKLOG P2-8: RWA(mF-ONE 류)는 NAV 대비 의도적 디스카운트 고정이 정상 설계 → critical 다운그레이드.
    const intentional = isIntentionalDiscountOracle(token, currOracle.type);
    out.push({
      severity: intentional ? "warning" : "critical",
      kind: "oracle_hardcoded_switch",
      token,
      protocolNodeId: curr.target,
      message: intentional
        ? `Oracle → hardcoded (ORACLE_FREE) on ${curr.target} — RWA 의도적 디스카운트(NAV 보수평가)일 수 있음, 확인 요`
        : `Oracle switched from live feed (${prevOracle.type}) to HARDCODED (ORACLE_FREE) on ${curr.target} — price frozen, liquidations won't fire (silent bad-debt risk)`,
      detail: { prev: prevOracle.type, curr: currOracle.type, rwaIntentional: intentional },
    });
  }

  if (prevOracle.depegSensitive !== currOracle.depegSensitive) {
    out.push({
      severity: t.oracle.depegFlagFlip,
      kind: "oracle_depeg_flag_flip",
      token,
      protocolNodeId: curr.target,
      message: `Oracle depeg-sensitive flag flipped on ${curr.target}: ${prevOracle.depegSensitive} → ${currOracle.depegSensitive}`,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Rule 4b: 오라클 freeze / staleness (D04b) — Chainlink latestRoundData 기반
// ─────────────────────────────────────────────────────────────

// 토큰의 정식 Chainlink USD 피드(FeedRegistry, snapshot-token 이 캡처)가 멈추면(updatedAt 노후) 디페그가
//   온체인에 안 잡혀 청산 미발화 → silent bad debt. heartbeatByClass × stalenessFactor 초과 = frozen ·
//   answer≤0 = invalid · answeredInRound<roundId = 미완료 라운드. FeedRegistry 미등록 토큰(LST/exotic)이면 oracleFeed=null → skip.
function checkOracleStaleness(current: TokenSnapshotResult, nowSec: number, t: AlertThresholds): DiffAlert[] {
  const f = current.token.metadata.oracleFeed;
  if (!f || !(f.updatedAt > 0)) return [];
  const token = current.token.label;
  if (f.answer <= 0) {
    return [{ severity: "critical", kind: "oracle_stale", token,
      message: `Oracle feed INVALID for ${token}: Chainlink USD answer ≤ 0 — broken price source`,
      detail: { reason: "non_positive_answer", answer: f.answer } }];
  }
  if (f.roundStale) {
    return [{ severity: "critical", kind: "oracle_stale", token,
      message: `Oracle STALE ROUND for ${token}: answeredInRound < roundId — incomplete update`,
      detail: { reason: "stale_round" } }];
  }
  const heartbeat = t.oracle.heartbeatByClass[classifyAsset(token)];
  const maxAge = heartbeat * t.oracle.stalenessFactor;
  const age = nowSec - f.updatedAt;
  if (age > maxAge) {
    return [{ severity: "critical", kind: "oracle_stale", token,
      message: `Oracle FROZEN for ${token}: Chainlink USD feed last updated ${(age / 3600).toFixed(1)}h ago > ${(maxAge / 3600).toFixed(1)}h (heartbeat×${t.oracle.stalenessFactor}) — price frozen, liquidations won't fire (silent bad-debt)`,
      detail: { reason: "stale", ageSec: age, maxAgeSec: maxAge, updatedAt: f.updatedAt } }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// Rule 5: totalSupply 급변 (block 단위 + snapshot 단위)
// ─────────────────────────────────────────────────────────────

// alarm-totalsupply Detector C 포팅. 두 신호 + corroboration:
//   • supply_single_mint — 단일 블록 totalSupply 증가가 supply 의 singleTxPctBps 이상
//       (급성 large mint / 무한민팅 시그널). 단독이면 warning.
//   • supply_spike       — 견고한 modified z-score(median/MAD) 로 본 비정상 증가.
//       통계-only 라 단독이면 info (페이지 X — alarm 의 WATCH 등급).
//   • 둘 다 동시 발화 = corroboration → single_mint 을 critical 로 승격(페이지).
//   ※ 증가(d>0)만 본다(무한민팅은 증가). 감소(번/리딤)는 정상.
//   ※ cross-chain backing invariant(alarm Detector A, Kelp rsETH)는 멀티체인 필요 →
//     현재 메인넷-only 스코프 밖. 멀티체인 도입 시 Σremote≤backing 으로 확장.
function checkTotalSupply(
  current: TokenSnapshotResult,
  prevBlock: number | null,
  recentSamples: number[], // 과거 totalSupply (현재 ts 미만), 최신순
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  const symbol = current.token.label;
  const curr = current.token.metadata.totalSupply;
  const whitelisted = t.totalSupply.autoMintWhitelist.includes(symbol);
  const ts = t.totalSupply;

  // ── 단일 블록 %of-supply (single-tx large mint) ──
  if (prevBlock != null && prevBlock > 0 && curr > prevBlock) {
    const pct = (curr - prevBlock) / prevBlock;
    const bps = pct * 10_000;
    const thrBps = whitelisted ? ts.singleTxPctBps * 2 : ts.singleTxPctBps;
    const critBps = whitelisted ? ts.largeSingleMintBps * 2 : ts.largeSingleMintBps;
    if (bps >= thrBps) {
      // ≥largeSingleMintBps(10%) 단일-블록 mint = 크기 무관 critical (provenance 우선, risk_rules large_single_mint_high).
      const sev: Severity = bps >= critBps ? "critical" : "warning";
      out.push({
        severity: sev,
        kind: "supply_single_mint",
        token: symbol,
        message: `totalSupply +${(pct * 100).toFixed(2)}% in 1 block (${bps.toFixed(0)} bps of supply) — large single mint${sev === "critical" ? " 🚨 (≥10% — unauthorized-mint suspect)" : ""}${whitelisted ? " [whitelisted-relaxed]" : ""}`,
        detail: { prevBlock, curr, deltaPct: pct, bps: Math.round(bps), block: current.blockNumber },
      });
    }
  }

  // ── robust z-score (median/MAD) on consecutive deltas ──
  if (recentSamples.length >= ts.minSamples) {
    const asc = [...recentSamples].reverse(); // 오래된→최신
    const last = asc[asc.length - 1];
    const d = curr - last;
    const baseline: number[] = [];
    for (let i = 1; i < asc.length; i++) baseline.push(asc[i] - asc[i - 1]);
    const z = robustZ(d, baseline);
    const minAbs = whitelisted ? ts.minAbsDeltaTokens * 100 : ts.minAbsDeltaTokens;
    // flat-MAD z-폭발 가드: delta 가 supply 의 minRelDelta(0.5%) 미만이면 z 무시 — near-flat 시계열에서
    // MAD≈0 이면 작은 변화도 z 가 폭발해 거짓 spike 가 됨(risk_rules supply_z_min_rel).
    const relDelta = curr > 0 ? Math.abs(d) / curr : 0;
    // 설계된 리베이스 억제(rebaseSaneMax): 1스냅샷 |Δ| 가 rebaseSaneMax(50%) 안이고 단일-블록 이산 mint 가
    //   없으면 탄력 공급(AMPL 등 리베이스)으로 보고 통계 스파이크 억제 — 백테스트 TOTAL_SUPPLY_SPIKE 억제와 동일.
    //   (단일-블록 ≥5%/10% provenance 경로·>50% 변화·corroboration 은 영향 없음 — 진짜 무한민팅은 계속 잡힘.)
    const snapPct = last > 0 ? Math.abs(d) / last : 0;
    const discreteMint = out.some((a) => a.kind === "supply_single_mint");
    const designedRebase = snapPct <= ts.rebaseSaneMax && !discreteMint;
    if (!designedRebase && d > 0 && Math.abs(d) >= minAbs && relDelta >= ts.minRelDelta && Math.abs(z) >= ts.zscore) {
      out.push({
        severity: "info", // 통계-only → 페이지 X (alarm WATCH 등급)
        kind: "supply_spike",
        token: symbol,
        message: `Abnormal totalSupply jump: +${d.toFixed(2)} (robust z=${z.toFixed(1)}, ${recentSamples.length}-sample baseline)`,
        detail: { curr, delta: d, z: Number(z.toFixed(2)), samples: recentSamples.length },
      });
    }
  }

  // ── corroboration: 단일-tx mint + 통계 스파이크 동시 → critical 승격 ──
  const single = out.find((a) => a.kind === "supply_single_mint");
  if (single && out.some((a) => a.kind === "supply_spike")) {
    single.severity = "critical";
    single.message = `🚨 ${single.message} — CORROBORATED by statistical spike (possible unbacked/infinite mint)`;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Rule 6: 고래 unwind
// ─────────────────────────────────────────────────────────────

function checkWhaleUnwind(
  current: TokenSnapshotResult,
  prevTopHolders: Array<{ address: string; amount: number }> | null,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  const currTop = current.token.metadata.topHolders ?? [];
  if (!prevTopHolders || prevTopHolders.length === 0 || currTop.length === 0) return out;

  // Token price 추정 — marketCapUsd / totalSupply
  const meta = current.token.metadata;
  const priceUsd = meta.totalSupply > 0 && meta.marketCapUsd
    ? meta.marketCapUsd / meta.totalSupply
    : 1;

  const prevByAddr = new Map(prevTopHolders.map((h) => [h.address.toLowerCase(), h.amount]));

  for (const c of currTop.slice(0, t.whaleUnwind.trackTopN)) {
    const prevAmt = prevByAddr.get(c.address.toLowerCase());
    if (prevAmt == null || prevAmt <= 0) continue;
    if (c.amount >= prevAmt) continue;  // 증가 또는 동일 → 무시

    const dropAbsToken = prevAmt - c.amount;
    const dropPct = dropAbsToken / prevAmt;
    const dropUsd = dropAbsToken * priceUsd;

    // dust 플로어: $1M(absDropUsd.info) 미만 인출은 % 가 커도 무시 — $100k 짜리 50% 인출이 critical 페이지 되던 것 차단
    // (risk_rules whale_dust_usd: mergeSeverity(max) 가 % 만으로 승격하던 우회를 절대 USD 게이트로 막음).
    if (dropUsd < t.whaleUnwind.absDropUsd.info) continue;
    const pctSev = severityForValue(dropPct, t.whaleUnwind.perSnapshotDropPct);
    const usdSev = severityForValue(dropUsd, t.whaleUnwind.absDropUsd);
    const severity = mergeSeverity(pctSev, usdSev);
    if (!severity) continue;

    out.push({
      severity,
      kind: "whale_unwind",
      token: current.token.label,
      message: `Whale ${c.address.slice(0, 6)}…${c.address.slice(-4)} reduced ${current.token.label} position by ${(dropPct * 100).toFixed(1)}% (${formatUsd(dropUsd)})`,
      detail: { address: c.address, prevAmount: prevAmt, currAmount: c.amount, dropPct, dropUsd },
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Rule 7: utilization / liquidity 급변
// ─────────────────────────────────────────────────────────────

function checkUtilizationLiquidity(
  token: string,
  curr: EdgeSnapshot,
  prev: EdgeSnapshot,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  const proto = curr.target;
  const protoClass = curr.attrs?.classification?.protocol_class;

  // Lending side — utilization jump + liquidity drop
  if (protoClass === "lending" || protoClass === "cdp") {
    const prevU = prev.attrs?.lendingRisk?.utilization;
    const currU = curr.attrs?.lendingRisk?.utilization;
    if (prevU != null && currU != null) {
      const delta = currU - prevU;
      // 레벨 co-gate: 점프가 jumpMinLevel(70%)에 **안착**할 때만 발화 — idle 5%→20% 같은 노이즈 차단.
      // (risk_rules util_jump: "1스냅샷 jump 이상 + 이 level 이상에 안착 → run". 레벨게이트 없던 게 오탐 원인.)
      if (delta > 0 && currU >= t.utilizationLiquidity.jumpMinLevel) {
        let sev = severityForValue(delta, t.utilizationLiquidity.utilizationJumpPct);
        // actionable run: ≥jumpActionable(12pp) 점프가 70%+ 안착 → 최소 warning(apxUSD run 류 — %티어가 놓치던 것).
        if ((!sev || sev === "info") && delta >= t.utilizationLiquidity.jumpActionable) sev = "warning";
        if (sev) {
          out.push({
            severity: sev,
            kind: "utilization_jump",
            token,
            protocolNodeId: proto,
            message: `Utilization +${(delta * 100).toFixed(2)}pp on ${proto}: ${(prevU * 100).toFixed(2)}% → ${(currU * 100).toFixed(2)}% (landed ${(currU * 100).toFixed(0)}% ≥ ${(t.utilizationLiquidity.jumpMinLevel * 100).toFixed(0)}%) — fast borrow / withdraw run`,
            detail: { prevUtilization: prevU, currUtilization: currU, deltaPp: delta, landedLevel: currU },
          });
        }
      }
    }

    // 절대 수준 룰 — 점프가 작아도 100%에 가까우면 가용 유동성 소진 = 인출/청산 위험.
    // 점프룰(속도)과 상보적. dedup(26h)이 매시간 반복을 막음.
    if (currU != null) {
      const sevAbs = severityForValue(currU, t.utilizationLiquidity.utilizationAbsolute);
      if (sevAbs) {
        out.push({
          severity: sevAbs,
          kind: "high_utilization",
          token,
          protocolNodeId: proto,
          message: `Utilization at ${(currU * 100).toFixed(2)}% on ${proto} — available liquidity nearly exhausted (withdraw / liquidation risk)`,
          detail: { utilization: currU },
        });
      }
    }

    const prevLiq = prev.attrs?.lendingRisk?.liquidityUsd;
    const currLiq = curr.attrs?.lendingRisk?.liquidityUsd;
    if (prevLiq != null && currLiq != null && prevLiq >= t.utilizationLiquidity.minLiquidityUsd && currLiq < prevLiq) {
      const dropPct = (prevLiq - currLiq) / prevLiq;
      const sev = severityForValue(dropPct, t.utilizationLiquidity.liquidityDropPct);
      if (sev) {
        out.push({
          severity: sev,
          kind: "liquidity_drop_lending",
          token,
          protocolNodeId: proto,
          message: `Available liquidity dropped ${(dropPct * 100).toFixed(1)}% on ${proto}: ${formatUsd(prevLiq)} → ${formatUsd(currLiq)}`,
          detail: { prevLiquidityUsd: prevLiq, currLiquidityUsd: currLiq, dropPct },
        });
      }
    }
  }

  // DEX side
  if (protoClass === "dex") {
    const prevLiq = prev.attrs?.dex?.liquidityUsd;
    const currLiq = curr.attrs?.dex?.liquidityUsd;
    if (prevLiq != null && currLiq != null && prevLiq >= t.utilizationLiquidity.minLiquidityUsd && currLiq < prevLiq) {
      const dropPct = (prevLiq - currLiq) / prevLiq;
      const sev = severityForValue(dropPct, t.utilizationLiquidity.dexLiquidityDropPct);
      if (sev) {
        out.push({
          severity: sev,
          kind: "liquidity_drop_dex",
          token,
          protocolNodeId: proto,
          message: `DEX liquidity dropped ${(dropPct * 100).toFixed(1)}% on ${proto}: ${formatUsd(prevLiq)} → ${formatUsd(currLiq)}`,
          detail: { prevLiquidityUsd: prevLiq, currLiquidityUsd: currLiq, dropPct },
        });
      }
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Rule 8: 디페깅 (USD 페그 이탈)
// ─────────────────────────────────────────────────────────────

// USD-페그로 볼 토큰. PT(만기 할인 거래)·LP 등은 $1 페그가 아니라 제외.
const KNOWN_USD_STABLES = new Set([
  "DAI", "sDAI", "GHO", "FRAX", "frxUSD", "USDS", "sUSDS", "USD0", "USD0++",
  "BUIDL", "USDM", "USDA", "AUSD", "deUSD", "sdeUSD",
]);
function isUsdPegged(symbol: string): boolean {
  const s = symbol.trim();
  if (!s) return false;
  // PT-/YT-/LP- 류 파생은 $1 페그 아님
  if (/^(pt|yt|lp)[-_]/i.test(s)) return false;
  if (KNOWN_USD_STABLES.has(s)) return true;
  // 심볼에 USD 포함 (USDC, USDT, USDe, crvUSD, apxUSD, savUSD, sUSDe, eUSD, LUSD …)
  return /usd/i.test(s);
}

function checkDepeg(current: TokenSnapshotResult, t: AlertThresholds): DiffAlert[] {
  const meta = current.token.metadata;
  const sym = meta.symbol;
  if (!isUsdPegged(sym)) return [];
  // 가격 = marketCapUsd / totalSupply (coins.llama 시세 기반, snapshot 에서 세팅)
  const price = meta.totalSupply > 0 && meta.marketCapUsd ? meta.marketCapUsd / meta.totalSupply : null;
  if (price == null || !(price > 0)) return [];
  // ⬇️ 하향 이탈만 본다. 이자 누적형 스테이블(sUSDe·sUSDS·savUSD·USDY 등)은 설계상
  // $1 위에서 거래되므로 상향 편차는 디페깅이 아님(수익률). 담보가 가정보다 싸지는
  // = $1 아래로 깨지는 경우만이 부실채권/전염 리스크.
  if (price >= 1) return [];
  const devBps = (1 - price) * 10_000;
  // 자산클래스별 band + catastrophic(8.5%) — risk_rules 보정.
  const sev = depegSeverity(sym ?? current.token.label, devBps / 10_000, t);
  if (!sev) return [];
  return [
    {
      severity: sev,
      kind: "depeg",
      token: current.token.label,
      // 토큰 레벨 알림 — 특정 프로토콜이 아님
      message: `${sym} off peg -${devBps.toFixed(0)} bps — price $${price.toFixed(4)} (below $1 peg)`,
      detail: { priceUsd: price, deviationBps: devBps, pegTarget: 1, direction: "down" },
    },
  ];
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function edgeKey(e: EdgeSnapshot): string {
  return `${e.source}→${e.target}`;
}

function mergeSeverity(a: Severity | null, b: Severity | null): Severity | null {
  if (!a && !b) return null;
  const rank = { info: 1, warning: 2, critical: 3 } as const;
  const ar = a ? rank[a] : 0;
  const br = b ? rank[b] : 0;
  const max = Math.max(ar, br);
  if (max === 3) return "critical";
  if (max === 2) return "warning";
  return "info";
}

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * totalSupply 시계열 윈도 — robust z-score baseline.
 * 현재 스냅샷(beforeTs) "미만"의 최근 limit 개만 → 자기 자신으로 baseline 오염 방지
 * (persist 가 diff 보다 먼저 돌아 현재 샘플이 이미 들어있어도 제외됨).
 */
async function fetchRecentSupplySamples(
  tokenNodeId: string,
  beforeTs: string,
  limit: number,
): Promise<number[]> {
  const r = await query<{ total_supply: number }>(
    `SELECT total_supply FROM supply_samples
     WHERE token_node_id = $1 AND snapshot_ts < $2
     ORDER BY snapshot_ts DESC LIMIT $3`,
    [tokenNodeId, beforeTs, limit],
  ).catch(() => ({ rows: [] as { total_supply: number }[] }));
  return r.rows.map((x) => Number(x.total_supply));
}

async function fetchPrevEdges(tokenNodeId: string): Promise<EdgeSnapshot[]> {
  const r = await query<{
    source: string;
    target: string;
    type: string;
    weight: number;
    attrs: EdgeSnapshot["attrs"];
  }>(
    `
    WITH ts AS (
      SELECT MAX(snapshot_ts) AS ts FROM edges
      WHERE token_node_id = $1 AND snapshot_ts < (SELECT MAX(snapshot_ts) FROM edges WHERE token_node_id = $1)
    )
    SELECT token_node_id AS source, protocol_node_id AS target, edge_type AS type, weight, attrs
    FROM edges
    WHERE token_node_id = $1 AND snapshot_ts = (SELECT ts FROM ts)
    `,
    [tokenNodeId],
  ).catch(() => ({ rows: [] as Array<{ source: string; target: string; type: string; weight: number; attrs: EdgeSnapshot["attrs"] }> }));
  return r.rows.map((row) => ({
    edgeId: `${row.source}__${row.target}`,
    source: row.source,
    target: row.target,
    type: row.type,
    weight: row.weight,
    attrs: row.attrs,
  }));
}

async function fetchPrevTopHolders(tokenNodeId: string): Promise<Array<{ address: string; amount: number }> | null> {
  const r = await query<{ metadata: { topHolders?: Array<{ address: string; amount: number }> } }>(
    `SELECT metadata FROM nodes WHERE node_id = $1`,
    [tokenNodeId],
  ).catch(() => ({ rows: [] as { metadata: { topHolders?: Array<{ address: string; amount: number }> } }[] }));
  return r.rows[0]?.metadata?.topHolders ?? null;
}

/**
 * 직전 블록(N-1)에서의 totalSupply 조회 — eth_call with blockTag.
 * "block-level 무한민팅" alert 의 1차 시그널.
 */
async function fetchTotalSupplyAtBlock(
  tokenAddress: string,
  blockNumber: number,
  decimals: number,
): Promise<number | null> {
  if (blockNumber <= 0) return null;
  try {
    const ERC20_ABI = [
      { inputs: [], name: "totalSupply", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
    ] as const;
    const supply = (await rpc().readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "totalSupply",
      blockNumber: BigInt(blockNumber),
    })) as bigint;
    return Number(supply) / 10 ** decimals;
  } catch {
    return null;
  }
}
