"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  type NodeMouseHandler,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GraphEdge, GraphNode, NodeTickState, RiskLevel, TopologyResponse } from "@/lib/api";
import { SAFE_NODE_STATE } from "@/lib/api";
import { collisionRadiusPx, sizeNorm } from "@/lib/node-size";
import { edgeProvenance } from "@/lib/provenance";
import { FloatingEdge, type FloatingEdgeType } from "./FloatingEdge";
import { HoverTooltip, type HoverState } from "./HoverTooltip";
import { RiskNode, type RiskNodeType } from "./RiskNode";

const nodeTypes = { risk: RiskNode };
const edgeTypes = { floating: FloatingEdge };

const SEVERITY: Record<RiskLevel, number> = { safe: 0, caution: 1, danger: 2 };

// Scale the curated position coordinates for ~190px-wide node cards
// 2-layer 레이아웃 좌표를 그대로 사용 (이미 최종 픽셀값).
const LAYOUT_SCALE_X = 1;
const LAYOUT_SCALE_Y = 1;

export interface GraphCanvasProps {
  graphKey: string;
  topology: TopologyResponse;
  nodeStates: Record<string, NodeTickState>;
  walletHighlightIds?: Set<string>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  /** Edge selection — when set, the edge is highlighted and detail panel opens. */
  selectedEdgeId?: string | null;
  onSelectEdge?: (id: string | null) => void;
  /** Phase 4: 검색 결과의 중심 노드 ID — 이 노드들 주변으로 카메라 이동. */
  focusCenterIds?: string[];
  /** Phase 4 옵션 C: 포커스 줌 모드 — 이 셋에 포함된 노드만 표시 (나머지 hidden). */
  focusOnlyIds?: Set<string> | null;
  /** 엣지 타입 필터 — 비어있으면 전체. 채워지면 그 타입 엣지만 보이고 나머지/고립 노드는 dim. */
  edgeTypeFilter?: Set<string>;
  /** 정적 레이아웃 — d3-force 끄고 주어진 좌표 그대로 사용(동심원 4-링 고정 배치용). */
  staticLayout?: boolean;
  /** ReactFlow 내부(ViewportPortal 사용 가능 위치)에 렌더할 오버레이 — 메인화면 실시간 입자 레이어용. */
  overlay?: React.ReactNode;
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider key={props.graphKey}>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// d3-force node type (extends SimulationNodeDatum)
interface D3Node extends SimulationNodeDatum {
  id: string;
  rfId: string;
  // 원래 레이아웃 좌표 — forceX/forceY 앵커가 사용. 드래그 후 "집으로 살짝 돌아가려는" 성향.
  homeX: number;
  homeY: number;
}

function GraphCanvasInner({
  topology,
  nodeStates,
  walletHighlightIds,
  selectedNodeId,
  onSelectNode,
  selectedEdgeId,
  onSelectEdge,
  focusCenterIds,
  focusOnlyIds,
  edgeTypeFilter,
  staticLayout,
  overlay,
}: GraphCanvasProps) {

  const initialNodes = useMemo<RiskNodeType[]>(
    () =>
      topology.nodes.map((n) => ({
        id: n.id,
        type: "risk",
        position: {
          x: (n.position?.x ?? 0) * LAYOUT_SCALE_X,
          y: (n.position?.y ?? 0) * LAYOUT_SCALE_Y,
        },
        draggable: true,
        data: {
          node: n,
          state: SAFE_NODE_STATE,
          walletHighlight: false,
        },
      })),
    [topology],
  );

  const initialEdges = useMemo<FloatingEdgeType[]>(() => {
    const nmap = new Map(topology.nodes.map((n) => [n.id, n] as const));
    return topology.edges.map((e) => {
      // 출처 3단계(verified/estimated/opaque) — 양 끝 노드 + 엣지 dataSource 종합 (정직성 인코딩)
      const prov = edgeProvenance(e, nmap.get(e.source), nmap.get(e.target));
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "floating" as const,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: "#64748b",
        },
        data: {
          edgeType: e.type,
          active: false,
          danger: false,
          unverified: prov === "estimated", // 점선 = breadth(미검증)
          opaque: prov === "opaque",         // 점점선 = 검증불가(DD 불가)
          tier: e.tier,
          bridge: e.bridge,
          sharedWhales: e.sharedWhales,
        },
      };
    });
  }, [topology]);

  const [nodes, setNodes, onNodesChange] = useNodesState<RiskNodeType>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FloatingEdgeType>(initialEdges);

  // Hover tooltip state — fixed-position overlay with rich node/edge metadata
  const [hover, setHover] = useState<HoverState | null>(null);
  // Hover-fade: 아무 모드(검색/포커스/선택)도 없을 때 hover 한 노드+이웃만 밝게 (3번째 보기)
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);

  // O(1) lookups used by hover handlers
  const nodesByIdMap = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of topology.nodes) m.set(n.id, n);
    return m;
  }, [topology.nodes]);
  const edgesByIdMap = useMemo(() => {
    const m = new Map<string, GraphEdge>();
    for (const e of topology.edges) m.set(e.id, e);
    return m;
  }, [topology.edges]);

  // d3-force simulation ref
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const simRef = useRef<any>(null);
  const d3NodesRef = useRef<D3Node[]>([]);
  const animFrameRef = useRef<number | null>(null);
  // 노드별 base 좌표 (포커스 ego-radial 적용 후 해제 시 복귀용)
  const basePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // 현재 드래그 중인 노드 ID (custom force 가 참조)
  const dragNodeIdRef = useRef<string | null>(null);

  // 노드 ID → 인접 노드 ID Set (1-hop 이웃 빠르게 찾기 위함)
  const neighborsMapRef = useRef<Map<string, Set<string>>>(new Map());

  // 노드 영구 고정 (드래그 후 그 자리에 둠 — 사용자가 reset 하기 전까지)
  // ※ d3n.fx/fy 는 simulation 내부 상태. React 와 분리.
  // ※ "리셋" 은 별도 버튼 또는 새로고침으로.

  // ── 엣지 타입별 link strength (오라클/프로토콜 연결은 강하게)
  //    범위 0~1. 클수록 link 가 더 강하게 노드를 끌어당김.
  const EDGE_STRENGTH: Record<string, number> = {
    oracle:     0.40,  // 자산 → 오라클: 같은 피드 의존 자산들이 오라클 주위에 모임
    protocol:   0.30,  // 프로토콜 위임/관리: 관련 컨트랙트 클러스터
    issued_by:  0.30,  // 발행자 → 발행 자산
    restaked:   0.30,
    collateral: 0.15,  // 토큰 ↔ lending 프로토콜
    dex:        0.08,
    yield:      0.08,
    exploit:    0.10,
    deploy:     0.05,
  };
  const DEFAULT_EDGE_STRENGTH = 0.05;

  // ── 엣지 목표 거리: tiger-research 처럼 "거의 균일한 길이" 로 통일.
  //    (타입별 차등 제거 → 직선 + 균일 길이로 가독성↑)
  const EDGE_DISTANCE: Record<string, number> = {};
  const DEFAULT_EDGE_DISTANCE = 200;

  // ── 충돌 반경 / charge 는 노드 규모(log2)에 비례 → 큰 노드가 더 넓게 자리.
  function getNodeRadius(nodeId: string): number {
    const n = nodesByIdMap.get(nodeId);
    const usd = (n?.metadata.sizeUsd ?? n?.metadata.tokensHeldUsd ?? 0) as number;
    return collisionRadiusPx(n?.type === "Token", usd);
  }
  function getNodeCharge(nodeId: string): number {
    const n = nodesByIdMap.get(nodeId);
    const usd = (n?.metadata.sizeUsd ?? n?.metadata.tokensHeldUsd ?? 0) as number;
    // 큰 노드일수록 강하게 밀어냄 (겹침 방지 + 균등 분산)
    return -(380 + sizeNorm(usd) * 520); // -380 ~ -900
  }

  // Initialize d3-force simulation
  useEffect(() => {
    if (staticLayout) return; // 동심원 고정 배치 — 시뮬레이션 안 돌리고 주어진 좌표 그대로.
    const d3Nodes: D3Node[] = topology.nodes.map((n) => {
      const hx = (n.position?.x ?? 0) * LAYOUT_SCALE_X;
      const hy = (n.position?.y ?? 0) * LAYOUT_SCALE_Y;
      return {
        id: n.id,
        rfId: n.id,
        x: hx,
        y: hy,
        homeX: hx,
        homeY: hy,
      };
    });

    const d3Links: (SimulationLinkDatum<D3Node> & { etype?: string })[] = topology.edges
      .map((e) => ({
        source: e.source,
        target: e.target,
        etype: e.type,
      }))
      .filter((l) => {
        const hasSource = d3Nodes.some((n) => n.id === l.source);
        const hasTarget = d3Nodes.some((n) => n.id === l.target);
        return hasSource && hasTarget;
      });

    d3NodesRef.current = d3Nodes;

    // 인접 맵 (1-hop 이웃) — drag attract force 가 사용
    const adj = new Map<string, Set<string>>();
    for (const n of d3Nodes) adj.set(n.id, new Set());
    for (const l of d3Links) {
      const s = typeof l.source === "string" ? l.source : (l.source as D3Node).id;
      const t = typeof l.target === "string" ? l.target : (l.target as D3Node).id;
      adj.get(s)?.add(t);
      adj.get(t)?.add(s);
    }
    neighborsMapRef.current = adj;

    // Custom force: 드래그 중인 노드의 1-hop 이웃을 끌어당김 (묶음 이동 효과)
    // 일반 link force 보다 훨씬 강한 spring 으로 이웃들이 잡은 노드를 따라옴.
    function dragAttract(alpha: number) {
      const dragId = dragNodeIdRef.current;
      if (!dragId) return;
      const nodes = d3NodesRef.current;
      const dragNode = nodes.find((n) => n.id === dragId);
      if (!dragNode) return;
      const neighbors = neighborsMapRef.current.get(dragId);
      if (!neighbors || neighbors.size === 0) return;

      const targetX = dragNode.fx ?? dragNode.x ?? 0;
      const targetY = dragNode.fy ?? dragNode.y ?? 0;
      const TARGET_DIST = 160;   // 이상적 이웃 거리
      const SPRING_K = 0.22;     // spring 강도 ↑ (bubblemaps 식 고무줄: 이웃이 탄성 있게 따라옴)
      const MAX_DV = 28;         // 속도 상한 완화 (탄성/관성 살림 — 단, 폭주는 방지)

      for (const nid of neighbors) {
        const n = nodes.find((x) => x.id === nid);
        if (!n || n.fx != null) continue; // 고정 노드는 skip
        const dx = targetX - (n.x ?? 0);
        const dy = targetY - (n.y ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        // dist 가 TARGET_DIST 보다 멀면 +(끌어당김), 가까우면 -(밀어냄 약하게)
        const k = (dist - TARGET_DIST) * SPRING_K * alpha;
        let dvx = (dx / dist) * k;
        let dvy = (dy / dist) * k;
        // 속도 가산량 clamp — momentum 누적 방지
        if (dvx > MAX_DV) dvx = MAX_DV;
        else if (dvx < -MAX_DV) dvx = -MAX_DV;
        if (dvy > MAX_DV) dvy = MAX_DV;
        else if (dvy < -MAX_DV) dvy = -MAX_DV;
        n.vx = (n.vx ?? 0) + dvx;
        n.vy = (n.vy ?? 0) + dvy;
      }
    }

    const sim = forceSimulation<D3Node>(d3Nodes)
      .force(
        "link",
        forceLink<D3Node, SimulationLinkDatum<D3Node>>(d3Links)
          .id((d) => d.id)
          // 엣지 타입별 strength — 오라클/프로토콜 연결은 강하게
          .strength((l) => {
            const t = (l as SimulationLinkDatum<D3Node> & { etype?: string }).etype ?? "";
            return EDGE_STRENGTH[t] ?? DEFAULT_EDGE_STRENGTH;
          })
          // 엣지 타입별 목표 거리 — 강한 link 는 더 짧게
          .distance((l) => {
            const t = (l as SimulationLinkDatum<D3Node> & { etype?: string }).etype ?? "";
            return EDGE_DISTANCE[t] ?? DEFAULT_EDGE_DISTANCE;
          }),
      )
      // 노드 크기별 charge (인프라는 강하게 밀어냄, 작은 노드는 약하게)
      .force("charge", forceManyBody<D3Node>().strength((d) => getNodeCharge(d.id)))
      // 충돌 반경도 노드 크기 비례
      .force("collide", forceCollide<D3Node>((d) => getNodeRadius(d.id)))
      // Custom: 드래그 중인 노드 + 1-hop 이웃을 끌어당기는 spring
      .force("dragAttract", dragAttract)
      // 방사형(bipartite ring) 구조를 유지하도록 home 앵커를 충분히 둠.
      // 밀집 bipartite 는 순수 force 면 hairball 로 뭉치므로, 균등 간격의 ring 좌표를
      // 골격으로 쓰고 force(직선·균일거리·크기충돌)는 국소 정돈만. (tiger 처럼 직선이되
      // 우리 구조엔 ring 배치가 가독성↑)
      .force("anchorX", forceX<D3Node>((d) => d.homeX).strength(0.06))
      .force("anchorY", forceY<D3Node>((d) => d.homeY).strength(0.06))
      // bubblemaps 식 탄성 드래그: 마찰 낮춰(0.5→0.34) 잡아끌 때 이웃이 고무줄처럼
      // 따라오고 클러스터가 출렁이며(breathing) 자리잡게. alphaDecay 도 살짝 낮춰 여운↑.
      .alphaDecay(0.0215)
      .velocityDecay(0.34);

    // 2-layer 는 결정적 정적 레이아웃 → force settle 안 함(force 가 구조를 흐트러뜨림).
    // d3 노드는 이미 레이아웃 좌표로 시드됨. 아래 setNodes 는 그 좌표를 그대로 RF 에 반영.

    // Apply initial d3 positions to ReactFlow nodes
    setNodes((nds) =>
      nds.map((n) => {
        const d3n = d3Nodes.find((d) => d.id === n.id);
        if (!d3n) return n;
        return { ...n, position: { x: d3n.x ?? n.position.x, y: d3n.y ?? n.position.y } };
      }),
    );

    // 포커스 복귀용 base 좌표 저장 (노드 클릭 시 ego-radial 적용 후 해제하면 여기로 복귀)
    const base = new Map<string, { x: number; y: number }>();
    for (const d of d3Nodes) base.set(d.id, { x: d.x ?? 0, y: d.y ?? 0 });
    basePositionsRef.current = base;

    // Stop after initial layout
    sim.stop();
    simRef.current = sim;

    return () => {
      sim.stop();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [topology, setNodes, staticLayout]);

  // selectedNodeId 의 1-hop 이웃 ID 셋 (노드 확장에 사용)
  const expandedAroundSelected = useMemo<Set<string>>(() => {
    if (!selectedNodeId) return new Set();
    const out = new Set<string>([selectedNodeId]);
    for (const e of topology.edges) {
      if (e.source === selectedNodeId) out.add(e.target);
      if (e.target === selectedNodeId) out.add(e.source);
    }
    return out;
  }, [selectedNodeId, topology.edges]);

  // 노드 클릭 = 재배치 없이 "제자리 하이라이팅"만 (사용자 요구). 위치는 동심원 그대로
  // 두고, 선택 노드 + 1-hop 이웃을 밝게 / 나머지는 흐리게 — 스타일링은 아래 노드 data
  // 업데이트(walletHighlight/faded)가 담당한다. ego-radial 재배치 effect 는 제거됨.

  // hoverNodeId 의 "가지(branch)" 전체 — 1-hop 이 아니라 하위 의존(프로토콜→마켓→볼트/큐레이터)
  // 전부 + 상위(→토큰) 경로까지 밝게. 큐레이터·볼트까지 불이 들어오게(사용자 요구).
  const hoverNeighbors = useMemo<Set<string>>(() => {
    if (!hoverNodeId) return new Set();
    // 방향 인접: children = source→targets (하위 의존), parents = target→sources (상위)
    const children = new Map<string, string[]>();
    const parents = new Map<string, string[]>();
    for (const e of topology.edges) {
      if (!children.has(e.source)) children.set(e.source, []);
      children.get(e.source)!.push(e.target);
      if (!parents.has(e.target)) parents.set(e.target, []);
      parents.get(e.target)!.push(e.source);
    }
    const out = new Set<string>([hoverNodeId]);
    // 하위(descendants) — 마켓·볼트·큐레이터까지 전부
    const down = [hoverNodeId];
    while (down.length) {
      const cur = down.pop()!;
      for (const t of children.get(cur) ?? []) if (!out.has(t)) { out.add(t); down.push(t); }
    }
    // 상위(ancestors) — 토큰까지의 경로(형제 노드는 제외)
    const up = [hoverNodeId];
    while (up.length) {
      const cur = up.pop()!;
      for (const s of parents.get(cur) ?? []) if (!out.has(s)) { out.add(s); up.push(s); }
    }
    return out;
  }, [hoverNodeId, topology.edges]);

  // Sync nodeStates + walletHighlight + 포커스 줌 모드(hidden) + 확장(expanded) 으로 ReactFlow nodes 업데이트
  // 단일 경로: focus 상태(walletHighlightIds/focusOnlyIds)가 노드 클릭·검색 둘 다를 구동.
  // (노드 클릭 시 page 가 focusIds 를 그 노드로 설정 → 검색과 동일하게 토글 모드 적용)
  useEffect(() => {
    const searchActive = (walletHighlightIds?.size ?? 0) > 0;
    const focusActive = !!focusOnlyIds && focusOnlyIds.size > 0;
    // 3번째 보기 — hover-fade: 검색/포커스 둘 다 없을 때만, hover 한 노드+1-hop 이웃만 밝게.
    const hoverActive = !!hoverNodeId && !searchActive && !focusActive;
    // dim 을 구동하는 "켜진 셋": 검색 우선 → 없으면 hover 이웃(노드+엣지 일관). (focus 는 hidden)
    const litSet: Set<string> | null = searchActive
      ? walletHighlightIds!
      : hoverActive
        ? hoverNeighbors
        : null;
    const dimming = !focusActive && litSet != null;

    // 엣지 타입 필터 — 선택된 타입의 엣지에 닿는 노드 집합(고립 노드는 dim 처리용)
    const typeFilterActive = !!edgeTypeFilter && edgeTypeFilter.size > 0;
    const nodesInTypeFilter = typeFilterActive
      ? (() => {
          const s = new Set<string>();
          for (const e of topology.edges) {
            if (edgeTypeFilter!.has(e.type)) {
              s.add(e.source);
              s.add(e.target);
            }
          }
          return s;
        })()
      : null;

    setNodes((nds) =>
      nds.map((n) => {
        const isHighlighted = walletHighlightIds?.has(n.id) ?? false;
        const isInFocus = focusActive ? (focusOnlyIds!.has(n.id)) : true;
        // 섬 핸들은 타입 필터의 영향을 받지 않음(항상 보임).
        const isHandle = n.id.startsWith("island:");
        const typeFaded =
          typeFilterActive && !isHandle && !nodesInTypeFilter!.has(n.id);
        return {
          ...n,
          selected: n.id === selectedNodeId,
          // 포커스 줌 모드: 포커스 셋에 포함된 노드만 보이게
          hidden: focusActive && !isInFocus,
          data: {
            ...n.data,
            state: nodeStates[n.id] ?? SAFE_NODE_STATE,
            walletHighlight: isHighlighted,
            // 검색/hover 셋 밖의 노드 또는 타입 필터에 안 닿는 노드를 흐리게
            faded: (dimming && !(litSet!.has(n.id))) || typeFaded,
          },
        };
      }),
    );
    setEdges((eds) =>
      eds.map((e) => {
        const s = SEVERITY[(nodeStates[e.source] ?? SAFE_NODE_STATE).riskLevel];
        const t = SEVERITY[(nodeStates[e.target] ?? SAFE_NODE_STATE).riskLevel];
        const minSev = Math.min(s, t);
        // 엣지도 포커스 줌 모드에선 양쪽 노드가 모두 보이는 경우만 표시
        const edgeHidden = focusActive
          ? !(focusOnlyIds!.has(e.source) && focusOnlyIds!.has(e.target))
          : false;
        // 검색/hover 시: 양 끝이 "모두" 켜진 셋일 때만 lit (한쪽만 lit인 엣지는 숨김).
        // → 이웃이 다른 비-lit 노드로 뻗는 엣지가 허공으로 보이는 것 방지.
        const edgeLit =
          dimming && litSet!.has(e.source) && litSet!.has(e.target);
        const edgeFaded = dimming && !edgeLit;
        // 엣지 타입 필터: 선택된 타입이 아니면 숨김.
        const typeHidden = typeFilterActive && !edgeTypeFilter!.has(e.data?.edgeType ?? "");
        return {
          ...e,
          // 포커스 줌 숨김 + (검색/hover) 양끝이 모두 lit 이 아닌 엣지 + 타입 필터 밖 엣지는 숨김.
          hidden: edgeHidden || edgeFaded || typeHidden,
          data: {
            ...e.data,
            edgeType: e.data?.edgeType ?? "",
            active: minSev >= 1,
            danger: minSev >= 2,
            faded: edgeFaded,
          },
        };
      }),
    );
  }, [nodeStates, walletHighlightIds, focusOnlyIds, selectedNodeId, expandedAroundSelected, hoverNodeId, hoverNeighbors, edgeTypeFilter, topology.edges, setNodes, setEdges]);

  // 포커스 줌 모드 진입/해제 시 자동 fitView (보이는 노드들만)
  useEffect(() => {
    if (!nodesInitializedRef.current) return;
    const t = setTimeout(() => {
      try {
        fitView({ padding: 0.18, duration: 500 });
      } catch {
        /* ignore */
      }
    }, 60);
    return () => clearTimeout(t);
    // focusOnlyIds 참조가 변할 때만 트리거
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusOnlyIds]);

  // Fit view on mount
  const nodesInitialized = useNodesInitialized();
  const { fitView, setCenter, getNode } = useReactFlow();
  const nodesInitializedRef = useRef(false);
  useEffect(() => {
    if (nodesInitialized) {
      nodesInitializedRef.current = true;
      fitView({ padding: 0.12, duration: 400 });
    }
  }, [nodesInitialized, fitView]);

  // Phase 4: focusCenterIds 변경 시 카메라 부드럽게 이동
  useEffect(() => {
    if (!focusCenterIds || focusCenterIds.length === 0) return;
    if (!nodesInitialized) return;

    // 첫 번째 center 노드를 카메라 중심으로
    const centerId = focusCenterIds[0];
    const node = getNode(centerId);
    if (node && node.position) {
      // ReactFlow Node 위치는 좌상단 — 노드 중심으로 보정 (대략 95×40)
      setCenter(node.position.x + 95, node.position.y + 40, {
        zoom: 1.0,
        duration: 600,
      });
    }
  }, [focusCenterIds, nodesInitialized, setCenter, getNode]);

  // 노드 클릭 시 카메라 이동/줌 없음 — 제자리에서 하이라이팅만 (사용자 요구).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fitView({ padding: 0.12, duration: 200 }), 140);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(timer);
    };
  }, [fitView]);

  // 2-layer 정적 레이아웃: 드래그는 React Flow 기본 동작(onNodesChange)에 맡긴다 →
  // 노드를 잡아 옮기면 그 자리에 머문다(force snap-back 없음). force 시뮬은 비활성(미사용).

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => {
      onSelectNode(node.id);
      onSelectEdge?.(null);
    },
    [onSelectNode, onSelectEdge],
  );

  // 드래그 follow — 잡은 노드의 1-hop 이웃이 같이 딸려옴 (force 시뮬 없이 동기 계산).
  // 드래그 시작 때 잡은 노드 + 이웃의 시작 좌표를 기록 → 이동량의 FOLLOW 비율만큼 이웃 이동.
  const FOLLOW_FACTOR = 0.6;
  const dragRef = useRef<
    null | { sx: number; sy: number; follow: number; nbrs: { id: string; sx: number; sy: number }[] }
  >(null);

  const onNodeDragStart = useCallback<OnNodeDrag<RiskNodeType>>(
    (_, node) => {
      // 섬 핸들(island:*) → 그 체인 노드 전체를 1:1로 함께 이동. 일반 노드 → 1-hop 이웃만 0.6배.
      const isIsland = node.id.startsWith("island:");
      let ids: string[];
      let follow: number;
      if (isIsland) {
        const chain = node.id.slice("island:".length);
        ids = nodesByIdMap.size
          ? [...nodesByIdMap.values()]
              .filter((n) => ((n.metadata?.chain as string) ?? "ethereum") === chain && n.id !== node.id)
              .map((n) => n.id)
          : [];
        follow = 1; // 원 전체가 핸들과 그대로 따라옴
      } else {
        ids = [...(neighborsMapRef.current.get(node.id) ?? [])];
        follow = FOLLOW_FACTOR;
      }
      const nbrs: { id: string; sx: number; sy: number }[] = [];
      ids.forEach((id) => {
        const n = getNode(id);
        if (n?.position) nbrs.push({ id, sx: n.position.x, sy: n.position.y });
      });
      dragRef.current = { sx: node.position.x, sy: node.position.y, follow, nbrs };
    },
    [getNode, nodesByIdMap],
  );

  const onNodeDrag = useCallback<OnNodeDrag<RiskNodeType>>(
    (_, node) => {
      const d = dragRef.current;
      if (!d || d.nbrs.length === 0) return;
      const dx = (node.position.x - d.sx) * d.follow;
      const dy = (node.position.y - d.sy) * d.follow;
      setNodes((nds) =>
        nds.map((n) => {
          const nb = d.nbrs.find((x) => x.id === n.id);
          return nb ? { ...n, position: { x: nb.sx + dx, y: nb.sy + dy } } : n;
        }),
      );
    },
    [setNodes],
  );

  const onNodeDragStop = useCallback<OnNodeDrag<RiskNodeType>>(() => {
    dragRef.current = null; // 이웃은 따라온 자리에 머문다 (move-and-stay)
  }, []);

  // Edge click → open edge detail panel (clears any node selection)
  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: { id: string }) => {
      onSelectEdge?.(edge.id);
      onSelectNode(null);
    },
    [onSelectEdge, onSelectNode],
  );

  // Hover handlers — show tooltip at cursor
  const onNodeMouseEnter = useCallback(
    (e: React.MouseEvent, node: { id: string }) => {
      const original = nodesByIdMap.get(node.id);
      if (original) {
        setHover({ kind: "node", node: original, x: e.clientX, y: e.clientY });
      }
      setHoverNodeId(node.id);
    },
    [nodesByIdMap],
  );
  const onNodeMouseMove = useCallback(
    (e: React.MouseEvent, node: { id: string }) => {
      const original = nodesByIdMap.get(node.id);
      if (original) {
        setHover({ kind: "node", node: original, x: e.clientX, y: e.clientY });
      }
    },
    [nodesByIdMap],
  );
  const onNodeMouseLeave = useCallback(() => {
    setHover(null);
    setHoverNodeId(null);
  }, []);

  const onEdgeMouseEnter = useCallback(
    (e: React.MouseEvent, edge: { id: string }) => {
      const original = edgesByIdMap.get(edge.id);
      if (!original) return;
      const sLabel = nodesByIdMap.get(original.source)?.label ?? original.source;
      const tLabel = nodesByIdMap.get(original.target)?.label ?? original.target;
      setHover({
        kind: "edge",
        edge: original,
        sourceLabel: sLabel,
        targetLabel: tLabel,
        x: e.clientX,
        y: e.clientY,
      });
    },
    [edgesByIdMap, nodesByIdMap],
  );
  const onEdgeMouseMove = useCallback(
    (e: React.MouseEvent, edge: { id: string }) => {
      const original = edgesByIdMap.get(edge.id);
      if (!original) return;
      const sLabel = nodesByIdMap.get(original.source)?.label ?? original.source;
      const tLabel = nodesByIdMap.get(original.target)?.label ?? original.target;
      setHover({
        kind: "edge",
        edge: original,
        sourceLabel: sLabel,
        targetLabel: tLabel,
        x: e.clientX,
        y: e.clientY,
      });
    },
    [edgesByIdMap, nodesByIdMap],
  );
  const onEdgeMouseLeave = useCallback(() => setHover(null), []);

  // 빈 영역 클릭 — 선택 해제(패널 닫기)만. 레이아웃은 그대로 유지.
  //   (이전엔 모든 노드를 unpin + 시뮬레이션 재시작해서 그래프가 "리셋"되는
  //    느낌이 있었음 → 제거. 검색/포커스 상태도 건드리지 않음.)
  const onPaneClick = useCallback(() => {
    onSelectNode(null);
    onSelectEdge?.(null);
  }, [onSelectNode, onSelectEdge]);

  return (
    <>
    <ReactFlow<RiskNodeType, FloatingEdgeType>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseMove={onNodeMouseMove}
        onNodeMouseLeave={onNodeMouseLeave}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseMove={onEdgeMouseMove}
        onEdgeMouseLeave={onEdgeMouseLeave}
        colorMode="light"
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.05}
        maxZoom={2}
        nodesDraggable
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d1d9e6" />
        <Controls showInteractive={false} />
        {overlay}
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const state = nodeStates[(n as RiskNodeType).id];
            if (!state) return "#cbd5e1";
            return state.riskLevel === "danger"
              ? "var(--color-danger)"
              : state.riskLevel === "caution"
                ? "var(--color-caution)"
                : "#94a3b8";
          }}
          maskColor="rgba(241,245,249,0.72)"
          style={{
            background: "rgba(255,255,255,0.86)",
            backdropFilter: "blur(8px)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: 8,
          }}
        />
      </ReactFlow>
    <HoverTooltip hover={hover} />
    </>
  );
}
