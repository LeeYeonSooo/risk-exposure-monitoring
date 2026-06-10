import { archiveClientFor, getLogsWindowed, publicClientFor, type RawLog, TRANSFER_TOPIC0, ZERO_TOPIC } from "@/lib/public-rpc";

/**
 * Detector B — mint/burn 정합 (alarm-totalsupply `mint_burn_recon` 포팅, Tier 0+1: 금액+시간창).
 *
 * 브릿지 흐름은 소스 burn → 목적지 mint(같은 금액, ~동시)다. 크로스체인으로 mint↔burn 을 **금액 동일 +
 * |시간차| ≤ window** 로 매칭하고, 창을 지나도 매칭 안 되는 **mint = 무담보민팅 의심**(Kelp rsETH 직접 시그니처).
 *   - 홈(ethereum) mint = 발행(예치 기반) → 매칭 불필요(최대 FP 원인 제거). burn 은 모든 체인 수집.
 *   - lock&mint 브릿지는 소스가 burn 이 아니라 *lock* → Detector A(backing)가 권위. B 는 burn&mint 가정.
 *
 * 이벤트 시각은 블록번호로 근사(평균 블록시간) — 창(기본 30분) 매칭엔 충분. 정확 시각이 필요하면 추후 getBlock.
 * 상태(미정합 mint/burn)는 DB ledger 에 누적(크로스런). 로그는 publicnode(Alchemy 무료티어 getLogs 불가).
 */

// 체인별 평균 블록시간(초) — 이벤트 시각 근사용.
const AVG_BLOCK_SEC: Record<string, number> = {
  ethereum: 12, base: 2, arbitrum: 0.26, optimism: 2, polygon: 2.1, bsc: 3,
  avalanche: 2, gnosis: 5, linea: 3, scroll: 3, mantle: 2,
};
const MAX_SCAN_BLOCKS = 50_000n; // 첫 실행/오래된 커서 시 스캔 깊이 상한(무료 RPC 보호 · 최근 흐름 집중)

/**
 * authorized 수신자 allowlist — 이 주소로 가는 mint = 발행/내부 운영으로 보고 정합 대상에서 제외(FP 컷).
 * (Python mint_burn_recon 의 watch.allowlist 에 해당.) bridge mint 는 사용자 EOA 로 가므로 영향 없음 —
 * issuer/treasury/known-internal 수신자만 넣으면 L2 비-브릿지 발행 FP 가 줄어든다. 전역은 모든 토큰 적용.
 */
// 정적 override(수동). 자동 시드는 러너(snapshot-mintburn.ts verifiedMintersFor)가 bridge_authorities 의
// 온체인 검증 주소를 동적으로 주입하므로, 여기는 그 밖의 issuer/treasury 만 보강하면 된다(보통 비어 있음).
export const GLOBAL_MINT_ALLOWLIST = new Set<string>([]); // 전역(식별 시 추가)
export const MINT_ALLOWLIST_BY_TOKEN: Record<string, string[]> = {
  // 예: "WEETH": ["0x<issuer/treasury 주소>"],
};
export function isAllowlistedRecipient(token: string, to: string | null): boolean {
  if (!to) return false;
  const a = to.toLowerCase();
  if (GLOBAL_MINT_ALLOWLIST.has(a)) return true;
  return (MINT_ALLOWLIST_BY_TOKEN[token.toUpperCase()] ?? []).some((x) => x.toLowerCase() === a);
}

export interface TransferEvent {
  chain: string; txHash: string; logIndex: number; block: number;
  amount: bigint; eventTsSec: number; to: string | null;
}

/** 한 (체인,토큰)에서 sinceBlock 이후 mint(옵션)·burn Transfer 를 수집(publicnode). */
export async function fetchNewTransfers(
  chain: string, addr: string, sinceBlock: bigint, includeMints: boolean,
): Promise<{ latest: bigint; mints: TransferEvent[]; burns: TransferEvent[] }> {
  const client = archiveClientFor(chain) ?? publicClientFor(chain); // archive(D#12) 있으면 더 넓은 범위
  if (!client) return { latest: sinceBlock, mints: [], burns: [] };
  let latest: bigint;
  try { latest = await client.getBlockNumber(); } catch { return { latest: sinceBlock, mints: [], burns: [] }; }
  const start = latest - sinceBlock > MAX_SCAN_BLOCKS ? latest - MAX_SCAN_BLOCKS : sinceBlock;
  if (start > latest) return { latest, mints: [], burns: [] };

  const nowSec = Math.floor(Date.now() / 1000);
  const avg = AVG_BLOCK_SEC[chain] ?? 12;
  const decode = (logs: RawLog[]): TransferEvent[] =>
    logs.map((l) => {
      const block = Number(BigInt(l.blockNumber));
      return {
        chain,
        txHash: l.transactionHash ?? "",
        logIndex: Number(BigInt(l.logIndex)),
        block,
        amount: l.data && l.data !== "0x" ? BigInt(l.data.slice(0, 66)) : 0n, // 첫 워드 = Transfer value
        eventTsSec: Math.round(nowSec - Number(latest - BigInt(block)) * avg),
        to: l.topics?.[2] ? ("0x" + l.topics[2].slice(-40)) : null,
      };
    }).filter((e) => e.txHash && e.amount > 0n);

  const burns = decode(await getLogsWindowed(client, addr, [TRANSFER_TOPIC0, null, ZERO_TOPIC], start, latest));
  const mints = includeMints ? decode(await getLogsWindowed(client, addr, [TRANSFER_TOPIC0, ZERO_TOPIC, null], start, latest)) : [];
  return { latest, mints, burns };
}

export interface LedgerRow {
  chain: string; txHash: string; logIndex: number;
  kind: "mint" | "burn"; amount: string; eventTsSec: number; firstSeenSec: number;
}
type Pk = { chain: string; txHash: string; logIndex: number };
export interface ReconResult {
  matchedPks: Pk[];      // 매칭된 mint+burn → ledger 에서 삭제
  staleBurnPks: Pk[];    // 2×window 지난 미정합 burn → 삭제(정상 redeem)
  flagged: Array<{ chain: string; txHash: string; amount: string; ageSec: number }>; // 무담보 mint → 알림
}

/**
 * 순수 정합 로직 — ledger 행들을 금액+시간창으로 매칭. (port of mint_burn_recon)
 *   matched: 같은 금액 burn 과 |Δt|≤window 인 mint 쌍.
 *   flagged: 창(window) 지나도 미정합인 mint(= 무담보민팅 의심).
 */
export function reconcile(rows: LedgerRow[], windowSec: number, nowSec: number): ReconResult {
  const mints = rows.filter((r) => r.kind === "mint");
  const burns = rows.filter((r) => r.kind === "burn");
  const byAmt = new Map<string, LedgerRow[]>();
  for (const b of burns) { (byAmt.get(b.amount) ?? byAmt.set(b.amount, []).get(b.amount)!).push(b); }

  const matchedPks: Pk[] = [];
  const usedBurn = new Set<LedgerRow>();
  const matchedMint = new Set<LedgerRow>();
  for (const m of [...mints].sort((a, b) => a.eventTsSec - b.eventTsSec)) {
    const bucket = byAmt.get(m.amount);
    if (!bucket) continue;
    const b = bucket.find((x) => !usedBurn.has(x) && Math.abs(m.eventTsSec - x.eventTsSec) <= windowSec);
    if (b) {
      usedBurn.add(b); matchedMint.add(m);
      matchedPks.push({ chain: m.chain, txHash: m.txHash, logIndex: m.logIndex });
      matchedPks.push({ chain: b.chain, txHash: b.txHash, logIndex: b.logIndex });
    }
  }
  const staleBurnPks = burns
    .filter((b) => !usedBurn.has(b) && nowSec - b.firstSeenSec > 2 * windowSec)
    .map((b) => ({ chain: b.chain, txHash: b.txHash, logIndex: b.logIndex }));
  const flagged = mints
    .filter((m) => !matchedMint.has(m) && nowSec - m.firstSeenSec >= windowSec)
    .map((m) => ({ chain: m.chain, txHash: m.txHash, amount: m.amount, ageSec: nowSec - m.firstSeenSec }));
  return { matchedPks, staleBurnPks, flagged };
}

/** ledger/cursor 스키마(migration 014 와 동일) — 러너가 idempotent 하게 보장. */
export const MINT_BURN_SCHEMA = `
CREATE TABLE IF NOT EXISTS mint_burn_ledger (
  token text NOT NULL, chain text NOT NULL, tx_hash text NOT NULL, log_index int NOT NULL,
  kind text NOT NULL, amount numeric(78,0) NOT NULL, event_ts timestamptz NOT NULL,
  first_seen_ts timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (chain, tx_hash, log_index));
CREATE INDEX IF NOT EXISTS idx_mbl_token_amt ON mint_burn_ledger (token, amount);
CREATE INDEX IF NOT EXISTS idx_mbl_token_kind ON mint_burn_ledger (token, kind);
CREATE TABLE IF NOT EXISTS mint_burn_cursor (
  token text NOT NULL, chain text NOT NULL, last_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (token, chain));`;
