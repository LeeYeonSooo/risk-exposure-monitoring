import type { Address, PublicClient } from "viem";

import { PUBLIC_RPC, publicClientFor, TRANSFER_TOPIC0, type RawLog } from "@/lib/public-rpc";
import { rpc } from "@/lib/rpc";
import { ZERO_ADDR } from "@/snapshot/flow-trace";

export interface FlowQueryRow {
  row_kind: "edge" | "actor";
  src: string;
  dst: string | null;
  asset: string | null;
  asset_symbol: string | null;
  amount: number | null;
  cnt: number | null;
  min_block: number | null;
  max_block: number | null;
  sample_tx: string | null;
  degree: number | null;
}

const META_ABI = [
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

const topicAddr = (topic: string | undefined): string | null => {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(26)}`.toLowerCase();
};

const blockNum = (log: RawLog): number => Number(BigInt(log.blockNumber));

const hexBlock = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;

async function getLogsFast(
  chain: string,
  address: string,
  fromBlock: bigint,
  toBlock: bigint,
  timeoutMs: number,
): Promise<RawLog[]> {
  const url = PUBLIC_RPC[chain];
  if (!url) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ address, topics: [TRANSFER_TOPIC0], fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock) }],
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { result?: RawLog[] };
    return data.result ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function getLogsFastWindowed(
  chain: string,
  address: string,
  from: bigint,
  to: bigint,
  win: bigint,
  timeoutMs: number,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let lo = from < 0n ? 0n : from;
  while (lo <= to) {
    const hi = lo + win - 1n < to ? lo + win - 1n : to;
    out.push(...await getLogsFast(chain, address, lo, hi, timeoutMs));
    lo = hi + 1n;
  }
  return out;
}

function amountToNumber(raw: bigint, decimals: number): number {
  const scale = 10 ** Math.min(decimals, 18);
  const clipped = decimals > 18 ? raw / BigInt(10 ** (decimals - 18)) : raw;
  return Number(clipped) / scale;
}

async function tokenMeta(tokenAddr: string): Promise<{ symbol: string | null; decimals: number }> {
  const client = rpc();
  const address = tokenAddr as Address;
  let symbol: string | null = null;
  let decimals = 18;
  try {
    const s = await client.readContract({ address, abi: META_ABI, functionName: "symbol" });
    symbol = typeof s === "string" ? s : null;
  } catch {
    symbol = null;
  }
  try {
    const d = await client.readContract({ address, abi: META_ABI, functionName: "decimals" });
    decimals = Number(d);
  } catch {
    decimals = 18;
  }
  return { symbol, decimals: Number.isFinite(decimals) ? decimals : 18 };
}

/**
 * Dune 가 느리거나 실패할 때 쓰는 빠른 온체인 폴백.
 *
 * 한계: 토큰 컨트랙트의 Transfer 이벤트만 보므로 "행위자 사이의 모든 ERC20 자산 흐름"은
 * Dune 결과보다 얕다. 대신 sample_tx/block range 는 실제 로그에서 즉시 채워진다.
 */
export async function collectTokenFlowRowsRpc(
  tokenAddr: string,
  opts: { chain?: string; windowDays: number; maxActors: number },
): Promise<FlowQueryRow[]> {
  const chain = opts.chain ?? "ethereum";
  if (chain !== "ethereum") throw new Error(`RPC flow fallback currently supports ethereum only, got ${chain}`);
  const client = publicClientFor(chain) as PublicClient | null;
  if (!client) throw new Error(`public RPC unavailable for ${chain}`);

  const [{ symbol, decimals }, latest] = await Promise.all([
    tokenMeta(tokenAddr),
    client.getBlockNumber(),
  ]);
  const avgBlockSec = 12;
  const windowBlocks = BigInt(Math.max(1, Math.round((opts.windowDays * 86_400) / avgBlockSec)));
  const maxBlocks = BigInt(Number(process.env.FLOW_RPC_MAX_BLOCKS ?? 2_500));
  const effectiveBlocks = windowBlocks < maxBlocks ? windowBlocks : maxBlocks;
  const from = latest > effectiveBlocks ? latest - effectiveBlocks : 0n;
  const win = BigInt(Number(process.env.FLOW_RPC_LOG_WINDOW_BLOCKS ?? 1_000));
  const timeoutMs = Number(process.env.FLOW_RPC_LOG_TIMEOUT_MS ?? 8_000);
  const logs = await getLogsFastWindowed(chain, tokenAddr, from, latest, win, timeoutMs);

  type Agg = {
    src: string;
    dst: string;
    raw: bigint;
    cnt: number;
    minBlock: number;
    maxBlock: number;
    sampleTx: string | null;
  };
  const aggs = new Map<string, Agg>();
  const degree = new Map<string, number>();

  for (const log of logs) {
    const src = topicAddr(log.topics[1]) ?? ZERO_ADDR;
    const dst = topicAddr(log.topics[2]) ?? ZERO_ADDR;
    if (!src || !dst) continue;
    let raw = 0n;
    try { raw = BigInt(log.data); } catch { raw = 0n; }
    const bn = blockNum(log);
    const key = `${src}|${dst}|${tokenAddr.toLowerCase()}`;
    const cur = aggs.get(key);
    if (cur) {
      cur.raw += raw;
      cur.cnt += 1;
      cur.minBlock = Math.min(cur.minBlock, bn);
      cur.maxBlock = Math.max(cur.maxBlock, bn);
      if (!cur.sampleTx && log.transactionHash) cur.sampleTx = log.transactionHash;
    } else {
      aggs.set(key, { src, dst, raw, cnt: 1, minBlock: bn, maxBlock: bn, sampleTx: log.transactionHash });
    }
    if (src !== ZERO_ADDR) degree.set(src, (degree.get(src) ?? 0) + 1);
    if (dst !== ZERO_ADDR) degree.set(dst, (degree.get(dst) ?? 0) + 1);
  }

  const topActors = [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.maxActors);
  const actorSet = new Set(topActors.map(([addr]) => addr));

  const rows: FlowQueryRow[] = topActors.map(([addr, deg]) => ({
    row_kind: "actor",
    src: addr,
    dst: null,
    asset: null,
    asset_symbol: null,
    amount: null,
    cnt: null,
    min_block: null,
    max_block: null,
    sample_tx: null,
    degree: deg,
  }));

  const edgeRows = [...aggs.values()]
    .filter((e) => actorSet.has(e.src) || actorSet.has(e.dst) || e.src === ZERO_ADDR || e.dst === ZERO_ADDR)
    .sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : b.cnt - a.cnt))
    .slice(0, Math.max(250, opts.maxActors * 30));

  for (const e of edgeRows) {
    rows.push({
      row_kind: "edge",
      src: e.src,
      dst: e.dst,
      asset: tokenAddr.toLowerCase(),
      asset_symbol: symbol,
      amount: amountToNumber(e.raw, decimals),
      cnt: e.cnt,
      min_block: e.minBlock,
      max_block: e.maxBlock,
      sample_tx: e.sampleTx,
      degree: null,
    });
  }

  return rows;
}
