/**
 * 체인별 블록 익스플로러 바로가기 — 알림 원인 tx/주소를 Etherscan 류로 연결.
 * 지원 체인: eth/base/arb (ACTIVE_CHAINS 와 일치). 미지원 체인은 null → 링크 미표시(잘못된 익스플로러 방지).
 */
const EXPLORER_BASE: Record<string, string> = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
  arbitrum: "https://arbiscan.io",
};

export function explorerBase(chain?: string | null): string | null {
  return EXPLORER_BASE[(chain ?? "").toLowerCase()] ?? null;
}

/** tx 바로가기 URL. 미지원 체인이면 null. */
export function explorerTxUrl(chain: string | null | undefined, txHash: string): string | null {
  const b = explorerBase(chain);
  return b ? `${b}/tx/${txHash}` : null;
}

/** 주소 바로가기 URL. 미지원 체인이면 null. */
export function explorerAddrUrl(chain: string | null | undefined, address: string): string | null {
  const b = explorerBase(chain);
  return b ? `${b}/address/${address}` : null;
}

/** 블록 바로가기 URL. 상태-스냅샷 디텍터(단일 원인 tx 없음)는 알림이 관측된 블록으로 연결 — 그 블록에 거버넌스/상태변경 tx 포함. */
export function explorerBlockUrl(chain: string | null | undefined, block: number): string | null {
  const b = explorerBase(chain);
  return b && block > 0 ? `${b}/block/${block}` : null;
}

/** 익스플로러 표시명 (Etherscan/Basescan/Arbiscan). */
export function explorerName(chain?: string | null): string {
  const c = (chain ?? "").toLowerCase();
  return c === "base" ? "Basescan" : c === "arbitrum" ? "Arbiscan" : "Etherscan";
}
