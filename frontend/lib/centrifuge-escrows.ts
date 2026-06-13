/**
 * Centrifuge V3 풀별 Escrow 주소 — 공식 GraphQL 인덱서(api.centrifuge.io, 키 불필요)에서 조회.
 * 예치 시 선택 토큰(USDC/USDS 등)이 share 토큰(JTRSY 등, asset() revert)이 아니라 **풀별 Escrow**로
 * 들어간다 — 이게 "asset() revert 라 불가" 오판의 정정 지점. escrow 주소는 정의상 Centrifuge 것만
 * 반환되므로 거짓 라벨 0. escrow 가 CREATE2 로 멀티체인 재사용되므로 반드시 체인별로 등록(chain-scope).
 * (2026-06-13 검증: 멀티에셋 escrow 0xdaf26da0... USDC 유입 최근. DeFiLlama가 주는 0xcccc...8a94는
 *  CFG 거버넌스 토큰이라 함정 — 쓰지 않는다.)
 */
const CENTRIFUGE_ID: Record<string, string> = { ethereum: "1", base: "2", arbitrum: "3" };
const _cache = new Map<string, { addr: string; label: string }[]>();

export async function centrifugeEscrows(chain: string): Promise<{ addr: string; label: string }[]> {
  const cid = CENTRIFUGE_ID[chain];
  if (!cid) return [];
  const hit = _cache.get(chain);
  if (hit) return hit;
  let out: { addr: string; label: string }[] = [];
  try {
    const query = `{ escrows(where:{centrifugeId:"${cid}"} limit:100){ items { address } } }`;
    const r = await fetch("https://api.centrifuge.io/", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const j = (await r.json()) as { data?: { escrows?: { items?: { address?: string }[] } } };
      const seen = new Set<string>();
      for (const it of j?.data?.escrows?.items ?? []) {
        const a = (it?.address ?? "").toLowerCase();
        if (/^0x[0-9a-f]{40}$/.test(a) && !seen.has(a)) { seen.add(a); out.push({ addr: a, label: "centrifuge-protocol" }); }
      }
    }
  } catch { out = []; /* API 실패 = 무라벨 폴백(거짓 라벨 0) */ }
  if (out.length) _cache.set(chain, out); // 성공 시만 캐시(빈 결과는 다음에 재시도)
  return out;
}
