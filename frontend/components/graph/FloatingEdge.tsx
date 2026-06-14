"use client";

import {
  type Edge,
  type EdgeProps,
  useInternalNode,
} from "@xyflow/react";

import { edgeColor, STRUCTURAL_EDGE_COLOR, VERIFIED_UNMEASURED_COLOR } from "@/lib/edge-colors";
import { getEdgeParams } from "@/lib/floating-edge";
import { oracleClassOf, ORACLE_COLORS } from "@/lib/oracle";

export interface FloatingEdgeData extends Record<string, unknown> {
  edgeType: string;
  active: boolean;
  danger: boolean;
  faded?: boolean;
  /** breadth(DeFiLlama, 온체인 미검증) 엣지 — 점선 표시 */
  unverified?: boolean;
  /** 검증불가(opaque) — 정체불명 노드(UNKNOWN·이름없는 큐레이터)에 닿는 엣지. 점점선. */
  opaque?: boolean;
  /**
   * 관측됨(실제 발생) 여부. true = 실제 자금(amountUsd>0)이 흐른 엣지 → 범례색(EDGE_TYPE_COLORS).
   * false = 구조상 가능하나 아직 관측 안 됨 → 회색 골격(STRUCTURAL_EDGE_COLOR). undefined = 기존 동작(범례색).
   */
  observed?: boolean;
  /**
   * (b) 관계 검증·금액 미측정 — evidence 는 있는데 amountUsd 가 null(데이터 소스 한계). observed=false 와
   * 별개로 칠하고(VERIFIED_UNMEASURED_COLOR) "구조상 가능" 토글에 안 묶인다. 측정된 0(미사용)은 여기 아님.
   */
  verifiedUnmeasured?: boolean;
  /** cross-protocol bridge tier: potential | latent | realized */
  tier?: string;
  bridge?: boolean;
  sharedWhales?: number;
  /** 레이아웃 중심(토큰) — 파생↔수용처 교차 엣지를 이 점에서 먼 쪽(바깥)으로 크게 휘게. */
  cx?: number;
  cy?: number;
  /** 외곽 반지름(최외곽 노드까지) — 교차 엣지 호의 정점을 이 밖으로 보내 모든 노드를 둘러 가게. */
  rp?: number;
  /** 엣지 위 오라클 원 — 한쪽 끝 마켓이 쓰는 오라클 종류(MARKET/EXCHANGE_RATE/NONE/ORACLE_FREE …)·심볼. */
  oracleType?: string;
  oracleSymbol?: string;
}

export type FloatingEdgeType = Edge<FloatingEdgeData, "floating">;

export function FloatingEdge({
  source,
  target,
  markerEnd,
  data,
}: EdgeProps<FloatingEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!sourceNode || !targetNode) return null;

  const { sx, sy, tx, ty } = getEdgeParams(sourceNode, targetNode);

  // 기본은 직선(동심원). 단 **파생↔수용처 교차 엣지**(collateral_at/staked_in)는 중앙을 직선
  // 관통하지 않게 중심(토큰)에서 먼 쪽으로 크게 휘어 바깥을 둘러 잇는다(길수록 더 큰 호).
  const et = data?.edgeType;
  const isCross = et === "collateral_at" || et === "staked_in";
  const cx = data?.cx, cy = data?.cy, rp = data?.rp;
  let path: string;
  const dx = tx - sx, dy = ty - sy, len = Math.hypot(dx, dy) || 1;
  if (isCross && typeof cx === "number" && typeof cy === "number" && typeof rp === "number") {
    // 최적(낭비 최소): 직선이 **중앙 클러스터를 실제로 가로지를 때만** 휜다. 그것도 외곽 전체가
    // 아니라 클러스터 가장자리까지만 부풀려 짧은 쪽으로 돌아간다.
    const h = Math.abs(dx * (cy - sy) - dy * (cx - sx)) / len; // 중심→코드 수직거리
    const Rcluster = rp * 0.6; // 프로토콜·마켓 밀집 영역 반지름(근사)
    if (h >= Rcluster) {
      path = `M ${sx} ${sy} L ${tx} ${ty}`; // 코드가 클러스터 밖 → 직선
    } else {
      const angS = Math.atan2(sy - cy, sx - cx), angT = Math.atan2(ty - cy, tx - cx);
      let diff = angT - angS;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const bis = angS + diff / 2; // 짧은 쪽 각이등분
      const apexR = Rcluster + rp * 0.1 + 22; // 클러스터 가장자리 살짝 밖까지만
      const apexX = cx + Math.cos(bis) * apexR, apexY = cy + Math.sin(bis) * apexR;
      const m0x = (sx + tx) / 2, m0y = (sy + ty) / 2;
      path = `M ${sx} ${sy} Q ${2 * apexX - m0x} ${2 * apexY - m0y} ${tx} ${ty}`;
    }
  } else {
    path = `M ${sx} ${sy} L ${tx} ${ty}`;
  }

  const active = data?.active ?? false;
  const danger = data?.danger ?? false;
  const faded = data?.faded ?? false;
  const unverified = data?.unverified ?? false;
  const opaque = data?.opaque ?? false;
  // 기반·배킹(언더라잉 체인) 엣지 — 고유 색(cyan)·실선. 인디고/회색 분기에 묶이지 않게 먼저 판정.
  const isBacking = data?.edgeType === "backed_by";
  // (b) 관계 검증·금액 미측정 — 별도 색, 토글에 안 묶임. (a) 구조상 가능(미관측/미사용) = 회색 골격.
  const verified = !isBacking && data?.observed === false && data?.verifiedUnmeasured === true;
  const structural = !isBacking && data?.observed === false && !verified;

  // 엣지 타입별 색. 위험(danger)>기반·배킹(cyan)>관계검증·미측정(인디고)>구조상가능(회색)>관측(범례색) 순.
  const stroke = danger ? "var(--color-danger)" : isBacking ? edgeColor("backed_by") : verified ? VERIFIED_UNMEASURED_COLOR : structural ? STRUCTURAL_EDGE_COLOR : edgeColor(data?.edgeType);

  // 엣지 위 오라클 원 — 마켓이 쓰는 오라클 종류를 색으로(시장가/환율/풀현물/하드코딩). 엣지 중점에.
  const oracleType = data?.oracleType as string | undefined;
  const oracleCls = oracleType ? oracleClassOf(oracleType, null, data?.oracleSymbol as string | undefined) : null;
  const mx = (sx + tx) / 2, my = (sy + ty) / 2;

  return (
    <g>
      {/* Wide invisible hit area — makes hover/click much easier to land on */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: "pointer" }}
      />
      {/* Visible styled path. unverified(breadth) = 점선 + 약간 흐리게 — 온체인 검증 엣지와 구분 */}
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={danger ? 3.2 : structural ? 1.5 : verified ? 2 : active ? 2.8 : 2.4}
        strokeOpacity={
          faded ? 0.08 : danger ? 0.95 : verified ? 0.85 : structural ? 0.5 : opaque ? 0.42 : unverified ? 0.7 : 0.92
        }
        strokeDasharray={verified ? "6 4" : structural ? "2 4" : opaque ? "1.5 4" : unverified ? "7 4" : undefined}
        markerEnd={faded ? undefined : markerEnd}
        style={{
          transition: "stroke 400ms var(--ease-snappy), stroke-opacity 400ms",
          pointerEvents: "none",
        }}
      />
      {/* 오라클 원 — 엣지 중점에 작은 원(오라클 종류 색). 하드코딩·고정은 위험색이라 한눈에 보임. */}
      {oracleCls && !faded && (
        <circle cx={mx} cy={my} r={9} fill={ORACLE_COLORS[oracleCls]} stroke="var(--color-surface)" strokeWidth={2.5} opacity={0.97} style={{ pointerEvents: "none" }}>
          <title>{`오라클: ${oracleCls}`}</title>
        </circle>
      )}
    </g>
  );
}
