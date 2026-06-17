/**
 * diff 엔진의 baseline/prev 조회 헬퍼 — diffAndAlert(오케스트레이터) 전용 DB·RPC read.
 * (god-file 축소 2026-06: diff.ts 에서 fetch* 7개를 분리. 디텍터 로직 무관 — 순수 데이터 조회라 충돌·위험 최소.)
 */
import { classifyAsset } from "@/config/alert-thresholds";
import { query } from "@/db/client";
import { rpc } from "@/lib/rpc";
import { median } from "@/lib/stats";
import { marketKey } from "@/snapshot/rules/shared";
import type { EdgeSnapshot } from "@/types/edge-schema";

interface MarketUtilRow { collateralAsset?: string; loanAsset?: string; oracleAddress?: string; irmAddress?: string; lltv: number; utilization?: number | null }

/**
 * per-market util 시계열(현재 ts 미만, 최신 N) — util_jump per-market 경로의 median baseline.
 * 단일-prev baseline 은 직전 스냅샷의 transient dip 이 +Δpp 를 인위적으로 부풀려 dip-recovery FP 를 낸다(#725/#703 weETH).
 *   marketKey(5요소·오라클/irm 주소 포함→프로토콜 구분)별 최근 util 을 median 기준선으로 써 일시 dip 만 평활(지속 상승은 추종).
 */
export async function fetchRecentMarketUtil(tokenNodeId: string, beforeTs: string, perMarket = 8): Promise<Map<string, number[]>> {
  const r = await query<{ markets: MarketUtilRow[] | null }>(
    `SELECT attrs->'topMarkets' AS markets FROM edges
     WHERE token_node_id = $1 AND snapshot_ts < $2 AND attrs->'topMarkets' IS NOT NULL
     ORDER BY snapshot_ts DESC LIMIT 200`,
    [tokenNodeId, beforeTs],
  ).catch(() => ({ rows: [] as { markets: MarketUtilRow[] | null }[] }));
  const map = new Map<string, number[]>();
  for (const row of r.rows) {
    for (const m of row.markets ?? []) {
      if (m.utilization == null || !(m.utilization >= 0)) continue;
      const k = marketKey(m);
      let arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      if (arr.length < perMarket) arr.push(Number(m.utilization));
    }
  }
  return map;
}

// 디페그 판정 기준선 = 이 토큰의 **최근 디페그 알림 가격**(detail.priceUsd) median.
//   chain_supply_samples 는 sUSDat 같은 소형 담보 토큰의 가격 이력이 없어(0샘플) 정작 재발화 대상을 못 잡는다.
//   대신 "그동안 우리가 디페그로 알린 가격"을 baseline 으로: 며칠째 ~$0.95 로 알려왔으면 그게 baseline →
//   현재도 ~$0.95 면 추가하락 아님 → 재발화 억제. 진짜 추가하락($0.95→$0.88)이면 baseline 밑이라 다시 발화.
//   첫 break(이전 알림 없음)는 baseline null → $1 기준으로 발화(초기 이탈 포착). 보조로 chain_supply 가격도 병합.
export async function fetchRecentPriceBaseline(tokenNodeId: string, label: string, beforeTs: string): Promise<number | null> {
  const [alertR, csR] = await Promise.all([
    query<{ p: number }>(
      `SELECT (detail->>'priceUsd')::float8 p FROM alerts
       WHERE kind='depeg' AND token=$1 AND detail ? 'priceUsd' AND created_at > now() - interval '7 days'
       ORDER BY created_at DESC LIMIT 30`,
      [label],
    ).catch(() => ({ rows: [] as { p: number }[] })),
    query<{ su: number; ts: number }>(
      `SELECT sum(supply_usd) su, sum(total_supply) ts FROM chain_supply_samples
       WHERE token_node_id=$1 AND snapshot_ts < $2 AND supply_usd IS NOT NULL AND total_supply > 0
       GROUP BY snapshot_ts ORDER BY snapshot_ts DESC LIMIT 48`,
      [tokenNodeId, beforeTs],
    ).catch(() => ({ rows: [] as { su: number; ts: number }[] })),
  ]);
  // 상한 필터 — USD 는 글리치($5↑) 컷. LST/BTC래퍼는 실가격이 ~$1800/$60000 라 종전 `p < 5` 가 비-USD baseline 을 **전량 폐기**
  //   → priceBaseline 영구 null → depeg.ts 평활 가드(cmpPrice=max(price,baseline)) 무력화(시장가-NAV skew FP #710/#705). 자산클래스별 상한.
  const usdLike = classifyAsset(label) === "stable" || classifyAsset(label) === "stable_soft";
  const upper = usdLike ? 5 : Number.POSITIVE_INFINITY;
  const prices = [
    ...alertR.rows.map((x) => Number(x.p)),
    ...csR.rows.map((x) => Number(x.su) / Number(x.ts)),
  ].filter((p) => p > 0 && p < upper);
  if (prices.length < 3) return null;  // 이력 부족 → $1/NAV 기준 폴백(초기 break 포착)
  return median(prices);
}

/**
 * totalSupply 시계열 윈도 — robust z-score baseline.
 * 현재 스냅샷(beforeTs) "미만"의 최근 limit 개만 → 자기 자신으로 baseline 오염 방지
 * (persist 가 diff 보다 먼저 돌아 현재 샘플이 이미 들어있어도 제외됨).
 */
export async function fetchRecentSupplySamples(
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

// 토큰의 각 프로토콜 엣지별 최근 유동성 시계열(현재 ts 미만, 최신 N) — 드롭 판정의 중앙값 기준선용.
// 단일 prev 가 일시 스파이크였다 복원될 때 가짜 liquidity_drop 이 뜨는 것(R1, 활성 FP의 최대 군)을 차단.
export async function fetchRecentEdgeLiquidity(
  tokenNodeId: string,
  beforeTs: string,
  perEdge = 6,
): Promise<Map<string, { lend: number[]; dex: number[]; util: number[] }>> {
  const r = await query<{ protocol: string; lend_liq: number | null; dex_liq: number | null; util: number | null }>(
    `SELECT protocol_node_id AS protocol,
            (attrs->'lendingRisk'->>'liquidityUsd')::float8 AS lend_liq,
            (attrs->'dex'->>'liquidityUsd')::float8 AS dex_liq,
            (attrs->'lendingRisk'->>'utilization')::float8 AS util
     FROM edges
     WHERE token_node_id = $1 AND snapshot_ts < $2
     ORDER BY snapshot_ts DESC
     LIMIT 400`,
    [tokenNodeId, beforeTs],
  ).catch(() => ({ rows: [] as { protocol: string; lend_liq: number | null; dex_liq: number | null; util: number | null }[] }));
  const map = new Map<string, { lend: number[]; dex: number[]; util: number[] }>();
  for (const row of r.rows) {
    let e = map.get(row.protocol);
    if (!e) { e = { lend: [], dex: [], util: [] }; map.set(row.protocol, e); }
    if (row.lend_liq != null && row.lend_liq > 0 && e.lend.length < perEdge) e.lend.push(Number(row.lend_liq));
    if (row.dex_liq != null && row.dex_liq > 0 && e.dex.length < perEdge) e.dex.push(Number(row.dex_liq));
    if (row.util != null && row.util >= 0 && e.util.length < perEdge) e.util.push(Number(row.util));
  }
  return map;
}

// (token, protocol) 엣지가 직전 스냅샷보다 더 과거(≥1일 전)에 존재한 적 있는지 — collateral_adoption
// 신규성 판정을 단일 스냅샷 부재가 아니라 "역사적 부재"로 강화(부분폴 dropout FP 차단).
export async function edgeExistedBefore(tokenNodeId: string, protocolNodeId: string, beforeTs: string): Promise<boolean> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM edges
     WHERE token_node_id = $1 AND protocol_node_id = $2
       AND snapshot_ts < ($3::timestamptz - interval '1 day')`,
    [tokenNodeId, protocolNodeId, beforeTs],
  ).catch(() => ({ rows: [{ n: 1 }] }));  // 쿼리 실패 시 보수적으로 "있었음"=발화 안 함(fail-safe against FP)
  return (r.rows[0]?.n ?? 1) > 0;
}

export async function fetchPrevEdges(tokenNodeId: string): Promise<EdgeSnapshot[]> {
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

export async function fetchPrevTopHolders(tokenNodeId: string): Promise<Array<{ address: string; amount: number }> | null> {
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
export async function fetchTotalSupplyAtBlock(
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
