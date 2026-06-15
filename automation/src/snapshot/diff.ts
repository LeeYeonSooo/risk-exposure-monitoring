import { insertAlert } from "@/db/upsert";
import {
  edgeExistedBefore, fetchPrevEdges, fetchPrevTopHolders, fetchRecentEdgeLiquidity,
  fetchRecentPriceBaseline, fetchRecentSupplySamples, fetchTotalSupplyAtBlock,
} from "@/snapshot/diff-queries";
import { checkDepeg } from "@/snapshot/rules/depeg";
import { checkBadDebt, checkCollateralAdoption, checkNewMarkets, checkReserveFreeze } from "@/snapshot/rules/market";
import { checkOracleChange, checkOracleStaleness } from "@/snapshot/rules/oracle";
import { checkIrmChange, checkUtilizationLiquidity } from "@/snapshot/rules/rates";
import type { DiffAlert } from "@/snapshot/rules/shared";
import { checkTotalSupply, checkWhaleUnwind } from "@/snapshot/rules/supply";
import {
  RECOMMENDED_THRESHOLDS,
  shouldSuppress,
  type AlertContext,
  type AlertThresholds,
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

// 디텍터(check*)는 @/snapshot/rules/{market,oracle,rates,supply,depeg} 로 분리. 공유 헬퍼·타입은 rules/shared.
// 이 파일은 오케스트레이터(diffAndAlert) + baseline/prev 조회(diff-queries) 조립만 담당.

export async function diffAndAlert(
  current: TokenSnapshotResult,
  thresholds: AlertThresholds = RECOMMENDED_THRESHOLDS,
): Promise<DiffAlert[]> {
  const alerts: DiffAlert[] = [];
  const token = current.token.label;
  const tokenNodeId = current.token.nodeId;
  const nowSec = Math.floor(new Date(current.snapshotTs).getTime() / 1000); // D04b 오라클 staleness 기준 시각

  // Load reference data (totalSupply 시계열 윈도, 직전 엣지, top holders, 직전-블록 supply, 유동성·가격 baseline)
  const [recentSupplySamples, prevEdges, prevTopHolders, prevTotalSupplyAtPrevBlock, liqBaseline, priceBaseline] =
    await Promise.all([
      fetchRecentSupplySamples(tokenNodeId, current.snapshotTs, thresholds.totalSupply.windowN),
      fetchPrevEdges(tokenNodeId),
      fetchPrevTopHolders(tokenNodeId),
      fetchTotalSupplyAtBlock(current.token.address, (current.blockNumber ?? 1) - 1, current.token.metadata.decimals),
      fetchRecentEdgeLiquidity(tokenNodeId, current.snapshotTs),
      fetchRecentPriceBaseline(tokenNodeId, current.token.label, current.snapshotTs),
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

  // ── Rule 8: 디페깅 — 토큰 레벨. USD=$1/baseline · LST=ETH×NAV · BTC래퍼=BTC/USD (peg 있는 전 토큰) ────
  alerts.push(...(await checkDepeg(current, thresholds, priceBaseline)));

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
      // 직전 1개 스냅샷에 엣지가 없다고 곧장 "신규 채택"이면, 부분폴/로테이션 갭(H3)으로 기존 엣지가
      // 잠깐 빠졌다 복귀한 경우까지 가짜 신규로 잡힌다(활성 critical FP 15건). DB 로 1일 이전 존재를
      // 재확인해, 과거에 한 번이라도 있었으면 신규가 아님 → 발화 안 함.
      if (!coldStart && !isBreadth) {
        const seenBefore = await edgeExistedBefore(tokenNodeId, curr.target, current.snapshotTs);
        if (!seenBefore) alerts.push(...checkCollateralAdoption(token, curr, thresholds));
      }
    } else {
      // Rule 3: IRM 변경
      alerts.push(...checkIrmChange(token, curr, prev, thresholds));
      // Rule 4: 오라클 변경
      alerts.push(...checkOracleChange(token, curr, prev, thresholds));
      // Rule 7: utilization / liquidity 변동 — 최근 중앙값 baseline 전달(spike-reversion FP 차단)
      alerts.push(...checkUtilizationLiquidity(token, curr, prev, thresholds, liqBaseline.get(curr.target)));
      // 동결 전이(false→true) — 방금 동결 = 거버넌스 긴급조치/사건. (standing 동결은 scan 이 info 로 별도 담당.)
      alerts.push(...checkReserveFreeze(token, curr, prev));
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
// 디텍터 모듈 맵 (check* 는 전부 @/snapshot/rules/* 순수 함수로 분리):
//   market : new_market · bad_debt_threshold · collateral_adoption · reserve_frozen(전이)
//   oracle : oracle_changed/paused/hardcoded · oracle_stale
//   rates  : irm_changed · irm_base_rate_jump · utilization_jump · liquidity_drop_dex
//   supply : supply_single_mint · supply_spike · whale_unwind
//   depeg  : depeg (USD/LST/BTC 일반화 + 오라클-인지)
// 조회(fetch*)는 diff-queries.ts. 이 파일은 오케스트레이션만.
// ─────────────────────────────────────────────────────────────

function edgeKey(e: EdgeSnapshot): string {
  return `${e.source}→${e.target}`;
}


