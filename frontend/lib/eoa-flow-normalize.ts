import type { EoaFlowDetail, EoaFlowPayload, EoaFlowTransfer } from "@/lib/eoa-flow-types";
import { TOKEN_BY_ADDR } from "@/lib/flowmap";

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const RPC_URL = process.env.ETH_RPC
  ?? process.env.ALCHEMY_URL
  ?? process.env.RPC_URL
  ?? (ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "https://eth.llamarpc.com");

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type RpcLog = {
  address?: string;
  topics?: string[];
  data?: string;
};

type RpcReceipt = {
  logs?: RpcLog[];
};

type ReceiptTransfer = {
  token: string;
  from: string;
  to: string;
  raw: bigint;
};

type TokenMeta = {
  symbol: string;
  decimals: number;
};

const receiptCache = new Map<string, Promise<ReceiptTransfer[]>>();
const decimalsCache = new Map<string, Promise<number>>();

function transferNeedsAmount(transfer: EoaFlowTransfer): boolean {
  const amount = Number(transfer.amount);
  return !Number.isFinite(amount) || amount <= 0;
}

function canonicalMeta(token: string | null | undefined, fallbackSymbol: string | null | undefined): TokenMeta {
  const key = token?.toLowerCase() ?? "";
  const known = TOKEN_BY_ADDR[key];
  return {
    symbol: known?.sym ?? fallbackSymbol ?? "TOKEN",
    decimals: known?.decimals ?? 18,
  };
}

function topicAddress(topic: string | undefined): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function parseRaw(data: string | undefined): bigint | null {
  if (!data || !/^0x[0-9a-fA-F]+$/.test(data)) return null;
  try {
    return BigInt(data);
  } catch {
    return null;
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { result?: T; error?: unknown };
    return json.result ?? null;
  } catch {
    return null;
  }
}

async function receiptTransfers(txHash: string): Promise<ReceiptTransfer[]> {
  const key = txHash.toLowerCase();
  const cached = receiptCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    const receipt = await rpc<RpcReceipt>("eth_getTransactionReceipt", [txHash]);
    const out: ReceiptTransfer[] = [];
    for (const log of receipt?.logs ?? []) {
      const topics = log.topics ?? [];
      if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
      const from = topicAddress(topics[1]);
      const to = topicAddress(topics[2]);
      const raw = parseRaw(log.data);
      const token = log.address?.toLowerCase();
      if (!from || !to || raw == null || !token || !ADDRESS_RE.test(token)) continue;
      if (raw <= 0n) continue;
      out.push({ token, from, to, raw });
    }
    return out;
  })();
  receiptCache.set(key, task);
  return task;
}

async function tokenDecimals(token: string, fallback: number): Promise<number> {
  const key = token.toLowerCase();
  const known = TOKEN_BY_ADDR[key]?.decimals;
  if (known != null) return known;
  const cached = decimalsCache.get(key);
  if (cached) return cached;
  const task = (async () => {
    const data = await rpc<string>("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
    if (!data || !/^0x[0-9a-fA-F]+$/.test(data)) return fallback;
    const value = Number(BigInt(data));
    return Number.isFinite(value) && value >= 0 && value <= 36 ? value : fallback;
  })();
  decimalsCache.set(key, task);
  return task;
}

function rawToNumber(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  const precision = 1_000_000_000n;
  const fracScaled = decimals > 0 ? (frac * precision) / scale : 0n;
  return Number(whole) + Number(fracScaled) / Number(precision);
}

function matchedRaw(logs: ReceiptTransfer[], detail: EoaFlowDetail, transfer: EoaFlowTransfer): bigint | null {
  const holder = detail.address?.toLowerCase();
  const token = transfer.token?.toLowerCase();
  if (!holder || !token) return null;
  const matches = logs.filter((log) =>
    log.token === token &&
    (transfer.direction === "in" ? log.to === holder : transfer.direction === "out" ? log.from === holder : false),
  );
  if (!matches.length) return null;
  return matches.reduce((sum, log) => sum + log.raw, 0n);
}

async function normalizeTransfer(detail: EoaFlowDetail, transfer: EoaFlowTransfer, logs: ReceiptTransfer[] | null): Promise<EoaFlowTransfer> {
  const meta = canonicalMeta(transfer.token, transfer.symbol);
  let amount = transfer.amount;
  let amountSource: "upstream" | "receipt_logs" | "missing" = transferNeedsAmount(transfer) ? "missing" : "upstream";
  const token = transfer.token?.toLowerCase() ?? transfer.token;

  if (logs && transferNeedsAmount(transfer) && token && ADDRESS_RE.test(token)) {
    const raw = matchedRaw(logs, detail, transfer);
    if (raw != null) {
      const decimals = await tokenDecimals(token, meta.decimals);
      amount = rawToNumber(raw, decimals);
      amountSource = "receipt_logs";
    }
  }

  return {
    ...transfer,
    token,
    symbol: meta.symbol,
    amount,
    amount_source: amountSource,
  };
}

async function normalizeDetail(detail: EoaFlowDetail): Promise<EoaFlowDetail> {
  const transfers = detail.transfers ?? [];
  const needsReceipt = !!detail.tx_hash && transfers.some(transferNeedsAmount);
  const logs = needsReceipt && detail.tx_hash ? await receiptTransfers(detail.tx_hash) : null;
  const normalizedTransfers = await Promise.all(transfers.map((transfer) => normalizeTransfer(detail, transfer, logs)));
  return {
    ...detail,
    transfers: normalizedTransfers.filter((transfer) => {
      const amount = Number(transfer.amount);
      return !Number.isFinite(amount) || amount > 0;
    }),
  };
}

function isTokenOnlyCategory(category: string | null | undefined): boolean {
  return ["token_receive", "token_send", "token_rebalance", "token_mint", "token_burn"].includes(category ?? "");
}

function isDropAfterZeroFilter(detail: EoaFlowDetail): boolean {
  return isTokenOnlyCategory(detail.category) && (detail.transfers?.length ?? 0) === 0;
}

function normalizeEdgeLabel(payload: EoaFlowPayload): EoaFlowPayload {
  return {
    ...payload,
    edges: payload.edges.filter((edge) => {
      if (!isTokenOnlyCategory(edge.category)) return true;
      return (edge.details?.length ?? 0) > 0;
    }).map((edge) => {
      const tokens = new Map<string, { symbol: string; net: number; count: number }>();
      for (const detail of edge.details ?? []) {
        for (const transfer of detail.transfers ?? []) {
          const key = `${transfer.token}:${transfer.symbol}`;
          const cur = tokens.get(key) ?? { symbol: transfer.symbol, net: 0, count: 0 };
          const amount = Number(transfer.amount);
          if (Number.isFinite(amount) && amount > 0) cur.net += transfer.direction === "out" ? -amount : transfer.direction === "in" ? amount : 0;
          cur.count += transfer.count || 1;
          tokens.set(key, cur);
        }
      }
      if (!tokens.size) return edge;
      const parts = [...tokens.values()]
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.symbol.localeCompare(b.symbol))
        .slice(0, 4)
        .map((token) => {
          if (Math.abs(token.net) <= 1e-12) return `${token.count}x ${token.symbol}`;
          const abs = Math.abs(token.net);
          const amount = abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(2)}m` : abs >= 1_000 ? `${(abs / 1_000).toFixed(2)}k` : abs.toFixed(4).replace(/\.?0+$/, "");
          return `${token.net > 0 ? "+" : "-"}${amount} ${token.symbol}`;
        });
      return { ...edge, label: `${edge.event_count ?? edge.details?.length ?? 0} tx | ${edge.category ?? edge.edge_type} | ${parts.join(" / ")}` };
    }),
  };
}

export async function normalizeEoaFlowPayload(payload: EoaFlowPayload): Promise<EoaFlowPayload> {
  const detailsByKey = new Map<string, EoaFlowDetail>();
  const normalizeOne = async (detail: EoaFlowDetail) => {
    const key = detail.event_id ?? `${detail.address ?? ""}:${detail.tx_hash ?? ""}:${detail.block_number ?? ""}:${detail.category ?? ""}:${detail.action ?? ""}`;
    const cached = detailsByKey.get(key);
    if (cached) return cached;
    const normalized = await normalizeDetail(detail);
    detailsByKey.set(key, normalized);
    return normalized;
  };

  const edges = await Promise.all(payload.edges.map(async (edge) => ({
    ...edge,
    details: edge.details ? (await Promise.all(edge.details.map(normalizeOne))).filter((detail) => !isDropAfterZeroFilter(detail)) : edge.details,
  })));
  const events = Array.isArray(payload.events)
    ? (await Promise.all(payload.events.map((event) => event && typeof event === "object" && "transfers" in event ? normalizeOne(event as EoaFlowDetail) : event)))
      .filter((event) => !(event && typeof event === "object" && "transfers" in event && isDropAfterZeroFilter(event as EoaFlowDetail)))
    : payload.events;
  return normalizeEdgeLabel({ ...payload, edges, events });
}
