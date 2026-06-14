/**
 * 현재 스냅샷의 실제 온체인 설정에서 리스크 시그널을 1회 스캔해 alerts 에 적재.
 * (diff 가 "변화"를 잡는다면, 이건 "지금 상태"의 위험을 한 번 훑어 패널을 채움)
 *
 * 전부 실데이터 기반 — 마켓 LLTV/ouroboros/규모는 DB 의 최신 스냅샷에서 읽음.
 * Usage: npm run scan:risks
 */
import { closePool, query } from "@/db/client";
import { insertAlert, upsertLoopFinding } from "@/db/upsert";

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

  let n = 0;
  for (const row of r.rows) {
    const token = row.token.replace("token:", "");
    const attrs = row.attrs ?? {};

    // 1) 동결된 리저브
    if (attrs.lendingRisk?.isFrozen === true) {
      await insertAlert({
        severity: "warning",
        kind: "reserve_frozen",
        token,
        protocolNodeId: row.protocol,
        message: `${token} reserve is FROZEN on ${row.protocol.replace("protocol:", "")}`,
      });
      n++;
    }

    // 2) 가동률 과열 (≥95%)
    const u = attrs.lendingRisk?.utilization;
    if (u != null && u >= 0.95) {
      await insertAlert({
        severity: "warning",
        kind: "high_utilization",
        token,
        protocolNodeId: row.protocol,
        message: `${token} utilization ${(u * 100).toFixed(1)}% on ${row.protocol.replace("protocol:", "")} — 유동성 회수 어려움`,
        detail: { utilization: u },
      });
      n++;
    }

    // 3) Morpho 마켓: 고-LLTV + ouroboros + 부실채권 임계 (실제 마켓 설정)
    for (const m of attrs.topMarkets ?? []) {
      if (m.marketSizeUsd < 100_000) continue;
      // (동일패밀리 재담보 ouroboros_market 알림 + structural-v1 loop_finding 제거 — 약한 추정 신호)
      if (m.lltv >= 0.945) {
        await insertAlert({
          severity: "info",
          kind: "high_lltv_market",
          token,
          protocolNodeId: row.protocol,
          message: `High-LLTV: ${token}/${m.loanAsset} @ ${(m.lltv * 100).toFixed(1)}% (${fmtUsd(m.marketSizeUsd)}) — 청산 여유 적음`,
          // collateral 포함(회장 작업3) — 담보+대출+LLTV 마켓 변별. 스캐너가 실제 가진 심볼만 실음(추측 없음).
          //   collateralAsset 없으면 token(=담보 토큰) 으로 폴백. 관계맵 alert-link 가 이 마켓만 위험색.
          detail: { collateral: m.collateralAsset ?? token, loanAsset: m.loanAsset, lltv: m.lltv, sizeUsd: m.marketSizeUsd },
        });
        n++;
      }

      // E) 부실채권 임계 — 담보가 몇 % 빠지면 underwater? (정밀 aggLTV 있을 때만 알림 발화;
      //    worst-case 는 패널 표시용이지 알림은 high_lltv 와 중복이라 안 띄움)
      const bd = badDebtThreshold(m);
      if (bd && bd.aggLtv != null && bd.dropToUnderwater <= 0.15) {
        const sev = bd.dropToUnderwater <= 0.07 ? "critical" : "warning";
        await insertAlert({
          severity: sev,
          kind: "bad_debt_threshold",
          token,
          protocolNodeId: row.protocol,
          source: "baddebt-v1",
          message:
            `부실채권 임계: ${token}/${m.loanAsset} — 담보가 −${(bd.dropToUnderwater * 100).toFixed(1)}% 빠지면 underwater` +
            ` (~${fmtUsd(bd.debtUsd)} 위험, ${bd.mode})`,
          detail: {
            // collateral 포함(회장 작업3) — bad_debt 는 critical 발화 가능. 담보+대출+LLTV 로 그 마켓만 위험색(추측 없음).
            collateral: m.collateralAsset ?? token,
            loanAsset: m.loanAsset,
            lltv: m.lltv,
            aggLtv: bd.aggLtv,
            dropToUnderwater: bd.dropToUnderwater,
            dropToLiquidation: bd.dropToLiquidation,
            debtUsd: bd.debtUsd,
            mode: bd.mode,
          },
        });
        n++;
      }
    }

    // 4) breadth(미검증) 익스포저가 큰 경우 — 추적 정확도 낮음 표시
    if ((attrs.meta?.dataSource ?? "").startsWith("defillama") && (attrs.core?.amountUsd ?? 0) >= 100_000_000) {
      await insertAlert({
        severity: "info",
        kind: "unverified_large_exposure",
        token,
        protocolNodeId: row.protocol,
        message: `${token} → ${row.protocol.replace("protocol:dl:", "")} ${fmtUsd(attrs.core?.amountUsd ?? 0)} (breadth, 온체인 미검증)`,
        detail: { amountUsd: attrs.core?.amountUsd },
      });
      n++;
    }
  }

  console.log(`[scan:risks] ${n} alert(s) 적재`);
  await closePool().catch(() => {});
}

/**
 * 부실채권 임계 — 격리마켓에서 담보가 몇 % 빠지면 underwater(담보<부채)/청산되는가.
 * 정밀: aggLTV = 차입$ / 담보$ → underwater drop = 1−aggLTV, 청산 drop = 1−aggLTV/LLTV.
 * 데이터 부족 시 worst-case: 포지션이 LLTV 한계에 있다고 가정 → underwater drop = 1−LLTV.
 */
function badDebtThreshold(m: {
  lltv: number;
  marketSizeUsd: number;
  utilization?: number | null;
  collateralUsd?: number | null;
  borrowUsd?: number | null;
}): { dropToUnderwater: number; dropToLiquidation: number; debtUsd: number; aggLtv: number | null; mode: string } | null {
  if (!m.lltv || m.lltv <= 0) return null;
  const borrow = m.borrowUsd ?? (m.utilization != null ? m.marketSizeUsd * m.utilization : null);
  const collat = m.collateralUsd ?? null;
  if (collat && collat > 0 && borrow != null && borrow > 0) {
    const aggLtv = borrow / collat;
    return {
      aggLtv,
      dropToUnderwater: Math.max(0, 1 - aggLtv),
      dropToLiquidation: Math.max(0, 1 - aggLtv / m.lltv),
      debtUsd: borrow,
      mode: "정밀(aggLTV)",
    };
  }
  return {
    aggLtv: null,
    dropToUnderwater: Math.max(0, 1 - m.lltv),
    dropToLiquidation: 0,
    debtUsd: borrow ?? m.marketSizeUsd,
    mode: "worst-case(LLTV)",
  };
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
