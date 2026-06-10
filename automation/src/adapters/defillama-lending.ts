/**
 * DeFiLlama lendBorrow 기반 렌딩 어댑터 — 프로토콜별 SDK/온체인 어댑터가 없거나 비용 대비 약한 체인
 * (Tron JustLend, Aptos Echelon 등)을 위한 범용 경로. EVM 어댑터(viem)·Solana(Kamino REST)가
 * 각자 소스를 읽듯, 이건 DeFiLlama 의 표준화된 렌딩 지표(totalSupplyUsd·totalBorrowUsd·ltv)를 읽는다.
 *
 *   /pools (체인·프로토콜·심볼·tvl) ⨝ /lendBorrow (supply/borrow/ltv) → util = borrow/supply.
 * NonEvmReserve 로 정규화 → 통합 러너가 EVM 과 동일 임계(이용률·고LTV)로 평가, 같은 alerts 계약.
 *
 * 왜 온체인 직접읽기 대신 DeFiLlama: Tron(TVM constant-call 다중호출·레이트), Aptos(Move resource)
 *   직접 읽기는 깨지기 쉽고 비용↑. DeFiLlama 가 이 둘의 렌딩 지표를 표준화해 제공(검증됨) → 견고.
 *   (오라클 staleness/큐레이터 등 정밀 신호는 미제공 — util/LTV 만. breadth 와 동일 정직성.)
 */
import type { NonEvmReserve } from "./nonevm-types";

const POOLS = "https://yields.llama.fi/pools";
const LENDBORROW = "https://yields.llama.fi/lendBorrow";

interface Pool { pool: string; chain?: string; project?: string; symbol?: string; tvlUsd?: number }
interface LB { pool: string; totalSupplyUsd?: number | null; totalBorrowUsd?: number | null; ltv?: number | null }

// 프로세스 1회만 받아 여러 체인 어댑터가 공유 (10MB pools 중복 다운로드 방지).
let _cache: { pools: Pool[]; lb: Map<string, LB> } | null = null;
async function load(): Promise<{ pools: Pool[]; lb: Map<string, LB> }> {
  if (_cache) return _cache;
  const [pr, lr] = await Promise.all([
    fetch(POOLS, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()) as Promise<{ data?: Pool[] }>,
    fetch(LENDBORROW, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()) as Promise<LB[]>,
  ]);
  const pools = pr.data ?? [];
  const lb = new Map<string, LB>((Array.isArray(lr) ? lr : []).map((x) => [x.pool, x]));
  _cache = { pools, lb };
  return _cache;
}

/** 한 체인(DeFiLlama chain 명)의 렌딩 reserve 를 NonEvmReserve 로. project 별로 분리(proto 노드 = protocol:{project}@{chain}). */
export function makeDefiLlamaLendingAdapter(chain: string, llamaChain: string): () => Promise<NonEvmReserve[]> {
  return async function fetchReserves(): Promise<NonEvmReserve[]> {
    const { pools, lb } = await load();
    const want = llamaChain.toLowerCase();
    const out: NonEvmReserve[] = [];
    for (const p of pools) {
      if ((p.chain ?? "").toLowerCase() !== want) continue;
      const b = lb.get(p.pool);
      if (!b || b.totalSupplyUsd == null) continue; // 렌딩(borrow) 지표 없는 풀(순수 stake/LP) 제외
      const supplyUsd = Number(b.totalSupplyUsd);
      const borrowUsd = Number(b.totalBorrowUsd ?? 0);
      if (!(supplyUsd > 0) || !Number.isFinite(supplyUsd)) continue;
      const project = (p.project ?? "lending").toLowerCase();
      out.push({
        protocol: project,
        chain,
        market: p.project ?? "lending",
        symbol: p.symbol ?? "?",
        maxLtv: b.ltv != null && b.ltv > 0 && b.ltv <= 1 ? b.ltv : null,
        utilization: supplyUsd > 0 ? borrowUsd / supplyUsd : 0,
        supplyUsd,
        borrowUsd,
      });
    }
    return out;
  };
}
