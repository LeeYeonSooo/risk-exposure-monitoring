/**
 * Real Curve pool addresses on L2 (arbitrum·base), from Curve's public registry API.
 * curve-pools.ts uses the on-chain MetaRegistry, but MetaRegistry is NOT deployed on L2
 * (eth_getCode = 0x there, verified 2026-06-13) — so L2 must go through the keyless API
 * (api.curve.finance, same source the project already trusts for ethereum LP derivation).
 * We register a pool only when ≥2 of the selected tokens are among its coins → REAL pool,
 * no guessing (false negatives only, never false labels). Pool list cached per chain.
 */
const REGISTRIES = ["main", "crypto", "factory", "factory-crypto", "factory-stable-ng", "factory-tricrypto"];
const _cache = new Map<string, { address: string; coins: string[] }[]>();

async function loadPools(chain: string): Promise<{ address: string; coins: string[] }[]> {
  const hit = _cache.get(chain);
  if (hit) return hit;
  const pools: { address: string; coins: string[] }[] = [];
  await Promise.all(REGISTRIES.map(async (reg) => {
    try {
      const r = await fetch(`https://api.curve.finance/api/getPools/${chain}/${reg}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return;
      const j = (await r.json()) as { data?: { poolData?: { address?: string; coinsAddresses?: string[] }[] } };
      for (const p of j?.data?.poolData ?? []) {
        const addr = (p.address ?? "").toLowerCase();
        const coins = (p.coinsAddresses ?? []).map((c) => (c ?? "").toLowerCase()).filter((c) => /^0x[0-9a-f]{40}$/.test(c));
        if (/^0x[0-9a-f]{40}$/.test(addr) && coins.length) pools.push({ address: addr, coins });
      }
    } catch { /* 한 레지스트리 실패는 false negative 만 — 다른 레지스트리는 계속 */ }
  }));
  _cache.set(chain, pools);
  return pools;
}

export async function curveL2PoolsFor(addrs: string[], chain: string): Promise<{ addr: string; label: string; pair: [string, string] }[]> {
  if (chain !== "arbitrum" && chain !== "base") return [];
  const want = new Set(addrs.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
  if (want.size < 2) return [];
  const pools = await loadPools(chain);
  const out: { addr: string; label: string; pair: [string, string] }[] = [];
  for (const p of pools) {
    const hit = p.coins.filter((c) => want.has(c));
    if (hit.length >= 2) out.push({ addr: p.address, label: "curve-dex", pair: [hit[0], hit[1]] });
  }
  return out;
}
