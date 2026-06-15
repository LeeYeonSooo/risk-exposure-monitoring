import { NextResponse } from "next/server";
import pg from "pg";

/**
 * POST /api/alerts/[id]/ack         — 알림 1건을 acknowledged=true(확인/해소)로 표시.
 * POST /api/alerts/[id]/ack?undo=1  — 되돌리기(acknowledged=false).
 * 확인된 알림은 기본 피드(GET /api/alerts)에서 제외된다.
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

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> } | { params: { id: string } }) {
  const params = await (ctx as { params: Promise<{ id: string }> }).params;
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const undo = new URL(req.url).searchParams.get("undo") === "1";
  const p = pool();
  if (!p) return NextResponse.json({ ok: false, error: "no database" }, { status: 503 });
  try {
    const r = await p.query<{ id: string }>(
      `UPDATE alerts SET acknowledged=$2 WHERE id=$1 RETURNING id`,
      [id, !undo],
    );
    if (r.rowCount === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, id, acknowledged: !undo });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
