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
  // sort=severity → 심각도(critical>warning>info) 우선, 동급은 최신순. 기본은 시간순(기존 동작 유지).
  //   info/warning 폭주 시 critical 이 limit 밖으로 밀려 안 보이던 문제(critical 매몰) 대응.
  const sortBySeverity = url.searchParams.get("sort") === "severity";
  // counts 집계는 ?withCounts=1 일 때만 — Dock 처럼 안 쓰는 표면의 불필요한 GROUP BY 제거.
  const withCounts = url.searchParams.get("withCounts") === "1";

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
    // 활성 = 미확인(acknowledged) AND 미해소(resolved_at). 조건 해소된 상태형 알림은 자동 제외. ?includeAck=1 로 포함.
    if (url.searchParams.get("includeAck") !== "1") conds.push(`acknowledged IS NOT TRUE AND resolved_at IS NULL`);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit);

    const orderBy = sortBySeverity
      ? `ORDER BY CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END DESC,
                  COALESCE(snapshot_ts, created_at) DESC, created_at DESC`
      : `ORDER BY COALESCE(snapshot_ts, created_at) DESC, created_at DESC`;

    const r = await p.query<AlertRow>(
      `SELECT id, created_at, snapshot_ts, severity, kind, token, protocol_node_id, message, detail, acknowledged
       FROM alerts ${where} ${orderBy} LIMIT $${params.length}`,
      params,
    );

    let counts: Record<string, number> = {};
    if (withCounts) {
      const countsR = await p.query<{ severity: string; n: string }>(
        `SELECT severity, count(*) AS n FROM alerts WHERE acknowledged IS NOT TRUE AND resolved_at IS NULL GROUP BY severity`,
      );
      for (const row of countsR.rows) counts[row.severity] = Number(row.n);
    }

    return NextResponse.json({ alerts: r.rows, counts, dbConnected: true });
  } catch (e) {
    // dbConnected:false 로 — 에러를 '알림 없음'(정상)으로 오인 표시하지 않게.
    return NextResponse.json(
      { alerts: [], counts: {}, dbConnected: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
