import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * GET /api/flows/[token] — 트랜잭션 플로우 그래프 (kuromi flow_trace 포팅, Dune 기반).
 * automation `snapshot:flows` 가 적재한 코어 행위자(flow_nodes) + 행위자간 멀티자산 방향
 * 흐름(flow_edges)을 반환. **상세그래프 탭 전용** — 관계맵은 이 데이터를 소비하지 않는다.
 * 데이터 없으면 { nodes: [], edges: [] } (프론트는 플로우 레이어를 그리지 않음).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATABASE_URL = process.env.DATABASE_URL;
const CHAIN = "ethereum";
const CACHE_TTL_HOURS = Number(process.env.FLOW_CACHE_TTL_HOURS ?? 24);
const JOB_DEBOUNCE_MIN = Number(process.env.FLOW_REFRESH_DEBOUNCE_MIN ?? 30);
const ACTIVE_JOB_HOURS = Number(process.env.FLOW_ACTIVE_JOB_HOURS ?? 2);
let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  return _pool;
}

type JobRow = {
  id: number;
  status: string;
  source: string;
  requested_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error: string | null;
  pid: number | null;
};

function automationDir(): string | null {
  const explicit = process.env.FLOW_AUTOMATION_DIR;
  const dir = explicit || path.resolve(process.cwd(), "..", "automation");
  return existsSync(path.join(dir, "scripts", "snapshot-flows.ts")) ? dir : null;
}

async function maybeQueueRefresh(
  p: pg.Pool,
  sym: string,
  opts: { force: boolean; stale: boolean; missing: boolean; disabled: boolean },
): Promise<JobRow | null> {
  let latest: JobRow | null = null;
  try {
    const latestR = await p.query<JobRow>(
      `SELECT id, status, source, requested_at, started_at, finished_at, error, pid
       FROM flow_refresh_jobs
       WHERE upper(token_symbol)=upper($1) AND chain=$2
       ORDER BY requested_at DESC LIMIT 1`,
      [sym, CHAIN],
    );
    latest = latestR.rows[0] ?? null;

    const activeR = await p.query<JobRow>(
      `SELECT id, status, source, requested_at, started_at, finished_at, error, pid
       FROM flow_refresh_jobs
       WHERE upper(token_symbol)=upper($1) AND chain=$2
         AND status IN ('queued','running')
         AND requested_at > now() - ($3::int * interval '1 hour')
       ORDER BY requested_at DESC LIMIT 1`,
      [sym, CHAIN, ACTIVE_JOB_HOURS],
    );
    if (activeR.rows[0]) return activeR.rows[0];
  } catch {
    return null;
  }

  const recentRequested = latest
    ? Date.now() - new Date(latest.requested_at).getTime() < JOB_DEBOUNCE_MIN * 60_000
    : false;
  if (opts.disabled || (!opts.force && !opts.stale && !opts.missing) || (!opts.force && recentRequested)) return latest;

  const dir = automationDir();
  if (!dir) return latest;

  const inserted = await p.query<JobRow>(
    `INSERT INTO flow_refresh_jobs (token_symbol, chain, status, source)
     VALUES ($1,$2,'queued','auto')
     RETURNING id, status, source, requested_at, started_at, finished_at, error, pid`,
    [sym, CHAIN],
  );
  const job = inserted.rows[0];
  try {
    const child = spawn(
      "npx",
      ["tsx", "scripts/snapshot-flows.ts", sym, "--source", "auto", "--bootstrap-rpc", "--job-id", String(job.id)],
      {
        cwd: dir,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          FLOW_BOOTSTRAP_RPC: "1",
          FLOW_DUNE_POLL_SEC: process.env.FLOW_DUNE_POLL_SEC ?? "3600",
        },
      },
    );
    child.unref();
    await p.query(`UPDATE flow_refresh_jobs SET pid=$2 WHERE id=$1`, [job.id, child.pid ?? null]).catch(() => {});
    return { ...job, pid: child.pid ?? null };
  } catch (e) {
    await p.query(
      `UPDATE flow_refresh_jobs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`,
      [job.id, (e as Error).message.slice(0, 300)],
    ).catch(() => {});
    return { ...job, status: "failed", error: (e as Error).message.slice(0, 300) };
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const sym = decodeURIComponent(token);
  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const noRefresh = url.searchParams.get("refresh") === "0";
  const p = pool();
  if (!p) return NextResponse.json({ nodes: [], edges: [], meta: null, dbConnected: false });

  try {
    const [nodesR, edgesR, runR] = await Promise.all([
      p.query(
        `SELECT addr, label, kind, protocol_family, degree, is_seed, in_cycle
         FROM flow_nodes WHERE upper(token_symbol)=upper($1) AND chain='ethereum'`,
        [sym],
      ),
      p.query(
        `SELECT src, dst, asset_addr, asset_symbol, suspicious, amount, amount_usd, transfer_count,
                role, in_cycle, is_mint_burn, min_block, max_block, sample_tx
         FROM flow_edges WHERE upper(token_symbol)=upper($1) AND chain='ethereum'
         ORDER BY amount_usd DESC NULLS LAST`,
        [sym],
      ),
      p.query(
        `SELECT snapshot_ts, window_days, max_actors, dune_query_id, stats
         FROM flow_runs WHERE upper(token_symbol)=upper($1) AND chain='ethereum'
         ORDER BY snapshot_ts DESC LIMIT 1`,
        [sym],
      ),
    ]);

    const snapshotTs = runR.rows[0]?.snapshot_ts ? new Date(runR.rows[0].snapshot_ts).getTime() : 0;
    const stale = !snapshotTs || Date.now() - snapshotTs > CACHE_TTL_HOURS * 60 * 60_000;
    const missing = nodesR.rows.length === 0 || edgesR.rows.length === 0;
    const job = await maybeQueueRefresh(p, sym, { force: forceRefresh, stale, missing, disabled: noRefresh });

    return NextResponse.json({
      nodes: nodesR.rows.map((n) => ({
        addr: n.addr, label: n.label, kind: n.kind, family: n.protocol_family,
        degree: n.degree != null ? Number(n.degree) : null, isSeed: n.is_seed, inCycle: n.in_cycle,
      })),
      edges: edgesR.rows.map((e) => ({
        src: e.src, dst: e.dst, assetAddr: e.asset_addr, assetSymbol: e.asset_symbol,
        suspicious: e.suspicious, amount: e.amount != null ? Number(e.amount) : null,
        amountUsd: e.amount_usd != null ? Number(e.amount_usd) : null,
        cnt: Number(e.transfer_count), role: e.role, inCycle: e.in_cycle, isMintBurn: e.is_mint_burn,
        minBlock: e.min_block != null ? Number(e.min_block) : null,
        maxBlock: e.max_block != null ? Number(e.max_block) : null, sampleTx: e.sample_tx,
      })),
      meta: runR.rows[0]
        ? { snapshotTs: runR.rows[0].snapshot_ts, windowDays: runR.rows[0].window_days, stats: runR.rows[0].stats }
        : null,
      refresh: job ? {
        id: job.id,
        status: job.status,
        source: job.source,
        requestedAt: job.requested_at,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
        error: job.error,
        pid: job.pid,
        stale,
        missing,
      } : { status: "idle", stale, missing },
    });
  } catch (e) {
    // flow_* 테이블 미생성(마이그레이션 전) 포함 — 빈 그래프로 정직 응답
    return NextResponse.json({ nodes: [], edges: [], meta: null, error: (e as Error).message }, { status: 200 });
  }
}
