import type { Abi, Address } from "viem";

import { rpcFor } from "./rpc";

/**
 * Multicall3 batched read. viem's built-in `multicall` already routes through
 * Multicall3 when available; this is a thin pass-through that returns null on
 * per-call failure (so callers don't have to handle exceptions item-by-item).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MulticallItem = any;

export async function batch<T = unknown>(
  calls: MulticallItem[],
  opts: { allowFailure?: boolean; chainId?: number } = {},
): Promise<Array<T | null>> {
  if (calls.length === 0) return [];
  const client = rpcFor(opts.chainId ?? 1);
  const results = await client.multicall({
    contracts: calls,
    allowFailure: opts.allowFailure ?? true,
  });
  return results.map((r) => {
    const item = r as { status: "success" | "failure"; result?: unknown };
    if (item.status === "failure") return null;
    return (item.result as T) ?? null;
  });
}

/** Convenience: standard ERC20 balanceOf for many holders. */
const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

export async function balanceOfBatch(
  token: Address,
  holders: Address[],
  chainId?: number,
): Promise<bigint[]> {
  const results = await batch<bigint>(
    holders.map((h) => ({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [h],
    })),
    { allowFailure: true, chainId },
  );
  return results.map((r) => r ?? BigInt(0));
}
