import type { Address } from "viem";

import type { EdgeAttrs, ProtocolNodeSnapshot } from "@/types/edge-schema";

/**
 * Common adapter interface — every protocol exposes the same shape.
 * One adapter per protocol family. Token-agnostic — accepts token address as input.
 */
export interface ProtocolAdapter {
  family: string;
  protocolNodeId: string;

  /** Static node metadata (label, architecture, governance) — used for upserting nodes table. */
  describeNode(): Omit<ProtocolNodeSnapshot, "metadata"> & {
    metadata: Omit<ProtocolNodeSnapshot["metadata"], "tokensHeld" | "tokensHeldUsd">;
  };

  /**
   * Build the EdgeAttrs for (token → this protocol).
   * Returns null if this protocol has no relationship with the token (skip).
   */
  fetchEdge(token: Address, opts: AdapterContext): Promise<EdgeAttrs | null>;
}

export interface AdapterContext {
  /** spot price of the token in USD (for amountUsd calculation) */
  tokenPriceUsd: number;
  /** total supply of the token (for pctOfSupply) */
  tokenTotalSupply: number;
  /** snapshot timestamp ISO string */
  snapshotTs: string;
  /** block number at snapshot */
  blockNumber: number | null;
  /** EVM chainId for on-chain reads (default 1=mainnet). Multichain 어댑터가 batch 로 전달. */
  chainId?: number;
  /** 토큰 심볼 — 오라클 타입 분류용(LST/LRT → EXCHANGE_RATE 교환비). 없으면 어댑터가 MARKET 폴백. */
  tokenSymbol?: string;
}
