/**
 * DeFiLlama 무료 API — breadth tier 데이터 소스.
 *
 *   - /protocols       : slug → category 매핑 (Lending/CDP/Dexs/…)
 *   - yields /pools     : 프로토콜 × 토큰 × 체인별 TVL (전 DeFi)
 *
 * 이걸로 프로토콜 ABI 하드코딩 없이 "이 토큰이 어디에 얼마나 있나"를
 * TVL 기준으로 동적 수집. 무료·배치(전체 1콜) → 비용 0.
 *
 * 캐시: 프로세스 수명 동안 메모리 캐시 (스냅샷 루프에서 토큰마다 재요청 방지).
 */

const POOLS_URL = "https://yields.llama.fi/pools";
const PROTOCOLS_URL = "https://api.llama.fi/protocols";

export interface LlamaPool {
  chain: string;
  project: string;       // slug, e.g. "silo-v2"
  symbol: string;        // e.g. "WBTC" or "WBTC-USDC"
  tvlUsd: number;
  pool: string;          // pool id
  stablecoin?: boolean;
  exposure?: string;     // "single" | "multi"
  poolMeta?: string | null;
}

let _poolsCache: LlamaPool[] | null = null;
let _catCache: Map<string, string> | null = null;

/** 전체 yields 풀 (Ethereum 만 필터). 메모리 캐시. */
export async function fetchLlamaPools(): Promise<LlamaPool[]> {
  if (_poolsCache) return _poolsCache;
  const res = await fetch(POOLS_URL);
  if (!res.ok) throw new Error(`DeFiLlama pools HTTP ${res.status}`);
  const json = (await res.json()) as { data: LlamaPool[] };
  _poolsCache = (json.data ?? []).filter((p) => p.chain === "Ethereum");
  return _poolsCache;
}

let _allPoolsCache: LlamaPool[] | null = null;
/** 특정 체인(DeFiLlama chain명, 예 "Base"/"Arbitrum")의 yields 풀. 멀티체인 스냅샷용. */
export async function fetchLlamaPoolsForChain(chainName: string): Promise<LlamaPool[]> {
  if (!_allPoolsCache) {
    const res = await fetch(POOLS_URL);
    if (!res.ok) throw new Error(`DeFiLlama pools HTTP ${res.status}`);
    const json = (await res.json()) as { data: LlamaPool[] };
    _allPoolsCache = json.data ?? [];
  }
  return _allPoolsCache.filter((p) => p.chain === chainName);
}

/** slug → category 매핑. 메모리 캐시. */
export async function fetchProtocolCategories(): Promise<Map<string, string>> {
  if (_catCache) return _catCache;
  const res = await fetch(PROTOCOLS_URL);
  if (!res.ok) throw new Error(`DeFiLlama protocols HTTP ${res.status}`);
  const json = (await res.json()) as Array<{ slug?: string; category?: string }>;
  const m = new Map<string, string>();
  for (const p of json) {
    if (p.slug && p.category) m.set(p.slug, p.category);
  }
  _catCache = m;
  return m;
}

/** 캐시 초기화 (테스트/장기 실행용). */
export function clearLlamaCache(): void {
  _poolsCache = null;
  _catCache = null;
}

/**
 * 풀 symbol 안에 토큰이 들어있는지 (대소문자 무시, 구분자 분리).
 * "WBTC-USDC" → [WBTC, USDC],  "WBTC" → [WBTC]
 */
export function poolContainsToken(poolSymbol: string, tokenSymbol: string): boolean {
  const parts = (poolSymbol || "").toUpperCase().split(/[-/\s+]+/).filter(Boolean);
  return parts.includes(tokenSymbol.toUpperCase());
}
