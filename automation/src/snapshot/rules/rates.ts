/**
 * Rule 3 / 7: IRM 변경(irm_changed·irm_base_rate_jump) + 이용률/유동성 급변(utilization_jump·liquidity_drop_dex).
 * (diff.ts 에서 분리.)
 */
import { severityForValue, type AlertThresholds } from "@/config/alert-thresholds";
import { protoLabel } from "@/lib/proto-label";
import { median } from "@/lib/stats";
import { isStaleGap } from "@/snapshot/data-quality";
import { type DiffAlert, formatUsd, hasImmutableMarkets, isUnresolvedToken, marketKey, UNCERTAIN_SEVERITY } from "@/snapshot/rules/shared";
import type { EdgeSnapshot } from "@/types/edge-schema";

export function checkIrmChange(
  token: string,
  curr: EdgeSnapshot,
  prev: EdgeSnapshot,
  t: AlertThresholds,
): DiffAlert[] {
  const out: DiffAlert[] = [];
  if (isUnresolvedToken(token)) return out;  // 미해석 토큰 — 충돌노드 비교 불가(R6)
  const prevIrm = prev.attrs?.lendingRisk?.irm;
  const currIrm = curr.attrs?.lendingRisk?.irm;
  if (!prevIrm || !currIrm) return out;

  // R5: Morpho/Euler 등 isolated 마켓은 IRM 컨트랙트가 immutable — 헤드라인 IRM "주소 변경"은
  // 최대마켓 회전 아티팩트(가짜 irm_changed). 주소 swap 판정은 mono-pool(Aave/Spark/Compound)에서만.
  if (!hasImmutableMarkets(curr.target)
      && prevIrm.address && currIrm.address && prevIrm.address.toLowerCase() !== currIrm.address.toLowerCase()) {
    out.push({
      severity: t.irmChange.addressChange,
      kind: "irm_changed",
      token,
      protocolNodeId: curr.target,
      message: `${protoLabel(curr.target)} — IRM ${prevIrm.address}→${currIrm.address}`,
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
        message: `${protoLabel(curr.target)} — 기준금리 +${(delta * 100).toFixed(2)}pp · ${(prevIrm.baseRate * 100).toFixed(2)}%→${(currIrm.baseRate * 100).toFixed(2)}%`,
        detail: { prevRate: prevIrm.baseRate, currRate: currIrm.baseRate, deltaPp: delta },
      });
    }
  }
  return out;
}

export function checkUtilizationLiquidity(
  token: string,
  curr: EdgeSnapshot,
  prev: EdgeSnapshot,
  t: AlertThresholds,
  baseline?: { lend: number[]; dex: number[]; util: number[] },
): DiffAlert[] {
  const out: DiffAlert[] = [];
  // 미해석 토큰(symbol=UNKNOWN) — 서로 다른 자산이 token:UNKNOWN 한 노드에 충돌 적재돼 가짜 util_jump/
  //   liquidity_drop_dex 를 만든다(FP 감사 2026-06: +52pp UNKNOWN 등). 타 디텍터(oracle/irm/new_market)와 일관되게 컷.
  if (isUnresolvedToken(token)) return out;
  const proto = curr.target;
  const protoClass = curr.attrs?.classification?.protocol_class;
  // DEX 유동성 중앙값 — 드롭 판정의 안정 기준선(단일 prev 스파이크 복원이 가짜 드롭 되는 것 방지). ≥3샘플.
  //   (lend 중앙값은 liquidity_drop_lending 제거로 불필요 — DEX 만 유지.)
  const dexMed = baseline && baseline.dex.length >= 3 ? median(baseline.dex) : null;

  // 스냅샷 경과시간(분) — prev↔curr 가 기대 폴 주기를 크게 넘으면 "단일 tick 급변"이 아니라
  // 커버리지 갭(H3) 누적 드리프트다(73h/48h outage 다수 관측). velocity 룰(jump/liquidity_drop)을 억제.
  const staleGap = isStaleGap(prev.attrs?.meta?.snapshotTs, curr.attrs?.meta?.snapshotTs, t.utilizationLiquidity.maxStalenessMin);

  // Lending side — utilization jump
  if (protoClass === "lending" || protoClass === "cdp") {
    const currMarkets = curr.attrs?.topMarkets ?? [];
    if (currMarkets.length > 0) {
      // ── per-market (Morpho/Euler 등 멀티마켓, 2026-06) — 헤드라인 util 은 supply 가중평균이라 한 마켓 스파이크를
      //   희석한다(wstETH@Morpho 60마켓: 평균 0.82 가 0.76~0.91 분산을 숨김). 마켓별로 본다. prev 와 marketKey(5요소)로
      //   매칭한 동일 마켓의 점프만, dust(<minMarketSupplyUsd) 제외, 신규 마켓은 new_market 담당. per-market 이력(median)이
      //   없어 prev-마켓 util 을 baseline 으로 — landed≥70% + Δ≥12pp 강게이트로 single-prev 노이즈 컷. (Aave 등 모노풀은
      //   topMarkets 가 비어 아래 else 의 median-baseline 헤드라인 경로.)
      const prevByKey = new Map((prev.attrs?.topMarkets ?? []).map((m) => [marketKey(m), m]));
      const jumped: Array<{ loanAsset?: string; lltv: number; prevU: number; currU: number; delta: number; sizeUsd: number }> = [];
      for (const m of currMarkets) {
        const sizeUsd = m.marketSizeUsd ?? 0;
        if (sizeUsd < t.utilizationLiquidity.minMarketSupplyUsd) continue;
        const pm = prevByKey.get(marketKey(m));
        const prevMU = pm?.utilization, currMU = m.utilization;
        if (prevMU == null || currMU == null) continue;
        const delta = currMU - prevMU;
        if (delta > 0 && currMU >= t.utilizationLiquidity.jumpMinLevel
            && (!!severityForValue(delta, t.utilizationLiquidity.utilizationJumpPct) || delta >= t.utilizationLiquidity.jumpActionable)) {
          jumped.push({ loanAsset: m.loanAsset, lltv: m.lltv, prevU: prevMU, currU: currMU, delta, sizeUsd });
        }
      }
      if (jumped.length > 0 && !staleGap) {
        // (token,protocol) 당 1알림 — 가장 큰 점프를 lead 로, 나머지 점프 마켓은 jumpedMarkets 에 breakdown(high_utilization 패턴).
        const lead = [...jumped].sort((a, b) => b.delta - a.delta)[0];
        out.push({
          severity: UNCERTAIN_SEVERITY, // '인지용 경고' 고정(critical 금지)
          kind: "utilization_jump",
          token,
          protocolNodeId: proto,
          message: `${protoLabel(proto)} ${token}/${lead.loanAsset} — +${(lead.delta * 100).toFixed(0)}pp → ${(lead.currU * 100).toFixed(0)}%${jumped.length > 1 ? ` · 외 ${jumped.length - 1}` : ""}`,
          detail: {
            // ⚠️ baselineSource="prev-market": per-market 경로는 마켓별 median 이력이 없어 직전 마켓 util 단일-prev
            //   기준(헤드라인 median 대비 dip-recovery FP 위험 높음). 예외룰/큐레이터가 식별하도록 태깅(2026-06).
            perMarket: true, baselineSource: "prev-market", market: `${token}/${lead.loanAsset}`, lltv: lead.lltv,
            matchedMarkets: jumped.length, scannedMarkets: currMarkets.length,
            baseUtilization: lead.prevU, currUtilization: lead.currU, deltaPp: lead.delta, landedLevel: lead.currU,
            jumpedMarkets: jumped.map((j) => ({ market: `${token}/${j.loanAsset}`, lltv: j.lltv, prevUtil: j.prevU, currUtil: j.currU, deltaPp: j.delta, sizeUsd: j.sizeUsd })),
          },
        });
      }
    } else {
      // ── headline (Aave/Spark/Compound/Fluid 등 mono-pool, topMarkets 없음) — median-baseline 경로(FP 감사 2026-06) ──
      // ★ 기준선 = 최근 util 중앙값(≥3샘플) 우선 — 단일 prev 가 일시 dip/갭복구점이면 "밴드 복귀"를 가짜 점프로 잡는다.
      //   중앙값 대비 점프라야 진짜 run(90%→99%)만 남고 80~94% 밴드 내 왕복은 컷. 중앙값 없으면 prev 폴백.
      const utilMed = baseline && baseline.util.length >= 3 ? median(baseline.util) : null;
      const prevU = prev.attrs?.lendingRisk?.utilization;
      const currU = curr.attrs?.lendingRisk?.utilization;
      const baseU = utilMed ?? prevU;
      if (baseU != null && currU != null && !staleGap) {
        const delta = currU - baseU;
        // 레벨 co-gate: 점프가 jumpMinLevel(70%)에 **안착**할 때만 발화 — idle 5%→20% 같은 노이즈 차단.
        if (delta > 0 && currU >= t.utilizationLiquidity.jumpMinLevel) {
          // UNCERTAIN(2026-06): 인출 러시 전조인지 정상 대형차입인지 확정 불가 → critical 승격 없이 '인지용 경고' 고정.
          const tier = severityForValue(delta, t.utilizationLiquidity.utilizationJumpPct);
          const fires = !!tier || delta >= t.utilizationLiquidity.jumpActionable;
          if (fires) {
            out.push({
              severity: UNCERTAIN_SEVERITY,
              kind: "utilization_jump",
              token,
              protocolNodeId: proto,
              message: `${protoLabel(proto)} ${token} — +${(delta * 100).toFixed(0)}pp → ${(currU * 100).toFixed(0)}%`,
              detail: { baseUtilization: baseU, currUtilization: currU, deltaPp: delta, landedLevel: currU, baselineSource: utilMed != null ? "median" : "prev" },
            });
          }
        }
      }
    }

    // high_utilization(절대 레벨, 상태형)은 scan-current-risks 가 단독 소유(전체스캔 + auto-resolve, currentscan-v1).
    //   diff 는 utilization_jump(이벤트/속도)만 담당. (liquidity_drop_lending 제거 2026-06: util_jump 와 중복.)
  }

  // DEX side
  if (protoClass === "dex") {
    const prevLiq = prev.attrs?.dex?.liquidityUsd;
    const currLiq = curr.attrs?.dex?.liquidityUsd;
    const baseLiq = dexMed ?? prevLiq;  // 스파이크/라우터-잔액 노이즈 내성 기준선
    if (prevLiq != null && currLiq != null && baseLiq != null && currLiq > 0 && !staleGap
        && baseLiq >= t.utilizationLiquidity.minLiquidityUsd && currLiq < baseLiq
        && (baseLiq - currLiq) >= t.utilizationLiquidity.minLiquidityDropUsd) {
      const dropPct = (baseLiq - currLiq) / baseLiq;
      // 읽기 아티팩트 가드(FP 감사 2026-06): 메이저 풀($60M USDT·$33M WBTC 등)이 한 틱에 ~$0 로 떨어지는 건
      //   실제 유동성 증발이 아니라 서브그래프/breadth 빈 read(실측 currLiq $0.00006 vs prev $60M). near-total(≥dexArtifactDropPct) 컷.
      // V3 진동 가드(FP 감사 2026-06 + 적대검증 재설계): Uniswap-V3 집중유동성 풀은 tick 교차로 liquidityUsd 가
      //   tick마다 수배 출렁인다(USDe 실측 $0.73M~$2.44M). 진동은 자기 **최저점까지 내려갔다 복귀**하므로 최저점
      //   근처면 정상; 진짜 드롭/드레인은 최근 윈도 최저점을 **깨고 더 내려간다**. currLiq < min(윈도)×(1−margin)
      //   일 때만 발화 → 점진드레인(매틱 새최저)·flat-read drop(평탄값 아래)도 잡고(구 robustZ 는 MAD 인플레/MAD==0
      //   으로 둘 다 FN), 진동 하단 복귀는 억제. 샘플<3 이면 진동범위 평가 불가 → 발화 보류(신규상장 노이즈 FP 차단).
      const dexSamples = baseline?.dex ?? [];
      const dexFloor = dexSamples.length >= 3 ? Math.min(...dexSamples) * (1 - t.utilizationLiquidity.dexFloorMargin) : null;
      const belowFloor = dexFloor != null && currLiq < dexFloor;
      // 읽기 아티팩트 = near-total 드롭이면서 **잔여가 ~$0**(서브그래프/breadth 빈 read). 잔여가 비-zero($1k+)면
      //   97% 드롭이라도 진짜 near-total 드레인(rug)이라 발화해야 한다(구버전은 dropPct≥95% 면 무조건 억제 → FN).
      const artifactRead = dropPct >= t.utilizationLiquidity.dexArtifactDropPct
        && currLiq < t.utilizationLiquidity.dexArtifactResidualUsd;
      // UNCERTAIN(2026-06): 청산 전조인지 정상 LP 리밸런싱/인센티브 종료인지 breadth 데이터로는 구분 못 함 →
      //   '인지용 경고' 고정(critical 금지). 발화 게이트(드롭% 티어 도달)는 노이즈 차단용으로만 유지.
      const tier = (belowFloor && !artifactRead)
        ? severityForValue(dropPct, t.utilizationLiquidity.dexLiquidityDropPct)
        : null;
      if (tier) {
        out.push({
          severity: UNCERTAIN_SEVERITY,
          kind: "liquidity_drop_dex",
          token,
          protocolNodeId: proto,
          message: `${protoLabel(proto)} ${token} — −${(dropPct * 100).toFixed(1)}% · ${formatUsd(baseLiq)}→${formatUsd(currLiq)}`,
          detail: { prevLiquidityUsd: prevLiq, baseLiquidityUsd: baseLiq, currLiquidityUsd: currLiq, dropPct, baselineSource: dexMed != null ? "median" : "prev" },
        });
      }
    }
  }

  return out;
}
