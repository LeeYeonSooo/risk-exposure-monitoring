import type { FlowTx } from "./flow-types";
import { STARKNET_VENUES } from "./nonevm-venues";

/**
 * 스타크넷 라이브 전송 피드 — 표준 starknet_getEvents (사용자 Alchemy 키의
 * starknet-mainnet 엔드포인트로 동작 확인). EVM getLogs 와 동형:
 * 토큰 컨트랙트의 Transfer 이벤트(from·to·u256 금액)를 블록 범위로 조회하고,
 * from/to 가 검증된 장소 주소와 일치할 때만 카운터파티 라벨 (felt 는 선행 0 차이가
 * 있어 BigInt 정규화 후 비교). 이벤트에 시각이 없어 블록 타임스탬프를 따로 조회(캐시).
 */

// sn_keccak("Transfer") — 표준 ERC20 이벤트 셀렉터 (라이브 프로빙으로 검증)
const TRANSFER_KEY = "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
const BLOCK_LOOKBACK = 400;  // ~2-3초 블록 → 6분 윈도우 커버 여유
const EVENT_CAP = 300;
const TS_FETCH_CAP = 60;     // 블록 타임스탬프 조회 상한 (캐시됨)

const normFelt = (x: string) => { try { return "0x" + BigInt(x).toString(16); } catch { return x.toLowerCase(); } };
const VENUE_BY_FELT = new Map(STARKNET_VENUES.map((v) => [normFelt(v.address), { label: v.label, kind: v.kind }] as const));
const ZERO = "0x0";

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!r.ok) return null;
    return ((await r.json()) as { result?: unknown }).result ?? null;
  } catch { return null; }
}

const _blockTsCache = new Map<number, number>();
async function blockTs(url: string, n: number): Promise<number | null> {
  if (_blockTsCache.has(n)) return _blockTsCache.get(n)!;
  const b = (await rpc(url, "starknet_getBlockWithTxHashes", [{ block_number: n }])) as { timestamp?: number } | null;
  if (b?.timestamp == null) return null;
  _blockTsCache.set(n, b.timestamp);
  if (_blockTsCache.size > 5000) _blockTsCache.clear();
  return b.timestamp;
}

interface SnEvent { block_number?: number; transaction_hash?: string; keys?: string[]; data?: string[] }

export async function starknetTransfers(rpcUrl: string, token: string, addr: string, loTs: number, hiTs: number, price: number, decimals: number): Promise<FlowTx[]> {
  const latest = (await rpc(rpcUrl, "starknet_blockNumber", [])) as number | null;
  if (latest == null) return [];
  const events: SnEvent[] = [];
  let continuation: string | undefined;
  for (let page = 0; page < 3 && events.length < EVENT_CAP; page++) {
    const res = (await rpc(rpcUrl, "starknet_getEvents", [{
      from_block: { block_number: Math.max(0, latest - BLOCK_LOOKBACK) }, to_block: "latest",
      address: addr, keys: [[TRANSFER_KEY]], chunk_size: 150, ...(continuation ? { continuation_token: continuation } : {}),
    }])) as { events?: SnEvent[]; continuation_token?: string } | null;
    if (!res?.events?.length) break;
    events.push(...res.events);
    continuation = res.continuation_token;
    if (!continuation) break;
  }
  if (!events.length) return [];

  // 두 가지 이벤트 형태: 신형 = keys[1]=from keys[2]=to + data[low,high] / 구형 = data[from,to,low,high]
  const parsed = events.slice(-EVENT_CAP).map((e) => {
    const k = e.keys ?? [], d = e.data ?? [];
    let from = "", to = "", low = "0x0", high = "0x0";
    if (k.length >= 3 && d.length >= 2) { from = k[1]; to = k[2]; low = d[0]; high = d[1]; }
    else if (d.length >= 4) { from = d[0]; to = d[1]; low = d[2]; high = d[3]; }
    else return null;
    let amount = 0;
    try { amount = Number(BigInt(low) + (BigInt(high) << 128n)) / Math.pow(10, decimals); } catch { /* skip */ }
    return { from: normFelt(from), to: normFelt(to), amount, block: e.block_number ?? 0, hash: e.transaction_hash ?? "" };
  }).filter((x): x is NonNullable<typeof x> => !!x && x.amount > 0 && !!x.hash);

  // 장소 매칭/민트·소각을 우선 타임스탬프 조회 (블록 ts 는 캐시 — 매 폴 비용 수렴)
  const ranked = parsed.sort((a, b) => {
    const av = VENUE_BY_FELT.has(a.from) || VENUE_BY_FELT.has(a.to) || a.from === ZERO || a.to === ZERO ? 0 : 1;
    const bv = VENUE_BY_FELT.has(b.from) || VENUE_BY_FELT.has(b.to) || b.from === ZERO || b.to === ZERO ? 0 : 1;
    return av - bv || b.block - a.block;
  });
  const out: FlowTx[] = [];
  let tsFetches = 0;
  for (const ev of ranked) {
    if (!_blockTsCache.has(ev.block)) { if (tsFetches >= TS_FETCH_CAP) continue; tsFetches++; }
    const ts = await blockTs(rpcUrl, ev.block);
    if (ts == null || ts < loTs || ts > hiTs) continue;
    let kind: FlowTx["kind"] = "transfer";
    let counterparty: string | null = null;
    let direction: "in" | "out" = "out";
    const vTo = VENUE_BY_FELT.get(ev.to), vFrom = VENUE_BY_FELT.get(ev.from);
    if (ev.from === ZERO) { kind = "mint"; direction = "in"; }
    else if (ev.to === ZERO) { kind = "burn"; direction = "out"; }
    else if (vTo) { counterparty = vTo.label; direction = "in"; kind = vTo.kind === "swap" ? "swap" : "deposit"; }
    else if (vFrom) { counterparty = vFrom.label; direction = "out"; kind = vFrom.kind === "swap" ? "swap" : "withdraw"; }
    out.push({ hash: ev.hash, chain: "starknet", token, from: ev.from, to: ev.to, valueUsd: ev.amount * price, ts, direction, kind, counterparty, counterpartyAddr: null, marketHint: null, reasons: [] });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
