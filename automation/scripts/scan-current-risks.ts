/**
 * 현재 스냅샷의 실제 온체인 설정에서 리스크 시그널을 1회 스캔해 alerts 에 적재.
 * (diff 가 "변화"를 잡는다면, 이건 "지금 상태"의 위험을 한 번 훑어 패널을 채움)
 *
 * 전부 실데이터 기반 — 마켓 LLTV/ouroboros/규모는 DB 의 최신 스냅샷에서 읽음.
 * Usage: npm run scan:risks
 */
import { closePool, query } from "@/db/client";
import { insertAlert, loadActiveStateAlerts, resolveStaleAlerts, updateStateAlert } from "@/db/upsert";
import { RECOMMENDED_THRESHOLDS as T, severityForValue, isNavPricedLoop } from "@/config/alert-thresholds";
import { isSuspectPartialScan } from "@/snapshot/data-quality";
import { fmtUsd } from "@/lib/fmt";
import { protoLabel } from "@/lib/proto-label";
import type { RiskiestPosition } from "@/types/edge-schema";

interface EdgeRow {
  token: string;
  protocol: string;
  edge_type: string;
  attrs: {
    core?: { amountUsd?: number; pctOfSupply?: number | null };
    lendingRisk?: { isFrozen?: boolean | null; utilization?: number | null } | null;
    topMarkets?: Array<{
      loanAsset?: string;
      collateralAsset?: string;
      lltv: number;
      marketSizeUsd: number;
      utilization?: number | null;
      ouroborosRisk?: boolean;
      collateralUsd?: number | null;
      borrowUsd?: number | null;
      riskiestPosition?: RiskiestPosition | null;
    }> | null;
    meta?: { dataSource?: string | null };
  };
}

async function main() {
  // 토큰별 최신 스냅샷의 엣지
  const r = await query<EdgeRow>(`
    WITH latest AS (
      SELECT token_node_id, MAX(snapshot_ts) ts FROM edges GROUP BY token_node_id
    )
    SELECT e.token_node_id AS token, e.protocol_node_id AS protocol,
           e.edge_type, e.attrs
    FROM edges e JOIN latest l
      ON e.token_node_id = l.token_node_id AND e.snapshot_ts = l.ts
  `);

  // ── auto-resolve(상태형) — 이 스캔이 관리하는 kind 들. 단일 source 로 스코프해 diff/nonevm 의 동일 kind 와 분리.
  //    조건이 해소된 active 알림은 resolveStaleAlerts 가 resolved 처리(피드 자동 정리). 지속 조건은 재삽입 안 함(active skip).
  const MANAGED_KINDS = ["reserve_frozen", "high_utilization", "near_liquidation"];
  const SCAN_SOURCE = "currentscan-v1";
  const activeAlerts = await loadActiveStateAlerts(MANAGED_KINDS, SCAN_SOURCE);
  const asserted = new Set<string>();
  let n = 0, updated = 0;
  // 상태 단언 — 새 조건은 insertAlert. 이미 active 면 재삽입 안 하되, **severity 가 바뀌었으면 in-place 갱신**
  //   (assert-once 의 severity-고착 결함 수정: high_util/near_liq 강등·악화가 active 알림에 반영되도록). 악화는 재발송.
  const assertAlert = async (kind: string, tok: string, protocol: string, payload: Parameters<typeof insertAlert>[0]): Promise<void> => {
    const key = `${kind}|${tok}|${protocol ?? ""}`;
    asserted.add(key);
    const active = activeAlerts.get(key);
    if (active) {                                     // 지속 조건 — row 유지, severity 변하면 갱신
      if ((await updateStateAlert(active, { ...payload, source: SCAN_SOURCE })) !== "unchanged") updated++;
      return;
    }
    if (await insertAlert({ ...payload, source: SCAN_SOURCE })) n++;
  };

  for (const row of r.rows) {
    const token = row.token.replace("token:", "");
    const attrs = row.attrs ?? {};

    // 심볼 미해석(token:UNKNOWN) 엣지 — 동일 온체인 리저브가 token:<symbol> 로도 적재돼 있어
    // 이 유령노드는 stale phantom 상태(가짜 reserve_frozen #286 등)만 만든다. 정상 노드가 커버하므로 skip(R6).
    if (token === "" || token.toUpperCase() === "UNKNOWN") continue;
    // 마켓 총공급 규모 — high_utilization dust 게이트용(R4: 의미 없는 초소형 마켓 100% util 차단).
    //   ⚠️ Math.max — topMarkets 합이 작아도(예 $2) core.amountUsd($1.265B)가 크면 큰 값 사용. `||` 는 합이
    //   truthy 면 core 를 무시해 USDC@arbitrum 같은 대형 고-util 마켓을 dust 로 오컷하던 FN(2026-06 검증).
    const marketSupplyUsd = Math.max(
      (attrs.topMarkets ?? []).reduce((s, m) => s + (m.marketSizeUsd ?? 0), 0),
      attrs.core?.amountUsd ?? 0,
    );

    // 1) 동결된 리저브 — 노출 $1M 미만은 죽은 deprecated 리저브(자금 없음)라 skip(노이즈 컷).
    //    ⚠️ severity = info 고정(2026-06 재검증): 동결은 위험이 아니라 위험의 **봉쇄**(방어적 거버넌스 액션).
    //    예: rsETH 는 Kelp 사건 후 Aave 가 보호용 동결(ltv=0 중립화) — 2개월 된 standing 상태를 warning 으로
    //    띄우면 실시간 경보로선 노이즈. 노출 규모와 무관하게 info(대시보드 컨텍스트). 진짜 주목할 "새로 동결됨"
    //    (전이 false→true)은 diff 의 상태변화 경로로 다뤄야 함(follow-up).
    const frozenExposure = attrs.core?.amountUsd ?? 0;
    if (attrs.lendingRisk?.isFrozen === true && frozenExposure >= 1_000_000) {
      await assertAlert("reserve_frozen", token, row.protocol, {
        severity: "info",
        kind: "reserve_frozen",
        token,
        protocolNodeId: row.protocol,
        message: `${protoLabel(row.protocol)} ${token} — 동결 · ${fmtUsd(frozenExposure)}`,
        detail: { exposedUsd: frozenExposure },
      });
    }

    // 2) 유동성 봉쇄(이용률 ≥98%, 임계 상향 2026-06) — 정상 kink(80~95%)는 위험 아님. "봉쇄/고착"(공급자 사실상
    //    못 빠져나감)만 잡고, 온셋(급증)은 diff.ts utilization_jump 이 별도 담당(둘은 보완재).
    //    ⚠️ Morpho 는 격리마켓이라 합산(aggUtil) 안 하고 **마켓별**로. 큰 마켓($1M+) 중 임계 초과만, 규모 최대를
    //    대표로(나머지 개수). Aave/Compound/Fluid 는 토큰=단일 리저브라 리저브 이용률이 곧 per-market.
    const proto = protoLabel(row.protocol);
    const isolatedMarkets = attrs.topMarkets ?? [];
    if (isolatedMarkets.length > 0) {
      // Morpho 등 격리마켓 — 마켓별 이용률(합산 금지)
      const stressed = isolatedMarkets.filter(
        (m) => (m.marketSizeUsd ?? 0) >= 1_000_000 && m.utilization != null
          && !!severityForValue(m.utilization, T.utilizationLiquidity.utilizationAbsolute),
      );
      if (stressed.length > 0) {
        // 대표 = 규모 최대 마켓(자본 노출 최대 = 전염 관점 최우선). 나머지는 개수로, 전 마켓은 detail.
        const lead = [...stressed].sort((a, b) => (b.marketSizeUsd ?? 0) - (a.marketSizeUsd ?? 0))[0];
        const lu = lead.utilization as number;
        const extra = stressed.length > 1 ? ` · 외 ${stressed.length - 1}개 마켓` : "";
        // NAV/교환비 루프(weETH·sUSDS/USDT0 등)는 kink 부근 고-util 이 **설계된 정상상태**(near_liquidation 과 동일
        //   면제 논리). 봉쇄 위험을 완전 묵살하진 않되 page 는 막는다 → info 강등(대시보드 컨텍스트로만). (2026-06 FP)
        const navLoop = isNavPricedLoop(token, lead.loanAsset ?? "");
        // 규모-인지 severity: critical(page)은 차입규모 ≥critMinSizeUsd 마켓만. 소형 격리마켓 100% util 은 봉쇄라도
        //   전염 위험 미미(공급자 인출지연) → warning 강등. NAV-루프는 설계된 정상상태라 info. (2026-06 검증: WBTC/EURC $3M)
        const baseSev = severityForValue(lu, T.utilizationLiquidity.utilizationAbsolute)!;
        const sev = navLoop ? "info"
          : (baseSev === "critical" && (lead.marketSizeUsd ?? 0) < T.utilizationLiquidity.critMinSizeUsd) ? "warning"
          : baseSev;
        await assertAlert("high_utilization", token, row.protocol, {
          severity: sev,
          kind: "high_utilization",
          token,
          protocolNodeId: row.protocol,
          message: `${proto} ${token}/${lead.loanAsset} — 이용률 ${(lu * 100).toFixed(1)}% · ${fmtUsd(lead.marketSizeUsd ?? 0)}${extra}`,
          detail: {
            utilization: lu, market: `${token}/${lead.loanAsset}`, marketSizeUsd: lead.marketSizeUsd,
            stressedMarkets: stressed.map((m) => ({ market: `${token}/${m.loanAsset}`, utilization: m.utilization, sizeUsd: m.marketSizeUsd })),
          },
        });
      }
    } else {
      // Aave/Compound/Fluid — 토큰 = 단일 리저브 (리저브 이용률 = per-market)
      const u = attrs.lendingRisk?.utilization;
      if (u != null && marketSupplyUsd >= 1_000_000) {
        const sevU = severityForValue(u, T.utilizationLiquidity.utilizationAbsolute);
        if (sevU) {
          // 규모-인지 강등(격리마켓과 동일): 소형 리저브 봉쇄는 page 부적정 → warning.
          const sev = (sevU === "critical" && marketSupplyUsd < T.utilizationLiquidity.critMinSizeUsd) ? "warning" : sevU;
          await assertAlert("high_utilization", token, row.protocol, {
            severity: sev,
            kind: "high_utilization",
            token,
            protocolNodeId: row.protocol,
            message: `${proto} ${token} — 이용률 ${(u * 100).toFixed(1)}%`,
            detail: { utilization: u },
          });
        }
      }
    }

    // 3) near_liquidation — **개별 포지션 단위** 청산위험. 마켓 집계 LTV(Σ차입/Σ담보)는 **완전히 폐기**(무의미):
    //    · FN — 큰 안전 포지션(고래)이 Σ담보를 키워 집계 LTV 를 끌어내려 옆의 청산임박 포지션을 가림.
    //    · FP — 집계만 높고 실제 청산 위험 포지션은 거의 없음(누가 헬스팩터 크게 넣으면 집계만 출렁).
    //    ★ 구조적으로 **Morpho 전용** — 차입자별 포지션(riskiestPosition)을 주는 어댑터가 Morpho 뿐(타 어댑터 topMarkets=null).
    //      다른 프로토콜로 넓히려면 그 어댑터가 차입자 포지션을 인덱싱해 riskiestPosition 을 채우고 이 가드를 풀어야 함.
    //      그 전엔 비-Morpho 는 침묵(집계로 흉내내지 않음 — 집계는 의미 없음).
    if ((row.protocol ?? "").startsWith("protocol:morpho_blue")) {
      // 발화 = "충분히 큰(차입≥$1M) 개별 포지션이 청산까지 ≤3%". 게이트: rp 존재 · dropToLiquidation≤3% · 차입≥$1M ·
      //   !navPriced(LST·달러루프·PT 는 NAV/교환비라 시장가-청산 채널 약함 → 어댑터서 조회 자체 생략). 토큰당 최악 1건 대표.
      const nearLiq: Array<{ loanAsset?: string; lltv: number; rp: RiskiestPosition }> = [];
      for (const m of attrs.topMarkets ?? []) {
        if (m.marketSizeUsd < 100_000) continue;
        const rp = m.riskiestPosition;
        const navPriced = isNavPricedLoop(token, m.loanAsset ?? "");
        if (rp && rp.dropToLiquidation <= 0.03 && rp.borrowUsd >= 1_000_000 && !navPriced) {
          nearLiq.push({ loanAsset: m.loanAsset, lltv: m.lltv, rp });
        }
      }
      if (nearLiq.length > 0) {
        // 최악 = 청산까지 낙폭 최소(가장 임박), 동률이면 차입 큰 포지션.
        const worst = [...nearLiq].sort((a, b) => a.rp.dropToLiquidation - b.rp.dropToLiquidation || b.rp.borrowUsd - a.rp.borrowUsd)[0];
        const { rp } = worst;
        const sev = rp.dropToLiquidation <= 0.015 ? "critical" : "warning";
        const extra = nearLiq.length > 1 ? ` · 외 ${nearLiq.length - 1}` : "";
        await assertAlert("near_liquidation", token, row.protocol, {
          severity: sev,
          kind: "near_liquidation",
          token,
          protocolNodeId: row.protocol,
          message: `${protoLabel(row.protocol)} ${token}/${worst.loanAsset} — 최대 위험 포지션 청산까지 −${(rp.dropToLiquidation * 100).toFixed(1)}% · 차입 ${fmtUsd(rp.borrowUsd)}${extra}`,
          detail: {
            loanAsset: worst.loanAsset, lltv: worst.lltv,
            // 개별 포지션 기준(집계 아님): 이 마켓 최대 차입자 중 청산임계 최근접 포지션.
            perPosition: true,
            position: { user: rp.user, healthFactor: rp.healthFactor, borrowUsd: rp.borrowUsd, collateralUsd: rp.collateralUsd },
            dropToLiquidation: rp.dropToLiquidation,
            marketCount: nearLiq.length,
            otherMarkets: nearLiq.slice(1, 5).map((x) => ({ market: `${token}/${x.loanAsset}`, dropToLiquidation: x.rp.dropToLiquidation, borrowUsd: x.rp.borrowUsd })),
          },
        });
      }
    }

    // 4) breadth(미검증) 대형 익스포저 — 알림 제거(사용자 피드백 2026-06): 어댑터 없는 프로토콜의 "정적 노출"은
    //    실시간 위험 이벤트가 아니라 **커버리지 공백** 신호다. 노출 자체는 그래프 엣지(흐름맵)에 그대로 남고,
    //    알림 피드엔 안 띄운다. 검증하려면 해당 프로토콜 어댑터를 추가해야 함(maple/dolomite/spark-savings 등 —
    //    각 프로토콜 컨트랙트를 직접 읽는 bespoke 어댑터 필요. 코드에 아직 없을 뿐, 불가능한 건 아님).
  }

  // 조건이 해소된 active 상태형 알림 자동 정리(피드에서 제거).
  // ⚠️ partial-read 가드(2026-06 검증 FN): edges 부분 결손(어댑터 실패로 열화 스냅샷)으로 asserted 가 비정상
  //   축소되면, 지속 중인 critical(near_liquidation 등)을 데이터 글리치만으로 대량 resolve 해 피드에서 사라진다.
  //   직전 active(activeKeys) 대비 이번 asserted 가 절반 미만이면 = 결손 의심 → resolve 보류(다음 정상 스캔까지 유지).
  let resolved = 0;
  const suspectPartial = isSuspectPartialScan(r.rows.length, activeAlerts.size, asserted.size, T.dataQuality);
  if (suspectPartial) {
    console.warn(`[scan:risks] partial-read 의심(rows=${r.rows.length}, asserted=${asserted.size} vs active=${activeAlerts.size}) — auto-resolve 보류`);
  } else {
    resolved = await resolveStaleAlerts(MANAGED_KINDS, asserted, SCAN_SOURCE);
  }
  console.log(`[scan:risks] ${n} alert(s) 신규 적재, ${updated}건 severity 갱신, ${resolved}건 해소(resolved)`);
  await closePool().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
