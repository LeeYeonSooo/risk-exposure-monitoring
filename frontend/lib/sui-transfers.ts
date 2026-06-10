import type { FlowTx } from "./flow-types";
import { SUI_VENUES } from "./nonevm-venues";

/**
 * Sui 라이브 전송 피드 — 공개 풀노드 suix_queryTransactionBlocks (키리스, 라이브 프로빙 검증).
 * Sui 는 코인 전송이 표준 이벤트를 내지 않아 "토큰 → 전송 목록" 직접 조회가 없다.
 * 대신 검증된 장소 패키지(MoveFunction 필터)의 최근 트랜잭션을 받아, 각 tx 의
 * balanceChanges 에서 대상 코인 타입의 이동을 읽는다 — 장소가 곧 쿼리 키라서
 * 카운터파티는 구조적으로 확정(추측 0)이지만, 등재 장소를 거치지 않은 P2P 전송은
 * 구조적으로 보이지 않는다 (배지에 공지). JSON-RPC 는 2026-07 폐기 예정 → 추후 GraphQL 이전 필요.
 */

const RPC = process.env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443";
const TX_LIMIT = 25; // 장소당 최근 tx (폴마다, 결과는 짧게 캐시)

interface BalanceChange { coinType?: string; amount?: string; owner?: { AddressOwner?: string } | string }
interface SuiTx { digest?: string; timestampMs?: string; balanceChanges?: BalanceChange[] }

async function rpc(body: unknown): Promise<unknown> {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// 장소 패키지별 최근 tx — 같은 폴 안에서 여러 토큰이 공유 (25초 캐시)
const _venueCache = new Map<string, { at: number; txs: SuiTx[] }>();
async function venueTxs(pkg: string): Promise<SuiTx[]> {
  const hit = _venueCache.get(pkg);
  if (hit && Date.now() - hit.at < 25_000) return hit.txs;
  const res = (await rpc({
    jsonrpc: "2.0", id: 1, method: "suix_queryTransactionBlocks",
    params: [{ filter: { MoveFunction: { package: pkg } }, options: { showBalanceChanges: true } }, null, TX_LIMIT, true],
  })) as { result?: { data?: SuiTx[] } } | null;
  const txs = res?.result?.data ?? [];
  _venueCache.set(pkg, { at: Date.now(), txs });
  return txs;
}

export async function suiTransfers(token: string, coinType: string, loTs: number, hiTs: number, price: number, decimals: number): Promise<FlowTx[]> {
  if (!SUI_VENUES.length) return [];
  const out: FlowTx[] = [];
  const seen = new Set<string>();
  await Promise.all(SUI_VENUES.map(async (venue) => {
    const txs = await venueTxs(venue.address);
    for (const tx of txs) {
      const ts = Math.floor(Number(tx.timestampMs ?? 0) / 1000);
      if (!tx.digest || ts < loTs || ts > hiTs) continue;
      const changes = (tx.balanceChanges ?? []).filter((b) => b.coinType === coinType);
      if (!changes.length) continue;
      let movedRaw = 0n, negOwners = 0;
      for (const c of changes) {
        try { const d = BigInt(c.amount ?? "0"); if (d > 0n) movedRaw += d; else if (d < 0n) negOwners++; } catch { /* skip */ }
      }
      const moved = Number(movedRaw) / Math.pow(10, decimals);
      if (!(moved > 0)) continue;
      const key = `${tx.digest}|${coinType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        hash: tx.digest, chain: "sui", token, from: "", to: "", valueUsd: moved * price, ts,
        direction: negOwners > 0 ? "in" : "out",
        kind: venue.kind === "swap" ? "swap" : negOwners > 0 ? "deposit" : "withdraw",
        counterparty: venue.label, counterpartyAddr: null, marketHint: null, reasons: [],
      });
    }
  }));
  return out.sort((a, b) => b.ts - a.ts);
}
