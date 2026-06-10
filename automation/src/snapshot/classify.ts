import type { Address } from "viem";

import { rpc } from "@/lib/rpc";
import { lookupProtocol, type ProtocolRegistryEntry } from "@/registry/protocol-registry";

/**
 * Classify a holder address:
 *   1. Registry exact match → ProtocolRegistryEntry
 *   2. Unknown contract → function selector heuristics → "candidate_family"
 *   3. EOA → "whale_eoa"
 */

export type Classification =
  | { kind: "protocol"; entry: ProtocolRegistryEntry }
  | { kind: "candidate"; family: string; reason: string; isContract: true }
  | { kind: "whale_eoa"; isContract: false }
  | { kind: "unknown"; isContract: boolean };

// Function selector → family hint
const SELECTOR_HINTS: Array<{ selector: string; family: string; reason: string }> = [
  { selector: "0x35ea6a75", family: "aave_v3", reason: "getReserveData(address) — likely Aave V3 fork" },
  { selector: "0x261a323e", family: "morpho_blue", reason: "idToMarketParams(bytes32) — Morpho Blue" },
  { selector: "0xb74f55a0", family: "morpho_blue", reason: "market(bytes32) — Morpho Blue" },
  { selector: "0x38d52e0f", family: "erc4626_vault", reason: "asset() — ERC-4626 vault" },
  { selector: "0x01e1d114", family: "erc4626_vault", reason: "totalAssets() — ERC-4626 vault" },
  { selector: "0xc9c65396", family: "compound_v3", reason: "getAssetInfo(uint8) — Compound V3 Comet" },
  { selector: "0xa9059cbb", family: "erc20", reason: "transfer(address,uint256) — generic ERC20" }, // very weak hint
];

/** Try a single selector against the contract — returns true if call doesn't revert. */
async function selectorReadable(address: Address, selector: string): Promise<boolean> {
  try {
    await rpc().call({ to: address, data: `${selector}${"00".repeat(32)}` as `0x${string}` });
    return true;
  } catch {
    return false;
  }
}

export async function classify(address: Address): Promise<Classification> {
  // 1) Registry lookup
  const entry = lookupProtocol(address);
  if (entry) return { kind: "protocol", entry };

  // 2) Check if it's a contract (bytecode size > 0)
  let isContract = false;
  try {
    const code = await rpc().getBytecode({ address });
    isContract = !!code && code !== "0x";
  } catch {
    /* swallow */
  }

  if (!isContract) {
    return { kind: "whale_eoa", isContract: false };
  }

  // 3) Selector heuristics — try the cheapest first (Morpho ID-based queries
  //    will revert without correct args, but the call shouldn't fail with INVALID_OPCODE).
  for (const h of SELECTOR_HINTS) {
    const matches = await selectorReadable(address, h.selector);
    if (matches) return { kind: "candidate", family: h.family, reason: h.reason, isContract: true };
  }

  return { kind: "unknown", isContract: true };
}
