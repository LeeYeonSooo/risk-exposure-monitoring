/**
 * Flow-graph schema — relationship + flow graph.
 *
 * Within ONE chain a protocol is a SINGLE shared node; every token that uses it
 * links to it (so two tokens sharing Aave = one Aave node, two edges). Markets and
 * vaults are real nodes too, and a market links back to EVERY in-graph token it
 * involves — that is what weaves the web (token ⇄ market ⇄ token). Different chains
 * are separate; their tokens/protocols are joined by bridge / sibling edges.
 */

export type FlowNodeKind = "token" | "protocol" | "market" | "vault" | "external" | "bridge";
export type RiskLevel = "safe" | "caution" | "danger";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  /** owning/primary token symbol (grouping hint); shared nodes use "" */
  token: string;
  chain: string;
  protocol?: string;
  tvlUsd: number;
  /** 일 거래량 USD (DeFiLlama volumeUsd1d 합) — DEX 류만 값이 있음. TVL 작아도 거래량 큰
   *  프로토콜(Uniswap)이 잘리지 않게 표시/선별 기준에 함께 쓴다. */
  volUsd?: number;
  /** share of the parent total (0..1) */
  sharePct?: number;
  /** token contract address on this chain (token nodes) */
  address?: string;
  /** 파생/LP 토큰 (derive 엣지의 타깃) — 기초 토큰보다 시각 크기를 줄인다 */
  derived?: boolean;
  meta?: Record<string, unknown>;
  risk?: RiskLevel;
}

// trace = live event feed로 발견된 흐름 — 기존 정적 엣지에 없던 "새 의존성"만 추가.
// derive = 기초자산 ↔ 파생 토큰 (랩/4626 발행·상환, 풀 LP 발행) — 머니레고의 토큰→토큰 연결.
//          온체인 검증(asset()/stETH()/eETH() 역참조, Curve API lpTokenAddress)된 쌍만. 흐름 엣지(차선 2개).
export type FlowEdgeKind = "holds" | "market" | "involves" | "vault" | "bridge" | "sibling" | "oracle" | "trace" | "derive";

/** 마켓 오라클 인텔 — 우리 DB 의 온체인 introspection(edges.attrs.topMarkets[].oracle) 결과. */
export interface OracleIntel {
  type?: string | null;        // MARKET | EXCHANGE_RATE | NAV | ORACLE_FREE …
  provider?: string | null;    // Chainlink · Morpho per-market …
  description?: string | null;
  verified?: boolean;
  address?: string | null;
  /** NAV/하드코딩(자기참조) — 디페그가 가격에 안 잡혀 청산 지연 위험 */
  danger?: boolean;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  kind: FlowEdgeKind;
  tvlUsd: number;
  /** 일 거래량 USD — DEX 풀/프로토콜 엣지만 (표시·컷오프에 max(tvl, vol) 사용) */
  volUsd?: number;
  /** normalized 0..1 — particle density / stroke weight */
  weight: number;
  chain: string;
  /** ambient flow direction along the edge */
  dir?: "forward" | "both";
  label?: string;
  bridge?: { mechanism?: string | null; protocol?: string | null; fromChain: string; toChain: string };
  /** kind=oracle 엣지의 introspection 인텔 (있을 때만 — 우리 DB) */
  oracle?: OracleIntel;
  /** kind=trace 엣지의 집계 수치 (event feed, current live window) */
  trace?: { assetSymbol: string | null; amountUsd: number | null; count: number; windowDays?: number; windowSec?: number; sampleTx?: string | null; viaCollapsed?: boolean; source?: "event" | "snapshot" | "baseline" };
  /** 평소(베이스라인) 모드 오버레이 — 이 엣지의 평소 흐름 (클라이언트가 부착).
   *  source: scan = 실전송 집계(유입/유출·거래수 분리) · volume = DeFiLlama 일거래량 보충
   *  (DEX 풀 — 방향·건수 없음, 24h 전체 기준) · mixed = 둘 다. 공유 엣지는 토큰별 관측구간이
   *  다를 수 있어 min/max 범위로 정직 표기. */
  baseline?: {
    usdPerHour: number; txPerHour: number; usd: number; count: number;
    inUsdPerHour: number; outUsdPerHour: number; inTxPerHour: number; outTxPerHour: number;
    observedSecMin: number; observedSecMax: number;
    source: "scan" | "volume" | "mixed";
    /** 토큰별 분해 — 입자 색을 토큰으로 칠하기 위한 per-token 레이트 (vol = 방향 미상 거래량 기반) */
    byToken?: Record<string, { inUsdPerHour: number; outUsdPerHour: number; volPerHour: number }>;
  };
}

export interface FlowTokenSummary {
  symbol: string;
  tvlUsd: number;
  chains: string[];
  addressByChain: Record<string, string>;
}

export interface FlowGraph {
  tokens: FlowTokenSummary[];
  chains: { chain: string; tvlUsd: number; tokens: number }[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  generatedAt: string;
  notes?: string[];
}

export type FlowMode = "token-flow" | "transaction" | "baseline";

/** 라이브(실시간) 모드 트레일링 윈도우 — 서버(/api/transactions)와 클라(트레이스 라벨)가 공유 */
export const LIVE_WINDOW_SEC = 30 * 60; // 최근 30분 (1분 지연 버퍼는 별도)
export const LIVE_DELAY_SEC = 60;

/** 평소(베이스라인) 모드 — 목표 집계 윈도우. 실제 관측 구간은 토큰별로 다를 수 있다(정직 표기). */
export const BASELINE_TARGET_SEC = 24 * 3600;

/**
 * 공개·무인증 흐름 API(/api/transactions·/api/flow-baseline)가 받는 타깃(체인:주소) 개수 상한.
 * 정상 흐름맵 뷰는 토큰+파생패밀리 노드 ~30개 — 넉넉히 48. 무제한이면 공격자가 수천 개 distinct
 * 주소로 한 번에 unbounded fan-out 을 일으켜 공유 Alchemy CU 를 고갈(denial-of-wallet)시킬 수 있다.
 * (2026-06-13 배포 준비성 감사)
 */
export const MAX_FLOW_TARGETS = 48;

/** /api/flow-baseline 한 행 — (토큰, 카운터파티, 방향)별 평소 흐름 집계 (실전송 기반, 레이트는 관측구간 기준) */
export interface FlowBaselineRow {
  token: string;
  chain: string;
  counterparty: string;        // 그래프 노드 라벨로 해석되는 카운터파티 (레지스트리/노드 매칭만 — 추측 0)
  counterpartyAddr: string | null;
  marketHint: string | null;   // 식별된 DEX 풀 페어("WBTC-WETH") — 마켓 노드 라우팅 힌트
  kind: "deposit" | "withdraw" | "swap" | "wrap" | "unwrap"; // wrap/unwrap = 기초↔파생(derive 엣지) 평소 흐름
  direction: "in" | "out";
  usd: number;                 // 관측 구간 총 USD
  count: number;               // 관측 구간 tx 수
  usdPerHour: number;
  txPerHour: number;
  sampleTx: string | null;
  /** 이 행의 관측구간(초) — 렌딩 이벤트 로그 행은 정확히 24h, 전송 스캔 행은 토큰 커버리지 적용(미지정) */
  observedSec?: number;
}
/** 토큰별 관측 커버리지 — 페이지 캡으로 24h 전체를 못 본 경우 관측구간이 줄어든다(레이트는 그 구간 기준) */
export interface FlowBaselineCoverage { token: string; chain: string; observedSec: number; targetSec: number; truncated: boolean }

/** A near-real-time (≈1 min delayed) real transfer surfaced in the 흐름맵. All tx are equal — no classification. */
export interface FlowTx {
  hash: string;
  chain: string;
  token: string;
  from: string;
  to: string;
  valueUsd: number;
  ts: number; // unix seconds (event time, ~1min delayed)
  /** flow direction in the graph: into a protocol (deposit/mint/wrap) or out (withdraw/burn/unwrap) */
  direction: "in" | "out";
  kind: "deposit" | "withdraw" | "swap" | "mint" | "burn" | "wrap" | "unwrap" | "transfer";
  counterparty?: string | null; // label of the non-token side (known protocol, or generically-resolved contract)
  counterpartyAddr?: string | null; // the contract address of that counterparty (for generic/dynamic nodes)
  /** known pool pair (e.g. "WBTC-WETH") when the counterparty is a derived DEX pool — lets the
   *  renderer land the particle on the EXACT market node instead of stopping at the protocol. */
  marketHint?: string | null;
  reasons: string[];
}
