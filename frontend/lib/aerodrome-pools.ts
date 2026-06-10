import { createPublicClient, http, type Address } from "viem";

/**
 * Real Aerodrome pool addresses on Base, read from the official factories ON-CHAIN
 * (same pattern as the Curve MetaRegistry — registry-grade constants, live lookups, no guessing):
 *   · v1 PoolFactory.getPool(tokenA, tokenB, stable)        — volatile + stable pools
 *   · Slipstream CLFactory.getPool(tokenA, tokenB, tickSpacing) — concentrated-liquidity pools
 * A wrong factory/ABI simply reverts → empty result (false negatives only, never false labels).
 * Cached per pair (pool addresses are immutable).
 */
const V1_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address;
const CL_FACTORY = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as Address;
const TICK_SPACINGS = [1, 50, 100, 200, 2000];
const ZERO = "0x0000000000000000000000000000000000000000";

const V1_ABI = [{ name: "getPool", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "bool" }], outputs: [{ type: "address" }] }] as const;
const CL_ABI = [{ name: "getPool", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "int24" }], outputs: [{ type: "address" }] }] as const;

let _client: ReturnType<typeof createPublicClient> | null = null;
function client() {
  if (!_client) _client = createPublicClient({ transport: http("https://base-rpc.publicnode.com") });
  return _client;
}
const cache = new Map<string, string[]>();

export async function aerodromePoolsFor(addrs: string[]): Promise<{ addr: string; label: string; pair: [string, string] }[]> {
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const pairs: [string, string][] = [];
  for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) pairs.push([uniq[i], uniq[j]]);
  const out: { addr: string; label: string; pair: [string, string] }[] = [];
  await Promise.all(pairs.map(async ([a, b]) => {
    const key = [a, b].sort().join("|");
    let pools = cache.get(key);
    if (!pools) {
      const found: string[] = [];
      const calls: Promise<void>[] = [];
      for (const stable of [false, true]) {
        calls.push(client().readContract({ address: V1_FACTORY, abi: V1_ABI, functionName: "getPool", args: [a as Address, b as Address, stable] })
          .then((p) => { const s = String(p).toLowerCase(); if (s && s !== ZERO) found.push(s); }).catch(() => {}));
      }
      for (const ts of TICK_SPACINGS) {
        calls.push(client().readContract({ address: CL_FACTORY, abi: CL_ABI, functionName: "getPool", args: [a as Address, b as Address, ts] })
          .then((p) => { const s = String(p).toLowerCase(); if (s && s !== ZERO) found.push(s); }).catch(() => {}));
      }
      await Promise.all(calls);
      pools = [...new Set(found)];
      cache.set(key, pools);
    }
    for (const p of pools) out.push({ addr: p, label: "aerodrome", pair: [a, b] });
  }));
  return out;
}
