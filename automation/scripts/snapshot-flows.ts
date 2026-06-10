/**
 * 트랜잭션 플로우 스냅샷 (kuromi flow_trace 포팅) — 토큰 심볼만 넣으면:
 *   ① Dune 저장쿼리(7688600)로 최근 N일 코어 행위자 + 행위자간 멀티자산 흐름 수집
 *   ② 주소 라벨링(우리 nodes → 프로토콜 레지스트리 → EOA판별 → 온체인 symbol → Etherscan)
 *   ③ 병적 자기조달 고리(차입 주입 + 고리 복귀) 탐지, 역할(공급/담보·차입/인출)·스푸핑 마킹
 *   ④ flow_nodes/flow_edges 적재 (토큰당 최신 런 1개 REPLACE) → 상세그래프 탭 전용 소비
 *
 * Usage:
 *   npm run snapshot:flows -- USDe USR            # 심볼 지정
 *   npm run snapshot:flows -- --top 6             # 엣지 규모순 상위 N 토큰
 *   npm run snapshot:flows -- USDe --input f.json # Dune 결과 JSON 파일로(개발/테스트, 크레딧 0)
 * Env: DATABASE_URL(필수), DUNE_API_KEY(라이브 실행), ETHERSCAN_API_KEY(라벨 정확도, 옵션),
 *      FLOW_QUERY_ID(기본 7688600) · FLOW_WINDOW_DAYS(14) · FLOW_MAX_ACTORS(60)
 */
import { readFileSync } from "node:fs";
import process from "node:process";

import type { Address } from "viem";

import { KNOWN_TOKENS } from "@/config/tokens";
import { env } from "@/config/chains";
import { closePool, pool, query } from "@/db/client";
import { executeDuneQueryById } from "@/lib/dune";
import { getContractName } from "@/lib/etherscan";
import { getTokenPricesUsd } from "@/lib/prices";
import { rpc } from "@/lib/rpc";
import { lookupProtocol } from "@/registry/protocol-registry";
import { enrichEdges, LENDERS, ZERO_ADDR, type FlowEdgeRaw } from "@/snapshot/flow-trace";
import { collectTokenFlowRowsRpc, type FlowQueryRow } from "@/snapshot/flow-rpc";

const FLOW_QUERY_ID = Number(process.env.FLOW_QUERY_ID ?? 7688600);
const WINDOW_DAYS = Number(process.env.FLOW_WINDOW_DAYS ?? 14);
const MAX_ACTORS = Number(process.env.FLOW_MAX_ACTORS ?? 60);
const CHAIN = "ethereum"; // kuromi v1 과 동일 스코프 — Dune erc20_{chain} 테이블이라 체인별 쿼리 ID 로 확장 가능

type FlowSource = "auto" | "dune" | "rpc";

// ── 토큰 주소 해석 — nodes(ethereum) → watchlist → KNOWN_TOKENS ──
async function resolveTokenAddr(sym: string): Promise<string | null> {
  const n = await query<{ address: string }>(
    `SELECT address FROM nodes WHERE type='Token' AND chain='ethereum' AND lower(label)=lower($1) AND address IS NOT NULL LIMIT 1`,
    [sym],
  );
  if (n.rows[0]?.address) return n.rows[0].address.toLowerCase();
  const w = await query<{ token_address: string }>(
    `SELECT token_address FROM watchlist WHERE lower(symbol)=lower($1) LIMIT 1`, [sym],
  );
  if (w.rows[0]?.token_address) return w.rows[0].token_address.toLowerCase();
  for (const [addr, v] of Object.entries(KNOWN_TOKENS)) if (v.symbol.toLowerCase() === sym.toLowerCase()) return addr;
  return null;
}

// ── 주소 라벨링 (kuromi resolve 포팅 — 우리 자산 우선) ──
const SYM_ABI = [{ inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" }] as const;
interface NodeLabel { label: string; kind: "mint_burn" | "EOA" | "token" | "protocol" | "contract"; family: string | null }
const _labelCache = new Map<string, NodeLabel>();
const LENDING_FAMILIES = new Set(["morpho_blue", "aave_v3", "aave_v2", "spark", "fluid", "compound_v3", "euler"]);
const isLendingFamily = (v: NodeLabel | undefined) => !!v && v.kind === "protocol" && !!v.family && LENDING_FAMILIES.has(v.family);

async function dbAddressBook(): Promise<Map<string, { label: string; isProtocol: boolean; family: string | null }>> {
  const r = await query<{ address: string; label: string; type: string; family: string | null }>(
    `SELECT lower(address) AS address, label, type, metadata->>'family' AS family
     FROM nodes WHERE chain='ethereum' AND address IS NOT NULL`,
  );
  const m = new Map<string, { label: string; isProtocol: boolean; family: string | null }>();
  for (const row of r.rows) m.set(row.address, { label: row.label, isProtocol: row.type === "DefiProtocol", family: row.family });
  return m;
}

async function labelAddr(addr: string, book: Map<string, { label: string; isProtocol: boolean; family: string | null }>, fast = false): Promise<NodeLabel> {
  const a = addr.toLowerCase();
  if (a === ZERO_ADDR) return { label: "민트/번", kind: "mint_burn", family: null };
  const hit = _labelCache.get(a);
  if (hit) return hit;
  let out: NodeLabel | null = null;
  if (LENDERS[a]) out = { label: LENDERS[a], kind: "protocol", family: null };
  if (!out) {
    const b = book.get(a);
    if (b) out = { label: b.label, kind: b.isProtocol ? "protocol" : "token", family: b.family };
  }
  if (!out) {
    const reg = lookupProtocol(a as Address);
    if (reg) out = { label: `${reg.family.replace(/_/g, " ")} (${reg.role})`, kind: "protocol", family: reg.family };
  }
  if (!out && KNOWN_TOKENS[a]) out = { label: KNOWN_TOKENS[a].symbol, kind: "token", family: null };
  if (!out && fast) return { label: `행위자 ${a.slice(0, 10)}`, kind: "contract", family: null };
  if (!out) {
    let isContract = false;
    try { const code = await rpc().getBytecode({ address: a as Address }); isContract = !!code && code !== "0x"; } catch { /* RPC 실패 → contract 가정 안함 */ }
    if (!isContract) out = { label: `EOA ${a.slice(0, 10)}`, kind: "EOA", family: null };
  }
  if (!out) {
    try {
      const sym = (await rpc().readContract({ address: a as Address, abi: SYM_ABI, functionName: "symbol" })) as string;
      if (sym && sym.length <= 24) out = { label: sym, kind: "token", family: null };
    } catch { /* 토큰 아님 */ }
  }
  if (!out) {
    const nm = await getContractName(a, 1).catch(() => "");
    out = nm ? { label: nm, kind: "contract", family: null } : { label: `컨트랙트 ${a.slice(0, 10)}`, kind: "contract", family: null };
  }
  _labelCache.set(a, out);
  return out;
}

async function loadRows(
  sym: string,
  tokenAddr: string,
  inputFile: string | null,
  source: FlowSource,
): Promise<{ rows: FlowQueryRow[]; executionId: string | null; runSource: string }> {
  if (inputFile) {
    const rows = JSON.parse(readFileSync(inputFile, "utf8")) as FlowQueryRow[];
    console.log(`[flows] ${sym}: --input ${inputFile} (${rows.length}행, Dune/RPC 호출 생략)`);
    return { rows, executionId: null, runSource: "input" };
  }

  if (source === "rpc" || (source === "auto" && !env.DUNE_API_KEY)) {
    const rows = await collectTokenFlowRowsRpc(tokenAddr, { chain: CHAIN, windowDays: WINDOW_DAYS, maxActors: MAX_ACTORS });
    return { rows, executionId: null, runSource: env.DUNE_API_KEY ? "rpc" : "rpc-no-dune-key" };
  }

  try {
    const r = await executeDuneQueryById<FlowQueryRow>(FLOW_QUERY_ID, [
      { key: "token_address", value: tokenAddr, type: "text" },
      { key: "window_days", value: String(WINDOW_DAYS), type: "number" },
      { key: "max_actors", value: String(MAX_ACTORS), type: "number" },
    ], { maxRows: 2500, pollSec: Number(process.env.FLOW_DUNE_POLL_SEC ?? 3600) });
    return { rows: r.rows, executionId: r.executionId, runSource: "dune" };
  } catch (e) {
    if (source === "dune") throw e;
    console.warn(`[flows] ${sym}: Dune 지연/실패 → RPC Transfer 폴백 (${(e as Error).message.slice(0, 120)})`);
    const rows = await collectTokenFlowRowsRpc(tokenAddr, { chain: CHAIN, windowDays: WINDOW_DAYS, maxActors: MAX_ACTORS });
    return { rows, executionId: null, runSource: "rpc-fallback" };
  }
}

async function persistRows(
  sym: string,
  rows: FlowQueryRow[],
  executionId: string | null,
  runSource: string,
): Promise<void> {
  const snapshotTs = new Date().toISOString();

  const actorRows = rows.filter((r) => r.row_kind === "actor" && r.src);
  const edgeRows = rows.filter((r) => r.row_kind === "edge" && r.src && r.dst && r.asset);
  const degree = new Map(actorRows.map((r) => [r.src.toLowerCase(), Number(r.degree ?? 0)]));
  const seedTop = new Set([...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([a]) => a)); // kuromi nseeds≈4~8

  const raw: FlowEdgeRaw[] = edgeRows.map((r) => ({
    src: r.src.toLowerCase(), dst: (r.dst as string).toLowerCase(), asset: (r.asset as string).toLowerCase(),
    assetSymbol: r.asset_symbol || null, amount: Number(r.amount ?? 0), cnt: Number(r.cnt ?? 1),
    minBlock: r.min_block, maxBlock: r.max_block, sampleTx: r.sample_tx,
  }));

  // ② 사이클·역할·스푸핑
  const { edges, cycleNodes } = enrichEdges(raw);

  // ③ 라벨링 (DB 주소록 1회 로드 → 캐시)
  const book = await dbAddressBook();
  const addrs = new Set<string>();
  for (const e of edges) { addrs.add(e.src); addrs.add(e.dst); }
  for (const a of degree.keys()) addrs.add(a);
  const labels = new Map<string, NodeLabel>();
  const fastLabels = runSource.startsWith("rpc");
  for (const a of addrs) labels.set(a, await labelAddr(a, book, fastLabels));
  for (const e of edges) {
    if (e.role) continue;
    if (isLendingFamily(labels.get(e.dst))) e.role = "공급/담보";
    else if (isLendingFamily(labels.get(e.src))) e.role = "차입/인출";
  }

  // ④ USD 환산 — 알려진 자산만 (llama, 메인넷). 모르는 자산은 null(정직).
  const assetAddrs = [...new Set(edges.map((e) => e.asset))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const prices = await getTokenPricesUsd(assetAddrs as Address[], "ethereum").catch(() => new Map<string, number>());

  // ⑤ 적재 (REPLACE)
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM flow_nodes WHERE token_symbol=$1 AND chain=$2`, [sym, CHAIN]);
    await client.query(`DELETE FROM flow_edges WHERE token_symbol=$1 AND chain=$2`, [sym, CHAIN]);
    for (const a of addrs) {
      const L = labels.get(a)!;
      await client.query(
        `INSERT INTO flow_nodes (token_symbol, chain, addr, label, kind, protocol_family, degree, is_seed, in_cycle, snapshot_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (token_symbol, chain, addr) DO UPDATE SET label=EXCLUDED.label, kind=EXCLUDED.kind,
           degree=EXCLUDED.degree, is_seed=EXCLUDED.is_seed, in_cycle=EXCLUDED.in_cycle, snapshot_ts=EXCLUDED.snapshot_ts`,
        [sym, CHAIN, a, L.label, L.kind, L.family, degree.get(a) ?? null, seedTop.has(a), cycleNodes.has(a), snapshotTs],
      );
    }
    for (const e of edges) {
      const px = prices.get(e.asset);
      await client.query(
        `INSERT INTO flow_edges (token_symbol, chain, src, dst, asset_addr, asset_symbol, suspicious, amount, amount_usd,
                                 transfer_count, role, in_cycle, is_mint_burn, min_block, max_block, sample_tx, snapshot_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (token_symbol, chain, src, dst, asset_addr) DO UPDATE SET
           amount=EXCLUDED.amount, amount_usd=EXCLUDED.amount_usd, transfer_count=EXCLUDED.transfer_count,
           role=EXCLUDED.role, in_cycle=EXCLUDED.in_cycle, suspicious=EXCLUDED.suspicious,
           min_block=EXCLUDED.min_block, max_block=EXCLUDED.max_block, sample_tx=EXCLUDED.sample_tx, snapshot_ts=EXCLUDED.snapshot_ts`,
        [sym, CHAIN, e.src, e.dst, e.asset, e.assetSymbol, e.suspicious, e.amount, px != null ? e.amount * px : null,
         e.cnt, e.role, e.inCycle, e.isMintBurn, e.minBlock, e.maxBlock, e.sampleTx, snapshotTs],
      );
    }
    await client.query(
      `INSERT INTO flow_runs (token_symbol, chain, snapshot_ts, window_days, max_actors, dune_query_id, dune_execution_id, stats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [sym, CHAIN, snapshotTs, WINDOW_DAYS, MAX_ACTORS, runSource === "dune" ? FLOW_QUERY_ID : null, executionId,
       JSON.stringify({ source: runSource, actors: degree.size, edges: edges.length, cycleNodes: cycleNodes.size, mintBurnEdges: edges.filter((e) => e.isMintBurn).length, lenderEdges: edges.filter((e) => e.role).length })],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const cyc = cycleNodes.size;
  console.log(`[flows] ${sym}: ${runSource} · 행위자 ${degree.size} · 엣지 ${edges.length} (렌더역할 ${edges.filter((e) => e.role).length}, 민트/번 ${edges.filter((e) => e.isMintBurn).length})${cyc ? ` · 🔴 자기조달 고리 노드 ${cyc}` : ""}`);
}

// ── 한 토큰 처리 ──
async function runToken(sym: string, inputFile: string | null, source: FlowSource, bootstrapRpc: boolean): Promise<void> {
  const tokenAddr = await resolveTokenAddr(sym);
  if (!tokenAddr) { console.warn(`[flows] ${sym}: 주소 해석 실패(메인넷 노드/워치리스트에 없음) — skip`); return; }

  if (bootstrapRpc && !inputFile && source !== "rpc") {
    try {
      const rpcRows = await collectTokenFlowRowsRpc(tokenAddr, { chain: CHAIN, windowDays: WINDOW_DAYS, maxActors: Math.min(MAX_ACTORS, 40) });
      if (rpcRows.length) await persistRows(sym, rpcRows, null, "rpc-bootstrap");
    } catch (e) {
      console.warn(`[flows] ${sym}: RPC bootstrap 실패(계속 진행): ${(e as Error).message.slice(0, 120)}`);
    }
  }

  const { rows, executionId, runSource } = await loadRows(sym, tokenAddr, inputFile, source);
  await persistRows(sym, rows, executionId, runSource);
}

async function topSymbols(n: number): Promise<string[]> {
  const r = await query<{ sym: string }>(
    `SELECT split_part(replace(e.token_node_id, 'token:', ''), '@', 1) AS sym, sum(e.weight) AS w
     FROM edges e JOIN nodes t ON t.node_id = e.token_node_id AND t.chain = 'ethereum'
     WHERE e.snapshot_ts > now() - interval '3 days'
     GROUP BY 1 ORDER BY w DESC NULLS LAST LIMIT $1`, [n],
  );
  return r.rows.map((x) => x.sym);
}

async function main() {
  if (!env.DATABASE_URL) { console.error("[flows] DATABASE_URL 필요"); process.exit(1); }
  const argv = process.argv.slice(2);
  const inputIdx = argv.indexOf("--input");
  const inputFile = inputIdx >= 0 ? argv[inputIdx + 1] : null;
  const topIdx = argv.indexOf("--top");
  const topN = topIdx >= 0 ? Number(argv[topIdx + 1] ?? 6) : 0;
  const sourceIdx = argv.indexOf("--source");
  const rawSource = (sourceIdx >= 0 ? argv[sourceIdx + 1] : process.env.FLOW_SOURCE ?? "auto") as FlowSource;
  const source: FlowSource = rawSource === "dune" || rawSource === "rpc" || rawSource === "auto" ? rawSource : "auto";
  const bootstrapRpc = argv.includes("--bootstrap-rpc") || process.env.FLOW_BOOTSTRAP_RPC === "1";
  const jobIdx = argv.indexOf("--job-id");
  const jobId = jobIdx >= 0 ? Number(argv[jobIdx + 1]) : 0;
  const valueFlags = new Set(["--input", "--top", "--source", "--job-id"]);
  const syms = argv.filter((s, i) => !s.startsWith("-") && !valueFlags.has(argv[i - 1] ?? ""));

  let targets = syms;
  if (!targets.length && topN > 0) targets = await topSymbols(topN);
  if (!targets.length) { console.error("[flows] 대상 없음 — 심볼 또는 --top N"); process.exit(1); }
  if (!inputFile && source === "dune" && !env.DUNE_API_KEY) {
    console.error("[flows] DUNE_API_KEY 미설정 — automation/.env 에 추가 (쿼리는 Dune ID " + FLOW_QUERY_ID + " 로 저장돼 있음). 개발은 --input <json> 가능.");
    process.exit(1);
  }

  if (jobId > 0) {
    await query(
      `UPDATE flow_refresh_jobs SET status='running', started_at=COALESCE(started_at, now()), pid=$2, source=$3, error=NULL WHERE id=$1`,
      [jobId, process.pid, source],
    ).catch(() => {});
  }

  let failed = false;
  let lastErr = "";
  for (const sym of targets) {
    try { await runToken(sym, inputFile, source, bootstrapRpc); }
    catch (e) {
      failed = true;
      lastErr = (e as Error).message.slice(0, 300);
      console.error(`[flows] ${sym} 실패:`, lastErr.slice(0, 120));
    }
  }
  if (jobId > 0) {
    await query(
      `UPDATE flow_refresh_jobs
       SET status=$2, finished_at=now(), error=$3
       WHERE id=$1`,
      [jobId, failed ? "failed" : "completed", failed ? lastErr : null],
    ).catch(() => {});
  }
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
