import type {
  EdgeSnapshot,
  ProtocolNodeSnapshot,
  TokenNodeSnapshot,
  TokenSnapshotResult,
} from "@/types/edge-schema";

import { cooldownSecondsFor, type Severity } from "@/config/alert-thresholds";
import { dispatchAlert } from "@/lib/notify";
import { STATE_SOURCES } from "@/snapshot/detector-registry";
import { applyFpFilters, defaultFpContext } from "@/snapshot/fp-filters";

import { pool, query } from "./client";

/** Upsert a token node — idempotent by node_id. */
export async function upsertTokenNode(n: TokenNodeSnapshot): Promise<void> {
  await query(
    `
    INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
    VALUES ($1, $2, $3, $4, 'ethereum', $5::jsonb, now())
    ON CONFLICT (node_id) DO UPDATE SET
      label = EXCLUDED.label,
      address = EXCLUDED.address,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    `,
    [n.nodeId, n.type, n.label, n.address, JSON.stringify(n.metadata)],
  );
}

/** Upsert a protocol node — idempotent by node_id. */
export async function upsertProtocolNode(n: ProtocolNodeSnapshot): Promise<void> {
  await query(
    `
    INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
    VALUES ($1, $2, $3, $4, 'ethereum', $5::jsonb, now())
    ON CONFLICT (node_id) DO UPDATE SET
      label = EXCLUDED.label,
      address = EXCLUDED.address,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    `,
    [n.nodeId, n.type, n.label, n.address, JSON.stringify(n.metadata)],
  );
}

/** Insert an edge for a specific snapshot timestamp. */
export async function insertEdge(
  e: EdgeSnapshot,
  snapshotTs: string,
  blockNumber: number | null,
): Promise<void> {
  await query(
    `
    INSERT INTO edges (snapshot_ts, token_node_id, protocol_node_id, edge_type, weight, attrs, block_number)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    ON CONFLICT (snapshot_ts, token_node_id, protocol_node_id) DO UPDATE SET
      edge_type = EXCLUDED.edge_type,
      weight = EXCLUDED.weight,
      attrs = EXCLUDED.attrs,
      block_number = EXCLUDED.block_number
    `,
    [snapshotTs, e.source, e.target, e.type, e.weight, JSON.stringify(e.attrs), blockNumber],
  );
}

/** Queue an unknown address for manual review. */
export async function queueUnknownAddress(
  address: string,
  firstSeenToken: string,
  rawBalance: bigint,
  hint: string | null,
): Promise<void> {
  await query(
    `
    INSERT INTO unknown_addresses (address, first_seen_token, raw_balance, heuristic_hint)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (address) DO UPDATE SET
      raw_balance = EXCLUDED.raw_balance,
      heuristic_hint = COALESCE(EXCLUDED.heuristic_hint, unknown_addresses.heuristic_hint)
    `,
    [address.toLowerCase(), firstSeenToken, rawBalance.toString(), hint],
  );
}

/** Update watchlist's last_snapshot_ts after a successful run. */
export async function markWatchlistSnapshotted(tokenAddress: string, snapshotTs: string): Promise<void> {
  await query(
    `UPDATE watchlist SET last_snapshot_ts = $2 WHERE token_address = $1`,
    [tokenAddress.toLowerCase(), snapshotTs],
  );
}

/**
 * Audit log of a cron snapshot execution → snapshot_runs.
 * 한 cron 실행(예: snapshot-all = ethereum 배치, snapshot-chain = 체인 1개)당 1행.
 * token_address 는 배치면 null, 체인 런이면 "chain:<name>" 식으로 그 런의 스코프 표기.
 * 나중 백테스트가 cron 건강도/시점/처리량을 읽는 데 쓰임.
 */
export interface SnapshotRunRecord {
  startedAt: string; // ISO
  status: "ok" | "error";
  tokenAddress?: string | null;
  blockNumber?: number | null;
  edgesWritten?: number | null;
  unknownsAdded?: number | null;
  errorMessage?: string | null;
}
export async function recordSnapshotRun(r: SnapshotRunRecord): Promise<void> {
  await query(
    `INSERT INTO snapshot_runs
       (started_at, finished_at, status, token_address, block_number, edges_written, unknowns_added, error_message)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7)`,
    [r.startedAt, r.status, r.tokenAddress ?? null, r.blockNumber ?? null,
     r.edgesWritten ?? null, r.unknownsAdded ?? null, r.errorMessage ?? null],
  );
}

/** Add or refresh a watchlist entry — sets active=TRUE (approved/seed). */
export async function upsertWatchlist(
  tokenAddress: string,
  symbol: string,
  reason: string,
): Promise<void> {
  await query(
    `
    INSERT INTO watchlist (token_address, symbol, reason, active)
    VALUES ($1, $2, $3, TRUE)
    ON CONFLICT (token_address) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      reason = EXCLUDED.reason,
      active = TRUE
    `,
    [tokenAddress.toLowerCase(), symbol, reason],
  );
}

/**
 * Propose a discovered token to the REVIEW QUEUE (active=FALSE).
 *
 * 중요: 이미 존재하는 토큰의 active 상태는 절대 건드리지 않음
 *   - 이미 승인됨(active=TRUE) → 그대로 유지 (다운그레이드 X)
 *   - 이미 제안됨(active=FALSE) → metric 만 갱신
 *   - 신규 → active=FALSE 로 삽입
 * snapshot:all 은 active=TRUE 만 읽으므로 제안 토큰은 승인 전까지 추적 안 됨.
 */
export async function proposeWatchlistCandidate(
  tokenAddress: string,
  symbol: string,
  source: string,
  metricUsd: number,
): Promise<"inserted" | "updated"> {
  const r = await query<{ inserted: boolean }>(
    `
    INSERT INTO watchlist (token_address, symbol, reason, active, discovery_source, discovery_metric_usd)
    VALUES ($1, $2, $3, FALSE, $3, $4)
    ON CONFLICT (token_address) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      discovery_source = EXCLUDED.discovery_source,
      discovery_metric_usd = EXCLUDED.discovery_metric_usd
      -- active 는 일부러 갱신하지 않음 (기존 승인 상태 보존)
    RETURNING (xmax = 0) AS inserted
    `,
    [tokenAddress.toLowerCase(), symbol, source, metricUsd],
  );
  return r.rows[0]?.inserted ? "inserted" : "updated";
}

/** 검토 대기 중(active=FALSE)인 제안 토큰 목록. */
export async function listProposedCandidates(): Promise<
  Array<{ token_address: string; symbol: string; discovery_source: string | null; discovery_metric_usd: number | null }>
> {
  const r = await query<{
    token_address: string;
    symbol: string;
    discovery_source: string | null;
    discovery_metric_usd: number | null;
  }>(
    `SELECT token_address, symbol, discovery_source, discovery_metric_usd
     FROM watchlist WHERE active = FALSE ORDER BY discovery_metric_usd DESC NULLS LAST`,
  );
  return r.rows;
}

/** 제안 토큰 승인 → active=TRUE flip. */
export async function approveWatchlistCandidate(tokenAddress: string): Promise<boolean> {
  const r = await query(
    `UPDATE watchlist SET active = TRUE, reviewed_at = now() WHERE token_address = $1 AND active = FALSE`,
    [tokenAddress.toLowerCase()],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 제안 토큰 거절 → 삭제 (또는 reviewed_at 만 찍고 보관하려면 수정). */
export async function rejectWatchlistCandidate(tokenAddress: string): Promise<boolean> {
  const r = await query(
    `DELETE FROM watchlist WHERE token_address = $1 AND active = FALSE`,
    [tokenAddress.toLowerCase()],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 자동수집(discovery) 토큰 중 이번 패스에 없는 것을 active=FALSE 로 내림.
 * 수동 추가(reason='manual')는 건드리지 않음. set == 현재 임계 세트 유지.
 * @returns 해제된 토큰 수
 */
export async function deactivateDiscoveredExcept(keepAddresses: string[]): Promise<number> {
  const keep = keepAddresses.map((a) => a.toLowerCase());
  const r = await query(
    `UPDATE watchlist SET active = FALSE
     WHERE active = TRUE
       AND reason <> 'manual'
       AND NOT (token_address = ANY($1::text[]))`,
    [keep],
  );
  return r.rowCount ?? 0;
}

/** 관리자가 제외(exclude)한 토큰 주소 집합 — discover 가 재활성화 금지. */
export async function getExcludedAddresses(): Promise<Set<string>> {
  const r = await query<{ token_address: string }>(
    `SELECT token_address FROM watchlist WHERE excluded = TRUE`,
  ).catch(() => ({ rows: [] as { token_address: string }[] }));
  return new Set(r.rows.map((x) => x.token_address.toLowerCase()));
}

/** 관리자 핀 — 임계 무관 항상 추적 (reason='manual', active=TRUE, 제외 해제). */
export async function pinWatchlist(tokenAddress: string, symbol: string): Promise<void> {
  await query(
    `INSERT INTO watchlist (token_address, symbol, reason, active, excluded)
     VALUES ($1, $2, 'manual', TRUE, FALSE)
     ON CONFLICT (token_address) DO UPDATE SET
       symbol = EXCLUDED.symbol, reason = 'manual', active = TRUE, excluded = FALSE`,
    [tokenAddress.toLowerCase(), symbol],
  );
}

/** 관리자 제외 — 임계 통과해도 추적 안 함 (active=FALSE, excluded=TRUE). */
export async function excludeWatchlist(tokenAddress: string): Promise<void> {
  await query(
    `INSERT INTO watchlist (token_address, symbol, reason, active, excluded)
     VALUES ($1, $1, 'excluded', FALSE, TRUE)
     ON CONFLICT (token_address) DO UPDATE SET active = FALSE, excluded = TRUE`,
    [tokenAddress.toLowerCase()],
  );
}

/** 관리자 핀/제외 해제 — 자동 임계 규칙으로 복귀. */
export async function unpinWatchlist(tokenAddress: string): Promise<void> {
  await query(
    `UPDATE watchlist SET excluded = FALSE, reason = COALESCE(discovery_source, 'auto')
     WHERE token_address = $1`,
    [tokenAddress.toLowerCase()],
  );
}

export async function listActiveWatchlist(): Promise<Array<{ token_address: string; symbol: string }>> {
  const r = await query<{ token_address: string; symbol: string }>(
    `SELECT token_address, symbol FROM watchlist WHERE active = TRUE ORDER BY added_at ASC`,
  );
  return r.rows;
}

/** diff 알림을 DB에 적재 (프론트 패널 + 이력). 최근 동일 알림은 중복 삽입 안 함. */
export async function insertAlert(a: {
  severity: string;
  kind: string;
  token: string;
  protocolNodeId?: string;
  message: string;
  detail?: Record<string, unknown>;
  snapshotTs?: string;
  /** 알림 계약 — 어느 알고리즘이 낸 알림인지. 외부 알고리즘 swap 시 추적용. 기본 builtin-v1. */
  source?: string;
}): Promise<boolean> {
  // FP 필터 (risk_rules filter 층 포팅, fp-filters.ts) — 양성패턴(CEX/브릿지 이동·RWA 디스카운트·리베이스·
  // bridge in-flight)은 발화 안 함. CRITICAL·near-LT 은 안전캡으로 항상 통과. coverage-gap(미검증 엣지)은 annotate.
  const fp = applyFpFilters(
    { severity: a.severity as "info" | "warning" | "critical", kind: a.kind, token: a.token, protocolNodeId: a.protocolNodeId, detail: a.detail },
    defaultFpContext(),
  );
  if (fp.verdict === "SUPPRESSED") {
    console.log(`[alerts] FP-filter 억제: ${a.kind}/${a.token} — ${fp.notes}`);
    return false;
  }
  if (fp.verdict === "ANNOTATED") {
    a.detail = { ...(a.detail ?? {}), fpFilter: { applied: fp.applied, notes: fp.notes } };
  }

  // Dedup — 동일 (kind, token, protocol) 알림이 쿨다운 내 있으면 skip. 단 **escalation-aware**:
  //   기존 active 가 새 알림보다 **같거나 높은 severity** 일 때만 억제. 새 알림이 더 높으면(info→warning→critical
  //   악화) 통과시켜 재발화 = 갑작스런 동결·악화를 묻지 않음(2026-06: standing info 가 전이 warning 을 막던 것 수정).
  //   resolved 제외 → auto-resolve 후 재발생 즉시 재발화. acknowledged 는 카운트 → 수동 ack 음소거 유지.
  //   risk_rules cooldown: critical 1h / warning 12h / info 24h.
  const cooldownSec = cooldownSecondsFor(a.severity as Severity);
  const sevRank = a.severity === "critical" ? 3 : a.severity === "warning" ? 2 : 1;
  const dup = await query<{ id: string; message: string }>(
    `SELECT id, message FROM alerts
     WHERE kind=$1 AND token=$2 AND coalesce(protocol_node_id,'')=coalesce($3,'')
       AND resolved_at IS NULL
       AND (CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END) >= $5
       AND created_at > now() - make_interval(secs => $4::double precision)
     ORDER BY created_at DESC LIMIT 1`,
    [a.kind, a.token, a.protocolNodeId ?? null, cooldownSec, sevRank],
  ).catch(() => ({ rows: [] as { id: string; message: string }[] }));
  if (dup.rows.length > 0) {
    // dedup: 재삽입·재발송 안 함. 단 **메시지/detail 이 바뀌었으면 in-place 갱신**(문구 리팩터·라이브 값 최신화).
    //   created_at(온셋) 보존. 알림 종류·severity 는 그대로라 재페이지 없음. (2026-06: 이벤트 알림 문구 최신화.)
    const d = dup.rows[0];
    if (d.message !== a.message) {
      await query(`UPDATE alerts SET message=$2, detail=$3::jsonb WHERE id=$1`,
        [d.id, a.message, a.detail ? JSON.stringify(a.detail) : null]).catch(() => {});
    }
    return false;
  }

  await query(
    `INSERT INTO alerts (snapshot_ts, severity, kind, token, protocol_node_id, message, detail, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      a.snapshotTs ?? null,
      a.severity,
      a.kind,
      a.token,
      a.protocolNodeId ?? null,
      a.message,
      a.detail ? JSON.stringify(a.detail) : null,
      a.source ?? "builtin-v1",
    ],
  ).catch((e) => console.warn("[alerts] insert failed:", (e as Error).message));

  // 채널 발송(D#9) — env 설정된 채널로만, fire-and-forget(메인 파이프라인 비차단). info 는 notify 내부에서 skip.
  void dispatchAlert({ severity: a.severity, kind: a.kind, token: a.token, message: a.message, source: a.source ?? "builtin-v1" });
  return true;
}

// 알림 활성키(kind|token|protocol) Set — 전체스캔 디텍터가 "이미 활성이면 재삽입 skip"용. source 로 스코프.
export async function loadActiveAlertKeys(kinds: string[], source: string): Promise<Set<string>> {
  const r = await query<{ kind: string; token: string; p: string }>(
    `SELECT kind, token, coalesce(protocol_node_id,'') p FROM alerts
     WHERE kind = ANY($1::text[]) AND source = $2 AND acknowledged IS NOT TRUE AND resolved_at IS NULL`,
    [kinds, source],
  ).catch(() => ({ rows: [] as { kind: string; token: string; p: string }[] }));
  return new Set(r.rows.map((x) => `${x.kind}|${x.token}|${x.p}`));
}

// 상태형 디텍터용 — 활성 키 → {id, severity, message} 맵. (loadActiveAlertKeys 의 변형: severity·message 재calibration 지원.)
export async function loadActiveStateAlerts(kinds: string[], source: string): Promise<Map<string, { id: string; severity: Severity; message: string }>> {
  const r = await query<{ id: string; kind: string; token: string; p: string; severity: Severity; message: string }>(
    `SELECT id, kind, token, coalesce(protocol_node_id,'') p, severity, message FROM alerts
     WHERE kind = ANY($1::text[]) AND source = $2 AND acknowledged IS NOT TRUE AND resolved_at IS NULL
     ORDER BY created_at ASC`,
    [kinds, source],
  ).catch(() => ({ rows: [] as { id: string; kind: string; token: string; p: string; severity: Severity; message: string }[] }));
  const m = new Map<string, { id: string; severity: Severity; message: string }>();
  for (const x of r.rows) m.set(`${x.kind}|${x.token}|${x.p}`, { id: x.id, severity: x.severity, message: x.message });
  return m;
}

const _sevRank = (s: string): number => (s === "critical" ? 3 : s === "warning" ? 2 : 1);

/**
 * 상태형 알림 재calibration — 조건은 지속(active)되는데 계산된 **severity 또는 message 가 바뀌면 기존 row 를
 *   in-place 갱신**(severity 완화·악화 + 메시지 문구 변경 모두 반영). 악화(escalation)면 채널 재발송, 그 외(완화·
 *   메시지만 변경)는 조용히(재페이지 churn 방지). in-place 라 created_at(온셋 시각) 보존.
 *   (구버전 assert-once: active 면 무조건 skip → severity·문구 변화가 영영 반영 안 됨. 라벨/문구 리팩터가 이를 노출.)
 */
export async function updateStateAlert(
  active: { id: string; severity: string; message: string },
  a: { severity: string; kind: string; token: string; message: string; detail?: Record<string, unknown>; source?: string },
): Promise<"unchanged" | "updated" | "escalated"> {
  const sevChanged = active.severity !== a.severity;
  const msgChanged = active.message !== a.message;
  if (!sevChanged && !msgChanged) return "unchanged";
  await query(
    `UPDATE alerts SET severity=$2, message=$3, detail=$4::jsonb WHERE id=$1`,
    [active.id, a.severity, a.message, a.detail ? JSON.stringify(a.detail) : null],
  ).catch((e) => console.warn("[alerts] 상태알림 갱신 실패:", (e as Error).message));
  const escalated = sevChanged && _sevRank(a.severity) > _sevRank(active.severity);
  if (escalated) void dispatchAlert({ severity: a.severity, kind: a.kind, token: a.token, message: a.message, source: a.source ?? "builtin-v1" });
  return escalated ? "escalated" : "updated";
}

// 상태형 알림 auto-resolve — 이번 스캔이 assert 한 (kind|token|protocol) 집합에 없는 active 알림(=조건 해소)을
// resolved 처리. source 로 스코프해 다른 디텍터(diff/nonevm)의 동일 kind 를 건드리지 않음. 반환: resolved 건수.
export async function resolveStaleAlerts(kinds: string[], assertedKeys: Set<string>, source: string): Promise<number> {
  const r = await query<{ id: string; kind: string; token: string; p: string }>(
    `SELECT id, kind, token, coalesce(protocol_node_id,'') p FROM alerts
     WHERE kind = ANY($1::text[]) AND source = $2 AND acknowledged IS NOT TRUE AND resolved_at IS NULL`,
    [kinds, source],
  ).catch(() => ({ rows: [] as { id: string; kind: string; token: string; p: string }[] }));
  const toResolve = r.rows.filter((row) => !assertedKeys.has(`${row.kind}|${row.token}|${row.p}`)).map((row) => row.id);
  if (!toResolve.length) return 0;
  await query(`UPDATE alerts SET resolved_at = now(), resolution_reason = 'auto:condition_cleared' WHERE id = ANY($1::bigint[])`, [toResolve]).catch(() => {});
  return toResolve.length;
}

/**
 * 이벤트형 알림 TTL 만료 — STATE 디텍터(resolveStaleAlerts 로 auto-resolve)는 제외하고, 이벤트형(자체 해소
 *   로직 없음)을 severity 별 경과시간 초과 시 resolved 처리. 조건 종료 후에도 DB 에 영구 잔존하던 문제 해결
 *   (FP 감사 2026-06: util_jump/liquidity_drop 등 종료된 이벤트가 active 로 남음). acknowledged 는 안 건드림.
 *   cron 이 주기 호출. 기본 TTL: critical 72h / warning 48h / info 24h(프론트 24h fade 와 정렬).
 */
export async function resolveExpiredEvents(
  ttlHours: { critical: number; warning: number; info: number } = { critical: 72, warning: 48, info: 24 },
): Promise<number> {
  const r = await query(
    `UPDATE alerts SET resolved_at = now(), resolution_reason = 'auto:event_ttl'
     WHERE resolved_at IS NULL AND acknowledged IS NOT TRUE
       AND source <> ALL($1::text[])
       AND created_at < now() - make_interval(hours =>
            (CASE severity WHEN 'critical' THEN $2::int WHEN 'warning' THEN $3::int ELSE $4::int END))`,
    [STATE_SOURCES as readonly string[], ttlHours.critical, ttlHours.warning, ttlHours.info],
  ).catch((e) => { console.warn("[alerts] resolveExpiredEvents 실패:", (e as Error).message); return { rowCount: 0 }; });
  return r.rowCount ?? 0;
}

/**
 * 루핑/ouroboros 계약 writer. 현 structural-v1(구조적 휴리스틱)이 기록.
 * 외부 flow-tracker 가 같은 스키마에 'flowtracker-vX' 로 upsert → UI 무변경 swap.
 * (source, token_node_id, market_key, kind) 단위 최신값 upsert.
 */
export async function upsertLoopFinding(f: {
  token: string;
  tokenNodeId?: string;
  protocolNodeId?: string;
  marketKey?: string;
  kind: "ouroboros" | "self_loop" | "cross_protocol";
  collateralSymbol?: string;
  loanSymbol?: string;
  loopedUsd?: number | null;
  lltv?: number | null;
  participants?: unknown;
  confidence?: "low" | "medium" | "high";
  source?: string;
  snapshotTs?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO loop_findings
       (snapshot_ts, token, token_node_id, protocol_node_id, market_key, kind,
        collateral_symbol, loan_symbol, looped_usd, lltv, participants, confidence, source, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb)
     ON CONFLICT (source, coalesce(token_node_id,''), coalesce(market_key,''), kind)
     DO UPDATE SET snapshot_ts=EXCLUDED.snapshot_ts, detected_at=now(),
       looped_usd=EXCLUDED.looped_usd, lltv=EXCLUDED.lltv,
       participants=EXCLUDED.participants, confidence=EXCLUDED.confidence,
       collateral_symbol=EXCLUDED.collateral_symbol, loan_symbol=EXCLUDED.loan_symbol,
       protocol_node_id=EXCLUDED.protocol_node_id, detail=EXCLUDED.detail`,
    [
      f.snapshotTs ?? null,
      f.token,
      f.tokenNodeId ?? null,
      f.protocolNodeId ?? null,
      f.marketKey ?? null,
      f.kind,
      f.collateralSymbol ?? null,
      f.loanSymbol ?? null,
      f.loopedUsd ?? null,
      f.lltv ?? null,
      f.participants ? JSON.stringify(f.participants) : null,
      f.confidence ?? "low",
      f.source ?? "structural-v1",
      f.detail ? JSON.stringify(f.detail) : null,
    ],
  ).catch((e) => console.warn("[loop_findings] upsert failed:", (e as Error).message));
}

/**
 * 토큰 변형(래핑본/CCIP 원격) 1급 레코드 — note 텍스트가 아닌 정식 테이블에 보존.
 * (token, chain, address) 단위 최신값 upsert. kind: 'bridged_wrapped' | 'ccip_remote'.
 *
 * keepBridged=true 면 이미 'bridged_wrapped' 로 박힌 행은 덮어쓰지 않음(kind 유지).
 *   래핑본(lock&mint 확정)이 CCIP 원격 추정으로 강등되는 것 방지 — ccip_remote 적재 시 사용.
 *   같은 PK 가 ccip_remote 끼리 재적재되는 건 그대로 갱신(snapshot_ts refresh).
 */
export async function upsertTokenVariant(v: {
  token: string;
  chain: string;
  address: string;
  sourceChain?: string | null;
  via?: string | null;
  kind: "bridged_wrapped" | "ccip_remote";
  note?: string | null;
  snapshotTs?: string;
  keepBridged?: boolean;
}): Promise<void> {
  // keepBridged 면 기존 bridged_wrapped 행은 보존(WHERE 로 업데이트 제외 → PK 충돌 시 no-op).
  const guard = v.keepBridged ? ` WHERE token_variants.kind <> 'bridged_wrapped'` : "";
  await query(
    `INSERT INTO token_variants (token, chain, address, source_chain, via, kind, note, snapshot_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()))
     ON CONFLICT (token, chain, address) DO UPDATE SET
       source_chain=EXCLUDED.source_chain, via=EXCLUDED.via, kind=EXCLUDED.kind,
       note=EXCLUDED.note, snapshot_ts=EXCLUDED.snapshot_ts${guard}`,
    [v.token, v.chain, v.address.toLowerCase(), v.sourceChain ?? null, v.via ?? null, v.kind, v.note ?? null, v.snapshotTs ?? null],
  );
}

/** Persist an entire snapshot result. */
export async function persistSnapshot(result: TokenSnapshotResult): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    // Nodes
    await client.query(
      `
      INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
      VALUES ($1, $2, $3, $4, 'ethereum', $5::jsonb, now())
      ON CONFLICT (node_id) DO UPDATE SET
        label = EXCLUDED.label, address = EXCLUDED.address, metadata = EXCLUDED.metadata, updated_at = now()
      `,
      [
        result.token.nodeId,
        result.token.type,
        result.token.label,
        result.token.address,
        JSON.stringify(result.token.metadata),
      ],
    );
    for (const p of result.protocols) {
      await client.query(
        `
        INSERT INTO nodes (node_id, type, label, address, chain, metadata, updated_at)
        VALUES ($1, $2, $3, $4, 'ethereum', $5::jsonb, now())
        ON CONFLICT (node_id) DO UPDATE SET
          label = EXCLUDED.label, address = EXCLUDED.address, metadata = EXCLUDED.metadata, updated_at = now()
        `,
        [p.nodeId, p.type, p.label, p.address, JSON.stringify(p.metadata)],
      );
    }
    // Edges
    for (const e of result.edges) {
      await client.query(
        `
        INSERT INTO edges (snapshot_ts, token_node_id, protocol_node_id, edge_type, weight, attrs, block_number)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (snapshot_ts, token_node_id, protocol_node_id) DO UPDATE SET
      edge_type = EXCLUDED.edge_type,
          weight = EXCLUDED.weight, attrs = EXCLUDED.attrs, block_number = EXCLUDED.block_number
        `,
        [
          result.snapshotTs,
          e.source,
          e.target,
          e.type,
          e.weight,
          JSON.stringify(e.attrs),
          result.blockNumber,
        ],
      );
    }
    // Unknowns
    for (const u of result.unknownAddresses) {
      await client.query(
        `
        INSERT INTO unknown_addresses (address, first_seen_token, raw_balance, heuristic_hint)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (address) DO UPDATE SET
          raw_balance = EXCLUDED.raw_balance,
          heuristic_hint = COALESCE(EXCLUDED.heuristic_hint, unknown_addresses.heuristic_hint)
        `,
        [u.address.toLowerCase(), result.token.address, u.balance.toString(), u.hint],
      );
    }
    // totalSupply 시계열 샘플 — robust z-score(Detector C) 윈도용. append-only.
    // A1 신뢰성 가드: flaky read(멀티콜 부분실패 등으로 스케일이 틀린 값)가 z-score baseline 을
    // 오염시키는 것 방지. 최근 중앙값 대비 >35% 벗어나면 의심 read 로 보고 샘플 skip(베이스라인 보존).
    // (실제 대형 민팅은 block-level single-mint detector 가 별도로 잡으므로 놓치지 않음.)
    const newSupply = result.token.metadata.totalSupply ?? 0;
    let writeSupply = true;
    if (newSupply > 0) {
      const prev = await client.query<{ total_supply: string }>(
        `SELECT total_supply FROM supply_samples WHERE token_node_id=$1 ORDER BY snapshot_ts DESC LIMIT 6`,
        [result.token.nodeId],
      );
      const vals = prev.rows.map((r) => Number(r.total_supply)).filter((v) => v > 0).sort((a, b) => a - b);
      if (vals.length >= 3) {
        const med = vals[Math.floor(vals.length / 2)];
        const dev = med > 0 ? Math.abs(newSupply - med) / med : 0;
        if (dev > 0.35) {
          writeSupply = false;
          console.warn(
            `[supply] suspect read ${result.token.nodeId}: ${newSupply.toLocaleString()} vs median ${med.toLocaleString()} (dev ${(dev * 100).toFixed(0)}%) — sample skipped`,
          );
        }
      }
    }
    if (writeSupply) {
      await client.query(
        `
        INSERT INTO supply_samples (snapshot_ts, token_node_id, block_number, total_supply)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (token_node_id, snapshot_ts) DO UPDATE SET
          block_number = EXCLUDED.block_number, total_supply = EXCLUDED.total_supply
        `,
        [result.snapshotTs, result.token.nodeId, result.blockNumber, newSupply],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Fetch the most recent snapshot for one token. Returns {nodes,edges} JSON for frontend. */
export async function fetchLatestTopology(tokenSymbol: string): Promise<{
  snapshotTs: string;
  nodes: Array<{ id: string; type: string; label: string; metadata: unknown; address: string }>;
  edges: Array<{ source: string; target: string; edge_type: string; weight: number; attrs: unknown }>;
} | null> {
  const tokenNodeId = `token:${tokenSymbol}`;

  // Latest snapshot timestamp for this token
  const tsRow = await query<{ snapshot_ts: string }>(
    `SELECT MAX(snapshot_ts) AS snapshot_ts FROM edges WHERE token_node_id = $1`,
    [tokenNodeId],
  );
  const snapshotTs = tsRow.rows[0]?.snapshot_ts;
  if (!snapshotTs) return null;

  // Edges at that timestamp
  const edgesR = await query<{
    source: string;
    target: string;
    edge_type: string;
    weight: number;
    attrs: unknown;
  }>(
    `SELECT token_node_id AS source, protocol_node_id AS target, edge_type, weight, attrs
     FROM edges WHERE token_node_id = $1 AND snapshot_ts = $2`,
    [tokenNodeId, snapshotTs],
  );

  // Pull all nodes referenced
  const involvedIds = new Set<string>([tokenNodeId]);
  edgesR.rows.forEach((e) => {
    involvedIds.add(e.source);
    involvedIds.add(e.target);
  });
  const nodesR = await query<{
    id: string;
    type: string;
    label: string;
    metadata: unknown;
    address: string;
  }>(
    `SELECT node_id AS id, type, label, metadata, address FROM nodes WHERE node_id = ANY($1::text[])`,
    [Array.from(involvedIds)],
  );

  return {
    snapshotTs,
    nodes: nodesR.rows,
    edges: edgesR.rows,
  };
}
