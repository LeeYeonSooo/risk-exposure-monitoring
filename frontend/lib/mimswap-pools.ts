import { gatedJsonRpc } from "./rpc-gate";

/**
 * mim-swap (Abracadabra MagicLP / DODO PMM) 풀 주소 — MagicLPFactory 온체인 열거(키리스).
 * 표준 getPair/getPool 인터페이스가 없어 DEX 포크 패턴과 다르다: getPoolCount(base,quote) 로 개수를
 * 받고 pools(base,quote,i) 로 주소를 읽는다. **getPoolCount 는 방향성**이라 (a,b)·(b,a) 양쪽 다 호출.
 * factory 가 반환한 주소만 등록 → 거짓 라벨 0(추측 없음). 페어별 immutable 캐시. arbitrum 전용.
 * (2026-06-13 온체인 검증: factory 코드 7694B, MIM-USDC 풀 0x8279699d... 당일 USDC 전송 다수.)
 */
const FACTORY: Record<string, string> = { arbitrum: "0x8d0cd3eef1794f59f2b3a664ef07fcad401fec73" };
const RPC: Record<string, string> = { arbitrum: "https://arbitrum-one-rpc.publicnode.com" };
const SEL_POOL_COUNT = "0xb75770bc"; // getPoolCount(address,address) -> uint256
const SEL_POOLS = "0x169c4cef";      // pools(address,address,uint256) -> address
const ZERO = "0x0000000000000000000000000000000000000000";
const padAddr = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padUint = (n: number) => n.toString(16).padStart(64, "0");
const MAX_MIM_TOKENS = 10; // 토큰 순서쌍 N*(N-1) — 상한으로 호출 폭증 방지(대부분 페어 0 반환 즉시 컷)

const cache = new Map<string, string[]>(); // `${chain}|${base}|${quote}` (방향성) → pool 주소[]

/** eth_call: { ok:false } = 비결론(실패), { ok:true, hex } = 결론. */
async function call(rpc: string, to: string, data: string): Promise<{ ok: boolean; hex: string | null }> {
  const hex = await gatedJsonRpc<string>(rpc, "eth_call", [{ to, data }, "latest"]);
  return hex == null ? { ok: false, hex: null } : { ok: true, hex };
}

export async function mimswapPoolsFor(addrs: string[], chain: string): Promise<{ addr: string; label: string; pair: [string, string] }[]> {
  const factory = FACTORY[chain], rpc = RPC[chain];
  if (!factory || !rpc) return [];
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, MAX_MIM_TOKENS);
  const ordered: [string, string][] = [];
  for (const b of uniq) for (const q of uniq) if (b !== q) ordered.push([b, q]); // 방향성 — 양쪽 다
  const out: { addr: string; label: string; pair: [string, string] }[] = [];
  await Promise.all(ordered.map(async ([base, quote]) => {
    const key = `${chain}|${base}|${quote}`;
    let pools = cache.get(key);
    if (!pools) {
      const cnt = await call(rpc, factory, SEL_POOL_COUNT + padAddr(base) + padAddr(quote));
      if (!cnt.ok || !cnt.hex) return;                       // 비결론 — 캐시 안 함(재시도)
      const n = parseInt(cnt.hex, 16);
      if (!Number.isFinite(n) || n <= 0) { cache.set(key, []); return; } // 결론적 0개
      if (n > 50) return;                                     // sanity
      const acc: string[] = [];
      let conclusive = true;
      await Promise.all(Array.from({ length: n }, (_, i) => i).map(async (i) => {
        const r = await call(rpc, factory, SEL_POOLS + padAddr(base) + padAddr(quote) + padUint(i));
        if (!r.ok || !r.hex) { conclusive = false; return; }
        const a = "0x" + r.hex.slice(-40).toLowerCase();
        if (a !== ZERO) acc.push(a);
      }));
      if (conclusive) cache.set(key, acc); // 결론적일 때만 캐시
      pools = acc;
    }
    for (const p of pools) out.push({ addr: p, label: "mim-swap", pair: [base, quote] });
  }));
  return out;
}
