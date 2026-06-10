import { createPublicClient, http, type Address } from "viem";
import { mainnet } from "viem/chains";

/**
 * Real Curve pool addresses for a set of token addresses, read from Curve's on-chain MetaRegistry
 * (find_pools_for_coins). Unlike Uniswap these aren't CREATE2-deterministic, so we read the canonical
 * registry — still REAL addresses, no guessing. Cached per pair (the registry is stable).
 * Routes to the existing "curve-dex" graph node (no new node added).
 */
const META_REGISTRY = "0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC" as Address;
const ABI = [{ name: "find_pools_for_coins", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address[]" }] }] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

let _client: ReturnType<typeof createPublicClient> | null = null;
function client() {
  if (!_client) _client = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
  return _client;
}
const cache = new Map<string, string[]>();

export async function curvePoolsFor(addrs: string[]): Promise<{ addr: string; label: string; pair: [string, string] }[]> {
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const pairs: [string, string][] = [];
  for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) pairs.push([uniq[i], uniq[j]]);
  const out: { addr: string; label: string; pair: [string, string] }[] = [];
  await Promise.all(pairs.map(async ([a, b]) => {
    const key = [a, b].sort().join("|");
    let pools = cache.get(key);
    if (!pools) {
      try {
        const r = (await client().readContract({ address: META_REGISTRY, abi: ABI, functionName: "find_pools_for_coins", args: [a as Address, b as Address] })) as readonly string[];
        pools = [...new Set(r.map((p) => p.toLowerCase()).filter((p) => p && p !== ZERO))];
      } catch { pools = []; }
      cache.set(key, pools);
    }
    // pair = the coin pair the registry was asked about (real lookup key, not a guess)
    for (const p of pools) out.push({ addr: p, label: "curve", pair: [a, b] });
  }));
  return out;
}
