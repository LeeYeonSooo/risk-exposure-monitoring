import { NextResponse } from "next/server";
import { formatUnits } from "viem";
import { isKnownInfrastructureCategory, lookupKnownCounterparty, type KnownCounterpartyCategory } from "@/lib/known-counterparties";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MORPHO_GQL = "https://blue-api.morpho.org/graphql";
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY ?? "";
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const RPC_URL = process.env.ETH_RPC
  ?? process.env.ALCHEMY_URL
  ?? process.env.RPC_URL
  ?? (ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "https://eth.llamarpc.com");
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MARKET_RE = /^0x[a-fA-F0-9]{64}$/;
const CHAIN = { key: "ethereum", chainId: 1 };
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type SourceStatus = {
  source: string;
  ok: boolean;
  elapsedMs: number;
  detail?: unknown;
  error?: string;
};

type TokenAmount = {
  tokenAddress?: string | null;
  symbol: string;
  amount: number | null;
  priceUsd?: number | null;
  valueUsd: number | null;
  rawAmount?: string | null;
  source?: string;
};

type WalletToken = TokenAmount & {
  chain?: string;
  mappedProtocolId?: string | null;
};

type WalletPosition = {
  supplied?: TokenAmount[];
  collateral?: TokenAmount[];
  borrowed?: TokenAmount[];
  redeemability?: {
    status?: string;
    redeemableNow?: TokenAmount[];
  };
  assetUsd?: number | null;
  debtUsd?: number | null;
  netUsd?: number | null;
};

type WalletProtocol = {
  protocolId?: string;
  protocolName?: string;
  netUsd?: number | null;
  assetUsd?: number | null;
  debtUsd?: number | null;
  positions?: WalletPosition[];
};

type WalletPortfolio = {
  address: string;
  totalUsd?: number | null;
  walletTokenUsd?: number | null;
  protocolNetUsd?: number | null;
  walletTokens?: WalletToken[];
  protocols?: WalletProtocol[];
  dataGaps?: string[];
  sources?: SourceStatus[];
};

type MorphoAsset = {
  address?: string | null;
  symbol?: string | null;
  decimals?: number | null;
};

type MorphoPosition = {
  user?: { address?: string | null };
  market?: {
    marketId?: string | null;
    lltv?: string | number | null;
    loanAsset?: MorphoAsset | null;
    collateralAsset?: MorphoAsset | null;
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

type MarketRef = {
  marketKey: string;
  hint?: {
    loan?: string | null;
    collateral?: string | null;
    lltv?: number | null;
    supplyUsd?: number | null;
    borrowAssetsUsd?: number | null;
    collateralAssetsUsd?: number | null;
    utilization?: number | null;
  };
};

type EtherscanTokenTransfer = {
  timeStamp?: string;
  hash?: string;
  from?: string;
  to?: string;
  value?: string;
  contractAddress?: string;
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

type OutflowCategory = KnownCounterpartyCategory | "eoa" | "contract" | "unclassified";
type OutflowConfidence = "curated_static" | "eth_getCode" | "unknown";
type CounterpartyTag = { category: OutflowCategory; label: string; confidence: OutflowConfidence; clusterEligible: boolean; protocolLike: boolean };

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

type OutflowSummary = {
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

const SUGGESTED_RISK_RULES = [
  {
    id: "liquidation_distance",
    input: "riskInputs.liquidation.debtToLiquidationThreshold",
    high: ">= 0.92",
    medium: ">= 0.80",
    note: "Compares current debt with collateral value times LLTV. This is a liquidation proximity input, not a final score.",
  },
  {
    id: "liquid_liquidity_shortfall",
    input: "riskInputs.liquidity.availableLiquidToDebt",
    high: "< 0.10",
    medium: "< 0.35",
    note: "Uses wallet high-quality liquid assets plus protocol legs marked redeemable now by adapters.",
  },
  {
    id: "externalized_liquidity",
    input: "riskInputs.externalization.knownInfraOutflowToDebt30d + walletOutflowToDebt30d",
    high: ">= 0.50",
    medium: ">= 0.20",
    note: "Known CEX/bridge/router/solver/protocol outflow plus transfers to other EOAs/contracts show liquidity moved away from the borrower address; this is an input, not proof of insolvency.",
  },
  {
    id: "market_exit_crowding",
    input: "riskInputs.market.utilization",
    high: ">= 0.95",
    medium: ">= 0.90",
    note: "High utilization matters for lender exit liquidity and borrow refinancing pressure.",
  },
  {
    id: "unclassified_outflow_review",
    input: "externalOutflows.unclassifiedLarge",
    high: "manual_review",
    medium: "manual_review",
    note: "Large unclassified transfers can be Safe-to-Safe, OTC, CEX, bridge, or protocol routers; do not auto-score without labels.",
  },
] as const;

function validAddress(address: string | null): address is string {
  return !!address && ADDRESS_RE.test(address);
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sum(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

function amountFromRaw(raw: string | number | bigint | null | undefined, decimals: number | null | undefined): number | null {
  if (raw == null) return null;
  try {
    const value = typeof raw === "bigint" ? raw : BigInt(String(raw));
    return Number(formatUnits(value, decimals ?? 18));
  } catch {
    return finite(raw);
  }
}

function lltvFromRaw(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 1e18 : n;
}

function pctRatio(num: number | null | undefined, den: number | null | undefined): number | null {
  if (typeof num !== "number" || typeof den !== "number" || !Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return num / den;
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out.filter((x): x is R => x != null);
}

async function morphoGql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(MORPHO_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Morpho HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message ?? "GraphQL error").join("; "));
  if (!json.data) throw new Error("Morpho returned empty data");
  return json.data;
}

function splitMarkets(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((x) => x.trim()).filter((x) => MARKET_RE.test(x));
}

function safeLimit(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function resolveMarketRefs(url: URL, marketLimit: number): Promise<{ refs: MarketRef[]; dataGaps: string[] }> {
  const direct = [
    ...splitMarkets(url.searchParams.get("market")),
    ...splitMarkets(url.searchParams.get("marketKey")),
    ...splitMarkets(url.searchParams.get("markets")),
  ];
  if (direct.length) {
    return { refs: [...new Set(direct)].slice(0, marketLimit).map((marketKey) => ({ marketKey })), dataGaps: [] };
  }

  const symbol = url.searchParams.get("symbol")?.trim();
  if (!symbol) return { refs: [], dataGaps: [] };

  const breadthUrl = new URL(`/api/breadth/${encodeURIComponent(symbol)}`, url.origin);
  const res = await fetch(breadthUrl, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`/api/breadth/${symbol} HTTP ${res.status}`);
  const data = (await res.json()) as {
    morphoMarkets?: Record<string, Array<{
      marketKey?: string;
      loan?: string | null;
      collateral?: string | null;
      lltv?: number | null;
      supplyUsd?: number | null;
      borrowAssetsUsd?: number | null;
      collateralAssetsUsd?: number | null;
      utilization?: number | null;
    }>>;
  };
  const refs = (data.morphoMarkets?.ethereum ?? [])
    .filter((m) => typeof m.marketKey === "string" && MARKET_RE.test(m.marketKey))
    .slice(0, marketLimit)
    .map((m) => ({
      marketKey: m.marketKey!,
      hint: {
        loan: m.loan ?? null,
        collateral: m.collateral ?? null,
        lltv: m.lltv ?? null,
        supplyUsd: m.supplyUsd ?? null,
        borrowAssetsUsd: m.borrowAssetsUsd ?? null,
        collateralAssetsUsd: m.collateralAssetsUsd ?? null,
        utilization: m.utilization ?? null,
      },
    }));
  return {
    refs,
    dataGaps: refs.length ? [] : [`no_morpho_markets_found_for_symbol:${symbol}`],
  };
}

async function fetchMarketBorrowers(marketKey: string, borrowerLimit: number) {
  const query = `query Borrowers($chainId:Int!, $market:String!, $limit:Int!) {
    marketPositions(first:$limit, where:{chainId_in:[$chainId], marketUniqueKey_in:[$market]}, orderBy:BorrowShares, orderDirection:Desc) {
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
  const data = await morphoGql<{ marketPositions?: { items?: MorphoPosition[] } }>(query, {
    chainId: CHAIN.chainId,
    market: marketKey,
    limit: borrowerLimit,
  });
  return data.marketPositions?.items ?? [];
}

async function fetchPortfolio(origin: string, address: string, minUsd: number): Promise<WalletPortfolio> {
  const api = new URL("/api/wallet-portfolio", origin);
  api.searchParams.set("address", address);
  api.searchParams.set("chain", "ethereum");
  api.searchParams.set("includeFlow", "false");
  api.searchParams.set("minUsd", String(minUsd));
  api.searchParams.set("maxTokens", "220");
  const res = await fetch(api, { cache: "no-store", signal: AbortSignal.timeout(35_000) });
  if (!res.ok) throw new Error(`/api/wallet-portfolio HTTP ${res.status}`);
  return (await res.json()) as WalletPortfolio;
}

async function fetchPrices(tokenAddresses: string[]): Promise<Map<string, number>> {
  const ids = [...new Set([
    "coingecko:ethereum",
    ...tokenAddresses.filter(Boolean).map((a) => `ethereum:${a.toLowerCase()}`),
  ])];
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
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
      /* prices are optional */
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
      return typeof json.result === "string" ? json.result : null;
    } catch {
      return null;
    }
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

async function fetchExternalOutflows(address: string, offset: number) {
  const [tokenRows, nativeRows] = await Promise.all([
    etherscanAccount<EtherscanTokenTransfer>(address, "tokentx", offset),
    etherscanAccount<EtherscanTx>(address, "txlist", Math.min(1000, offset)),
  ]);
  const lower = address.toLowerCase();
  const tokenAddresses = [...new Set(tokenRows.map((row) => row.contractAddress?.toLowerCase()).filter((x): x is string => !!x && ADDRESS_RE.test(x)))];
  const prices = await fetchPrices(tokenAddresses);
  const rawRows: RawOutflowRow[] = [];

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

  return summarizeOutflows(rows);
}

function summarizeOutflows(rows: OutflowRow[]) {
  const now = Date.now() / 1000;
  const recent30d = rows.filter((row) => row.timestamp >= now - 30 * 86400);
  const recent7d = rows.filter((row) => row.timestamp >= now - 7 * 86400);
  const cexBridge = (set: OutflowRow[]) => set.filter((row) => row.category === "cex" || row.category === "bridge");
  const knownInfra = (set: OutflowRow[]) => set.filter((row) => isKnownInfrastructureCategory(row.category));
  const wallet = (set: OutflowRow[]) => set.filter((row) => row.clusterEligible);
  const valueSum = (set: OutflowRow[]) => sum(set.map((row) => row.valueUsd)) ?? 0;
  const cex = summarizeGroups(rows.filter((row) => row.category === "cex")).slice(0, 8);
  const bridge = summarizeGroups(rows.filter((row) => row.category === "bridge")).slice(0, 8);
  const router = summarizeGroups(rows.filter((row) => row.category === "router")).slice(0, 8);
  const solver = summarizeGroups(rows.filter((row) => row.category === "solver")).slice(0, 8);
  const protocol = summarizeGroups(rows.filter((row) => row.category === "protocol")).slice(0, 10);
  const eoa = summarizeGroups(rows.filter((row) => row.category === "eoa")).slice(0, 10);
  const contract = summarizeGroups(rows.filter((row) => row.category === "contract")).slice(0, 10);
  const unclassifiedLarge = summarizeGroups(rows.filter((row) => row.category === "unclassified" && (row.valueUsd ?? 0) >= 25_000)).slice(0, 12);

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
    cex,
    bridge,
    router,
    solver,
    protocol,
    eoa,
    contract,
    unclassifiedLarge,
    dataGaps: [
      "known_counterparty_registry_is_static_and_incomplete",
      "contract_or_safe_classification_uses_eth_getCode_not_owner_semantics",
      "internal_contract_call_semantics_not_decoded_here",
    ],
  };
}

function summarizeGroups(rows: OutflowRow[]): OutflowSummary[] {
  const byKey = new Map<string, OutflowSummary>();
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

function tokenBucket(symbol: string | null | undefined): "stable" | "eth_like" | "btc_like" | "other" {
  const s = (symbol ?? "").toUpperCase();
  if (["USDC", "USDT", "DAI", "USDS", "PYUSD", "RLUSD", "GHO", "USDE", "SUSDE", "USD0", "USDG", "CRVUSD"].includes(s)) return "stable";
  if (["ETH", "WETH", "STETH", "WSTETH", "WEETH", "EZETH", "RSETH", "RETH", "CBETH"].includes(s)) return "eth_like";
  if (["WBTC", "CBBTC", "TBTC", "LBTC", "EBTC"].includes(s)) return "btc_like";
  return "other";
}

function portfolioLiquidity(portfolio: WalletPortfolio | null) {
  const walletTokens = portfolio?.walletTokens ?? [];
  const unmapped = walletTokens.filter((token) => !token.mappedProtocolId && (token.valueUsd ?? 0) > 0);
  let stableUsd = 0;
  let ethLikeUsd = 0;
  let btcLikeUsd = 0;
  let otherPricedUsd = 0;
  for (const token of unmapped) {
    const value = token.valueUsd ?? 0;
    const bucket = tokenBucket(token.symbol);
    if (bucket === "stable") stableUsd += value;
    else if (bucket === "eth_like") ethLikeUsd += value;
    else if (bucket === "btc_like") btcLikeUsd += value;
    else otherPricedUsd += value;
  }
  const redeemableProtocolUsd = sum((portfolio?.protocols ?? []).flatMap((protocol) =>
    (protocol.positions ?? []).flatMap((position) =>
      position.redeemability?.status === "likely"
        ? (position.redeemability.redeemableNow ?? []).map((token) => token.valueUsd)
        : [],
    ),
  )) ?? 0;
  return {
    walletLiquidUsd: stableUsd + ethLikeUsd + btcLikeUsd,
    highQualityLiquidUsd: stableUsd + ethLikeUsd * 0.9 + btcLikeUsd * 0.9,
    redeemableProtocolUsd,
    availableLiquidUsd: stableUsd + ethLikeUsd * 0.9 + btcLikeUsd * 0.9 + redeemableProtocolUsd,
    buckets: { stableUsd, ethLikeUsd, btcLikeUsd, otherPricedUsd },
    topWalletTokens: unmapped.slice(0, 8),
  };
}

function buildBorrowerAnalysis(
  item: MorphoPosition,
  portfolio: WalletPortfolio | null,
  outflows: ReturnType<typeof summarizeOutflows> | null,
) {
  const market = item.market;
  const state = item.state;
  const loan = market?.loanAsset ?? null;
  const collateralAsset = market?.collateralAsset ?? null;
  const borrowUsd = state?.borrowAssetsUsd ?? 0;
  const collateralUsd = state?.collateralUsd ?? 0;
  const supplyUsd = state?.supplyAssetsUsd ?? 0;
  const lltv = lltvFromRaw(market?.lltv ?? null);
  const ltv = collateralUsd > 0 && borrowUsd > 0 ? borrowUsd / collateralUsd : null;
  const liquidationThresholdUsd = collateralUsd > 0 && lltv != null ? collateralUsd * lltv : null;
  const debtToLiquidationThreshold = pctRatio(borrowUsd, liquidationThresholdUsd);
  const liquidationBufferUsd = liquidationThresholdUsd != null ? liquidationThresholdUsd - borrowUsd : null;
  const liquidity = portfolioLiquidity(portfolio);
  const knownInfraUsd30d = outflows?.totals.knownInfraUsd30d ?? 0;
  const knownCexBridgeUsd30d = outflows?.totals.knownCexBridgeUsd30d ?? 0;
  const routerOutflowUsd30d = outflows?.totals.routerUsd30d ?? 0;
  const solverOutflowUsd30d = outflows?.totals.solverUsd30d ?? 0;
  const protocolOutflowUsd30d = outflows?.totals.protocolUsd30d ?? 0;
  const walletOutflowUsd30d = outflows?.totals.walletUsd30d ?? 0;
  const eoaOutflowUsd30d = outflows?.totals.eoaUsd30d ?? 0;
  const contractOutflowUsd30d = outflows?.totals.contractUsd30d ?? 0;
  const largeUnclassifiedUsd30d = outflows?.totals.largeUnclassifiedUsd30d ?? 0;
  const borrowerShareOfMarketDebt = pctRatio(borrowUsd, market?.state?.borrowAssetsUsd ?? null);

  return {
    address: item.user?.address?.toLowerCase() ?? null,
    marketPosition: {
      loanAsset: loan,
      collateralAsset,
      borrowAmount: amountFromRaw(state?.borrowAssets, loan?.decimals ?? 18),
      borrowUsd,
      collateralAmount: amountFromRaw(state?.collateral, collateralAsset?.decimals ?? 18),
      collateralUsd,
      supplyAmount: amountFromRaw(state?.supplyAssets, loan?.decimals ?? 18),
      supplyUsd,
      shareOfMarketBorrow: borrowerShareOfMarketDebt,
    },
    portfolioSnapshot: portfolio ? {
      totalUsd: portfolio.totalUsd ?? null,
      walletTokenUsd: portfolio.walletTokenUsd ?? null,
      protocolNetUsd: portfolio.protocolNetUsd ?? null,
      protocolCount: portfolio.protocols?.length ?? 0,
      liquidAssets: liquidity,
      topProtocols: (portfolio.protocols ?? [])
        .slice()
        .sort((a, b) => (b.assetUsd ?? b.netUsd ?? 0) - (a.assetUsd ?? a.netUsd ?? 0))
        .slice(0, 8)
        .map((protocol) => ({
          protocolId: protocol.protocolId ?? null,
          protocolName: protocol.protocolName ?? null,
          assetUsd: protocol.assetUsd ?? null,
          debtUsd: protocol.debtUsd ?? null,
          netUsd: protocol.netUsd ?? null,
        })),
      dataGaps: portfolio.dataGaps ?? [],
    } : null,
    externalOutflows: outflows,
    riskInputs: {
      liquidation: {
        ltv,
        lltv,
        liquidationThresholdUsd,
        liquidationBufferUsd,
        liquidationBufferPct: debtToLiquidationThreshold == null ? null : 1 - debtToLiquidationThreshold,
        debtToLiquidationThreshold,
        healthFactor: debtToLiquidationThreshold && debtToLiquidationThreshold > 0 ? 1 / debtToLiquidationThreshold : null,
      },
      liquidity: {
        debtUsd: borrowUsd,
        walletLiquidUsd: liquidity.walletLiquidUsd,
        highQualityLiquidUsd: liquidity.highQualityLiquidUsd,
        redeemableProtocolUsd: liquidity.redeemableProtocolUsd,
        availableLiquidUsd: liquidity.availableLiquidUsd,
        walletLiquidToDebt: pctRatio(liquidity.walletLiquidUsd, borrowUsd),
        highQualityLiquidToDebt: pctRatio(liquidity.highQualityLiquidUsd, borrowUsd),
        availableLiquidToDebt: pctRatio(liquidity.availableLiquidUsd, borrowUsd),
        totalNetWorthToDebt: pctRatio(portfolio?.totalUsd ?? null, borrowUsd),
      },
      externalization: {
        knownInfraOutflowUsd30d: knownInfraUsd30d,
        knownCexBridgeOutflowUsd30d: knownCexBridgeUsd30d,
        routerOutflowUsd30d,
        solverOutflowUsd30d,
        protocolOutflowUsd30d,
        walletOutflowUsd30d,
        eoaOutflowUsd30d,
        contractOutflowUsd30d,
        largeUnclassifiedOutflowUsd30d: largeUnclassifiedUsd30d,
        knownInfraOutflowToDebt30d: pctRatio(knownInfraUsd30d, borrowUsd),
        knownCexBridgeOutflowToDebt30d: pctRatio(knownCexBridgeUsd30d, borrowUsd),
        routerOutflowToDebt30d: pctRatio(routerOutflowUsd30d, borrowUsd),
        solverOutflowToDebt30d: pctRatio(solverOutflowUsd30d, borrowUsd),
        protocolOutflowToDebt30d: pctRatio(protocolOutflowUsd30d, borrowUsd),
        walletOutflowToDebt30d: pctRatio(walletOutflowUsd30d, borrowUsd),
        eoaOutflowToDebt30d: pctRatio(eoaOutflowUsd30d, borrowUsd),
        contractOutflowToDebt30d: pctRatio(contractOutflowUsd30d, borrowUsd),
        largeUnclassifiedOutflowToDebt30d: pctRatio(largeUnclassifiedUsd30d, borrowUsd),
      },
      market: {
        utilization: market?.state?.utilization ?? null,
        borrowerShareOfMarketDebt,
        marketSupplyUsd: market?.state?.supplyAssetsUsd ?? null,
        marketBorrowUsd: market?.state?.borrowAssetsUsd ?? null,
        marketCollateralUsd: market?.state?.collateralAssetsUsd ?? null,
      },
    },
    riskScore: null,
    riskBand: "not_scored",
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const borrowerLimit = safeLimit(url.searchParams.get("limit"), 5, 10);
  const marketLimit = safeLimit(url.searchParams.get("marketLimit"), 3, 8);
  const minUsd = Math.max(0, Number(url.searchParams.get("minUsd") ?? 1));
  const outflowOffset = safeLimit(url.searchParams.get("outflowOffset"), 500, 2000);
  const includePortfolio = url.searchParams.get("includePortfolio") !== "false";
  const includeOutflows = url.searchParams.get("includeOutflows") !== "false";
  const dataGaps: string[] = [];

  const borrower = url.searchParams.get("borrower")?.trim() ?? null;
  if (borrower && !validAddress(borrower)) {
    return NextResponse.json({ error: "Invalid borrower address." }, { status: 400 });
  }

  let marketRefs: MarketRef[] = [];
  try {
    const resolved = await resolveMarketRefs(url, marketLimit);
    marketRefs = resolved.refs;
    dataGaps.push(...resolved.dataGaps);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }

  if (!marketRefs.length && borrower) {
    const [portfolioRes, outflowsRes] = await Promise.all([
      includePortfolio ? timed("wallet-portfolio", () => fetchPortfolio(url.origin, borrower, minUsd)) : Promise.resolve({ value: null, status: { source: "wallet-portfolio", ok: true, elapsedMs: 0, detail: "disabled" } satisfies SourceStatus }),
      includeOutflows ? timed("etherscan:external-outflows", () => fetchExternalOutflows(borrower, outflowOffset)) : Promise.resolve({ value: null, status: { source: "etherscan:external-outflows", ok: true, elapsedMs: 0, detail: "disabled" } satisfies SourceStatus }),
    ]);
    if (!ETHERSCAN_KEY) dataGaps.push("external_outflow_scan_requires_etherscan_key");
    return NextResponse.json({
      chain: CHAIN.key,
      fetchedAt: new Date().toISOString(),
      mode: "borrower_snapshot",
      borrower: borrower.toLowerCase(),
      pseudoDebank: portfolioRes.value,
      externalOutflows: outflowsRes.value,
      suggestedRiskRules: SUGGESTED_RISK_RULES,
      riskScore: null,
      riskBand: "not_scored",
      sources: [portfolioRes.status, outflowsRes.status],
      dataGaps,
    });
  }

  if (!marketRefs.length) {
    return NextResponse.json({ error: "Provide market=<morpho market key> or symbol=<token> or borrower=<address>." }, { status: 400 });
  }

  const marketResults = await mapLimit(marketRefs, 2, async (ref) => {
    const borrowerRows = await fetchMarketBorrowers(ref.marketKey, borrowerLimit);
    const first = borrowerRows[0];
    const market = first?.market ?? null;
    const borrowers = borrowerRows
      .filter((item) => validAddress(item.user?.address ?? null) && (item.state?.borrowAssetsUsd ?? 0) > 0)
      .filter((item) => !borrower || item.user?.address?.toLowerCase() === borrower.toLowerCase());

    const analyzedBorrowers = await mapLimit(borrowers, 2, async (item) => {
      const address = item.user!.address!.toLowerCase();
      const [portfolioRes, outflowsRes] = await Promise.all([
        includePortfolio ? timed(`wallet-portfolio:${address}`, () => fetchPortfolio(url.origin, address, minUsd)) : Promise.resolve({ value: null, status: { source: `wallet-portfolio:${address}`, ok: true, elapsedMs: 0, detail: "disabled" } satisfies SourceStatus }),
        includeOutflows ? timed(`etherscan:external-outflows:${address}`, () => fetchExternalOutflows(address, outflowOffset)) : Promise.resolve({ value: null, status: { source: `etherscan:external-outflows:${address}`, ok: true, elapsedMs: 0, detail: "disabled" } satisfies SourceStatus }),
      ]);
      const analysis = buildBorrowerAnalysis(item, portfolioRes.value, outflowsRes.value);
      return {
        ...analysis,
        sources: [portfolioRes.status, outflowsRes.status],
      };
    });

    const loan = market?.loanAsset ?? null;
    const collateral = market?.collateralAsset ?? null;
    return {
      marketKey: ref.marketKey,
      marketLabel: `${collateral?.symbol ?? ref.hint?.collateral ?? "?"}/${loan?.symbol ?? ref.hint?.loan ?? "?"}`,
      loanAsset: loan ?? (ref.hint?.loan ? { symbol: ref.hint.loan } : null),
      collateralAsset: collateral ?? (ref.hint?.collateral ? { symbol: ref.hint.collateral } : null),
      lltv: lltvFromRaw(market?.lltv ?? null) ?? ref.hint?.lltv ?? null,
      utilization: market?.state?.utilization ?? ref.hint?.utilization ?? null,
      marketSupplyUsd: market?.state?.supplyAssetsUsd ?? ref.hint?.supplyUsd ?? null,
      marketBorrowUsd: market?.state?.borrowAssetsUsd ?? ref.hint?.borrowAssetsUsd ?? null,
      marketCollateralUsd: market?.state?.collateralAssetsUsd ?? ref.hint?.collateralAssetsUsd ?? null,
      borrowers: analyzedBorrowers,
      borrowerCountReturned: analyzedBorrowers.length,
    };
  });

  if (!ETHERSCAN_KEY) dataGaps.push("external_outflow_scan_requires_etherscan_key");
  dataGaps.push("cex_bridge_registry_is_static_and_incomplete");
  dataGaps.push("risk_score_intentionally_not_computed_yet");

  return NextResponse.json({
    chain: CHAIN.key,
    chainId: CHAIN.chainId,
    fetchedAt: new Date().toISOString(),
    query: {
      symbol: url.searchParams.get("symbol") ?? null,
      borrower: borrower?.toLowerCase() ?? null,
      borrowerLimit,
      marketLimit,
      includePortfolio,
      includeOutflows,
    },
    markets: marketResults,
    suggestedRiskRules: SUGGESTED_RISK_RULES,
    riskScore: null,
    riskBand: "not_scored",
    dataGaps,
  });
}
