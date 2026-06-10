import { encodeAbiParameters, encodePacked, getCreate2Address, keccak256, type Address, type Hex } from "viem";

/**
 * Deterministic Uniswap V2 / V3 pool addresses for a set of token addresses, PER CHAIN.
 * Pool addresses are CREATE2 — computable EXACTLY from (factory, token0, token1, fee) without any
 * subgraph or API key. So a transfer whose counterparty is one of these is a REAL swap through that
 * pool (we don't guess). Wrong fee-tier/chain combos just never match (harmless false negatives,
 * never false labels — a mis-derived CREATE2 address is an address nobody deployed to).
 *
 * Factories = official Uniswap deployments (docs.uniswap.org). The official V3 deployments share
 * the same pool bytecode → same init code hash.
 */
const V3_FACTORY: Record<string, Address> = {
  ethereum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  arbitrum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  optimism: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  polygon: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  base: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  bsc: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
  avalanche: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD",
};
const V3_INIT = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54" as Hex;
// V2 pairs only on mainnet (the original deployment; that's where the volume is)
const V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as Address;
const V2_INIT = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f" as Hex;
const V3_FEES = [100, 500, 3000, 10000];

export function uniswapPoolsFor(addrs: string[], chain = "ethereum"): { addr: string; label: string; pair: [string, string] }[] {
  const factory = V3_FACTORY[chain];
  if (!factory) return [];
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const out: { addr: string; label: string; pair: [string, string] }[] = [];
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const [t0, t1] = (uniq[i] < uniq[j] ? [uniq[i], uniq[j]] : [uniq[j], uniq[i]]) as [Address, Address];
      // pair = the two token addresses this CREATE2 pool is derived FROM — the pool's identity is known
      for (const fee of V3_FEES) {
        const salt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [t0, t1, fee]));
        out.push({ addr: getCreate2Address({ from: factory, salt, bytecodeHash: V3_INIT }).toLowerCase(), label: "uniswap-v3", pair: [t0, t1] });
      }
      if (chain === "ethereum") {
        const saltV2 = keccak256(encodePacked(["address", "address"], [t0, t1]));
        out.push({ addr: getCreate2Address({ from: V2_FACTORY, salt: saltV2, bytecodeHash: V2_INIT }).toLowerCase(), label: "uniswap-v2", pair: [t0, t1] });
      }
    }
  }
  return out;
}
