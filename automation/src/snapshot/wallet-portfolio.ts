import type { Address } from "viem";

import { getAllTokenBalances } from "@/lib/alchemy";
import { scrapeDebankPortfolio, type DebankProfile } from "@/lib/debank-scrape";
import { lookupProtocol } from "@/registry/protocol-registry";

/**
 * Resolve a wallet's exposure to our graph.
 *
 * Two strategies (combined):
 *   1. Alchemy alchemy_getTokenBalances → match wallet's ERC20 holdings against
 *      receipt tokens registered in protocol-registry.ts.
 *      Fast, deterministic, but misses positions without transferable receipts
 *      (Morpho Blue, Maker CDPs, f(x), Fluid).
 *
 *   2. DeBank Puppeteer scrape → comprehensive protocol-level positions, including
 *      non-transferable ones. Slower (~10-15s per wallet) but covers the gap.
 *
 * Returns the union of nodeIds detected via both methods.
 */

export interface PortfolioResult {
  wallet: string;
  nodeIds: string[];
  sources: Array<{
    method: "alchemy_token_match" | "debank_scrape";
    nodeIds: string[];
    detail?: unknown;
  }>;
}

const DEBANK_NAME_TO_FAMILY: Record<string, string> = {
  // DeBank protocol IDs / names → our protocol family
  aave: "aave_v3",
  "aave-v3": "aave_v3",
  "aave-v2": "aave_v2",
  "morpho-blue": "morpho_blue",
  morpho: "morpho_blue",
  compound: "compound_v3",
  "compound-v3": "compound_v3",
  spark: "spark",
  maker: "maker",
  fluid: "fluid",
  etherfi: "etherfi_boringvault",
  "ether-fi": "etherfi_boringvault",
  "f-x-protocol": "fx",
  fxprotocol: "fx",
  "uniswap-v3": "uniswap_v3",
  "uniswap-v2": "uniswap_v2",
  curve: "curve",
};

function familyToNodeId(family: string): string {
  return `protocol:${family}`;
}

export async function resolveWalletExposure(wallet: Address): Promise<PortfolioResult> {
  const sources: PortfolioResult["sources"] = [];
  const detected = new Set<string>();

  // ── Strategy 1: Alchemy ERC20 balance → registry match ─────
  try {
    const balances = await getAllTokenBalances(wallet);
    const alchemyNodes = new Set<string>();
    for (const [addr] of balances) {
      const entry = lookupProtocol(addr);
      if (entry && entry.family !== "bridge" && entry.family !== "cex") {
        alchemyNodes.add(entry.protocolNodeId);
        detected.add(entry.protocolNodeId);
      }
    }
    sources.push({
      method: "alchemy_token_match",
      nodeIds: [...alchemyNodes],
      detail: { tokensScanned: balances.size },
    });
  } catch (e) {
    sources.push({
      method: "alchemy_token_match",
      nodeIds: [],
      detail: { error: (e as Error).message },
    });
  }

  // ── Strategy 2: DeBank scrape → protocol-level positions ───
  try {
    const debank: DebankProfile = await scrapeDebankPortfolio(wallet);
    const debankNodes = new Set<string>();
    for (const p of debank.protocols) {
      if (p.chain.toLowerCase() !== "eth" && p.chain.toLowerCase() !== "ethereum") continue;
      const family = mapDebankProtocolName(p.protocolName);
      if (!family) continue;
      const nodeId = familyToNodeId(family);
      debankNodes.add(nodeId);
      detected.add(nodeId);
    }
    sources.push({
      method: "debank_scrape",
      nodeIds: [...debankNodes],
      detail: {
        protocolCount: debank.protocols.length,
        totalUsd: debank.totalUsdValue,
      },
    });
  } catch (e) {
    sources.push({
      method: "debank_scrape",
      nodeIds: [],
      detail: { error: (e as Error).message },
    });
  }

  return {
    wallet: wallet.toLowerCase(),
    nodeIds: [...detected],
    sources,
  };
}

function mapDebankProtocolName(rawName: string): string | null {
  const key = rawName.toLowerCase().replace(/\s+/g, "-");
  if (DEBANK_NAME_TO_FAMILY[key]) return DEBANK_NAME_TO_FAMILY[key];
  // fuzzy match — contains-style
  for (const [k, v] of Object.entries(DEBANK_NAME_TO_FAMILY)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}
