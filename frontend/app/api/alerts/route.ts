import { NextResponse } from "next/server";
import pg from "pg";

/**
 * GET /api/alerts?limit=100&severity=critical,warning,info&token=WBTC
 * automation diff 엔진이 적재한 알림을 최신순으로 반환. DB 없으면 빈 배열.
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

interface AlertRow {
  id: string;
  created_at: string;
  snapshot_ts: string | null;
  severity: string;
  kind: string;
  token: string;
  protocol_node_id: string | null;
  message: string;
  detail: unknown;
  acknowledged: boolean;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const token = url.searchParams.get("token");
  const severityParam = url.searchParams.get("severity");

  const p = pool();
  if (!p) return NextResponse.json({ alerts: [], counts: {}, dbConnected: false });

  try {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (token) {
      params.push(token.toUpperCase());
      conds.push(`token = $${params.length}`);
    }
    if (severityParam) {
      const sevs = severityParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (sevs.length) {
        params.push(sevs);
        conds.push(`severity = ANY($${params.length}::text[])`);
      }
    }
    // acknowledged(처리/무시됨) 알림은 기본 제외 — 활성 피드만. ?includeAck=1 로 포함.
    if (url.searchParams.get("includeAck") !== "1") conds.push(`acknowledged IS NOT TRUE`);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit);

    const r = await p.query<AlertRow>(
      `SELECT id, created_at, snapshot_ts, severity, kind, token, protocol_node_id, message, detail, acknowledged
       FROM alerts ${where} ORDER BY COALESCE(snapshot_ts, created_at) DESC, created_at DESC LIMIT $${params.length}`,
      params,
    );

    const countsR = await p.query<{ severity: string; n: string }>(
      `SELECT severity, count(*) AS n FROM alerts WHERE acknowledged IS NOT TRUE GROUP BY severity`,
    );
    const counts: Record<string, number> = {};
    for (const row of countsR.rows) counts[row.severity] = Number(row.n);

    return NextResponse.json({ alerts: r.rows, counts, dbConnected: true });
  } catch (e) {
    return NextResponse.json(
      { alerts: [], counts: {}, dbConnected: true, error: (e as Error).message },
      { status: 500 },
    );
  }
}
