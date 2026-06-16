import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EoaFlowDetail, EoaFlowEdge, EoaFlowNode, EoaFlowPayload, EoaWalletClusterEdge, EoaWalletClusterPayload } from "@/lib/eoa-flow-types";
import { lookupKnownCounterparty } from "@/lib/known-counterparties";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY ?? "";
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const RPC_URL = process.env.ETH_RPC
  ?? process.env.ALCHEMY_URL
  ?? process.env.RPC_URL
  ?? (ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "https://eth.llamarpc.com");
const FILE_CACHE_DIR = process.env.EOA_FLOW_CACHE_DIR ?? "/Users/link/defi-dagggg/feeder/cache/eoa_timeline";

type AddressKind = "eoa" | "safe" | "contract" | "unknown";
type AddressClassification = {
  address: string;
  nodeId?: string;
  label?: string;
  kind: AddressKind;
  eligible: boolean;
  reason: string;
};

type ContractCreation = {
  contractAddress?: string;
  contractCreator?: string;
  txHash?: string;
};

const codeCache = new Map<string, Promise<string | null>>();
const creationCache = new Map<string, Promise<ContractCreation | null>>();

function cachePath(key: string): string {
  return path.join(FILE_CACHE_DIR, `${createHash("sha256").update(key).digest("hex")}.json`);
}

async function fileCacheGet<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(cachePath(key), "utf8")) as T;
  } catch {
    return null;
  }
}

async function fileCachePut(key: string, value: unknown): Promise<void> {
  try {
    await mkdir(FILE_CACHE_DIR, { recursive: true });
    await writeFile(cachePath(key), JSON.stringify(value), "utf8");
  } catch {
    /* cache is best effort */
  }
}

function normalizeAddress(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase();
  return raw && ADDRESS_RE.test(raw) ? raw : null;
}

function addressFromNodeId(id: string): string | null {
  const maybe = id.split(":").at(-1);
  return normalizeAddress(maybe);
}

function nodeAddress(node: EoaFlowNode | undefined): string | null {
  return normalizeAddress(node?.data?.address) ?? (node ? addressFromNodeId(node.id) : null);
}

function isProtocolNode(node: EoaFlowNode | undefined): boolean {
  return node?.type === "protocol" || node?.data?.kind === "protocol";
}

function inferNodeKind(node: EoaFlowNode | undefined): AddressKind | null {
  const kind = String(node?.data?.kind ?? node?.type ?? "").toLowerCase();
  if (kind === "safe") return "safe";
  if (kind === "eoa") return "eoa";
  if (kind === "contract") return "contract";
  return null;
}

async function ethGetCode(address: string): Promise<string | null> {
  const key = address.toLowerCase();
  const cached = codeCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const fileKey = `next:eth_getCode:${key}`;
    const fileCached = await fileCacheGet<string | null>(fileKey);
    if (fileCached != null) return fileCached;
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [key, "latest"] }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: string };
      const code = typeof json.result === "string" ? json.result : null;
      await fileCachePut(fileKey, code);
      return code;
    } catch {
      return null;
    }
  })();
  codeCache.set(key, promise);
  return promise;
}

async function classifyAddress(address: string, node: EoaFlowNode | undefined): Promise<AddressClassification> {
  const known = lookupKnownCounterparty(address);
  if (known) {
    return { address, nodeId: node?.id, label: known.label, kind: "contract", eligible: false, reason: `known_${known.category}` };
  }
  if (isProtocolNode(node)) {
    return { address, nodeId: node?.id, label: node?.label, kind: "contract", eligible: false, reason: "protocol_node" };
  }
  const inferred = inferNodeKind(node);
  if (inferred === "eoa" || inferred === "safe") {
    return { address, nodeId: node?.id, label: node?.label, kind: inferred, eligible: true, reason: `node_kind_${inferred}` };
  }
  const code = await ethGetCode(address);
  if (code === "0x") return { address, nodeId: node?.id, label: node?.label, kind: "eoa", eligible: true, reason: "eth_getCode_eoa" };
  if (code && /^0x[0-9a-fA-F]+$/.test(code)) {
    return { address, nodeId: node?.id, label: node?.label, kind: inferred ?? "contract", eligible: true, reason: "eth_getCode_contract_wallet_like" };
  }
  return { address, nodeId: node?.id, label: node?.label, kind: inferred ?? "unknown", eligible: true, reason: "unknown_not_known_protocol" };
}

async function fetchContractCreation(address: string): Promise<ContractCreation | null> {
  const key = address.toLowerCase();
  const cached = creationCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const fileKey = `next:contract_creation:${key}`;
    const fileCached = await fileCacheGet<ContractCreation | null>(fileKey);
    if (fileCached != null) return fileCached;
    if (!ETHERSCAN_KEY) return null;
    const api = new URL("https://api.etherscan.io/v2/api");
    api.searchParams.set("chainid", "1");
    api.searchParams.set("module", "contract");
    api.searchParams.set("action", "getcontractcreation");
    api.searchParams.set("contractaddresses", key);
    api.searchParams.set("apikey", ETHERSCAN_KEY);
    try {
      const res = await fetch(api, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: ContractCreation[] | string };
      if (!Array.isArray(json.result)) return null;
      const row = json.result[0] ?? null;
      await fileCachePut(fileKey, row);
      return row;
    } catch {
      return null;
    }
  })();
  creationCache.set(key, promise);
  return promise;
}

function firstLast(details: EoaFlowDetail[] | undefined): { firstSeenUtc: string | null; lastSeenUtc: string | null } {
  let firstSeenUtc: string | null = null;
  let lastSeenUtc: string | null = null;
  for (const detail of details ?? []) {
    const ts = detail.datetime_utc;
    if (!ts) continue;
    if (!firstSeenUtc || ts < firstSeenUtc) firstSeenUtc = ts;
    if (!lastSeenUtc || ts > lastSeenUtc) lastSeenUtc = ts;
  }
  return { firstSeenUtc, lastSeenUtc };
}

function summarizeSymbols(details: EoaFlowDetail[] | undefined): string[] {
  const symbols = new Set<string>();
  for (const detail of details ?? []) {
    for (const transfer of detail.transfers ?? []) {
      if (transfer.symbol) symbols.add(transfer.symbol);
    }
  }
  return [...symbols].slice(0, 12);
}

function detailDedupeKey(detail: EoaFlowDetail): string {
  const transferKey = (detail.transfers ?? [])
    .map((transfer) => `${transfer.direction}:${transfer.token}:${transfer.symbol}:${transfer.amount ?? ""}`)
    .join("|");
  return detail.event_id ?? `${detail.tx_hash ?? ""}:${detail.block_number ?? ""}:${detail.address ?? ""}:${transferKey}`;
}

function dedupeDetails(details: EoaFlowDetail[]): EoaFlowDetail[] {
  const seen = new Map<string, EoaFlowDetail>();
  for (const detail of details) {
    const key = detailDedupeKey(detail);
    if (!seen.has(key)) seen.set(key, detail);
  }
  return [...seen.values()].sort((a, b) => (a.block_number ?? 0) - (b.block_number ?? 0) || detailDedupeKey(a).localeCompare(detailDedupeKey(b)));
}

function upsertTransferEdge(map: Map<string, EoaWalletClusterEdge>, edge: EoaFlowEdge, source: string, target: string) {
  const key = `${source}->${target}`;
  const cur = map.get(key);
  const details = dedupeDetails(edge.details ?? []);
  const txCount = details.length || edge.event_count || 1;
  const { firstSeenUtc, lastSeenUtc } = firstLast(details);
  if (!cur) {
    map.set(key, {
      id: `wallet:${source}:${target}`,
      source,
      target,
      relation: "transfer",
      direction: "directed",
      strength: "weak",
      reasons: [],
      txCount,
      symbols: summarizeSymbols(edge.details),
      firstSeenUtc,
      lastSeenUtc,
      sampleTx: edge.tx_hash ?? edge.details?.[0]?.tx_hash ?? null,
      details: [...details],
    });
    return;
  }
  cur.details = dedupeDetails([...(cur.details ?? []), ...details]);
  cur.txCount = cur.details.length || cur.txCount + txCount;
  for (const symbol of summarizeSymbols(details)) if (!cur.symbols.includes(symbol)) cur.symbols.push(symbol);
  cur.symbols = cur.symbols.slice(0, 12);
  if (firstSeenUtc && (!cur.firstSeenUtc || firstSeenUtc < cur.firstSeenUtc)) cur.firstSeenUtc = firstSeenUtc;
  if (lastSeenUtc && (!cur.lastSeenUtc || lastSeenUtc > cur.lastSeenUtc)) cur.lastSeenUtc = lastSeenUtc;
  if (!cur.sampleTx && (edge.tx_hash || edge.details?.[0]?.tx_hash)) cur.sampleTx = edge.tx_hash ?? edge.details?.[0]?.tx_hash ?? null;
}

function stronglyConnectedComponents(addresses: string[], edges: EoaWalletClusterEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const address of addresses) adjacency.set(address, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    if (edge.relation === "deployer") adjacency.get(edge.target)?.push(edge.source);
  }

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const components: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, lowlink.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, indices.get(w) ?? 0));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      while (stack.length) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      components.push(component.sort());
    }
  };

  for (const address of addresses) if (!indices.has(address)) strongConnect(address);
  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

export async function buildWalletClusters(payload: EoaFlowPayload): Promise<EoaWalletClusterPayload> {
  const nodesById = new Map(payload.nodes.map((node) => [node.id, node] as const));
  const nodesByAddress = new Map<string, EoaFlowNode>();
  for (const node of payload.nodes) {
    const address = nodeAddress(node);
    if (address) nodesByAddress.set(address, node);
  }

  const candidateAddresses = new Set<string>();
  for (const node of payload.nodes) {
    const address = nodeAddress(node);
    if (!address || isProtocolNode(node)) continue;
    candidateAddresses.add(address);
  }
  for (const edge of payload.edges) {
    if (edge.edge_type !== "wallet_move" && edge.edge_type !== "wallet_transfer") continue;
    const source = nodeAddress(nodesById.get(edge.source)) ?? addressFromNodeId(edge.source);
    const target = nodeAddress(nodesById.get(edge.target)) ?? addressFromNodeId(edge.target);
    if (source) candidateAddresses.add(source);
    if (target) candidateAddresses.add(target);
  }

  const classifiedPairs = await Promise.all([...candidateAddresses].map(async (address) => [address, await classifyAddress(address, nodesByAddress.get(address))] as const));
  const classifications = new Map(classifiedPairs);
  const eligible = new Set([...classifications.values()].filter((row) => row.eligible).map((row) => row.address));
  const edgeMap = new Map<string, EoaWalletClusterEdge>();

  for (const edge of payload.edges) {
    if (edge.edge_type !== "wallet_move" && edge.edge_type !== "wallet_transfer") continue;
    const source = nodeAddress(nodesById.get(edge.source)) ?? addressFromNodeId(edge.source);
    const target = nodeAddress(nodesById.get(edge.target)) ?? addressFromNodeId(edge.target);
    if (!source || !target || !eligible.has(source) || !eligible.has(target)) continue;
    upsertTransferEdge(edgeMap, edge, source, target);
  }

  for (const edge of edgeMap.values()) {
    const reverse = edgeMap.get(`${edge.target}->${edge.source}`);
    if (!reverse) continue;
    edge.direction = "mutual";
    edge.strength = "strong";
    if (!edge.reasons.includes("mutual_transfer")) edge.reasons.push("mutual_transfer");
  }

  const contractAddresses = [...eligible].filter((address) => {
    const kind = classifications.get(address)?.kind;
    return kind === "safe" || kind === "contract";
  });
  const creationRows = await Promise.all(contractAddresses.slice(0, 40).map(async (address) => [address, await fetchContractCreation(address)] as const));
  const extraAddresses: string[] = [];
  for (const [contract, creation] of creationRows) {
    const deployer = normalizeAddress(creation?.contractCreator);
    if (!deployer || deployer === contract) continue;
    if (!classifications.has(deployer)) {
      const deployerClass = await classifyAddress(deployer, nodesByAddress.get(deployer));
      classifications.set(deployer, deployerClass);
      if (deployerClass.eligible) {
        eligible.add(deployer);
        extraAddresses.push(deployer);
      }
    }
    if (!eligible.has(deployer)) continue;
    edgeMap.set(`deployer:${deployer}->${contract}`, {
      id: `deployer:${deployer}:${contract}`,
      source: deployer,
      target: contract,
      relation: "deployer",
      direction: "mutual",
      strength: "strong",
      reasons: ["contract_deployer"],
      txCount: 1,
      symbols: [],
      firstSeenUtc: null,
      lastSeenUtc: null,
      sampleTx: creation?.txHash ?? null,
    });
  }

  const addresses = [...eligible].sort();
  const edges = [...edgeMap.values()].sort((a, b) => b.txCount - a.txCount || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const components = stronglyConnectedComponents(addresses, edges);
  const clusterIdByAddress = new Map<string, string>();
  const clusters = components.map((members, index) => {
    const id = `wallet-cluster:${index + 1}`;
    for (const address of members) clusterIdByAddress.set(address, id);
    const internalEdges = edges.filter((edge) => members.includes(edge.source) && members.includes(edge.target));
    return {
      id,
      addresses: members,
      size: members.length,
      edgeCount: internalEdges.length,
      transferTxCount: internalEdges.filter((edge) => edge.relation === "transfer").reduce((total, edge) => total + edge.txCount, 0),
      strongReasons: [...new Set(internalEdges.flatMap((edge) => edge.reasons))],
      hasSeed: members.some((address) => (nodesByAddress.get(address)?.data?.discovered_by === "seed") || (nodesByAddress.get(address)?.data?.dfs_depth ?? 99) === 0),
    };
  });

  return {
    addresses: addresses.map((address) => {
      const row = classifications.get(address)!;
      return {
        address,
        nodeId: row.nodeId ?? null,
        label: row.label ?? null,
        kind: row.kind,
        clusterId: clusterIdByAddress.get(address) ?? null,
        classificationReason: row.reason,
        discoveredBy: nodesByAddress.get(address)?.data?.discovered_by ?? (extraAddresses.includes(address) ? "deployer" : null),
      };
    }),
    edges,
    clusters,
    dataGaps: [
      "known_counterparty_registry_is_incomplete",
      "contract_wallet_like_classification_uses_eth_getCode_not_ownership_semantics",
      ...(!ETHERSCAN_KEY ? ["deployer_edges_require_etherscan_key"] : []),
    ],
    sources: [
      { source: "eoa-flow:wallet_move_edges", ok: true, detail: { edgeCount: edges.filter((edge) => edge.relation === "transfer").length } },
      { source: "etherscan:getcontractcreation", ok: !!ETHERSCAN_KEY, detail: { checkedContracts: contractAddresses.slice(0, 40).length } },
    ],
  };
}
