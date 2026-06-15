/**
 * 스캐너 공통 런타임 — RPC client·포맷터·샘플 조회를 한 곳에.
 * (스캐너 스크립트마다 clientFor/publicClientFor/fmtUsd/recentSamples 를 복붙하던 중복 제거. 2026-06 리팩터.)
 */
import { createPublicClient, http, type PublicClient } from "viem";

import { evmRpcUrl } from "@/config/chains";
import { query } from "@/db/client";

// 공개 RPC client 는 lib/public-rpc 의 단일 구현 재사용(재발명 금지).
export { publicClientFor } from "@/lib/public-rpc";
// 금액 포맷터는 단일 출처(lib/fmt)에서 재노출 — 스캐너 import 부 호환(fmtUsd/fmtToken).
export { fmtToken, fmtUsd } from "@/lib/fmt";

// 1차 RPC(Alchemy 우선) — 체인명 기준. 디텍터 read 용. 체인당 1회 생성·캐시.
const _clients = new Map<string, PublicClient>();
export function clientFor(chain: string): PublicClient | null {
  const url = evmRpcUrl(chain);
  if (!url) return null;
  if (!_clients.has(chain)) {
    _clients.set(chain, createPublicClient({ transport: http(url, { retryCount: 2, retryDelay: 500, timeout: 25_000 }) }) as PublicClient);
  }
  return _clients.get(chain)!;
}

/** chain_supply_samples 최근 N 샘플(최신순, >0). chain-supply/value-drift 등 공용. */
export async function recentSupplySamples(tokenNodeId: string, chain: string, beforeTs: string, n: number): Promise<number[]> {
  const r = await query<{ total_supply: string }>(
    `SELECT total_supply FROM chain_supply_samples
     WHERE token_node_id=$1 AND chain=$2 AND snapshot_ts < $3
     ORDER BY snapshot_ts DESC LIMIT $4`,
    [tokenNodeId, chain, beforeTs, n],
  ).catch(() => ({ rows: [] as { total_supply: string }[] }));
  return r.rows.map((x) => Number(x.total_supply)).filter((v) => v > 0);
}
