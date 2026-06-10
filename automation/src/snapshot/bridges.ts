import { type Address, formatUnits } from "viem";

import { balanceOfBatch } from "@/lib/multicall";
import { listFamily, type ProtocolRegistryEntry } from "@/registry/protocol-registry";

/**
 * Fetch token balance for every known bridge contract in 1 Multicall3 call.
 *
 * Why: bridges are bipartite-out (token → bridge metadata). Top-holder
 * enumeration usually catches them, but a new bridge or one with smaller
 * balance might fall outside top-N. Direct lookup via registry guarantees
 * complete bridge coverage regardless of holder cutoff.
 */

export interface BridgeBalance {
  bridge: string;        // human label (e.g. "arbitrum")
  address: string;
  protocolNodeId: string; // e.g. "bridge:arbitrum"
  amountToken: number;
}

export async function fetchAllBridgeBalances(
  token: Address,
  tokenDecimals: number,
): Promise<BridgeBalance[]> {
  const entries: ProtocolRegistryEntry[] = listFamily("bridge");
  if (entries.length === 0) return [];

  const addresses = entries.map((e) => e.address as Address);
  const balances = await balanceOfBatch(token, addresses);

  const out: BridgeBalance[] = [];
  for (let i = 0; i < entries.length; i++) {
    const amount = Number(formatUnits(balances[i], tokenDecimals));
    if (amount <= 0) continue;
    const e = entries[i];
    out.push({
      bridge: e.protocolNodeId.replace("bridge:", ""),
      address: e.address,
      protocolNodeId: e.protocolNodeId,
      amountToken: amount,
    });
  }
  return out.sort((a, b) => b.amountToken - a.amountToken);
}
