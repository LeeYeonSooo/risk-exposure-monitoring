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
  // 알림 클릭 → Etherscan 바로가기용 컨트랙트 주소(nodes JOIN). 모든 알림이 최소 하나는 가짐(tx 없는 상태형 폴백).
  token_address: string | null;
  token_chain: string | null;
  protocol_address: string | null;
  protocol_chain: string | null;
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
    // 컬럼은 alerts 별칭 a. 로 한정(아래 nodes JOIN 과 모호성 방지).
    const conds: string[] = [];
    const params: unknown[] = [];
    if (token) {
      params.push(token.toUpperCase());
      conds.push(`a.token = $${params.length}`);
    }
    if (severityParam) {
      const sevs = severityParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (sevs.length) {
        params.push(sevs);
        conds.push(`a.severity = ANY($${params.length}::text[])`);
      }
    }
    // 활성 = 미확인(acknowledged) AND 미해소(resolved_at). 조건 해소된 상태형 알림은 자동 제외. ?includeAck=1 로 포함.
    if (url.searchParams.get("includeAck") !== "1") conds.push(`a.acknowledged IS NOT TRUE AND a.resolved_at IS NULL`);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit);

    const orderBy = sortBySeverity
      ? `ORDER BY CASE a.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END DESC,
                  COALESCE(a.snapshot_ts, a.created_at) DESC, a.created_at DESC`
      : `ORDER BY COALESCE(a.snapshot_ts, a.created_at) DESC, a.created_at DESC`;

    // 컨트랙트 주소 enrich — 알림 클릭 시 Etherscan 바로가기(tx 없는 상태형 알림 폴백). protocol_node_id 는 exact JOIN(체인 정확),
    //   token 은 case-insensitive + 활성체인(eth/base/arb) 우선 LATERAL JOIN. 체인은 node_id 의 @suffix(없으면 ethereum).
    const r = await p.query<AlertRow>(
      `SELECT a.id, a.created_at, a.snapshot_ts, a.severity, a.kind, a.token, a.protocol_node_id, a.message, a.detail, a.acknowledged,
              tn.address AS token_address,
              CASE WHEN tn.node_id LIKE '%@%' THEN split_part(tn.node_id, '@', 2) ELSE 'ethereum' END AS token_chain,
              pn.address AS protocol_address,
              CASE WHEN a.protocol_node_id LIKE '%@%' THEN split_part(a.protocol_node_id, '@', 2) ELSE 'ethereum' END AS protocol_chain
       FROM alerts a
       LEFT JOIN LATERAL (
         SELECT address, node_id FROM nodes
         WHERE (node_id ILIKE 'token:' || a.token OR node_id ILIKE 'token:' || a.token || '@%')
           AND address IS NOT NULL AND address <> ''
         ORDER BY (lower(node_id) = lower('token:' || a.token)) DESC,
                  (node_id NOT LIKE '%@%' OR node_id ILIKE '%@base' OR node_id ILIKE '%@arbitrum') DESC
         LIMIT 1
       ) tn ON true
       LEFT JOIN nodes pn ON pn.node_id = a.protocol_node_id
       ${where} ${orderBy} LIMIT $${params.length}`,
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
