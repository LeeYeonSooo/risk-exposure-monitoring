import type { Address } from "viem";

import { env } from "@/config/chains";
import { topHoldersAlchemy } from "@/lib/alchemy";
import { topHoldersEtherscan } from "@/lib/etherscan";

export interface Holder {
  address: string;
  rawBalance: bigint;
}

/**
 * Get top N holders for a token. BEST-EFFORT (호출부에서 실패 허용).
 *
 * 비용/속도 메모 (전문가 조언 반영):
 *   - 핵심 그래프(edges)는 holder 목록이 필요 없음 — adapter 가 protocol 을
 *     Multicall3 로 직접 조회함 (Alchemy 무료, 토큰당 ~10 batched calls).
 *   - holder 목록은 (a) 고래 unwind 추적, (b) 미지 컨트랙트 발굴 용 부가기능.
 *   - Alchemy JSON-RPC 에는 top-holders 메서드가 없음(`alchemy_getTokenHolders`
 *     = Unsupported). Etherscan `tokenholderlist` 는 PRO(유료). Dune 도 가능하나
 *     쿼리 사전등록 + rate-limit. → 무료 소스 없으면 그냥 skip (비용 0 우선).
 *
 * 우선순위: Etherscan PRO(키 있으면) → 없으면 throw (호출부가 best-effort 로 흡수).
 */
export async function topHolders(token: Address, limit = 200): Promise<Holder[]> {
  // Etherscan PRO 키가 있을 때만 holder 목록 사용 (유료지만 정확).
  if (env.ETHERSCAN_API_KEY) {
    const rows = await topHoldersEtherscan(token, limit);
    return rows.map((r) => ({ address: r.address, rawBalance: r.quantityRaw }));
  }
  throw new Error(
    "holder-list 소스 없음 — 무료 경로 부재(Alchemy 미지원, Etherscan PRO 유료). " +
      "핵심 그래프는 adapter 직접 조회로 동작하므로 skip 해도 무방.",
  );
}

// topHoldersAlchemy 는 alchemy_getTokenHolders 가 Unsupported 라 더 이상 호출하지 않음.
// (lib/alchemy.ts 에 코드는 남겨두되 사용 안 함 — 추후 Alchemy 가 지원하면 복구)
void topHoldersAlchemy;
