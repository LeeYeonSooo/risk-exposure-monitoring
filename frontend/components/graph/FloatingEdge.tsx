"use client";

import {
  type Edge,
  type EdgeProps,
  getStraightPath,
  useInternalNode,
} from "@xyflow/react";

import { edgeColor } from "@/lib/edge-colors";
import { getEdgeParams } from "@/lib/floating-edge";

export interface FloatingEdgeData extends Record<string, unknown> {
  edgeType: string;
  active: boolean;
  danger: boolean;
  faded?: boolean;
  /** breadth(DeFiLlama, 온체인 미검증) 엣지 — 점선 표시 */
  unverified?: boolean;
  /** 검증불가(opaque) — 정체불명 노드(UNKNOWN·이름없는 큐레이터)에 닿는 엣지. 점점선. */
  opaque?: boolean;
  /** cross-protocol bridge tier: potential | latent | realized */
  tier?: string;
  bridge?: boolean;
  sharedWhales?: number;
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

  // 직선 엣지 (tiger-research 스타일) — bezier 의 "구불구불함" 제거.
  const [path] = getStraightPath({
    sourceX: sx,
    sourceY: sy,
    targetX: tx,
    targetY: ty,
  });

  const active = data?.active ?? false;
  const danger = data?.danger ?? false;
  const faded = data?.faded ?? false;
  const unverified = data?.unverified ?? false;
  const opaque = data?.opaque ?? false;

  // 엣지 타입별 색. 위험(danger)일 때만 빨강으로 override (라이브에선 거의 없음).
  const stroke = danger ? "var(--color-danger)" : edgeColor(data?.edgeType);

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
        strokeWidth={danger ? 3.2 : active ? 2.8 : 2.4}
        strokeOpacity={
          faded ? 0.08 : danger ? 0.95 : opaque ? 0.42 : unverified ? 0.7 : 0.92
        }
        strokeDasharray={opaque ? "1.5 4" : unverified ? "7 4" : undefined}
        markerEnd={faded ? undefined : markerEnd}
        style={{
          transition: "stroke 400ms var(--ease-snappy), stroke-opacity 400ms",
          pointerEvents: "none",
        }}
      />
    </g>
  );
}
