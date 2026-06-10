import { type Address } from "viem";

import { KNOWN_TOKENS } from "@/config/tokens";
import { fetchLlamaPools } from "@/lib/defillama";
import { batch } from "@/lib/multicall";

import { isExcludedRwa } from "./rwa-filter";

/**
 * 전체 DeFi 토큰 발굴 — DeFiLlama yields 풀의 underlyingTokens 주소별 TVL 발자국 합산.
 * 누적 coverageTarget(전체 DeFi 기준) 까지 포함 → Morpho/Aave 너머 전 DeFi 커버.
 *
 * 주소 기반(0x0 네이티브 placeholder 제외). 심볼은 KNOWN_TOKENS → 온체인 symbol() 순.
 */

// 실제 ERC20 가 아닌 sentinel 주소 (네이티브 ETH placeholder 등) — 제외.
const SENTINELS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // native ETH placeholder
]);

const ERC20_ABI = [
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
] as const;

export interface DiscoveredDefiToken {
  address: string;
  symbol: string;
  decimals: number;
  collateralUsd: number; // 발자국 USD (랭킹 metric — coverage 헬퍼 호환 위해 동일 필드명)
  source: "defillama_footprint";
}

export async function fetchDefiLlamaTopTokens(
  topN = 100,
  minUsd = 5_000_000,
  coverageTarget = 0.9,
): Promise<DiscoveredDefiToken[]> {
  const pools = await fetchLlamaPools(); // Ethereum only

  // 1) underlyingToken 주소별 TVL 발자국 합산 (0x0 제외)
  const foot = new Map<string, number>();
  for (const p of pools) {
    const tvl = p.tvlUsd ?? 0;
    if (tvl <= 0) continue;
    const tokens = (p as unknown as { underlyingTokens?: string[] }).underlyingTokens ?? [];
    for (const a of tokens) {
      if (!a) continue;
      const addr = a.toLowerCase();
      if (SENTINELS.has(addr)) continue; // 네이티브 ETH placeholder 등 제외
      foot.set(addr, (foot.get(addr) ?? 0) + tvl);
    }
  }

  // 2) 누적 커버리지 컷 (전체 DeFi 발자국 기준) — 심볼/decimals 는 컷 이후 해석
  const ranked = [...foot.entries()]
    .map(([address, usd]) => ({ address, collateralUsd: usd }))
    .filter((x) => x.collateralUsd >= minUsd)
    .sort((a, b) => b.collateralUsd - a.collateralUsd);
  const total = ranked.reduce((s, x) => s + x.collateralUsd, 0);
  const selected: typeof ranked = [];
  let cum = 0;
  for (const x of ranked) {
    selected.push(x);
    cum += x.collateralUsd;
    if (cum >= total * coverageTarget) break;
    if (selected.length >= topN) break;
  }
  console.log(
    `[discover:defillama] 전체 DeFi 발자국 $${(total / 1e9).toFixed(1)}B · 커버리지 ${(coverageTarget * 100).toFixed(0)}% → ${selected.length}개`,
  );

  // 3) 심볼 해석 — KNOWN_TOKENS 우선, 없으면 온체인 symbol() 배치
  const needOnchain = selected.filter((x) => !KNOWN_TOKENS[x.address]);
  const symbolResults = (await batch(
    needOnchain.map((x) => ({ address: x.address as Address, abi: ERC20_ABI, functionName: "symbol" })),
    { allowFailure: true },
  )) as Array<string | null>;
  const onchainSym = new Map<string, string>();
  needOnchain.forEach((x, i) => {
    const s = symbolResults[i];
    if (s && typeof s === "string") onchainSym.set(x.address, s);
  });

  // 4) 심볼 부여 + RWA 필터
  const out: DiscoveredDefiToken[] = [];
  for (const x of selected) {
    const symbol =
      KNOWN_TOKENS[x.address]?.symbol ?? onchainSym.get(x.address) ?? x.address.slice(0, 8);
    const decimals = KNOWN_TOKENS[x.address]?.decimals ?? 18;
    if (isExcludedRwa(symbol, x.address)) continue; // 부동산·금 등 제외
    out.push({ address: x.address, symbol, decimals, collateralUsd: x.collateralUsd, source: "defillama_footprint" });
  }
  return out;
}
