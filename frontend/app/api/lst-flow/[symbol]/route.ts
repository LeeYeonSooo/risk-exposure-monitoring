import { NextResponse } from "next/server";
import type { LstFlowDailyPoint, LstFlowData } from "@/lib/api";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 14;
const WEEK_DAYS = 7;
const CACHE_MS = 30 * 60 * 1000;
const BLOCKS_PER_DAY = 7200;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY ?? "";
const ETHERSCAN = "https://api.etherscan.io/v2/api";
const PUBLIC_ETH_RPC = "https://ethereum-rpc.publicnode.com";

const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LIDO_SUBMITTED_TOPIC = "0x96a25c8ce0baabc1fdefd93e9ed25d8e092a3332f3aa9a41722b5697231d1d1a";
const LIDO_WITHDRAWAL_REQUESTED_TOPIC = "0xf0cb471f23fb74ea44b8252eb1881a2dca546288d9f6e90d1a0e82fe0ed342ab";
const LIDO_WITHDRAWALS_FINALIZED_TOPIC = "0x197874c72af6a06fb0aa4fab45fd39c7cb61ac0992159872dc3295207da7e9eb";
const LIDO_WITHDRAWAL_CLAIMED_TOPIC = "0x6ad26c5e238e7d002799f9a5db07e81ef14e37386ae03496d7a7ef04713e145b";

const LIDO_STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const LIDO_WITHDRAWAL_QUEUE = "0x889edc2edab5f40e902b864ad4d7ade8e412f9b1";
const SEL_UNFINALIZED_STETH = "0xd0fb84e8";
const SEL_UNFINALIZED_REQUEST_NUMBER = "0xc2fc7aff";
const SEL_LAST_REQUEST_ID = "0x19c2b4c3";
const SEL_LAST_FINALIZED_REQUEST_ID = "0x4f069a13";

type TokenAdapter = {
  symbol: string;
  tokenType: "lst" | "lrt";
  protocol: string;
  unit: string;
  address: string;
  mode: "erc20_zero";
  notes: string[];
};

const ERC20_ADAPTERS: Record<string, TokenAdapter> = {
  RETH: {
    symbol: "rETH",
    tokenType: "lst",
    protocol: "Rocket Pool",
    unit: "rETH",
    address: "0xae78736cd615f374d3085123a210448e74fc6393",
    mode: "erc20_zero",
    notes: ["Transfer from/to zero-address 기준 공급 발행·소각입니다. 프로토콜 withdrawal queue는 별도 이벤트가 아니면 표시하지 않습니다."],
  },
  CBETH: {
    symbol: "cbETH",
    tokenType: "lst",
    protocol: "Coinbase",
    unit: "cbETH",
    address: "0xbe9895146f7af43049ca1c1ae358b0541ea49704",
    mode: "erc20_zero",
    notes: ["Transfer from/to zero-address 기준 공급 발행·소각입니다. Coinbase custody 내부 redeem queue는 온체인 이벤트만으로 보이지 않습니다."],
  },
  ANKRETH: {
    symbol: "ankrETH",
    tokenType: "lst",
    protocol: "Ankr",
    unit: "ankrETH",
    address: "0xe95a203b1a91a908f9b9ce46459d101078c2c3cb",
    mode: "erc20_zero",
    notes: ["Transfer from/to zero-address 기준 공급 발행·소각입니다."],
  },
  SWETH: {
    symbol: "swETH",
    tokenType: "lst",
    protocol: "Swell",
    unit: "swETH",
    address: "0xf951e335afb289353dc249e82926178eac7ded78",
    mode: "erc20_zero",
    notes: ["Transfer from/to zero-address 기준 공급 발행·소각입니다."],
  },
  OSETH: {
    symbol: "osETH",
    tokenType: "lst",
    protocol: "StakeWise",
    unit: "osETH",
    address: "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38",
    mode: "erc20_zero",
    notes: ["Transfer from/to zero-address 기준 공급 발행·소각입니다."],
  },
  SFRXETH: {
    symbol: "sfrxETH",
    tokenType: "lst",
    protocol: "Frax",
    unit: "sfrxETH",
    address: "0xac3e018457b222d93114458476f3e3416abbe38f",
    mode: "erc20_zero",
    notes: ["Vault share token의 zero-address mint/burn 기준입니다. frxETH↔sfrxETH 래핑 흐름으로 해석해야 합니다."],
  },
  WEETH: {
    symbol: "weETH",
    tokenType: "lrt",
    protocol: "Ether.fi",
    unit: "weETH",
    address: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee",
    mode: "erc20_zero",
    notes: ["Transfer from/to zero-address 기준입니다. ether.fi withdrawal queue 이벤트 어댑터는 다음 단계에서 붙여야 정확한 queue 압력이 나옵니다."],
  },
  EZETH: {
    symbol: "ezETH",
    tokenType: "lrt",
    protocol: "Renzo",
    unit: "ezETH",
    address: "0xbf5495efe5db9ce00f80364c8b423567e58d2110",
    mode: "erc20_zero",
    notes: ["Transfer from/to zero-address 기준입니다. Renzo withdrawal queue는 별도 어댑터가 필요합니다."],
  },
  RSETH: {
    symbol: "rsETH",
    tokenType: "lrt",
    protocol: "KelpDAO",
    unit: "rsETH",
    address: "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
    mode: "erc20_zero",
    notes: ["Transfer from/to zero-address 기준입니다. Kelp withdrawal queue는 별도 어댑터가 필요합니다."],
  },
};

const PENDING_LST_LRT = new Set(["EETH", "METH", "CMETH", "WBETH", "PUFETH", "PZETH", "STONE", "WBERAETH"]);

type RawLog = {
  timeStamp?: string;
  data?: string;
  topics?: string[];
};

type EtherscanResp = {
  status?: string;
  message?: string;
  result?: RawLog[] | string;
};

const cache = new Map<string, { ts: number; data: LstFlowData }>();

function hexToNumber(hex: string | undefined): number {
  if (!hex) return 0;
  try { return Number(BigInt(hex)); } catch { return 0; }
}

function wordToUnits(data: string | undefined, wordIdx = 0, decimals = 18): number {
  if (!data?.startsWith("0x")) return 0;
  const start = 2 + wordIdx * 64;
  if (data.length < start + 64) return 0;
  const raw = BigInt(`0x${data.slice(start, start + 64)}`);
  return Number(raw) / Math.pow(10, decimals);
}

function utcDay(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

function emptyDaily(): LstFlowDailyPoint[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - (WINDOW_DAYS - 1 - i));
    return { date: d.toISOString().slice(0, 10), mint: 0, redeem: 0, queueIn: 0, queueOut: 0 };
  });
}

function weekly(daily: LstFlowDailyPoint[]) {
  const rows = daily.slice(-WEEK_DAYS);
  const sum = (k: keyof Omit<LstFlowDailyPoint, "date">) => rows.reduce((s, r) => s + r[k], 0);
  const queueIn = sum("queueIn");
  const redeem = sum("redeem");
  const queueOut = sum("queueOut");
  return { mint: sum("mint"), redeem, queueIn, queueOut, queueNet: queueIn - queueOut };
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string };
    return j.result ?? null;
  } catch { return null; }
}

async function latestBlock(): Promise<number | null> {
  const urls = [
    ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null,
    PUBLIC_ETH_RPC,
  ].filter(Boolean) as string[];
  for (const url of urls) {
    const hex = await rpcCall(url, "eth_blockNumber", []);
    if (hex) return Number(BigInt(hex));
  }
  return null;
}

async function ethCall(to: string, data: string): Promise<string | null> {
  const urls = [
    ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null,
    PUBLIC_ETH_RPC,
  ].filter(Boolean) as string[];
  for (const url of urls) {
    const hex = await rpcCall(url, "eth_call", [{ to, data }, "latest"]);
    if (hex && hex !== "0x") return hex;
  }
  return null;
}

function uintHexToNumber(hex: string | null, decimals = 0): number | null {
  if (!hex || hex === "0x") return null;
  try {
    const n = BigInt(hex);
    return Number(n) / Math.pow(10, decimals);
  } catch { return null; }
}

async function lidoQueueNow() {
  const [amountHex, requestsHex, lastHex, finalizedHex] = await Promise.all([
    ethCall(LIDO_WITHDRAWAL_QUEUE, SEL_UNFINALIZED_STETH),
    ethCall(LIDO_WITHDRAWAL_QUEUE, SEL_UNFINALIZED_REQUEST_NUMBER),
    ethCall(LIDO_WITHDRAWAL_QUEUE, SEL_LAST_REQUEST_ID),
    ethCall(LIDO_WITHDRAWAL_QUEUE, SEL_LAST_FINALIZED_REQUEST_ID),
  ]);
  return {
    amount: uintHexToNumber(amountHex, 18),
    requests: uintHexToNumber(requestsHex),
    lastRequestId: uintHexToNumber(lastHex),
    lastFinalizedRequestId: uintHexToNumber(finalizedHex),
  };
}

async function etherscanLogs(params: Record<string, string | number>, page = 1): Promise<RawLog[]> {
  if (!ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY missing");
  const url = new URL(ETHERSCAN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("chainid", "1");
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("page", String(page));
  url.searchParams.set("offset", "1000");
  url.searchParams.set("apikey", ETHERSCAN_API_KEY);

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { cache: "no-store" });
    const j = (await r.json()) as EtherscanResp;
    if (Array.isArray(j.result)) return j.result;
    const msg = String(j.result ?? j.message ?? "");
    if (/No records found/i.test(msg)) return [];
    if (/rate limit|timeout|busy/i.test(msg) && attempt < 2) {
      await sleep(900 + attempt * 900);
      continue;
    }
    throw new Error(msg || "etherscan logs failed");
  }
  return [];
}

async function fetchPagedLogs(params: Record<string, string | number>, maxPages = 20): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await etherscanLogs(params, page);
    out.push(...rows);
    if (rows.length < 1000) break;
    await sleep(220);
  }
  return out;
}

function addLogs(
  rowsByDate: Map<string, LstFlowDailyPoint>,
  logs: RawLog[],
  field: keyof Omit<LstFlowDailyPoint, "date">,
  wordIdx = 0,
  sinceSec: number,
) {
  for (const log of logs) {
    const ts = hexToNumber(log.timeStamp);
    if (!ts || ts < sinceSec) continue;
    const date = utcDay(ts);
    const row = rowsByDate.get(date);
    if (!row) continue;
    row[field] += wordToUnits(log.data, wordIdx);
  }
}

async function buildLidoFlow(symbol: string, fromBlock: number, latest: number, sinceSec: number): Promise<LstFlowData> {
  const daily = emptyDaily();
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const common = { fromBlock, toBlock: latest };

  const [submitted, requested, finalized, claimed] = await Promise.all([
    fetchPagedLogs({ ...common, address: LIDO_STETH, topic0: LIDO_SUBMITTED_TOPIC }, 12),
    fetchPagedLogs({ ...common, address: LIDO_WITHDRAWAL_QUEUE, topic0: LIDO_WITHDRAWAL_REQUESTED_TOPIC }, 12),
    fetchPagedLogs({ ...common, address: LIDO_WITHDRAWAL_QUEUE, topic0: LIDO_WITHDRAWALS_FINALIZED_TOPIC }, 4),
    fetchPagedLogs({ ...common, address: LIDO_WITHDRAWAL_QUEUE, topic0: LIDO_WITHDRAWAL_CLAIMED_TOPIC }, 12),
  ]);

  addLogs(byDate, submitted, "mint", 0, sinceSec);
  addLogs(byDate, requested, "queueIn", 0, sinceSec);
  addLogs(byDate, finalized, "queueOut", 0, sinceSec);
  addLogs(byDate, claimed, "redeem", 0, sinceSec);
  const queueNow = await lidoQueueNow();

  return {
    symbol,
    supported: true,
    tokenType: "lst",
    protocol: "Lido",
    basisSymbol: symbol.toUpperCase() === "WSTETH" ? "stETH" : symbol,
    unit: symbol.toUpperCase() === "WSTETH" ? "stETH equiv" : "stETH/ETH",
    windowDays: WINDOW_DAYS,
    queueSupported: true,
    daily,
    weekly: weekly(daily),
    queueNow,
    source: "Etherscan logs · Lido Submitted + WithdrawalQueue events",
    notes: [
      "mint = Lido Submitted amount.",
      "redeem = WithdrawalClaimed amount. queue in = WithdrawalRequested, queue out = WithdrawalsFinalized.",
      symbol.toUpperCase() === "WSTETH" ? "wstETH 자체 wrap/unwrap가 아니라 기초 stETH Lido 발행·출금 큐 흐름입니다." : "stETH rebasing reward 증가는 Submitted mint에 포함되지 않습니다.",
    ],
    updatedAt: new Date().toISOString(),
  };
}

async function buildErc20Flow(adapter: TokenAdapter, fromBlock: number, latest: number, sinceSec: number): Promise<LstFlowData> {
  const daily = emptyDaily();
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const common = { fromBlock, toBlock: latest, address: adapter.address, topic0: TRANSFER_TOPIC };
  const [mints, burns] = await Promise.all([
    fetchPagedLogs({ ...common, topic1: ZERO_TOPIC }, 12),
    fetchPagedLogs({ ...common, topic2: ZERO_TOPIC }, 12),
  ]);

  addLogs(byDate, mints, "mint", 0, sinceSec);
  addLogs(byDate, burns, "redeem", 0, sinceSec);

  return {
    symbol: adapter.symbol,
    supported: true,
    tokenType: adapter.tokenType,
    protocol: adapter.protocol,
    unit: adapter.unit,
    windowDays: WINDOW_DAYS,
    queueSupported: false,
    daily,
    weekly: weekly(daily),
    source: `Etherscan logs · ${adapter.protocol} ERC20 Transfer zero-address mint/burn`,
    notes: adapter.notes,
    updatedAt: new Date().toISOString(),
  };
}

function unsupported(symbol: string): LstFlowData {
  return {
    symbol,
    supported: false,
    tokenType: PENDING_LST_LRT.has(symbol.toUpperCase()) ? "lst" : "unknown",
    queueSupported: false,
    daily: [],
    notes: PENDING_LST_LRT.has(symbol.toUpperCase())
      ? ["LST/LRT 후보지만 아직 이벤트 어댑터가 없습니다. 프로토콜별 mint/redeem/queue 이벤트 확인 후 추가해야 합니다."]
      : ["LST/LRT issuance-flow 어댑터 대상이 아닙니다."],
    updatedAt: new Date().toISOString(),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const want = decodeURIComponent(symbol).toUpperCase();
  const cached = cache.get(want);
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return NextResponse.json(cached.data, { headers: { "Cache-Control": "public, max-age=300" } });
  }

  if (!ETHERSCAN_API_KEY) {
    return NextResponse.json({ ...unsupported(want), error: "ETHERSCAN_API_KEY missing" }, { status: 200 });
  }

  try {
    const latest = await latestBlock();
    if (!latest) throw new Error("latest block unavailable");
    const fromBlock = Math.max(0, latest - BLOCKS_PER_DAY * (WINDOW_DAYS + 2));
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (WINDOW_DAYS - 1));
    const sinceSec = Math.floor(since.getTime() / 1000);

    const data = want === "STETH" || want === "WSTETH"
      ? await buildLidoFlow(want, fromBlock, latest, sinceSec)
      : ERC20_ADAPTERS[want]
        ? await buildErc20Flow(ERC20_ADAPTERS[want], fromBlock, latest, sinceSec)
        : unsupported(want);

    cache.set(want, { ts: Date.now(), data });
    return NextResponse.json(data, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (e) {
    const data = { ...unsupported(want), error: e instanceof Error ? e.message : String(e) };
    cache.set(want, { ts: Date.now(), data });
    return NextResponse.json(data, { status: 200 });
  }
}
