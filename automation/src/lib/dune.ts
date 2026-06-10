import { env } from "@/config/chains";

const BASE = "https://api.dune.com/api/v1";

interface DuneCreateResp { query_id: number }
interface DuneExecuteResp { execution_id: string }
interface DuneStatusResp { state: string; error?: { message: string } }
interface DuneResultsResp<T = Record<string, unknown>> {
  result: { rows: T[] };
}

/** Execute an SQL query via Dune REST API. Creates a query if needed, then polls. */
export async function runDuneSql<T = Record<string, unknown>>(
  sql: string,
  name = "automation query",
): Promise<T[]> {
  if (!env.DUNE_API_KEY) {
    throw new Error("DUNE_API_KEY not set");
  }
  const headers = {
    "X-Dune-API-Key": env.DUNE_API_KEY,
    "Content-Type": "application/json",
  };

  // 1) Create query (public, to avoid private quota)
  const createR = await fetch(`${BASE}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, query_sql: sql, is_private: false }),
  });
  if (!createR.ok) throw new Error(`Dune create: ${createR.status}`);
  const created = (await createR.json()) as DuneCreateResp;

  // 2) Execute
  const execR = await fetch(`${BASE}/query/${created.query_id}/execute`, {
    method: "POST",
    headers,
  });
  if (!execR.ok) throw new Error(`Dune execute: ${execR.status}`);
  const exec = (await execR.json()) as DuneExecuteResp;

  // 3) Poll
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const stR = await fetch(`${BASE}/execution/${exec.execution_id}/status`, { headers });
    const st = (await stR.json()) as DuneStatusResp;
    if (st.state === "QUERY_STATE_COMPLETED") break;
    if (st.state === "QUERY_STATE_FAILED") {
      throw new Error(`Dune execution failed: ${st.error?.message ?? "unknown"}`);
    }
  }

  // 4) Fetch results
  const resR = await fetch(`${BASE}/execution/${exec.execution_id}/results`, { headers });
  const res = (await resR.json()) as DuneResultsResp<T>;
  return res.result.rows;
}

/** Lookup community labels for a batch of addresses in labels.addresses table. */
export async function lookupAddressLabels(
  addresses: string[],
): Promise<Map<string, { labels: string[]; categories: string[] }>> {
  if (addresses.length === 0) return new Map();
  const values = addresses.map((a) => `(${a.toLowerCase()})`).join(",\n    ");
  const sql = `
    WITH addrs(addr) AS (VALUES ${values})
    SELECT
      lower(to_hex(a.addr)) AS address,
      array_agg(DISTINCT l.name) FILTER (WHERE l.name IS NOT NULL) AS labels,
      array_agg(DISTINCT l.category) FILTER (WHERE l.category IS NOT NULL) AS categories
    FROM addrs a
    LEFT JOIN labels.addresses l
      ON l.address = a.addr
      AND (l.blockchain = 'ethereum' OR l.blockchain IS NULL)
    GROUP BY a.addr
  `;
  type Row = { address: string; labels: string[] | null; categories: string[] | null };
  const rows = await runDuneSql<Row>(sql, "address label lookup");
  const m = new Map<string, { labels: string[]; categories: string[] }>();
  for (const r of rows) {
    m.set("0x" + r.address.replace(/^0x/, "").toLowerCase(), {
      labels: r.labels ?? [],
      categories: r.categories ?? [],
    });
  }
  return m;
}
