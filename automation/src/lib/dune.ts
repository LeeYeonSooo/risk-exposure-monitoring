import { env } from "@/config/chains";

const BASE = "https://api.dune.com/api/v1";

interface DuneCreateResp { query_id: number }
interface DuneExecuteResp { execution_id: string }
interface DuneStatusResp { state: string; error?: { message: string } }
interface DuneResultsResp<T = Record<string, unknown>> {
  result: { rows: T[] };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 45_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

// ─────────────────────────────────────────────────────────────
// 저장 쿼리 실행 (query_id + 파라미터) — 매 실행마다 쿼리를 새로 만들지 않음(크레딧·재현성).
// flow 파이프라인용: 쿼리는 Dune 에 1회 저장(MCP 로 생성·검증), 런타임은 ID 로만 실행.
// ─────────────────────────────────────────────────────────────

export interface DuneParam { key: string; value: string; type?: "text" | "number" | "date" | "enum" }

export async function executeDuneQueryById<T = Record<string, unknown>>(
  queryId: number,
  params: DuneParam[],
  opts: { maxRows?: number; pollSec?: number; performance?: "free" | "small" | "medium" | "large" } = {},
): Promise<{ rows: T[]; executionId: string }> {
  if (!env.DUNE_API_KEY) throw new Error("DUNE_API_KEY not set — automation/.env 에 추가 필요");
  const headers = { "X-Dune-API-Key": env.DUNE_API_KEY, "Content-Type": "application/json" };
  const maxRows = opts.maxRows ?? 3000;

  const execR = await fetchWithTimeout(`${BASE}/query/${queryId}/execute`, {
    method: "POST", headers,
    body: JSON.stringify({
      query_parameters: Object.fromEntries(params.map((p) => [p.key, p.value])),
      ...(opts.performance ? { performance: opts.performance } : {}),
    }),
  });
  if (!execR.ok) throw new Error(`Dune execute(${queryId}): HTTP ${execR.status} ${await execR.text().catch(() => "")}`);
  const exec = (await execR.json()) as DuneExecuteResp;

  const deadline = Date.now() + (opts.pollSec ?? 300) * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const stR = await fetchWithTimeout(`${BASE}/execution/${exec.execution_id}/status`, { headers }, 30_000);
    const st = (await stR.json()) as DuneStatusResp;
    if (st.state === "QUERY_STATE_COMPLETED") break;
    if (st.state === "QUERY_STATE_FAILED") throw new Error(`Dune 실행 실패: ${st.error?.message ?? "unknown"}`);
    if (Date.now() > deadline) throw new Error(`Dune 실행 타임아웃 (${opts.pollSec ?? 300}s)`);
  }

  // 결과 페이지네이션 (limit/offset)
  const rows: T[] = [];
  for (let offset = 0; rows.length < maxRows; offset += 1000) {
    const r = await fetchWithTimeout(`${BASE}/execution/${exec.execution_id}/results?limit=1000&offset=${offset}`, { headers }, 45_000);
    if (!r.ok) break;
    const j = (await r.json()) as DuneResultsResp<T>;
    const page = j.result?.rows ?? [];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return { rows: rows.slice(0, maxRows), executionId: exec.execution_id };
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
