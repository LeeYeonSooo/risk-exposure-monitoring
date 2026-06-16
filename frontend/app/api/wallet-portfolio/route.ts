import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";
import { formatUnits, toFunctionSelector } from "viem";

import type { EoaFlowPayload } from "@/lib/eoa-flow-types";
import { isKnownInfrastructureCategory, lookupKnownCounterparty, type KnownCounterpartyCategory } from "@/lib/known-counterparties";
import { PROTOCOL_TOKENS } from "@/lib/protocol-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY ?? "";
const RPC_URL = process.env.ETH_RPC ?? process.env.ALCHEMY_URL ?? process.env.RPC_URL ?? (ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "https://eth.llamarpc.com");
const ALCHEMY_URL = process.env.ALCHEMY_URL ?? (ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "");
const FILE_CACHE_DIR = process.env.EOA_FLOW_CACHE_DIR ?? "/Users/link/defi-dagggg/feeder/cache/eoa_timeline";
const MORPHO_GQL = "https://blue-api.morpho.org/graphql";
const MORPHO_BLUE_SINGLETON = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SEL_ASSET = toFunctionSelector("function asset()");
const SEL_CONVERT_TO_ASSETS = toFunctionSelector("function convertToAssets(uint256)");
const SEL_MORPHO = toFunctionSelector("function MORPHO()");
const SEL_UNDERLYING_ASSET = toFunctionSelector("function UNDERLYING_ASSET_ADDRESS()");
const BALANCE_OF_SELECTOR = "0x70a08231";

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

function requestCacheKey(url: URL, address: string): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete("force");
  params.sort();
  return `wallet-portfolio-response:v2:${address.toLowerCase()}:${params.toString()}`;
}

type Confidence = "high" | "medium" | "low";
type PositionType = "lending" | "receipt_token" | "erc4626_vault" | "flow_hint" | "unknown";
type RedeemStatus = "likely" | "liquidity_limited" | "blocked_by_debt" | "claim_on_protocol" | "unknown";

type ChainConfig = {
  key: "ethereum";
  debank: "eth";
  chainId: 1;
};

const CHAIN: ChainConfig = { key: "ethereum", debank: "eth", chainId: 1 };

type SourceStatus = {
  source: string;
  ok: boolean;
  elapsedMs: number;
  detail?: unknown;
  error?: string;
};

type OutflowCategory = KnownCounterpartyCategory | "eoa" | "contract" | "unclassified";
type OutflowConfidence = "curated_static" | "eth_getCode" | "unknown";

type CounterpartyTag = {
  category: OutflowCategory;
  label: string;
  confidence: OutflowConfidence;
  clusterEligible: boolean;
  protocolLike: boolean;
};

type TokenAmount = {
  tokenAddress?: string | null;
  symbol: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  rawAmount?: string | null;
  source: string;
};

type WalletToken = TokenAmount & {
  chain: string;
  name?: string | null;
  decimals?: number | null;
  mappedProtocolId?: string | null;
  mappedPositionType?: PositionType | null;
};

type Redeemability = {
  status: RedeemStatus;
  summary: string;
  redeemableNow: TokenAmount[];
  queued: TokenAmount[];
  source: string;
};

type WalletPosition = {
  positionId: string;
  label: string;
  type: PositionType;
  marketId?: string | null;
  marketLabel?: string | null;
  supplied: TokenAmount[];
  collateral: TokenAmount[];
  borrowed: TokenAmount[];
  rewards: TokenAmount[];
  assetUsd: number | null;
  debtUsd: number | null;
  netUsd: number | null;
  ltv: number | null;
  lltv: number | null;
  healthRate: number | null;
  utilization: number | null;
  redeemability: Redeemability;
  source: string;
  confidence: Confidence;
};

type WalletProtocol = {
  protocolId: string;
  protocolName: string;
  canonical: string;
  chain: string;
  netUsd: number | null;
  assetUsd: number | null;
  debtUsd: number | null;
  healthRate: number | null;
  positions: WalletPosition[];
  sources: string[];
  confidence: Confidence;
};

type FlowHint = {
  available: boolean;
  source?: string;
  eventCount: number;
  linkedProtocols: string[];
  lastEventUtc?: string | null;
  protocolFlows: Array<{
    protocol: string;
    canonical: string;
    eventCount: number;
    actions: string[];
    tokenDeltas: TokenAmount[];
  }>;
  error?: string;
};

type OutflowSummaryRow = {
  category: OutflowCategory;
  label: string;
  counterparty: string;
  tokenAddress: string | null;
  symbol: string;
  amount: number | null;
  valueUsd: number | null;
  txCount: number;
  firstSeenUtc: string | null;
  lastSeenUtc: string | null;
  sampleTx: string | null;
};

type ExternalOutflows = {
  totals: {
    knownInfraUsd7d: number;
    knownInfraUsd30d: number;
    knownInfraUsdAll: number;
    knownCexBridgeUsd7d: number;
    knownCexBridgeUsd30d: number;
    knownCexBridgeUsdAll: number;
    cexUsd30d: number;
    bridgeUsd30d: number;
    routerUsd30d: number;
    solverUsd30d: number;
    protocolUsd30d: number;
    walletUsd7d: number;
    walletUsd30d: number;
    walletUsdAll: number;
    eoaUsd30d: number;
    contractUsd30d: number;
    largeUnclassifiedUsd30d: number;
  };
  cex: OutflowSummaryRow[];
  bridge: OutflowSummaryRow[];
  router: OutflowSummaryRow[];
  solver: OutflowSummaryRow[];
  protocol: OutflowSummaryRow[];
  eoa: OutflowSummaryRow[];
  contract: OutflowSummaryRow[];
  unclassifiedLarge: OutflowSummaryRow[];
  scannedRows: number;
  scanLimit: number;
  dataGaps: string[];
};

type WalletPortfolioResponse = {
  address: string;
  chain: string;
  debankChain: string;
  fetchedAt: string;
  totalUsd: number | null;
  walletTokenUsd: number | null;
  protocolNetUsd: number | null;
  walletTokens: WalletToken[];
  protocols: WalletProtocol[];
  externalOutflows: ExternalOutflows | null;
  flowHints: FlowHint;
  sources: SourceStatus[];
  dataGaps: string[];
};

type AlchemyBalance = {
  contractAddress: string;
  tokenBalance: string | null;
  error?: string | null;
};

type TokenMeta = {
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
};

type TokenBalanceScan = {
  balances: Map<string, bigint>;
  metadata: Map<string, TokenMeta>;
  source: string;
};

type EtherscanTokenTransfer = {
  timeStamp?: string;
  hash?: string;
  from?: string;
  to?: string;
  value?: string;
  contractAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
};

type EtherscanTx = {
  timeStamp?: string;
  hash?: string;
  from?: string;
  to?: string;
  value?: string;
};

type AlchemyAssetTransfer = {
  blockNum?: string;
  hash?: string;
  from?: string;
  to?: string;
  value?: number;
  asset?: string;
  category?: string;
  metadata?: { blockTimestamp?: string };
  rawContract?: {
    value?: string;
    address?: string | null;
    decimal?: string | number | null;
  };
};

type OutflowRow = {
  category: OutflowCategory;
  label: string;
  counterparty: string;
  confidence: OutflowConfidence;
  clusterEligible: boolean;
  protocolLike: boolean;
  tokenAddress: string | null;
  symbol: string;
  amount: number | null;
  valueUsd: number | null;
  timestamp: number;
  datetimeUtc: string | null;
  txHash: string;
  source: string;
};

type RawOutflowRow = Omit<OutflowRow, "category" | "label" | "confidence" | "clusterEligible" | "protocolLike">;

type MorphoPositionItem = {
  user?: { address?: string | null };
  market?: {
    marketId?: string | null;
    lltv?: string | null;
    loanAsset?: { address?: string | null; symbol?: string | null; decimals?: number | null } | null;
    collateralAsset?: { address?: string | null; symbol?: string | null; decimals?: number | null } | null;
    state?: {
      utilization?: number | null;
      borrowAssetsUsd?: number | null;
      supplyAssetsUsd?: number | null;
      collateralAssetsUsd?: number | null;
    } | null;
  } | null;
  state?: {
    collateral?: string | number | null;
    collateralUsd?: number | null;
    supplyAssets?: string | number | null;
    supplyAssetsUsd?: number | null;
    borrowAssets?: string | number | null;
    borrowAssetsUsd?: number | null;
  } | null;
};

function validAddress(address: string | null): address is string {
  return !!address && ADDRESS_RE.test(address);
}

function canonicalProtocolName(name: string, id = ""): string {
  const raw = `${name || ""} ${id || ""}`.toLowerCase();
  if (raw.includes("spark")) return "spark";
  if (raw.includes("aave")) return "aave3";
  if (raw.includes("morpho")) return "morpho";
  if (raw.includes("compound")) return "compound3";
  if (raw.includes("yield basis") || raw.includes("yieldbasis")) return "yieldbasis";
  if (raw.includes("pendle")) return "pendle2";
  if (raw.includes("curve")) return "curve";
  if (raw.includes("uniswap")) return "uniswap";
  return raw.replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 3).join(" ") || "unknown";
}

function protocolLabel(protocolNodeId: string): string {
  const key = protocolNodeId.replace(/^protocol:/, "");
  const labels: Record<string, string> = {
    aave_v2: "Aave V2",
    aave_v3: "Aave V3",
    spark: "Spark",
    compound_v3: "Compound V3",
    etherfi_boringvault: "Ether.fi",
    morpho_blue: "Morpho Blue",
  };
  return labels[key] ?? key.replace(/_/g, " ");
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sumNullable(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

function safeLimit(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function amountFromRaw(raw: string | number | bigint | null | undefined, decimals: number | null | undefined): number | null {
  if (raw == null) return null;
  try {
    const value = typeof raw === "bigint" ? raw : BigInt(String(raw));
    if (value === 0n) return 0;
    return Number(formatUnits(value, decimals ?? 18));
  } catch {
    return toFiniteNumber(raw);
  }
}

function parseAlchemyDecimal(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 18;
}

function parseAlchemyTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

async function fetchAlchemyOutflowTransfers(wallet: string, limit: number): Promise<AlchemyAssetTransfer[]> {
  if (!ALCHEMY_URL) throw new Error("missing ALCHEMY_API_KEY or ALCHEMY_URL");
  const out: AlchemyAssetTransfer[] = [];
  let pageKey: string | undefined;
  while (out.length < limit) {
    const maxCount = Math.min(1000, Math.max(1, limit - out.length));
    const params: Record<string, unknown> = {
      fromAddress: wallet.toLowerCase(),
      category: ["external", "erc20"],
      withMetadata: true,
      excludeZeroValue: true,
      order: "desc",
      maxCount: `0x${maxCount.toString(16)}`,
    };
    if (pageKey) params.pageKey = pageKey;
    const result = await alchemyCall<{ transfers?: AlchemyAssetTransfer[]; pageKey?: string }>("alchemy_getAssetTransfers", [params], 18_000);
    out.push(...(result.transfers ?? []));
    pageKey = result.pageKey;
    if (!pageKey) break;
  }
  return out;
}

async function fetchExternalOutflowsAlchemy(address: string, scanLimit: number): Promise<RawOutflowRow[]> {
  const transfers = await fetchAlchemyOutflowTransfers(address, scanLimit);
  const tokenAddresses = [...new Set(transfers
    .map((row) => row.rawContract?.address?.toLowerCase())
    .filter((x): x is string => !!x && ADDRESS_RE.test(x)))];
  const prices = await fetchPrices(tokenAddresses);
  const ethPrice = prices.get("coingecko:ethereum") ?? null;
  const lower = address.toLowerCase();
  const rows: RawOutflowRow[] = [];

  for (const row of transfers) {
    if (row.from?.toLowerCase() !== lower) continue;
    const to = row.to?.toLowerCase();
    if (!to || !ADDRESS_RE.test(to) || to === ZERO_ADDRESS) continue;

    const category = String(row.category ?? "").toLowerCase();
    const rawContract = row.rawContract ?? {};
    const isNative = category === "external";
    const tokenAddress = isNative ? null : rawContract.address?.toLowerCase() ?? null;
    if (!isNative && (!tokenAddress || !ADDRESS_RE.test(tokenAddress))) continue;
    const decimals = isNative ? 18 : parseAlchemyDecimal(rawContract.decimal);
    const amount = rawContract.value
      ? amountFromRaw(rawContract.value, decimals)
      : toFiniteNumber(row.value);
    if (amount == null || amount <= 0) continue;
    const price = isNative ? ethPrice : prices.get(`ethereum:${tokenAddress}`) ?? null;
    const timestamp = parseAlchemyTimestamp(row.metadata?.blockTimestamp);
    rows.push({
      counterparty: to,
      tokenAddress,
      symbol: isNative ? "ETH" : row.asset || tokenAddress?.slice(0, 8) || "TOKEN",
      amount,
      valueUsd: price == null ? null : amount * price,
      timestamp,
      datetimeUtc: timestampIso(timestamp),
      txHash: row.hash ?? "",
      source: "alchemy_getAssetTransfers",
    });
  }
  return rows;
}

function encodeUint256(value: string | number | bigint): string {
  const n = typeof value === "bigint" ? value : BigInt(String(value));
  return n.toString(16).padStart(64, "0");
}

function decodeAddressWord(hex: string | null | undefined): string | null {
  if (!hex || !/^0x[0-9a-fA-F]+$/.test(hex) || hex.length < 66) return null;
  const word = hex.slice(2, 66);
  if (word.slice(0, 24) !== "0".repeat(24)) return null;
  const address = `0x${word.slice(24).toLowerCase()}`;
  return ADDRESS_RE.test(address) && address !== "0x0000000000000000000000000000000000000000" ? address : null;
}

function decodeUintWord(hex: string | null | undefined): bigint | null {
  if (!hex || !/^0x[0-9a-fA-F]+$/.test(hex) || hex === "0x") return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

async function ethCall(to: string, data: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    return await rpcCall<string>("eth_call", [{ to, data }, "latest"], timeoutMs);
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R | null>): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      const value = await fn(items[idx]);
      if (value != null) out.push(value);
    }
  });
  await Promise.all(workers);
  return out;
}

function nonzeroAmount(token: TokenAmount): boolean {
  return (token.amount != null && Math.abs(token.amount) > 1e-18) || (token.valueUsd != null && Math.abs(token.valueUsd) > 1e-9);
}

async function timed<T>(source: string, fn: () => Promise<T>): Promise<{ value: T | null; status: SourceStatus }> {
  const started = Date.now();
  try {
    const value = await fn();
    return { value, status: { source, ok: true, elapsedMs: Date.now() - started } };
  } catch (error) {
    return {
      value: null,
      status: {
        source,
        ok: false,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function rpcCall<T = unknown>(method: string, params: unknown[], timeoutMs = 12_000): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? `${method} failed`);
  return json.result as T;
}

async function alchemyCall<T = unknown>(method: string, params: unknown[], timeoutMs = 15_000): Promise<T> {
  if (!ALCHEMY_URL) throw new Error("missing ALCHEMY_API_KEY or ALCHEMY_URL");
  const res = await fetch(ALCHEMY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? `${method} failed`);
  return json.result as T;
}

async function fetchEthBalance(wallet: string): Promise<string> {
  return rpcCall<string>("eth_getBalance", [wallet, "latest"]);
}

async function fetchAlchemyBalances(wallet: string, maxTokens: number): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  let pageKey: string | undefined;
  for (let i = 0; i < 50 && balances.size < maxTokens; i += 1) {
    const params = pageKey ? [wallet, "erc20", { pageKey }] : [wallet, "erc20"];
    const data = await alchemyCall<{ tokenBalances: AlchemyBalance[]; pageKey?: string }>("alchemy_getTokenBalances", params);
    for (const row of data.tokenBalances ?? []) {
      if (balances.size >= maxTokens) break;
      if (row.error || !row.tokenBalance) continue;
      try {
        const balance = BigInt(row.tokenBalance);
        if (balance > 0n) balances.set(row.contractAddress.toLowerCase(), balance);
      } catch {
        /* skip malformed balance */
      }
    }
    if (!data.pageKey) break;
    pageKey = data.pageKey;
  }
  return balances;
}

function balanceOfData(wallet: string): string {
  return `${BALANCE_OF_SELECTOR}${wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

async function fetchBalanceOf(tokenAddress: string, wallet: string): Promise<bigint> {
  const hex = await ethCall(tokenAddress, balanceOfData(wallet), 10_000);
  if (!hex || hex === "0x") return 0n;
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

async function scanBalancesViaEtherscan(wallet: string, maxTokens: number): Promise<TokenBalanceScan> {
  if (!ETHERSCAN_KEY) throw new Error("missing ETHERSCAN_API_KEY for token fallback");
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", "1");
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "tokentx");
  url.searchParams.set("address", wallet);
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(Math.min(1000, Math.max(50, maxTokens * 6))));
  url.searchParams.set("sort", "desc");
  url.searchParams.set("apikey", ETHERSCAN_KEY);
  const res = await fetch(url.toString(), { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Etherscan tokentx HTTP ${res.status}`);
  const json = (await res.json()) as { status?: string; message?: string; result?: EtherscanTokenTransfer[] | string };
  if (!Array.isArray(json.result)) {
    if (json.status === "0") return { balances: new Map(), metadata: new Map(), source: "etherscan:tokentx-empty" };
    throw new Error(typeof json.result === "string" ? json.result : json.message ?? "Etherscan tokentx failed");
  }
  const metadata = new Map<string, TokenMeta>();
  for (const row of json.result) {
    const address = row.contractAddress?.toLowerCase();
    if (!address || !ADDRESS_RE.test(address) || metadata.has(address)) continue;
    metadata.set(address, {
      name: row.tokenName ?? null,
      symbol: row.tokenSymbol ?? null,
      decimals: row.tokenDecimal != null && /^\d+$/.test(row.tokenDecimal) ? Number(row.tokenDecimal) : null,
    });
    if (metadata.size >= maxTokens) break;
  }
  const balances = new Map<string, bigint>();
  await Promise.all([...metadata.keys()].map(async (address) => {
    const balance = await fetchBalanceOf(address, wallet);
    if (balance > 0n) balances.set(address, balance);
  }));
  return { balances, metadata, source: "etherscan:tokentx+rpc:balanceOf" };
}

async function scanWalletTokenBalances(wallet: string, maxTokens: number): Promise<TokenBalanceScan> {
  if (ALCHEMY_URL) {
    try {
      return { balances: await fetchAlchemyBalances(wallet, maxTokens), metadata: new Map(), source: "alchemy_getTokenBalances" };
    } catch (error) {
      if (!ETHERSCAN_KEY) throw error;
    }
  }
  return scanBalancesViaEtherscan(wallet, maxTokens);
}

async function fetchTokenMetadata(tokenAddresses: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  const queue = [...new Set(tokenAddresses.map((a) => a.toLowerCase()))];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length) {
      const address = queue.shift();
      if (!address) return;
      try {
        const meta = await alchemyCall<TokenMeta>("alchemy_getTokenMetadata", [address], 10_000);
        out.set(address, meta);
      } catch {
        out.set(address, {});
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchPrices(tokenAddresses: string[]): Promise<Map<string, number>> {
  const ids = [...new Set([
    "coingecko:ethereum",
    ...tokenAddresses.map((a) => `ethereum:${a.toLowerCase()}`),
  ])];
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 70) {
    const chunk = ids.slice(i, i + 70);
    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=4h`, {
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { coins?: Record<string, { price?: number }> };
      for (const [id, row] of Object.entries(json.coins ?? {})) {
        if (typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0) out.set(id, row.price);
      }
    } catch {
      /* price is optional */
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let etherscanQueue: Promise<unknown> = Promise.resolve();
let lastEtherscanRequestAt = 0;

async function withEtherscanThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const run = etherscanQueue.then(async () => {
    const elapsed = Date.now() - lastEtherscanRequestAt;
    if (elapsed < 380) await sleep(380 - elapsed);
    lastEtherscanRequestAt = Date.now();
    return fn();
  });
  etherscanQueue = run.catch(() => undefined);
  return run;
}

async function etherscanAccount<T>(address: string, action: "tokentx" | "txlist", offset: number): Promise<T[]> {
  if (!ETHERSCAN_KEY) throw new Error("missing ETHERSCAN_API_KEY");
  const api = new URL("https://api.etherscan.io/v2/api");
  api.searchParams.set("chainid", "1");
  api.searchParams.set("module", "account");
  api.searchParams.set("action", action);
  api.searchParams.set("address", address);
  api.searchParams.set("page", "1");
  api.searchParams.set("offset", String(offset));
  api.searchParams.set("sort", "desc");
  api.searchParams.set("apikey", ETHERSCAN_KEY);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const json = await withEtherscanThrottle(async () => {
      const res = await fetch(api, { cache: "no-store", signal: AbortSignal.timeout(18_000) });
      if (!res.ok) throw new Error(`Etherscan ${action} HTTP ${res.status}`);
      return (await res.json()) as { status?: string; message?: string; result?: T[] | string };
    });
    if (Array.isArray(json.result)) return json.result;
    const detail = typeof json.result === "string" ? json.result : json.message ?? `Etherscan ${action} failed`;
    if (/no transactions found/i.test(detail)) return [];
    if (/rate limit|Max calls per sec|timeout|temporarily unavailable/i.test(detail) && attempt < 3) {
      await sleep(850 * (attempt + 1));
      continue;
    }
    throw new Error(detail);
  }
  return [];
}

const codeCache = new Map<string, Promise<string | null>>();

async function ethGetCode(address: string): Promise<string | null> {
  const key = address.toLowerCase();
  const cached = codeCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const fileKey = `next:eth_getCode:${key}`;
    const fileCached = await fileCacheGet<string | null>(fileKey);
    if (fileCached != null) return fileCached;
    const code = await rpcCall<string>("eth_getCode", [key, "latest"], 8_000).catch(() => null);
    await fileCachePut(fileKey, code);
    return code;
  })();
  codeCache.set(key, promise);
  return promise;
}

async function classifyCounterparty(to: string | null | undefined): Promise<CounterpartyTag> {
  const key = to?.toLowerCase();
  if (key === ZERO_ADDRESS) {
    return { category: "protocol", label: "burn / zero address", confidence: "curated_static", clusterEligible: false, protocolLike: true };
  }
  const tagged = lookupKnownCounterparty(key);
  if (tagged) {
    return {
      category: tagged.category,
      label: tagged.label,
      confidence: "curated_static",
      clusterEligible: tagged.clusterEligible,
      protocolLike: tagged.protocolLike,
    };
  }
  if (!key || !ADDRESS_RE.test(key)) {
    return { category: "unclassified", label: "unclassified", confidence: "unknown", clusterEligible: false, protocolLike: false };
  }
  const code = await ethGetCode(key);
  if (code === "0x") return { category: "eoa", label: "EOA wallet", confidence: "eth_getCode", clusterEligible: true, protocolLike: false };
  if (code && /^0x[0-9a-fA-F]+$/.test(code)) {
    return { category: "contract", label: "contract / Safe-like", confidence: "eth_getCode", clusterEligible: true, protocolLike: false };
  }
  return { category: "unclassified", label: "unclassified", confidence: "unknown", clusterEligible: false, protocolLike: false };
}

function timestampIso(ts: number): string | null {
  return ts > 0 ? new Date(ts * 1000).toISOString() : null;
}

function summarizeGroups(rows: OutflowRow[]): OutflowSummaryRow[] {
  const byKey = new Map<string, OutflowSummaryRow>();
  for (const row of rows) {
    const key = `${row.category}:${row.counterparty}:${row.tokenAddress ?? "eth"}:${row.symbol}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        category: row.category,
        label: row.label,
        counterparty: row.counterparty,
        tokenAddress: row.tokenAddress,
        symbol: row.symbol,
        amount: row.amount,
        valueUsd: row.valueUsd,
        txCount: 1,
        firstSeenUtc: row.datetimeUtc,
        lastSeenUtc: row.datetimeUtc,
        sampleTx: row.txHash || null,
      });
      continue;
    }
    cur.amount = cur.amount != null || row.amount != null ? (cur.amount ?? 0) + (row.amount ?? 0) : null;
    cur.valueUsd = cur.valueUsd != null || row.valueUsd != null ? (cur.valueUsd ?? 0) + (row.valueUsd ?? 0) : null;
    cur.txCount += 1;
    if (row.datetimeUtc && (!cur.firstSeenUtc || row.datetimeUtc < cur.firstSeenUtc)) cur.firstSeenUtc = row.datetimeUtc;
    if (row.datetimeUtc && (!cur.lastSeenUtc || row.datetimeUtc > cur.lastSeenUtc)) cur.lastSeenUtc = row.datetimeUtc;
  }
  return [...byKey.values()].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
}

function summarizeOutflows(rows: OutflowRow[], scanLimit: number): ExternalOutflows {
  const now = Date.now() / 1000;
  const recent30d = rows.filter((row) => row.timestamp >= now - 30 * 86400);
  const recent7d = rows.filter((row) => row.timestamp >= now - 7 * 86400);
  const cexBridge = (set: OutflowRow[]) => set.filter((row) => row.category === "cex" || row.category === "bridge");
  const knownInfra = (set: OutflowRow[]) => set.filter((row) => isKnownInfrastructureCategory(row.category));
  const wallet = (set: OutflowRow[]) => set.filter((row) => row.clusterEligible);
  const valueSum = (set: OutflowRow[]) => sumNullable(set.map((row) => row.valueUsd)) ?? 0;
  return {
    totals: {
      knownInfraUsd7d: valueSum(knownInfra(recent7d)),
      knownInfraUsd30d: valueSum(knownInfra(recent30d)),
      knownInfraUsdAll: valueSum(knownInfra(rows)),
      knownCexBridgeUsd7d: valueSum(cexBridge(recent7d)),
      knownCexBridgeUsd30d: valueSum(cexBridge(recent30d)),
      knownCexBridgeUsdAll: valueSum(cexBridge(rows)),
      cexUsd30d: valueSum(recent30d.filter((row) => row.category === "cex")),
      bridgeUsd30d: valueSum(recent30d.filter((row) => row.category === "bridge")),
      routerUsd30d: valueSum(recent30d.filter((row) => row.category === "router")),
      solverUsd30d: valueSum(recent30d.filter((row) => row.category === "solver")),
      protocolUsd30d: valueSum(recent30d.filter((row) => row.category === "protocol")),
      walletUsd7d: valueSum(wallet(recent7d)),
      walletUsd30d: valueSum(wallet(recent30d)),
      walletUsdAll: valueSum(wallet(rows)),
      eoaUsd30d: valueSum(recent30d.filter((row) => row.category === "eoa")),
      contractUsd30d: valueSum(recent30d.filter((row) => row.category === "contract")),
      largeUnclassifiedUsd30d: valueSum(recent30d.filter((row) => row.category === "unclassified" && (row.valueUsd ?? 0) >= 25_000)),
    },
    cex: summarizeGroups(rows.filter((row) => row.category === "cex")).slice(0, 8),
    bridge: summarizeGroups(rows.filter((row) => row.category === "bridge")).slice(0, 8),
    router: summarizeGroups(rows.filter((row) => row.category === "router")).slice(0, 8),
    solver: summarizeGroups(rows.filter((row) => row.category === "solver")).slice(0, 8),
    protocol: summarizeGroups(rows.filter((row) => row.category === "protocol")).slice(0, 10),
    eoa: summarizeGroups(rows.filter((row) => row.category === "eoa")).slice(0, 10),
    contract: summarizeGroups(rows.filter((row) => row.category === "contract")).slice(0, 10),
    unclassifiedLarge: summarizeGroups(rows.filter((row) => row.category === "unclassified" && (row.valueUsd ?? 0) >= 25_000)).slice(0, 12),
    scannedRows: rows.length,
    scanLimit,
    dataGaps: [
      "known_counterparty_registry_is_static_and_incomplete",
      "outflow_history_is_limited_by_scan_limit",
      "contract_or_safe_classification_uses_eth_getCode_not_owner_semantics",
    ],
  };
}

async function fetchExternalOutflows(address: string, offset: number): Promise<ExternalOutflows> {
  const lower = address.toLowerCase();
  let rawRows: RawOutflowRow[] = [];

  if (ALCHEMY_URL) {
    try {
      rawRows = await fetchExternalOutflowsAlchemy(address, offset);
    } catch {
      rawRows = [];
    }
  }

  if (!rawRows.length && ETHERSCAN_KEY) {
    const [tokenRows, nativeRows] = await Promise.all([
      etherscanAccount<EtherscanTokenTransfer>(address, "tokentx", offset),
      etherscanAccount<EtherscanTx>(address, "txlist", Math.min(1000, offset)),
    ]);
    const tokenAddresses = [...new Set(tokenRows.map((row) => row.contractAddress?.toLowerCase()).filter((x): x is string => !!x && ADDRESS_RE.test(x)))];
    const prices = await fetchPrices(tokenAddresses);

    for (const row of tokenRows) {
      if (row.from?.toLowerCase() !== lower) continue;
      const to = row.to?.toLowerCase();
      if (!to || !ADDRESS_RE.test(to)) continue;
      if (to === ZERO_ADDRESS) continue;
      const tokenAddress = row.contractAddress?.toLowerCase() ?? null;
      const decimals = row.tokenDecimal != null && /^\d+$/.test(row.tokenDecimal) ? Number(row.tokenDecimal) : 18;
      const amount = amountFromRaw(row.value ?? "0", decimals);
      if (amount == null || amount <= 0) continue;
      const price = tokenAddress ? prices.get(`ethereum:${tokenAddress}`) ?? null : null;
      const valueUsd = amount != null && price != null ? amount * price : null;
      const timestamp = Number(row.timeStamp ?? 0);
      rawRows.push({
        counterparty: to,
        tokenAddress,
        symbol: row.tokenSymbol || tokenAddress?.slice(0, 8) || "TOKEN",
        amount,
        valueUsd,
        timestamp,
        datetimeUtc: timestampIso(timestamp),
        txHash: row.hash ?? "",
        source: "etherscan:tokentx",
      });
    }

    const ethPrice = prices.get("coingecko:ethereum") ?? null;
    for (const row of nativeRows) {
      if (row.from?.toLowerCase() !== lower) continue;
      const to = row.to?.toLowerCase();
      if (!to || !ADDRESS_RE.test(to)) continue;
      if (to === ZERO_ADDRESS) continue;
      const amount = amountFromRaw(row.value ?? "0", 18);
      if (!amount || amount <= 0) continue;
      const timestamp = Number(row.timeStamp ?? 0);
      rawRows.push({
        counterparty: to,
        tokenAddress: null,
        symbol: "ETH",
        amount,
        valueUsd: ethPrice == null ? null : amount * ethPrice,
        timestamp,
        datetimeUtc: timestampIso(timestamp),
        txHash: row.hash ?? "",
        source: "etherscan:txlist",
      });
    }
  }

  const tags = new Map(await mapLimit([...new Set(rawRows.map((row) => row.counterparty))], 8, async (to) => {
    const tag = await classifyCounterparty(to);
    return [to, tag] as [string, CounterpartyTag];
  }));
  const rows: OutflowRow[] = rawRows.map((row) => {
    const tag = tags.get(row.counterparty) ?? { category: "unclassified", label: "unclassified", confidence: "unknown", clusterEligible: false, protocolLike: false };
    return {
      ...row,
      category: tag.category,
      label: tag.label,
      confidence: tag.confidence,
      clusterEligible: tag.clusterEligible,
      protocolLike: tag.protocolLike,
    };
  });

  return summarizeOutflows(rows, offset);
}

async function fetchWalletTokens(wallet: string, maxTokens: number, minUsd: number, includeUnpriced: boolean): Promise<WalletToken[]> {
  const [ethRaw, tokenScan] = await Promise.all([
    fetchEthBalance(wallet).catch(() => "0x0"),
    scanWalletTokenBalances(wallet, maxTokens),
  ]);
  const balances = tokenScan.balances;
  const tokenAddresses = [...balances.keys()];
  const [metadataFromAlchemy, prices] = await Promise.all([
    tokenAddresses.length ? fetchTokenMetadata(tokenAddresses) : Promise.resolve(new Map<string, TokenMeta>()),
    fetchPrices(tokenAddresses),
  ]);
  const metadata = new Map<string, TokenMeta>(tokenScan.metadata);
  for (const [address, meta] of metadataFromAlchemy) {
    metadata.set(address, {
      ...metadata.get(address),
      ...meta,
    });
  }

  const tokens: WalletToken[] = [];
  const ethAmount = amountFromRaw(ethRaw, 18) ?? 0;
  const ethPrice = prices.get("coingecko:ethereum") ?? null;
  if (ethAmount > 0) {
    tokens.push({
      chain: CHAIN.key,
      tokenAddress: null,
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
      amount: ethAmount,
      priceUsd: ethPrice,
      valueUsd: ethPrice == null ? null : ethAmount * ethPrice,
      rawAmount: String(BigInt(ethRaw)),
      source: "rpc:eth_getBalance",
    });
  }

  for (const [address, raw] of balances) {
    const meta = metadata.get(address) ?? {};
    const decimals = typeof meta.decimals === "number" && Number.isFinite(meta.decimals) ? meta.decimals : 18;
    const amount = amountFromRaw(raw, decimals);
    const priceUsd = prices.get(`ethereum:${address}`) ?? null;
    const valueUsd = amount != null && priceUsd != null ? amount * priceUsd : null;
    if (valueUsd != null && Math.abs(valueUsd) < minUsd) continue;
    if (valueUsd == null && !includeUnpriced) continue;
    tokens.push({
      chain: CHAIN.key,
      tokenAddress: address,
      symbol: meta.symbol || address.slice(0, 8),
      name: meta.name ?? null,
      decimals,
      amount,
      priceUsd,
      valueUsd,
      rawAmount: raw.toString(),
      source: tokenScan.source,
    });
  }

  return tokens.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
}

function tokenAmount(
  tokenAddress: string | null | undefined,
  symbol: string | null | undefined,
  amount: number | null,
  valueUsd: number | null,
  rawAmount: string | number | null | undefined,
  source: string,
  priceUsd: number | null = amount && valueUsd != null && amount !== 0 ? valueUsd / amount : null,
): TokenAmount {
  return {
    tokenAddress: tokenAddress?.toLowerCase() ?? null,
    symbol: symbol || tokenAddress?.slice(0, 8) || "TOKEN",
    amount,
    priceUsd,
    valueUsd,
    rawAmount: rawAmount == null ? null : String(rawAmount),
    source,
  };
}

function morphoRedeemability(position: {
  supplied: TokenAmount[];
  collateral: TokenAmount[];
  borrowed: TokenAmount[];
  userSupplyUsd: number;
  userCollateralUsd: number;
  userBorrowUsd: number;
  marketSupplyUsd: number;
  marketBorrowUsd: number;
}): Redeemability {
  const availableUsd = Math.max(0, position.marketSupplyUsd - position.marketBorrowUsd);
  if (position.userBorrowUsd > 0 && position.userCollateralUsd > 0) {
    return {
      status: "blocked_by_debt",
      summary: "collateral withdrawal requires repayment or enough unused borrowing capacity",
      redeemableNow: [],
      queued: [],
      source: "morpho:marketPositions",
    };
  }
  if (position.userSupplyUsd > 0) {
    const enoughLiquidity = availableUsd + 1 >= position.userSupplyUsd;
    return {
      status: enoughLiquidity ? "likely" : "liquidity_limited",
      summary: enoughLiquidity
        ? "supplied loan asset appears withdrawable against current market liquidity"
        : "supplied loan asset may be limited by current market utilization",
      redeemableNow: enoughLiquidity ? position.supplied : [],
      queued: [],
      source: "morpho:marketPositions",
    };
  }
  if (position.userCollateralUsd > 0) {
    return {
      status: "likely",
      summary: "collateral has no current borrow in this market",
      redeemableNow: position.collateral,
      queued: [],
      source: "morpho:marketPositions",
    };
  }
  return {
    status: "unknown",
    summary: "position is present but has no non-zero token leg after filtering",
    redeemableNow: [],
    queued: [],
    source: "morpho:marketPositions",
  };
}

async function fetchMorphoProtocol(wallet: string, minUsd: number): Promise<WalletProtocol | null> {
  const query = `query WalletMorpho($chainId:Int!, $user:String!) {
    marketPositions(first:100, where:{chainId_in:[$chainId], userAddress_in:[$user]}, orderBy:BorrowShares, orderDirection:Desc) {
      items {
        user { address }
        market {
          marketId
          lltv
          loanAsset { address symbol decimals }
          collateralAsset { address symbol decimals }
          state { utilization borrowAssetsUsd supplyAssetsUsd collateralAssetsUsd }
        }
        state { collateral collateralUsd supplyAssets supplyAssetsUsd borrowAssets borrowAssetsUsd }
      }
    }
  }`;
  const res = await fetch(MORPHO_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { chainId: CHAIN.chainId, user: wallet.toLowerCase() } }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Morpho HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { marketPositions?: { items?: MorphoPositionItem[] } }; errors?: Array<{ message?: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message ?? "GraphQL error").join("; "));

  const positions: WalletPosition[] = [];
  for (const item of json.data?.marketPositions?.items ?? []) {
    const market = item.market;
    const state = item.state;
    if (!market || !state) continue;
    const loan = market.loanAsset;
    const collateralAsset = market.collateralAsset;
    const supplyAmount = amountFromRaw(state.supplyAssets, loan?.decimals ?? 18);
    const borrowAmount = amountFromRaw(state.borrowAssets, loan?.decimals ?? 18);
    const collateralAmount = amountFromRaw(state.collateral, collateralAsset?.decimals ?? 18);
    const supplyUsd = state.supplyAssetsUsd ?? 0;
    const borrowUsd = state.borrowAssetsUsd ?? 0;
    const collateralUsd = state.collateralUsd ?? 0;
    const assetUsd = supplyUsd + collateralUsd;
    const netUsd = assetUsd - borrowUsd;
    if (Math.max(Math.abs(assetUsd), Math.abs(borrowUsd), Math.abs(netUsd)) < minUsd) continue;

    const supplied = [
      tokenAmount(loan?.address, loan?.symbol, supplyAmount, state.supplyAssetsUsd ?? null, state.supplyAssets, "morpho:marketPositions"),
    ].filter(nonzeroAmount);
    const collateral = [
      tokenAmount(collateralAsset?.address, collateralAsset?.symbol, collateralAmount, state.collateralUsd ?? null, state.collateral, "morpho:marketPositions"),
    ].filter(nonzeroAmount);
    const borrowed = [
      tokenAmount(loan?.address, loan?.symbol, borrowAmount, state.borrowAssetsUsd ?? null, state.borrowAssets, "morpho:marketPositions"),
    ].filter(nonzeroAmount);
    const lltv = market.lltv ? Number(market.lltv) / 1e18 : null;
    const ltv = collateralUsd > 0 && borrowUsd > 0 ? borrowUsd / collateralUsd : null;
    const healthRate = collateralUsd > 0 && borrowUsd > 0 && lltv != null ? (collateralUsd * lltv) / borrowUsd : null;
    const positionForRedeem = {
      supplied,
      collateral,
      borrowed,
      userSupplyUsd: supplyUsd,
      userCollateralUsd: collateralUsd,
      userBorrowUsd: borrowUsd,
      marketSupplyUsd: market.state?.supplyAssetsUsd ?? 0,
      marketBorrowUsd: market.state?.borrowAssetsUsd ?? 0,
    };
    positions.push({
      positionId: `morpho:${CHAIN.key}:${market.marketId ?? `${collateralAsset?.symbol}/${loan?.symbol}`}`,
      label: `Morpho Blue ${collateralAsset?.symbol ?? "?"}/${loan?.symbol ?? "?"}`,
      type: "lending",
      marketId: market.marketId ?? null,
      marketLabel: `${collateralAsset?.symbol ?? "?"}/${loan?.symbol ?? "?"}`,
      supplied,
      collateral,
      borrowed,
      rewards: [],
      assetUsd,
      debtUsd: borrowUsd,
      netUsd,
      ltv,
      lltv,
      healthRate,
      utilization: market.state?.utilization ?? null,
      redeemability: morphoRedeemability(positionForRedeem),
      source: "morpho:marketPositions",
      confidence: "high",
    });
  }

  if (!positions.length) return null;
  const assetUsd = sumNullable(positions.map((p) => p.assetUsd));
  const debtUsd = sumNullable(positions.map((p) => p.debtUsd));
  return {
    protocolId: "morpho-blue",
    protocolName: "Morpho Blue",
    canonical: "morpho",
    chain: CHAIN.key,
    assetUsd,
    debtUsd,
    netUsd: assetUsd != null || debtUsd != null ? (assetUsd ?? 0) - (debtUsd ?? 0) : null,
    healthRate: minNullable(positions.map((p) => p.healthRate)),
    positions,
    sources: ["morpho:marketPositions"],
    confidence: "high",
  };
}

function minNullable(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return nums.length ? Math.min(...nums) : null;
}

function receiptProtocols(walletTokens: WalletToken[]): WalletProtocol[] {
  const tokenByAddress = new Map(walletTokens.filter((t) => t.tokenAddress).map((t) => [t.tokenAddress!.toLowerCase(), t]));
  const protocols: WalletProtocol[] = [];
  for (const entry of PROTOCOL_TOKENS) {
    if (!entry.protocolNodeId.startsWith("protocol:")) continue;
    const walletToken = tokenByAddress.get(entry.tokenAddress.toLowerCase());
    if (!walletToken) continue;
    const protocolName = protocolLabel(entry.protocolNodeId);
    const supplied = [tokenAmount(walletToken.tokenAddress, walletToken.symbol, walletToken.amount, walletToken.valueUsd, walletToken.rawAmount, "receipt-token-registry", walletToken.priceUsd)];
    const position: WalletPosition = {
      positionId: `receipt:${CHAIN.key}:${entry.tokenAddress.toLowerCase()}`,
      label: entry.label,
      type: "receipt_token",
      marketId: entry.tokenAddress.toLowerCase(),
      marketLabel: walletToken.symbol,
      supplied,
      collateral: [],
      borrowed: [],
      rewards: [],
      assetUsd: walletToken.valueUsd,
      debtUsd: null,
      netUsd: walletToken.valueUsd,
      ltv: null,
      lltv: null,
      healthRate: null,
      utilization: null,
      redeemability: {
        status: "claim_on_protocol",
        summary: "wallet holds a protocol receipt/share token; redeemable amount depends on the protocol contract and market liquidity",
        redeemableNow: supplied,
        queued: [],
        source: "receipt-token-registry",
      },
      source: "receipt-token-registry",
      confidence: "medium",
    };
    protocols.push({
      protocolId: entry.protocolNodeId.replace(/^protocol:/, "").replace(/_/g, "-"),
      protocolName,
      canonical: canonicalProtocolName(protocolName, entry.protocolNodeId),
      chain: CHAIN.key,
      assetUsd: walletToken.valueUsd,
      debtUsd: null,
      netUsd: walletToken.valueUsd,
      healthRate: null,
      positions: [position],
      sources: ["receipt-token-registry"],
      confidence: "medium",
    });
  }
  return protocols;
}

type VaultProbe = {
  vaultToken: WalletToken;
  assetAddress: string;
  assetsRaw: bigint;
  morphoAddress: string | null;
};

type LendingTokenProbe = {
  walletToken: WalletToken;
  protocolId: "aave-v3" | "spark";
  protocolName: "Aave V3" | "Spark";
  side: "supplied" | "borrowed";
  underlyingAddress: string;
};

function inferAaveLikeToken(token: WalletToken): Pick<LendingTokenProbe, "protocolId" | "protocolName" | "side"> | null {
  const raw = `${token.symbol} ${token.name ?? ""}`.toLowerCase();
  const isSpark = raw.includes("spark") || /^sp/i.test(token.symbol);
  const isDebt = raw.includes("variabledebt") || raw.includes("stabledebt") || raw.includes("variable debt") || raw.includes("stable debt");
  const isAaveSupply = raw.includes("aave ethereum") || /^aeth/i.test(token.symbol);
  const isSparkSupply = isSpark && (/^sp/i.test(token.symbol) || raw.includes("spark"));
  if (!isDebt && !isAaveSupply && !isSparkSupply) return null;
  return {
    protocolId: isSpark ? "spark" : "aave-v3",
    protocolName: isSpark ? "Spark" : "Aave V3",
    side: isDebt ? "borrowed" : "supplied",
  };
}

async function fetchAaveLikeProtocols(walletTokens: WalletToken[], minUsd: number): Promise<WalletProtocol[]> {
  const candidates = walletTokens.filter((token) => token.tokenAddress && token.rawAmount && inferAaveLikeToken(token));
  const probes = await mapLimit(candidates, 8, async (walletToken): Promise<LendingTokenProbe | null> => {
    const inferred = inferAaveLikeToken(walletToken);
    const tokenAddress = walletToken.tokenAddress?.toLowerCase();
    if (!inferred || !tokenAddress) return null;
    const underlyingAddress = decodeAddressWord(await ethCall(tokenAddress, SEL_UNDERLYING_ASSET, 8_000));
    if (!underlyingAddress) return null;
    return { walletToken, ...inferred, underlyingAddress };
  });
  if (!probes.length) return [];

  const underlyingAddresses = [...new Set(probes.map((p) => p.underlyingAddress))];
  const [metadata, prices] = await Promise.all([
    fetchTokenMetadata(underlyingAddresses),
    fetchPrices(underlyingAddresses),
  ]);
  const byProtocol = new Map<string, WalletProtocol>();
  for (const probe of probes) {
    const meta = metadata.get(probe.underlyingAddress) ?? {};
    const symbol = meta.symbol ?? probe.walletToken.symbol.replace(/^(aEth|sp|variableDebtEth|stableDebtEth)/, "");
    const decimals = typeof meta.decimals === "number" && Number.isFinite(meta.decimals) ? meta.decimals : probe.walletToken.decimals ?? 18;
    const amount = amountFromRaw(probe.walletToken.rawAmount, decimals);
    const price = prices.get(`ethereum:${probe.underlyingAddress}`) ?? null;
    const valueUsd = amount != null && price != null ? amount * price : Math.abs(probe.walletToken.valueUsd ?? 0) || null;
    if (valueUsd != null && Math.abs(valueUsd) < minUsd) continue;
    const leg = tokenAmount(probe.underlyingAddress, symbol, amount, valueUsd, probe.walletToken.rawAmount, "aave-token:UNDERLYING_ASSET_ADDRESS", price);
    const supplied = probe.side === "supplied" ? [leg] : [];
    const borrowed = probe.side === "borrowed" ? [leg] : [];
    const position: WalletPosition = {
      positionId: `${probe.protocolId}:${CHAIN.key}:${probe.walletToken.tokenAddress}`,
      label: `${probe.protocolName} ${symbol} ${probe.side}`,
      type: "lending",
      marketId: probe.walletToken.tokenAddress?.toLowerCase() ?? null,
      marketLabel: symbol,
      supplied,
      collateral: [],
      borrowed,
      rewards: [],
      assetUsd: probe.side === "supplied" ? valueUsd : null,
      debtUsd: probe.side === "borrowed" ? valueUsd : null,
      netUsd: probe.side === "borrowed" ? -(valueUsd ?? 0) : valueUsd,
      ltv: null,
      lltv: null,
      healthRate: null,
      utilization: null,
      redeemability: {
        status: probe.side === "borrowed" ? "unknown" : "claim_on_protocol",
        summary: probe.side === "borrowed"
          ? "debt token balance is a current borrow leg, not a redeemable asset"
          : "wallet holds an interest-bearing lending receipt token; withdrawal can still depend on protocol liquidity and collateral configuration",
        redeemableNow: probe.side === "supplied" ? [leg] : [],
        queued: [],
        source: "aave-token:UNDERLYING_ASSET_ADDRESS",
      },
      source: "aave-token:UNDERLYING_ASSET_ADDRESS",
      confidence: "medium",
    };
    const protocol = byProtocol.get(probe.protocolId) ?? {
      protocolId: probe.protocolId,
      protocolName: probe.protocolName,
      canonical: canonicalProtocolName(probe.protocolName, probe.protocolId),
      chain: CHAIN.key,
      netUsd: null,
      assetUsd: null,
      debtUsd: null,
      healthRate: null,
      positions: [],
      sources: ["aave-token:UNDERLYING_ASSET_ADDRESS"],
      confidence: "medium" as Confidence,
    };
    protocol.positions.push(position);
    byProtocol.set(probe.protocolId, protocol);
  }

  for (const protocol of byProtocol.values()) {
    protocol.assetUsd = sumNullable(protocol.positions.map((p) => p.assetUsd));
    protocol.debtUsd = sumNullable(protocol.positions.map((p) => p.debtUsd));
    protocol.netUsd = (protocol.assetUsd ?? 0) - (protocol.debtUsd ?? 0);
    const hasDebt = (protocol.debtUsd ?? 0) > 0;
    if (hasDebt) {
      for (const position of protocol.positions) {
        if (position.supplied.length) {
          position.redeemability = {
            ...position.redeemability,
            status: "blocked_by_debt",
            summary: "wallet also has debt in this lending protocol; exact withdrawable collateral requires protocol collateral-flag and health-factor reads",
            redeemableNow: [],
          };
        }
      }
    }
  }
  return [...byProtocol.values()];
}

async function fetchErc4626Protocols(walletTokens: WalletToken[], minUsd: number): Promise<WalletProtocol[]> {
  const candidates = walletTokens.filter((token) => token.tokenAddress && token.rawAmount && token.rawAmount !== "0");
  const probes = await mapLimit(candidates, 8, async (walletToken): Promise<VaultProbe | null> => {
    const vault = walletToken.tokenAddress?.toLowerCase();
    if (!vault || !walletToken.rawAmount) return null;
    const assetHex = await ethCall(vault, SEL_ASSET);
    const assetAddress = decodeAddressWord(assetHex);
    if (!assetAddress || assetAddress === vault) return null;
    const assetsHex = await ethCall(vault, `${SEL_CONVERT_TO_ASSETS}${encodeUint256(walletToken.rawAmount)}`, 12_000);
    const assetsRaw = decodeUintWord(assetsHex);
    if (assetsRaw == null || assetsRaw <= 0n) return null;
    const morphoAddress = decodeAddressWord(await ethCall(vault, SEL_MORPHO, 6_000));
    return { vaultToken: walletToken, assetAddress, assetsRaw, morphoAddress };
  });
  if (!probes.length) return [];

  const assetAddresses = [...new Set(probes.map((p) => p.assetAddress))];
  const [metadata, prices] = await Promise.all([
    fetchTokenMetadata(assetAddresses),
    fetchPrices(assetAddresses),
  ]);
  const byProtocol = new Map<string, WalletProtocol>();
  for (const probe of probes) {
    const assetMeta = metadata.get(probe.assetAddress) ?? {};
    const decimals = typeof assetMeta.decimals === "number" && Number.isFinite(assetMeta.decimals) ? assetMeta.decimals : 18;
    const assetAmount = amountFromRaw(probe.assetsRaw, decimals);
    const assetPrice = prices.get(`ethereum:${probe.assetAddress}`) ?? null;
    const valueUsd = assetAmount != null && assetPrice != null ? assetAmount * assetPrice : probe.vaultToken.valueUsd;
    if (valueUsd != null && Math.abs(valueUsd) < minUsd) continue;
    const isMorphoVault = probe.morphoAddress?.toLowerCase() === MORPHO_BLUE_SINGLETON;
    const protocolId = isMorphoVault ? "morpho-vaults" : "erc4626-vaults";
    const protocolName = isMorphoVault ? "Morpho Vaults" : "ERC-4626 Vaults";
    const supplied = [
      tokenAmount(probe.assetAddress, assetMeta.symbol, assetAmount, valueUsd ?? null, probe.assetsRaw.toString(), "erc4626:convertToAssets", assetPrice),
    ].filter(nonzeroAmount);
    const position: WalletPosition = {
      positionId: `erc4626:${CHAIN.key}:${probe.vaultToken.tokenAddress}`,
      label: `${probe.vaultToken.symbol} vault share`,
      type: "erc4626_vault",
      marketId: probe.vaultToken.tokenAddress?.toLowerCase() ?? null,
      marketLabel: `${probe.vaultToken.symbol} -> ${assetMeta.symbol ?? probe.assetAddress.slice(0, 8)}`,
      supplied,
      collateral: [],
      borrowed: [],
      rewards: [],
      assetUsd: valueUsd ?? null,
      debtUsd: null,
      netUsd: valueUsd ?? null,
      ltv: null,
      lltv: null,
      healthRate: null,
      utilization: null,
      redeemability: {
        status: "claim_on_protocol",
        summary: "wallet holds ERC-4626 vault shares; convertToAssets gives current underlying claim, while actual redemption can still depend on vault liquidity or queue rules",
        redeemableNow: supplied,
        queued: [],
        source: "erc4626:asset+convertToAssets",
      },
      source: "erc4626:asset+convertToAssets",
      confidence: "medium",
    };
    const protocol = byProtocol.get(protocolId) ?? {
      protocolId,
      protocolName,
      canonical: canonicalProtocolName(protocolName, protocolId),
      chain: CHAIN.key,
      netUsd: null,
      assetUsd: null,
      debtUsd: null,
      healthRate: null,
      positions: [],
      sources: ["erc4626:asset+convertToAssets"],
      confidence: "medium" as Confidence,
    };
    protocol.positions.push(position);
    byProtocol.set(protocolId, protocol);
  }

  for (const protocol of byProtocol.values()) {
    protocol.assetUsd = sumNullable(protocol.positions.map((p) => p.assetUsd));
    protocol.debtUsd = sumNullable(protocol.positions.map((p) => p.debtUsd));
    protocol.netUsd = sumNullable(protocol.positions.map((p) => p.netUsd));
  }
  return [...byProtocol.values()];
}

function mergeProtocols(protocols: WalletProtocol[]): WalletProtocol[] {
  const byKey = new Map<string, WalletProtocol>();
  for (const protocol of protocols) {
    const key = `${protocol.chain}|${protocol.protocolId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...protocol, positions: [...protocol.positions], sources: [...protocol.sources] });
      continue;
    }
    existing.positions.push(...protocol.positions);
    existing.sources = [...new Set([...existing.sources, ...protocol.sources])];
    existing.assetUsd = sumNullable([existing.assetUsd, protocol.assetUsd]);
    existing.debtUsd = sumNullable([existing.debtUsd, protocol.debtUsd]);
    existing.netUsd = sumNullable([existing.netUsd, protocol.netUsd]);
    existing.healthRate = minNullable([existing.healthRate, protocol.healthRate]);
    existing.confidence = existing.confidence === "high" || protocol.confidence === "high" ? "high" : existing.confidence;
  }
  return [...byKey.values()].sort((a, b) => Math.abs(b.netUsd ?? 0) - Math.abs(a.netUsd ?? 0));
}

function isWalletNode(node: { type?: string; data?: { kind?: string } } | undefined): boolean {
  const kind = node?.data?.kind;
  return node?.type === "eoa" || kind === "eoa" || kind === "safe";
}

function addTokenDelta(map: Map<string, TokenAmount>, symbol: string, delta: number, source: string) {
  const key = symbol || "TOKEN";
  const cur = map.get(key) ?? tokenAmount(null, key, 0, null, null, source);
  cur.amount = (cur.amount ?? 0) + delta;
  map.set(key, cur);
}

async function fetchFlowHints(req: Request, wallet: string): Promise<FlowHint> {
  const url = new URL(req.url);
  const flowUrl = new URL("/api/eoa-flow", url.origin);
  flowUrl.searchParams.set("address", wallet);
  flowUrl.searchParams.set("depth", "1");
  try {
    const res = await fetch(flowUrl.toString(), { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      return { available: false, eventCount: 0, linkedProtocols: [], protocolFlows: [], error: `/api/eoa-flow HTTP ${res.status}` };
    }
    const payload = (await res.json()) as EoaFlowPayload;
    const addr = wallet.toLowerCase();
    const nodesById = new Map((payload.nodes ?? []).filter((n) => n.type !== "event" && n.data?.kind !== "event").map((n) => [n.id, n]));
    const rows = new Map<string, { protocol: string; canonical: string; eventCount: number; actions: Set<string>; tokens: Map<string, TokenAmount>; lastEventUtc: string | null }>();
    let eventCount = 0;
    let lastEventUtc: string | null = null;
    for (const edge of payload.edges ?? []) {
      if (edge.edge_type !== "protocol_flow") continue;
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      const protocol = source && isWalletNode(source) ? target : source;
      if (!protocol || isWalletNode(protocol)) continue;
      for (const detail of edge.details ?? []) {
        if ((detail.address ?? "").toLowerCase() !== addr) continue;
        eventCount += 1;
        if (detail.datetime_utc && (!lastEventUtc || detail.datetime_utc > lastEventUtc)) lastEventUtc = detail.datetime_utc;
        const label = protocol.label || protocol.id;
        const row = rows.get(protocol.id) ?? {
          protocol: label,
          canonical: canonicalProtocolName(label, protocol.id),
          eventCount: 0,
          actions: new Set<string>(),
          tokens: new Map<string, TokenAmount>(),
          lastEventUtc: null,
        };
        row.eventCount += 1;
        if (detail.action) row.actions.add(detail.action);
        for (const transfer of detail.transfers ?? []) {
          if (transfer.direction === "internal") continue;
          const amount = toFiniteNumber(transfer.amount) ?? 0;
          const sign = transfer.direction === "out" ? -1 : 1;
          addTokenDelta(row.tokens, transfer.symbol, sign * amount, "eoa-flow");
        }
        rows.set(protocol.id, row);
      }
    }
    const protocolFlows = [...rows.values()]
      .map((row) => ({
        protocol: row.protocol,
        canonical: row.canonical,
        eventCount: row.eventCount,
        actions: [...row.actions].sort(),
        tokenDeltas: [...row.tokens.values()].filter(nonzeroAmount),
      }))
      .sort((a, b) => b.eventCount - a.eventCount)
      .slice(0, 30);
    return {
      available: protocolFlows.length > 0,
      source: payload.metadata?.source,
      eventCount,
      linkedProtocols: protocolFlows.map((p) => p.protocol),
      lastEventUtc,
      protocolFlows,
    };
  } catch (error) {
    return {
      available: false,
      eventCount: 0,
      linkedProtocols: [],
      protocolFlows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address")?.trim() ?? null;
  if (!validAddress(address)) {
    return NextResponse.json({ error: "Invalid address. Expected 0x-prefixed 40-hex address." }, { status: 400 });
  }
  const chainParam = (url.searchParams.get("chain") ?? "ethereum").toLowerCase();
  if (!["ethereum", "eth", "mainnet"].includes(chainParam)) {
    return NextResponse.json({ error: "Only Ethereum mainnet is supported by this endpoint for now." }, { status: 400 });
  }

  const maxTokens = Math.min(500, Math.max(1, Number(url.searchParams.get("maxTokens") ?? 160)));
  const minUsd = Math.max(0, Number(url.searchParams.get("minUsd") ?? 1));
  const includeUnpriced = url.searchParams.get("includeUnpriced") !== "false";
  const includeFlow = url.searchParams.get("includeFlow") !== "false";
  const includeOutflows = url.searchParams.get("includeOutflows") !== "false";
  const outflowOffset = safeLimit(url.searchParams.get("outflowOffset"), 500, 2000);
  const force = ["1", "true", "yes"].includes((url.searchParams.get("force") ?? "").toLowerCase());
  const cacheKey = requestCacheKey(url, address);
  if (!force) {
    const cached = await fileCacheGet<WalletPortfolioResponse>(cacheKey);
    if (cached) return NextResponse.json(cached);
  }

  const [walletTokenRes, morphoRes, flowRes, outflowRes] = await Promise.all([
    timed("wallet-tokens:alchemy+rpc+llama", () => fetchWalletTokens(address, maxTokens, minUsd, includeUnpriced)),
    timed("protocol:morpho-blue", () => fetchMorphoProtocol(address, minUsd)),
    includeFlow
      ? timed("flow-hints:eoa-flow", () => fetchFlowHints(req, address))
      : Promise.resolve({
          value: { available: false, eventCount: 0, linkedProtocols: [], protocolFlows: [] } satisfies FlowHint,
          status: { source: "flow-hints:eoa-flow", ok: true, elapsedMs: 0, detail: "disabled" } satisfies SourceStatus,
        }),
    includeOutflows
      ? timed("external-outflows:alchemy+etherscan-fallback+known-counterparties", () => fetchExternalOutflows(address, outflowOffset))
      : Promise.resolve({
          value: null,
          status: { source: "external-outflows:alchemy+etherscan-fallback+known-counterparties", ok: true, elapsedMs: 0, detail: "disabled" } satisfies SourceStatus,
        }),
  ]);

  const walletTokens = walletTokenRes.value ?? [];
  const aaveLikeRes = await timed("protocol:aave-spark-token-balances", () => fetchAaveLikeProtocols(walletTokens, minUsd));
  const erc4626Res = await timed("protocol:erc4626-vaults", () => fetchErc4626Protocols(walletTokens, minUsd));
  const protocols = mergeProtocols([
    ...(morphoRes.value ? [morphoRes.value] : []),
    ...(aaveLikeRes.value ?? []),
    ...(erc4626Res.value ?? []),
    ...receiptProtocols(walletTokens),
  ]);
  const mappedByAddress = new Map<string, { protocolId: string; type: PositionType }>();
  for (const protocol of protocols) {
    for (const position of protocol.positions) {
      const isWalletTokenBackedPosition = position.type === "receipt_token" || position.type === "erc4626_vault" || position.source.startsWith("aave-token:");
      if (isWalletTokenBackedPosition && position.marketId && ADDRESS_RE.test(position.marketId)) {
        mappedByAddress.set(position.marketId.toLowerCase(), { protocolId: protocol.protocolId, type: position.type });
      }
    }
  }
  for (const token of walletTokens) {
    const mapped = token.tokenAddress ? mappedByAddress.get(token.tokenAddress.toLowerCase()) : null;
    if (mapped) {
      token.mappedProtocolId = mapped.protocolId;
      token.mappedPositionType = mapped.type;
    }
  }
  const walletTokenUsd = sumNullable(walletTokens.filter((t) => !t.mappedProtocolId).map((t) => t.valueUsd));
  const protocolNetUsd = sumNullable(protocols.map((p) => p.netUsd));
  const dataGaps: string[] = [];
  if (!ALCHEMY_URL && !ETHERSCAN_KEY) dataGaps.push("wallet_token_full_scan_requires_alchemy_or_etherscan");
  if (includeOutflows && !ALCHEMY_URL && !ETHERSCAN_KEY) dataGaps.push("external_outflow_scan_requires_alchemy_or_etherscan_key");
  if (includeOutflows) {
    for (const gap of outflowRes.value?.dataGaps ?? []) dataGaps.push(gap);
  }
  if (!morphoRes.value) dataGaps.push("no_morpho_position_or_adapter_empty");
  dataGaps.push("aave_collateral_flags_and_health_factor_pending");
  dataGaps.push("compound_direct_user_adapter_pending");
  dataGaps.push("redeemability_is_adapter_estimate_not_protocol_simulation");

  const response: WalletPortfolioResponse = {
    address: address.toLowerCase(),
    chain: CHAIN.key,
    debankChain: CHAIN.debank,
    fetchedAt: new Date().toISOString(),
    totalUsd: walletTokenUsd != null || protocolNetUsd != null ? (walletTokenUsd ?? 0) + (protocolNetUsd ?? 0) : null,
    walletTokenUsd,
    protocolNetUsd,
    walletTokens,
    protocols,
    externalOutflows: outflowRes.value,
    flowHints: flowRes.value ?? {
      available: false,
      eventCount: 0,
      linkedProtocols: [],
      protocolFlows: [],
      error: "error" in flowRes.status ? flowRes.status.error : "flow hints unavailable",
    },
    sources: [walletTokenRes.status, morphoRes.status, aaveLikeRes.status, erc4626Res.status, flowRes.status, outflowRes.status],
    dataGaps,
  };

  await fileCachePut(cacheKey, response);
  return NextResponse.json(response);
}
