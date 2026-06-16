import generatedEntries from "@/data/known-counterparties.generated.json";
import manualEntries from "@/data/known-counterparties.manual.json";

export type KnownCounterpartyCategory = "cex" | "bridge" | "router" | "solver" | "protocol";

export type KnownCounterparty = {
  category: KnownCounterpartyCategory;
  label: string;
  family?: string;
  source?: string;
  updatedAt?: string;
  protocolLike: true;
  clusterEligible: false;
};

type RawCounterpartyEntry = {
  address: string;
  category: KnownCounterpartyCategory;
  label: string;
  family?: string;
  source?: string;
  updatedAt?: string;
};

const INFRA_CATEGORIES = new Set<KnownCounterpartyCategory>(["cex", "bridge", "router", "solver", "protocol"]);

function normalizeEntry(entry: RawCounterpartyEntry): [string, KnownCounterparty] | null {
  const key = entry.address?.toLowerCase();
  if (!key || !/^0x[a-f0-9]{40}$/.test(key) || !INFRA_CATEGORIES.has(entry.category)) return null;
  return [key, {
    category: entry.category,
    label: entry.label,
    family: entry.family,
    source: entry.source,
    updatedAt: entry.updatedAt,
    protocolLike: true,
    clusterEligible: false,
  }];
}

function buildRegistry(): Record<string, KnownCounterparty> {
  const registry: Record<string, KnownCounterparty> = {};
  for (const entry of [...generatedEntries, ...manualEntries] as RawCounterpartyEntry[]) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    const [address, counterparty] = normalized;
    registry[address] = counterparty;
  }
  return registry;
}

export const KNOWN_COUNTERPARTIES: Record<string, KnownCounterparty> = buildRegistry();

export function lookupKnownCounterparty(address: string | null | undefined): KnownCounterparty | null {
  const key = address?.toLowerCase();
  return key ? KNOWN_COUNTERPARTIES[key] ?? null : null;
}

export function isKnownInfrastructureCategory(category: string): category is KnownCounterpartyCategory {
  return INFRA_CATEGORIES.has(category as KnownCounterpartyCategory);
}
