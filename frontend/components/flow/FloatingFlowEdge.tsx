"use client";

import { memo } from "react";
import { type EdgeProps, useInternalNode } from "@xyflow/react";

import type { FlowEdge, FlowMode, RiskLevel } from "@/lib/flow-types";

/**
 * Center-to-center floating edge landing on the CIRCLE boundary of each node.
 * Token-flow mode animates particles along the path; `dir:'both'` edges flow in BOTH
 * directions (deposits & withdrawals). A wide transparent path gives a click hit-area.
 */

const KIND_COLOR: Record<FlowEdge["kind"], string> = {
  holds: "#6366f1", market: "#0ea5e9", involves: "#94a3b8", vault: "#a855f7", bridge: "#f59e0b", sibling: "#cbd5e1", oracle: "#64748b",
  trace: "#c026d3", // 퓨샤 — 위험색(빨강 #ef4444)과 확실히 다른 "발견" 색
  derive: "#16a34a", // 초록 — 기초↔파생 토큰 (발행/상환 흐름 차선)
};
const RISK_COLOR: Partial<Record<RiskLevel, string>> = { danger: "#ef4444", caution: "#f59e0b" };
const LANE = 2.6; // perpendicular spacing between the two directional lanes (matches TxFlowLayer)

interface Center { x: number; y: number; r: number }
function centerOf(node: ReturnType<typeof useInternalNode>): Center | null {
  if (!node) return null;
  const w = node.measured?.width ?? 0, h = node.measured?.height ?? 0;
  return { x: node.internals.positionAbsolute.x + w / 2, y: node.internals.positionAbsolute.y + h / 2, r: Math.min(w, h) / 2 };
}

export interface FlowEdgeData {
  kind: FlowEdge["kind"]; weight: number; tvlUsd: number; volUsd?: number; mode: FlowMode; dir?: "forward" | "both"; risk?: RiskLevel; label?: string;
  oracle?: FlowEdge["oracle"]; trace?: FlowEdge["trace"];
  /** 평소 모드 — 이 엣지의 평소 흐름 (두께·라벨에 사용) */
  baseline?: FlowEdge["baseline"];
  /** 윈도우 내 트랜잭션이 한 건도 안 탄 엣지 — 색을 빼서 가라앉힘 */
  dim?: boolean;
  [key: string]: unknown;
}

function Base({ id, source, target, data, selected }: EdgeProps) {
  const s = centerOf(useInternalNode(source));
  const t = centerOf(useInternalNode(target));
  if (!s || !t) return null;

  const d = data as FlowEdgeData;
  const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const x1 = s.x + ux * (s.r + 1), y1 = s.y + uy * (s.r + 1);
  const x2 = t.x - ux * (t.r + 2), y2 = t.y - uy * (t.r + 2);
  const long = d.kind === "bridge" || d.kind === "sibling";
  // relationship-only edges (bridge/sibling/involves=루핑/oracle/trace) carry no two-way deposit flow → ONE line.
  // flow edges (holds/market/vault) carry deposits AND withdrawals → two directional lanes.
  const relation = long || d.kind === "involves" || d.kind === "oracle" || d.kind === "trace";
  const curve = long ? Math.min(130, len * 0.18) : Math.min(26, len * 0.07);
  const mx = (x1 + x2) / 2 - uy * curve, my = (y1 + y2) / 2 + ux * curve;
  const center = `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;

  // dim = "색을 뺀다": 윈도우 내 트랜잭션이 한 건도 안 탄 엣지는 회색·반투명으로 가라앉혀,
  // 흐름이 실재하는 엣지만 상대적으로 도드라지게 한다 (선택하면 일시적으로 색 복귀).
  const dim = !!d.dim && !selected;
  // 위험(알림) 색 입히기는 "흐름 엣지"(holds/market/vault 실선)에만 — 관계 점선(sibling/involves/
  // bridge/oracle/trace)까지 빨갛게 물들면 화면이 점선 천지가 되어 추적(발견) 점선과 구분이 안 된다.
  const baseColor = dim ? "#cbd5e1" : !relation && d.risk && RISK_COLOR[d.risk] ? RISK_COLOR[d.risk]! : KIND_COLOR[d.kind];
  const opacity = dim ? 0.22 : selected ? 1 : d.kind === "sibling" || d.kind === "involves" ? 0.3 : d.kind === "market" ? 0.46 : 0.55;

  const px = uy * LANE, py = -ux * LANE; // right perpendicular × lane
  const lane = (sx: number, sy: number) => `M ${x1 + sx} ${y1 + sy} Q ${mx + sx} ${my + sy} ${x2 + sx} ${y2 + sy}`;
  // 평소 모드: 활동 엣지 두께 = 평소 시간당 흐름($/h, log) — TVL 두께와 별개의 절대 스케일
  const laneW = (selected ? 1.3 : 1) * (
    d.mode === "baseline" && d.baseline ? 0.8 + Math.min(3.2, Math.log10(d.baseline.usdPerHour + 1) * 0.55)
    : d.kind === "holds" ? 0.9 + d.weight * 1.4 : d.kind === "market" ? 0.8 + d.weight : 0.7);
  const midX = 0.25 * x1 + 0.5 * mx + 0.25 * x2, midY = 0.25 * y1 + 0.5 * my + 0.25 * y2;
  const fmtUsd = (u: number) => (u >= 1e6 ? `$${(u / 1e6).toFixed(1)}M` : u >= 1e3 ? `$${(u / 1e3).toFixed(0)}K` : `$${u.toFixed(0)}`);

  return (
    <g className="flow-edge">
      <path d={center} fill="none" stroke="transparent" strokeWidth={16} style={{ cursor: "pointer" }} />
      {relation ? (
        <>
          <path id={`fe-${id}`} d={center} fill="none" stroke={!dim && d.kind === "oracle" && d.oracle?.danger ? "#dc2626" : baseColor} strokeWidth={d.kind === "oracle" ? 1 : d.kind === "trace" ? 1.7 + d.weight * 1.6 : 1.4} strokeOpacity={dim ? 0.22 : d.kind === "oracle" ? 0.45 : d.kind === "trace" ? 0.9 : opacity} strokeDasharray={d.kind === "oracle" ? "3 4" : d.kind === "trace" ? "7 5" : "5 5"} strokeLinecap="round" style={{ pointerEvents: "none" }}>
            {/* trace = 방향 있는 발견 흐름 — 점선이 흐르는 방향으로 기어간다 */}
            {d.kind === "trace" && <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="1s" repeatCount="indefinite" />}
          </path>
          {d.kind === "trace" && (
            // ◆ = 트랜잭션 추적이 "발견"한 새 의존성 표식 — 위험색 점선들과 한눈에 구분.
            <g style={{ pointerEvents: "none" }}>
              <rect x={midX - 4.4} y={midY - 4.4} width={8.8} height={8.8} transform={`rotate(45 ${midX} ${midY})`}
                fill="var(--color-surface, #fff)" stroke={KIND_COLOR.trace} strokeWidth={1.8} />
              <text x={midX} y={midY + 2.4} textAnchor="middle" fontSize={6} fontWeight={800} fill={KIND_COLOR.trace}>N</text>
            </g>
          )}
          {d.kind === "oracle" && !dim && (() => {
            // 오라클 배지 — 원래 상세그래프의 ◉/⚠ 모양: 흰 원 + 위험분류 색 테두리.
            // 시장가(MARKET)=초록 · 환율(EXCHANGE_RATE)=파랑 · 자기참조/NAV·하드코딩=빨강 ⚠ · 미상=회색.
            const oc = d.oracle?.danger ? "#dc2626"
              : d.oracle?.type === "MARKET" ? "#16a34a"
              : d.oracle?.type === "EXCHANGE_RATE" ? "#2563eb"
              : "#64748b";
            const r = d.oracle?.danger ? 9 : 8;
            return (
              <g style={{ pointerEvents: "none" }}>
                <circle cx={midX} cy={midY} r={r} fill="var(--color-surface, #fff)" stroke={oc} strokeWidth={2}
                  style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.18))" }} />
                {d.oracle?.danger
                  ? <text x={midX} y={midY + 3.4} textAnchor="middle" fontSize={9.5} fontWeight={800} fill={oc}>⚠</text>
                  : <circle cx={midX} cy={midY} r={2.8} fill={oc} />}
              </g>
            );
          })()}
        </>
      ) : (
        <>
          <path id={`fe-${id}`} d={lane(px, py)} fill="none" stroke={baseColor} strokeWidth={laneW} strokeOpacity={opacity} strokeLinecap="round" style={{ pointerEvents: "none" }} />
          <path d={lane(-px, -py)} fill="none" stroke={baseColor} strokeWidth={laneW} strokeOpacity={opacity * 0.78} strokeLinecap="round" style={{ pointerEvents: "none" }} />
        </>
      )}
      {/* 평소 모드: 선택한 엣지에 평소 수치를 그 자리에서 — $X/h · 거래수 (거래량 보충은 건수 미상 표기) */}
      {selected && d.baseline && (
        <g style={{ pointerEvents: "none" }}>
          <rect x={midX - 52} y={midY - 18} width={104} height={13} rx={3} fill="var(--color-surface, #fff)" opacity={0.92} />
          <text x={midX} y={midY - 8} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="#0f172a">
            평소 {fmtUsd(d.baseline.usdPerHour)}/h · {d.baseline.txPerHour > 0 ? `${d.baseline.txPerHour >= 10 ? Math.round(d.baseline.txPerHour) : d.baseline.txPerHour.toFixed(1)} tx/h` : "건수 미상(거래량 기반)"}
          </text>
        </g>
      )}
    </g>
  );
}

export const FloatingFlowEdge = memo(Base);
