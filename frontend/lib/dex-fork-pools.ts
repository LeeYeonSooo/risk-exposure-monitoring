import { gatedJsonRpc } from "./rpc-gate";

/**
 * Uniswap V2/V3-compatible DEX **fork** pool addresses, read from each fork's official factory
 * ON-CHAIN — same pattern as aerodrome-pools.ts (registry-grade constants, live getPool/getPair,
 * no guessing). A node's pool carries its token PAIR (underlyingTokens) but not the pool address;
 * we recover the real address by asking the fork's factory. A wrong factory/fee just returns 0x0 →
 * skipped (false negatives only, never false labels). Cached per (chain, pair) — pools are immutable.
 *
 * Factories verified on-chain 2026-06-13 (eth_getCode + a sample getPool's token0/token1):
 *   · PancakeSwap V3 uses fee tier 2500 (NOT Uniswap's 3000) — getPool(t0,t1,3000)=0x0.
 *   · Camelot V3 is Algebra (dynamic fee): poolByPair(t0,t1), no fee arg, order-independent.
 * Labels MUST equal the DeFiLlama project slug (flow-match buildCpResolver matches by norm), and
 * every slug here must also be in lib/flow-adapters.ts COVERED or the node colors yet shows "미지원".
 */
// getPool/getPair eth_call 은 **publicnode**(별도 호스트 게이트 3) — 일부러 Alchemy 를 쓰지 않는다:
// 콜드 로드에서 같은 Alchemy 게이트(12)를 트랜잭션 피드(getAssetTransfers)와 공유하면 포크 조회가
// 피드를 굶겨 첫 폴이 비는 게 실측됐다(2026-06-13). 포크는 L2 전용·토큰 그래프가 작아 호출 수가
// 적으므로 publicnode-3 로도 충분하고, Alchemy 피드와 **병렬**로 돌아 서로 안 막는다.
const RPC: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
};
// 포크 풀 조회는 **주요 토큰** 사이에서만 의미 있다(파생/LP 토큰은 pancakeswap 풀이 없음). addrs 는
// 선택 토큰이 앞에 오므로 앞쪽 N개만 본다 — C(n,2)×fee×fork 호출 폭증 방지. 누락은 false negative(소수 파생쌍).
const MAX_FORK_TOKENS = 10;

type Fork =
  | { kind: "v2"; factory: string; label: string }                 // getPair(t0,t1)
  | { kind: "v3"; factory: string; label: string; fees: number[] } // getPool(t0,t1,fee) per fee
  | { kind: "algebra"; factory: string; label: string };           // poolByPair(t0,t1)

// 모든 주소·메서드는 2026-06-13 온체인 검증분(eth_getCode + 샘플 풀 token0/token1).
// **base·arbitrum 전용**: 이더리움 DEX 볼륨은 uniswap/curve/balancer 가 이미 커버하고 pancakeswap/
// sushiswap 은 미미한 반면, 이더리움은 파생패밀리가 커서(토큰 49개) getPool 폭증으로 콜드로드를
// 112s 로 밀어올렸다(2026-06-13 실측). 포크가 거대 볼륨인 곳은 L2(pancakeswap base 일 $105M·camelot arb).
const FORKS: Record<string, Fork[]> = {
  base: [
    { kind: "v3", factory: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865", label: "pancakeswap-amm-v3", fees: [100, 500, 2500, 10000] },
    { kind: "v2", factory: "0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e", label: "pancakeswap-amm" },
    { kind: "v2", factory: "0x71524b4f93c58fcbf659783284e38825f0622859", label: "sushiswap" },
    { kind: "v3", factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4", label: "sushiswap-v3", fees: [100, 500, 3000, 10000] },
  ],
  arbitrum: [
    { kind: "v3", factory: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865", label: "pancakeswap-amm-v3", fees: [100, 500, 2500, 10000] },
    { kind: "v2", factory: "0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e", label: "pancakeswap-amm" },
    { kind: "v2", factory: "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac", label: "sushiswap" },
    { kind: "v3", factory: "0x1af415a1eba07a4986a52b6f2e7de7003d82231e", label: "sushiswap-v3", fees: [100, 500, 3000, 10000] },
    { kind: "v2", factory: "0x6eccab422d763ac031210895c81787e87b43a652", label: "camelot-v2" },
    { kind: "algebra", factory: "0x1a3c9b1d2f0529d97f2afc5136cc23e58f1fd35b", label: "camelot-v3" },
  ],
};

const SEL_GET_PAIR = "0xe6a43905";      // getPair(address,address)
const SEL_GET_POOL = "0x1698ee82";      // getPool(address,address,uint24)
const SEL_POOL_BY_PAIR = "0xd9a641e1";  // poolByPair(address,address)  — Algebra
const ZERO = "0x0000000000000000000000000000000000000000";
const padAddr = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padUint = (n: number) => n.toString(16).padStart(64, "0");

const cache = new Map<string, { addr: string; label: string }[]>();

/**
 * eth_call returning a single address word — 3-state (음성 캐시 오염 방지):
 *   { ok:true,  addr:string } = 실제 풀, { ok:true, addr:null } = 결론적 "풀 없음"(0x0),
 *   { ok:false, addr:null } = 비결론(전송/429 실패) → 호출부가 이 페어를 캐시하지 않고 다음에 재시도.
 * (getPool/getPair 는 미존재 풀에 0x0 을 정상 반환하므로, gatedJsonRpc 의 string=결론·null=실패로 구분된다.)
 */
async function callAddr(rpc: string, to: string, data: string): Promise<{ ok: boolean; addr: string | null }> {
  const hex = await gatedJsonRpc<string>(rpc, "eth_call", [{ to, data }, "latest"]);
  if (hex == null) return { ok: false, addr: null };       // 비결론(실패/재시도 소진)
  if (hex.length < 66) return { ok: true, addr: null };     // 결론적 빈 결과
  const a = "0x" + hex.slice(-40).toLowerCase();
  return { ok: true, addr: a === ZERO ? null : a };
}

/** real fork pool addresses for the selected token addresses on one chain. */
export async function dexForkPoolsFor(addrs: string[], chain: string): Promise<{ addr: string; label: string; pair: [string, string] }[]> {
  const rpc = RPC[chain];
  const forks = FORKS[chain];
  if (!rpc || !forks?.length) return [];
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, MAX_FORK_TOKENS);
  const pairs: [string, string][] = [];
  for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) pairs.push([uniq[i], uniq[j]]);
  const out: { addr: string; label: string; pair: [string, string] }[] = [];
  await Promise.all(pairs.map(async ([a, b]) => {
    const [t0, t1] = a < b ? [a, b] : [b, a];
    const key = `${chain}|${t0}|${t1}`;
    let found = cache.get(key);
    if (!found) {
      const acc: { addr: string; label: string }[] = [];
      let conclusive = true; // 한 호출이라도 실패(비결론)면 이 페어는 캐시하지 않는다(음성 캐시 오염 방지)
      const push = (label: string) => (r: { ok: boolean; addr: string | null }) => { if (!r.ok) conclusive = false; else if (r.addr) acc.push({ addr: r.addr, label }); };
      const calls: Promise<void>[] = [];
      for (const f of forks) {
        if (f.kind === "v2") {
          calls.push(callAddr(rpc, f.factory, SEL_GET_PAIR + padAddr(t0) + padAddr(t1)).then(push(f.label)));
        } else if (f.kind === "algebra") {
          calls.push(callAddr(rpc, f.factory, SEL_POOL_BY_PAIR + padAddr(t0) + padAddr(t1)).then(push(f.label)));
        } else {
          for (const fee of f.fees) calls.push(callAddr(rpc, f.factory, SEL_GET_POOL + padAddr(t0) + padAddr(t1) + padUint(fee)).then(push(f.label)));
        }
      }
      await Promise.all(calls);
      // de-dup (a pool address can't belong to two labels, but guard anyway)
      const seen = new Set<string>();
      const result = acc.filter((x) => (seen.has(x.addr) ? false : (seen.add(x.addr), true)));
      if (conclusive) cache.set(key, result); // 결론적일 때만 캐시 — 실패한 페어는 다음 요청에 재시도
      found = result;
    }
    for (const { addr, label } of found) out.push({ addr, label, pair: [t0, t1] });
  }));
  return out;
}
