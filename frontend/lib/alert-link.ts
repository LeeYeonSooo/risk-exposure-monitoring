/**
 * 알림 → 흐름맵 딥링크: 그 알림과 관련된 토큰들 + 해당 체인만 선택된 /flow URL 을 만든다.
 *  · 토큰: 알림의 token + detail 에 든 상대 토큰(loanAsset / loan_symbol / collateral*)
 *  · 체인: protocol_node_id 의 @chain → 그 체인 / detail.chain / 그 외엔 ethereum
 *    (홈 chainOf 와 같은 규칙 — 알림 테이블에 chain 컬럼이 없어 노드 id 접미사가 근거)
 */
export interface AlertLike {
  token: string;
  protocol_node_id?: string | null;
  detail?: Record<string, unknown> | null;
}

const SYM_RE = /^[A-Za-z0-9.\-+_]{2,24}$/;
const isUsable = (s: string | null | undefined): s is string => {
  const v = (s ?? "").trim();
  return v !== "" && v.toUpperCase() !== "UNKNOWN" && SYM_RE.test(v);
};

/** 체인 추정 — 모르면 null(흐름맵에서 chains 파라미터 생략). 'ethereum' 강제 디폴트는 멀티체인 토큰을 오핀. */
export function alertChain(a: AlertLike): string | null {
  const p = a.protocol_node_id ?? "";
  if (p.includes("@")) {
    const c = p.split("@")[1]?.toLowerCase();
    if (c) return c;
  }
  const dc = (a.detail as { chain?: unknown } | null | undefined)?.chain;
  if (typeof dc === "string" && dc) return dc.toLowerCase();
  return null;
}

export function alertFlowHref(a: AlertLike): string {
  const tokens: string[] = [];
  if (isUsable(a.token)) tokens.push(a.token); // token=UNKNOWN 이면 제외(빈 흐름맵 방지)
  const d = (a.detail ?? {}) as Record<string, unknown>;
  for (const k of ["loanAsset", "loan_symbol", "collateralAsset", "collateral_symbol"]) {
    const v = d[k];
    if (typeof v === "string" && isUsable(v) && !tokens.some((t) => t.toUpperCase() === v.toUpperCase())) tokens.push(v);
  }
  const chain = alertChain(a);
  const parts: string[] = [];
  if (tokens.length) parts.push(`tokens=${encodeURIComponent(tokens.join(","))}`);
  if (chain) parts.push(`chains=${encodeURIComponent(chain)}`);
  return `/flow${parts.length ? `?${parts.join("&")}` : ""}`;
}
