/**
 * Kamino (Solana) 렌딩 어댑터 — 첫 비-EVM 렌딩 어댑터.
 *
 * EVM 어댑터가 viem 으로 온체인 읽듯, Kamino 는 공개 REST API(api.kamino.finance)로 reserve 상태를 읽는다
 * (Morpho 가 blue-api GraphQL 쓰는 것과 동일 패턴). reserve = 한 토큰의 렌딩 풀(담보/대출 공용).
 *
 * 제공 지표: maxLtv · 이용률(borrow/supply) · supply/borrowUsd · APY. → high_utilization·high_lltv·유동성 알림.
 * (오라클은 Pyth/Switchboard/Scope 외부 시장피드 — 자기참조 NAV 위험은 EVM Morpho 와 성격 다름. 정밀 오라클은 후속 scope API.)
 */

import type { NonEvmReserve } from "./nonevm-types";

const KAMINO_API = "https://api.kamino.finance";

export interface KaminoReserve {
  market: string;
  marketName: string;
  reserve: string;
  symbol: string;
  mint: string;
  maxLtv: number;          // 0..1
  utilization: number;     // 0..1 (borrow/supply)
  supply: number;
  borrow: number;
  supplyUsd: number;
  borrowUsd: number;
  borrowApy: number;
  supplyApy: number;
}

interface MarketRow { name?: string; lendingMarket?: string; isPrimary?: boolean }
interface MetricRow {
  reserve?: string; liquidityToken?: string; liquidityTokenMint?: string;
  maxLtv?: string | number; borrowApy?: string | number; supplyApy?: string | number;
  totalSupply?: string | number; totalBorrow?: string | number;
  totalBorrowUsd?: string | number; totalSupplyUsd?: string | number;
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** 메인넷 Kamino 렌딩 마켓 목록 (Main·JLP·Altcoin 등). */
export async function fetchKaminoMarkets(): Promise<{ market: string; name: string }[]> {
  const r = await fetch(`${KAMINO_API}/kamino-market?env=mainnet-beta`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`kamino markets ${r.status}`);
  const j = (await r.json()) as MarketRow[];
  return (j ?? [])
    .filter((m) => m.lendingMarket)
    .map((m) => ({ market: m.lendingMarket as string, name: m.name ?? "Kamino market" }));
}

/** 한 마켓의 reserve 지표 → 정규화. */
export async function fetchKaminoReserves(market: string, marketName: string): Promise<KaminoReserve[]> {
  const r = await fetch(`${KAMINO_API}/kamino-market/${market}/reserves/metrics?env=mainnet-beta`, { signal: AbortSignal.timeout(25_000) });
  if (!r.ok) return [];
  const arr = (await r.json()) as MetricRow[];
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => {
    const supply = num(x.totalSupply), borrow = num(x.totalBorrow);
    return {
      market, marketName,
      reserve: String(x.reserve ?? ""),
      symbol: String(x.liquidityToken ?? "?"),
      mint: String(x.liquidityTokenMint ?? ""),
      maxLtv: num(x.maxLtv),
      utilization: supply > 0 ? borrow / supply : 0,
      supply, borrow,
      supplyUsd: num(x.totalSupplyUsd),
      borrowUsd: num(x.totalBorrowUsd),
      borrowApy: num(x.borrowApy),
      supplyApy: num(x.supplyApy),
    };
  });
}

/** 모든 마켓의 모든 reserve. */
export async function fetchAllKaminoReserves(): Promise<KaminoReserve[]> {
  const markets = await fetchKaminoMarkets();
  const all: KaminoReserve[] = [];
  for (const m of markets) {
    try {
      const rs = await fetchKaminoReserves(m.market, m.name);
      all.push(...rs);
    } catch { /* skip market */ }
  }
  return all;
}

export const protocol = "kamino";

/** /oracles/prices → mint별 오라클 신선도(경과초·maxAge·이름). 피드 동결 탐지(oracle_stale)용. */
async function fetchOracleAges(): Promise<Map<string, { ageSec: number; maxAgeSec: number; name: string }>> {
  const out = new Map<string, { ageSec: number; maxAgeSec: number; name: string }>();
  try {
    const r = await fetch(`${KAMINO_API}/oracles/prices?markets=all`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return out;
    const arr = (await r.json()) as { mint?: string; name?: string; maxAgeInSeconds?: string; timestamp?: string }[];
    const now = Math.floor(Date.now() / 1000);
    for (const x of arr ?? []) {
      const ts = num(x.timestamp); const maxAge = num(x.maxAgeInSeconds);
      if (!x.mint || !(ts > 0) || !(maxAge > 0)) continue;
      out.set(x.mint, { ageSec: Math.max(0, now - ts), maxAgeSec: maxAge, name: x.name ?? "" }); // Solana mint = base58, 대소문자 보존
    }
  } catch { /* 오라클 신선도 없이 진행 */ }
  return out;
}

/** 공통 계약(NonEvmReserve)으로 — 통합 러너용. + 오라클 신선도 병합. */
export async function fetchReserves(): Promise<NonEvmReserve[]> {
  const [rs, oracleByMint] = await Promise.all([fetchAllKaminoReserves(), fetchOracleAges()]);
  return rs.map((r) => {
    const o = oracleByMint.get(r.mint);
    return {
      protocol: "kamino", chain: "solana", market: r.marketName, symbol: r.symbol,
      maxLtv: r.maxLtv > 0 && r.maxLtv <= 1 ? r.maxLtv : null,
      utilization: r.utilization, supplyUsd: r.supplyUsd, borrowUsd: r.borrowUsd,
      oracleAgeSec: o?.ageSec ?? null, oracleMaxAgeSec: o?.maxAgeSec ?? null, oracleName: o?.name ?? null,
    };
  });
}
