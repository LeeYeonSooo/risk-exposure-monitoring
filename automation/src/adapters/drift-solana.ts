/**
 * Drift (Solana) borrow/lend 어댑터 — 공개 Data API(data.api.drift.trade, 무인증).
 *   /market/{symbol}/deposits 최신 레코드: marketDepositBalance·marketWithdrawBalance·oraclePrice (모두 human 단위).
 *   → 이용률(withdraw/deposit)·supply/borrowUsd. ⚠️ 자산 weight(LTV)는 SDK 전용 → util-only(maxLtv=null).
 *   Drift spot 마켓 목록 API 가 없어 주요 심볼 하드코딩(스테일 시 추가).
 */
import type { NonEvmReserve } from "./nonevm-types";

const API = "https://data.api.drift.trade";
const SYMBOLS = ["USDC", "SOL", "jitoSOL", "mSOL", "dSOL", "INF", "bSOL", "wBTC", "wETH", "USDT", "PYUSD", "USDe", "USDS", "JLP", "BONK"];

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export const protocol = "drift";

async function latest(sym: string): Promise<{ dep: number; wit: number; px: number } | null> {
  try {
    const r = await fetch(`${API}/market/${sym}/deposits`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { records?: Record<string, unknown>[] } | Record<string, unknown>[];
    const recs = Array.isArray(j) ? j : (j.records ?? []);
    const rec = recs[0] as Record<string, unknown> | undefined; // API 는 최신순
    if (!rec) return null;
    return { dep: n(rec.marketDepositBalance), wit: n(rec.marketWithdrawBalance), px: n(rec.oraclePrice) };
  } catch { return null; }
}

export async function fetchReserves(): Promise<NonEvmReserve[]> {
  const out: NonEvmReserve[] = [];
  await Promise.all(SYMBOLS.map(async (sym) => {
    const d = await latest(sym);
    if (!d || !(d.px > 0) || !(d.dep > 0)) return;
    out.push({
      protocol: "drift", chain: "solana", market: "Drift", symbol: sym,
      maxLtv: null, // 자산 weight 는 SDK 전용 — util-only
      utilization: d.dep > 0 ? d.wit / d.dep : 0,
      supplyUsd: d.dep * d.px, borrowUsd: d.wit * d.px,
    });
  }));
  return out;
}
