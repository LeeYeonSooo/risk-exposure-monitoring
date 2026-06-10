import { createPublicClient, http, type PublicClient } from "viem";

import { env, EVM_CHAINS } from "@/config/chains";

/**
 * 공개 RPC(publicnode) 로그 스캔 전용 클라이언트.
 *
 * 왜 별도: Alchemy 가 viem 의 `eth_getLogs` 요청을 "JSON is not a valid request object"로 거부한다
 * (getBlockNumber/eth_call 등은 정상). 그래서 **로그(getLogs) 계열만** publicnode 로 돌린다.
 * 일반 read(잔액/마켓 파라미터 등)는 기존 Alchemy 클라이언트가 빠르고 안정적이라 그대로 둔다.
 *
 * 깊은 과거(full-history): 무료 RPC 는 getLogs 범위를 제한(Alchemy 10블록·publicnode ~200k)해서 bounded
 * 최근 스캔만 가능. `ARCHIVE_RPC_URL`(유료 archive, 설계 D#12)을 설정하면 `scanLogsRecent(..., deep=true)`
 * 가 한 콜로 fromBlock:0 전체 과거를 훑는다. 미설정이면 기본 zero-cost(publicnode bounded) 유지.
 */

// 공용 체인 레지스트리(config/chains.ts EVM_CHAINS)에서 파생 — 디텍터 간 체인 리스트 단일화.
export const PUBLIC_RPC: Record<string, string> = Object.fromEntries(
  Object.entries(EVM_CHAINS).map(([k, v]) => [k, v.publicRpc]),
);

const _clients = new Map<string, PublicClient>();
export function publicClientFor(chain: string): PublicClient | null {
  const url = PUBLIC_RPC[chain];
  if (!url) return null;
  if (_clients.has(chain)) return _clients.get(chain)!;
  const c = createPublicClient({ transport: http(url, { retryCount: 2, retryDelay: 500, timeout: 30_000 }) }) as PublicClient;
  _clients.set(chain, c);
  return c;
}

/** 유료 archive RPC 설정돼 있으면 그 클라이언트(깊은 과거 getLogs용). 미설정이면 null → 호출부가 publicnode 폴백. */
export function hasArchiveRpc(): boolean { return !!env.ARCHIVE_RPC_URL; }
export function archiveClientFor(_chain: string): PublicClient | null {
  if (!env.ARCHIVE_RPC_URL) return null; // ARCHIVE_RPC_URL = 단일 엔드포인트(보통 홈체인 archive) — 사용자가 대상 체인용으로 설정.
  const key = "__archive__";
  if (_clients.has(key)) return _clients.get(key)!;
  const c = createPublicClient({ transport: http(env.ARCHIVE_RPC_URL, { retryCount: 2, retryDelay: 500, timeout: 60_000 }) }) as PublicClient;
  _clients.set(key, c);
  return c;
}

// keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC0: `0x${string}` = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_TOPIC: `0x${string}` = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface RawLog {
  transactionHash: `0x${string}` | null;
  logIndex: `0x${string}`;
  blockNumber: `0x${string}`;
  data: `0x${string}`;
  topics: `0x${string}`[];
}

const hexBlock = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;

/**
 * raw eth_getLogs. topics 는 [topic0, topic1, topic2] (null 허용). 실패 시 throw(상위에서 흡수).
 * viem getLogs 대신 raw 를 쓰는 이유는 일부 RPC 의 event/args 인코딩 거부 회피.
 */
export async function getLogsRaw(
  client: PublicClient,
  address: string,
  topics: (`0x${string}` | null)[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RawLog[]> {
  return (await client.request({
    method: "eth_getLogs",
    params: [{ address: address as `0x${string}`, topics, fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock) }],
  })) as RawLog[];
}

/** [from,to] 를 win 블록씩 끊어 순방향 스캔(증분 커서용). 각 창 실패는 skip. */
export async function getLogsWindowed(
  client: PublicClient,
  address: string,
  topics: (`0x${string}` | null)[],
  from: bigint,
  to: bigint,
  win = 180_000n,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let lo = from < 0n ? 0n : from;
  while (lo <= to) {
    const hi = lo + win - 1n < to ? lo + win - 1n : to;
    try { out.push(...(await getLogsRaw(client, address, topics, lo, hi))); } catch { /* 창 범위/한도 실패 skip */ }
    lo = hi + 1n;
  }
  return out;
}

const SCAN_WINDOWS = [200_000n, 50_000n, 10_000n]; // publicnode 가 허용하는 최대 창부터(초과 시 축소)

/**
 * 최근 `maxChunks`개 창만큼 과거로 훑어 로그 수집. **bounded 최근 스캔**.
 * ⚠️ full-history 아님 — 무료 RPC 는 getLogs 범위를 제한(Alchemy 10블록·publicnode ~200k)해서
 *    전체 과거 스캔은 비현실적. paid archive RPC 면 한 콜로 fromBlock:0 가능.
 *    (200k 블록 ≈ ETH 28일 → maxChunks=5 면 ≈ 4~5개월 커버.)
 */
export async function scanLogsRecent(
  client: PublicClient,
  address: string,
  topics: (`0x${string}` | null)[],
  maxChunks = 5,
  deep = false, // archive RPC(D#12): 한 콜로 fromBlock:0 전체 과거. 실패 시 bounded 폴백.
): Promise<RawLog[]> {
  let latest: bigint;
  try { latest = await client.getBlockNumber(); } catch { return []; }
  if (deep) {
    try { return await getLogsRaw(client, address, topics, 0n, latest); } catch { /* archive 한도 초과 시 아래 bounded */ }
  }
  let win = 0n;
  let acc: RawLog[] = [];
  for (const w of SCAN_WINDOWS) {
    try { acc = await getLogsRaw(client, address, topics, latest > w ? latest - w : 0n, latest); win = w; break; } catch { /* 더 작은 창 */ }
  }
  if (win === 0n) return [];
  let end = latest - win - 1n;
  let chunks = 1;
  while (chunks < maxChunks && end > 0n) {
    const from = end > win ? end - win : 0n;
    try { acc = acc.concat(await getLogsRaw(client, address, topics, from, end)); } catch { /* 청크 skip */ }
    chunks++;
    end = from - 1n;
  }
  return acc;
}
