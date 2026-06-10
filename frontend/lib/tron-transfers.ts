import type { FlowTx } from "./flow-types";
import { TRON_VENUES } from "./nonevm-venues";

/**
 * 트론 라이브 전송 피드 — TronGrid 공식 이벤트 API (키리스).
 * GET /v1/contracts/{토큰}/events?event_name=Transfer — from/to(20바이트 hex)·금액·시각 제공.
 * 카운터파티 = 검증된 장소 주소(T-base58 → hex 디코드)와 from/to 일치할 때만 라벨.
 * 미등재 컨트랙트/지갑 전송은 "전송"으로 표시 (라벨 추측 없음).
 */

const API = "https://api.trongrid.io";
// 키리스도 동작하지만 호출이 몰리면 429 — TRONGRID_API_KEY 설정 시 헤더로 사용
const TRON_KEY = process.env.TRONGRID_API_KEY;
const ZERO20 = "0x0000000000000000000000000000000000000000";

// base58 디코드 (체크섬 검증 불필요 — 매칭용 payload 만) → 41-prefix 제거한 20바이트 hex
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function tronToHex(t: string): string | null {
  let n = 0n;
  for (const c of t) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  // 25바이트 = 0x41 + 20바이트 주소 + 4바이트 체크섬
  if (hex.length < 50) return null;
  const body = hex.slice(0, hex.length - 8); // 체크섬 제거
  if (!body.startsWith("41") || body.length !== 42) return null;
  return "0x" + body.slice(2).toLowerCase();
}

const VENUE_BY_HEX = new Map<string, { label: string; kind: "swap" | "lend" | "stake" }>();
for (const v of TRON_VENUES) {
  const h = tronToHex(v.address);
  if (h) VENUE_BY_HEX.set(h, { label: v.label, kind: v.kind });
}

interface TronEvent {
  transaction_id?: string;
  block_timestamp?: number; // ms
  result?: { from?: string; to?: string; value?: string; "2"?: string };
}

export async function tronTransfers(token: string, addr: string, loTs: number, hiTs: number, price: number, decimals: number): Promise<FlowTx[]> {
  const url = `${API}/v1/contracts/${encodeURIComponent(addr)}/events?event_name=Transfer&only_confirmed=true&limit=200` +
    `&min_block_timestamp=${loTs * 1000}&max_block_timestamp=${hiTs * 1000}`;
  let events: TronEvent[] = [];
  try {
    const r = await fetch(url, { cache: "no-store", headers: TRON_KEY ? { "TRON-PRO-API-KEY": TRON_KEY } : undefined });
    if (!r.ok) return [];
    events = ((await r.json()) as { data?: TronEvent[] }).data ?? [];
  } catch { return []; }

  const out: FlowTx[] = [];
  for (const e of events) {
    const ts = Math.floor((e.block_timestamp ?? 0) / 1000);
    if (!e.transaction_id || ts < loTs || ts > hiTs) continue;
    const from = (e.result?.from ?? "").toLowerCase();
    const to = (e.result?.to ?? "").toLowerCase();
    const raw = e.result?.value ?? e.result?.["2"] ?? "0";
    const amount = Number(BigInt(raw)) / Math.pow(10, decimals);
    if (!(amount > 0)) continue;
    let kind: FlowTx["kind"] = "transfer";
    let counterparty: string | null = null;
    let direction: "in" | "out" = "out";
    const vTo = VENUE_BY_HEX.get(to), vFrom = VENUE_BY_HEX.get(from);
    if (from === ZERO20) { kind = "mint"; direction = "in"; }
    else if (to === ZERO20) { kind = "burn"; direction = "out"; }
    else if (vTo) { counterparty = vTo.label; direction = "in"; kind = vTo.kind === "swap" ? "swap" : "deposit"; }
    else if (vFrom) { counterparty = vFrom.label; direction = "out"; kind = vFrom.kind === "swap" ? "swap" : "withdraw"; }
    out.push({ hash: e.transaction_id, chain: "tron", token, from, to, valueUsd: amount * price, ts, direction, kind, counterparty, counterpartyAddr: null, marketHint: null, reasons: [] });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
