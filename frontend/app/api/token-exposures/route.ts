import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/token-exposures
 * Home ranking coverage metric.
 *
 * DB edges are precise but only cover adapters/snapshots we run. DeFiLlama breadth is live
 * and wider, but less precise for per-token accounting. For the home list, use the larger
 * of the two rather than summing them, so duplicated protocol coverage does not inflate TVL.
 */

export const dynamic = "force-dynamic";

const DATABASE_URL = process.env.DATABASE_URL;
let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  return _pool;
}

const CHAIN_MAP: Record<string, string> = {
  Ethereum: "ethereum", Arbitrum: "arbitrum", Base: "base", "OP Mainnet": "optimism", Optimism: "optimism",
  Polygon: "polygon", "Polygon zkEVM": "polygon-zkevm", Avalanche: "avalanche", BSC: "bsc", Gnosis: "gnosis",
  Linea: "linea", Scroll: "scroll", "ZKsync Era": "zksync", Mantle: "mantle", Mode: "mode", Blast: "blast",
  Sonic: "sonic", Fraxtal: "fraxtal", Unichain: "unichain", Ink: "ink", Soneium: "soneium", "World Chain": "wc",
  Taiko: "taiko", Manta: "manta", Celo: "celo", Cronos: "cronos", Kava: "kava", Bob: "bob", Flare: "flare",
  Berachain: "berachain", Sei: "sei", Katana: "katana", Plasma: "plasma", "Hyperliquid L1": "hyperliquid",
  HyperEVM: "hyperliquid", Monad: "monad", MegaETH: "megaeth", "Plume Mainnet": "plume", Plume: "plume",
  Pharos: "pharos", Hemi: "hemi", Swellchain: "swell", Corn: "corn", Lisk: "lisk", Metis: "metis",
  Solana: "solana", Sui: "sui", Aptos: "aptos", Starknet: "starknet", Osmosis: "osmosis", Tron: "tron",
  Stellar: "stellar", Stacks: "stacks", Near: "near", TON: "ton",
};

const CHAIN_TVL_MIN = 250_000;
const PROTO_TVL_MIN = 20_000;
const MAX_CHAINS = 12;
const LLAMA_REVALIDATE_SECONDS = 1800;

interface Pool {
  chain?: string;
  project?: string;
  symbol?: string;
  tvlUsd?: number;
  exposure?: string | null;
  underlyingTokens?: string[] | null;
}

interface DbExposureRow {
  symbol: string;
  db_usd: number | string | null;
  snapshot_ts: string | null;
}

interface TokenExposure {
  usd: number;
  dbUsd: number;
  breadthUsd: number;
  source: "defillama-live" | "db-snapshot" | "none";
  snapshotTs: string | null;
}

function symbolParts(symbol: string | null | undefined): string[] {
  return (symbol ?? "").toUpperCase().split(/[-/\s+.]+/).filter(Boolean);
}

function normAddress(addr: string): string {
  return /^0x/i.test(addr) ? addr.toLowerCase() : addr;
}

async function dbExposures(p: pg.Pool): Promise<Map<string, { dbUsd: number; snapshotTs: string | null }>> {
  const r = await p.query<DbExposureRow>(`
    WITH active_tokens AS (
      SELECT DISTINCT replace(split_part(n.node_id, '@', 1), 'token:', '') AS symbol
      FROM watchlist w
      JOIN nodes n ON lower(n.address) = lower(w.token_address) AND n.type = 'Token'
      JOIN edges e ON e.token_node_id = n.node_id
      WHERE w.active = TRUE
    ),
    latest AS (
      SELECT token_node_id, MAX(snapshot_ts) AS ts
      FROM edges
      GROUP BY token_node_id
    )
    SELECT
      replace(split_part(e.token_node_id, '@', 1), 'token:', '') AS symbol,
      SUM(COALESCE((e.attrs->'core'->>'amountUsd')::double precision, e.weight, 0)) AS db_usd,
      MAX(e.snapshot_ts) AS snapshot_ts
    FROM edges e
    JOIN latest l ON e.token_node_id = l.token_node_id AND e.snapshot_ts = l.ts
    JOIN active_tokens a ON a.symbol = replace(split_part(e.token_node_id, '@', 1), 'token:', '')
    GROUP BY 1
  `);

  const out = new Map<string, { dbUsd: number; snapshotTs: string | null }>();
  for (const row of r.rows) {
    out.set(row.symbol, { dbUsd: Number(row.db_usd ?? 0), snapshotTs: row.snapshot_ts });
  }
  return out;
}

async function fetchLlamaPools(): Promise<Pool[]> {
  const res = await fetch("https://yields.llama.fi/pools", { next: { revalidate: LLAMA_REVALIDATE_SECONDS } });
  if (!res.ok) throw new Error(`DeFiLlama pools HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Pool[] };
  return json.data ?? [];
}

function computeBreadthTotals(tokens: string[], pools: Pool[]): Map<string, number> {
  const displayByKey = new Map(tokens.map((sym) => [sym.toUpperCase(), sym] as const));
  const wanted = new Set(displayByKey.keys());
  const candidates: Array<{ key: string; pool: Pool; chain: string }> = [];
  const canonByTokenChain = new Map<string, Set<string>>();

  for (const pool of pools) {
    const chain = CHAIN_MAP[pool.chain ?? ""];
    if (!chain) continue;
    const matched = [...new Set(symbolParts(pool.symbol).filter((part) => wanted.has(part)))];
    if (!matched.length) continue;

    for (const key of matched) {
      candidates.push({ key, pool, chain });
      const underlying = pool.underlyingTokens ?? [];
      if (pool.exposure === "single" && underlying.length === 1 && underlying[0]) {
        const canonKey = `${key}|${chain}`;
        const set = canonByTokenChain.get(canonKey) ?? new Set<string>();
        set.add(normAddress(underlying[0]));
        canonByTokenChain.set(canonKey, set);
      }
    }
  }

  const protoUsd = new Map<string, number>();
  for (const { key, pool, chain } of candidates) {
    if (!pool.project) continue;
    const tvlUsd = pool.tvlUsd ?? 0;
    if (!(tvlUsd > 0)) continue;

    const canon = canonByTokenChain.get(`${key}|${chain}`);
    if (canon?.size) {
      const underlying = (pool.underlyingTokens ?? []).map(normAddress);
      if (underlying.length > 0 && !underlying.some((addr) => canon.has(addr))) continue;
    }

    const display = displayByKey.get(key);
    if (!display) continue;
    const protoKey = `${display}|${chain}|${pool.project}`;
    protoUsd.set(protoKey, (protoUsd.get(protoKey) ?? 0) + tvlUsd);
  }

  const byTokenChain = new Map<string, number>();
  for (const [key, usd] of protoUsd) {
    if (usd < PROTO_TVL_MIN) continue;
    const [symbol, chain] = key.split("|");
    const chainKey = `${symbol}|${chain}`;
    byTokenChain.set(chainKey, (byTokenChain.get(chainKey) ?? 0) + usd);
  }

  const byToken = new Map<string, Array<{ chain: string; usd: number }>>();
  for (const [key, usd] of byTokenChain) {
    const [symbol, chain] = key.split("|");
    const list = byToken.get(symbol) ?? [];
    list.push({ chain, usd });
    byToken.set(symbol, list);
  }

  const totals = new Map<string, number>();
  for (const [symbol, chains] of byToken) {
    const kept = chains
      .filter((x) => x.usd >= CHAIN_TVL_MIN)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, MAX_CHAINS);
    totals.set(symbol, kept.reduce((sum, x) => sum + x.usd, 0));
  }
  return totals;
}

export async function GET() {
  const p = pool();
  if (!p) return NextResponse.json({ exposures: {}, dbConnected: false });

  try {
    const db = await dbExposures(p);
    const symbols = [...db.keys()];
    const exposures: Record<string, TokenExposure> = {};
    let breadth = new Map<string, number>();
    let breadthError: string | null = null;

    try {
      breadth = computeBreadthTotals(symbols, await fetchLlamaPools());
    } catch (e) {
      breadthError = (e as Error).message;
    }

    for (const symbol of symbols) {
      const dbItem = db.get(symbol);
      const dbUsd = dbItem?.dbUsd ?? 0;
      const breadthUsd = breadth.get(symbol) ?? 0;
      const useBreadth = breadthUsd > dbUsd;
      const usd = Math.max(dbUsd, breadthUsd);
      exposures[symbol] = {
        usd,
        dbUsd,
        breadthUsd,
        source: usd > 0 ? (useBreadth ? "defillama-live" : "db-snapshot") : "none",
        snapshotTs: dbItem?.snapshotTs ?? null,
      };
    }

    return NextResponse.json({
      exposures,
      generatedAt: new Date().toISOString(),
      dbConnected: true,
      breadthError,
      method: "max(latest DB snapshot exposure, live DeFiLlama breadth)",
    });
  } catch (e) {
    return NextResponse.json(
      { exposures: {}, dbConnected: true, error: (e as Error).message },
      { status: 500 },
    );
  }
}
