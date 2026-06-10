/**
 * Detector B 러너 — 크로스체인 mint/burn 정합 (alarm-totalsupply 포팅).
 *
 * 멀티체인 토큰의 mint(비-홈)·burn(전 체인)을 ledger 에 누적, 금액+시간창으로 매칭.
 * 창 지나도 미정합 mint = 무담보민팅 의심 → alerts(kind=unmatched_mint, source=mintburn-v1).
 * backing 불일치(Detector A unbacked_supply 최근)와 동반되면 critical 로 승격.
 *
 * Usage: npm run snapshot:mintburn
 * Env: DATABASE_URL(필수), MINTBURN_WINDOW_SEC(기본 1800), MINTBURN_MAX(기본 8).
 */
import process from "node:process";

import { env, EVM_CHAIN_KEYS } from "@/config/chains";
import { closePool, query } from "@/db/client";
import { insertAlert } from "@/db/upsert";
import { fetchNewTransfers, isAllowlistedRecipient, type LedgerRow, MINT_BURN_SCHEMA, reconcile } from "@/snapshot/mint-burn-recon";
import { BACKING_WATCHES } from "@/snapshot/supply-backing";
import { RECOMMENDED_THRESHOLDS } from "@/config/alert-thresholds";

const HOME = "ethereum"; // 홈 mint=발행(예치) → 매칭 불필요
// 매칭 창은 config(mintBurn.matchWindowSeconds) 가 기본값 — env 로 override 가능.
const WINDOW_SEC = Number(process.env.MINTBURN_WINDOW_SEC ?? RECOMMENDED_THRESHOLDS.mintBurn.matchWindowSeconds);
const PROBE_CHAINS = EVM_CHAIN_KEYS; // 공용 레지스트리(18체인) — 디텍터 간 리스트 단일화
const MAX_TOKENS = Number(process.env.MINTBURN_MAX ?? 8);

// Detector B = burn&mint 메시 가정. 모델이 다른 토큰은 구조적 FP 라 제외(헤더 설계 의도의 구현):
//   ① 네이티브 발행 스테이블(Circle/Tether/PayPal) — 발행사가 체인별 직접 mint(소스 burn 없음)가 일상.
//      이들의 무담보 감시는 Detector A(backing)·chain_supply_spike 담당.
//   ② Detector A 수동 watch 토큰(BACKING_WATCHES) — lock&mint 라 A 가 권위(소스는 burn 이 아니라 lock).
//   (WETH = 체인별 독립 wrap 컨트랙트(deposit mint/withdraw burn), cbBTC = Coinbase 체인별 네이티브 발행 — 동일 클래스.)
const NATIVE_ISSUANCE_SKIP = new Set(["USDC", "USDT", "PYUSD", "EURC", "WETH", "CBBTC"]);
const A_WATCHED = new Set(BACKING_WATCHES.map((w) => w.symbol.toUpperCase()));

async function multichainTokens(): Promise<{ sym: string; byChain: Map<string, string> }[]> {
  const rows = (await query(
    `SELECT label, chain, address FROM nodes WHERE type='Token' AND address IS NOT NULL`,
  )).rows as { label: string; chain: string; address: string }[];
  const m = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!PROBE_CHAINS.includes(r.chain)) continue;
    const sym = r.label.toUpperCase();
    if (NATIVE_ISSUANCE_SKIP.has(sym) || A_WATCHED.has(sym)) continue; // B 모델 밖 → skip
    if (!m.has(sym)) m.set(sym, new Map());
    m.get(sym)!.set(r.chain, r.address);
  }
  return [...m.entries()].filter(([, c]) => c.size >= 2).map(([sym, byChain]) => ({ sym, byChain })).slice(0, MAX_TOKENS);
}

async function getCursor(token: string, chain: string): Promise<bigint | null> {
  const r = (await query(`SELECT last_block FROM mint_burn_cursor WHERE token=$1 AND chain=$2`, [token, chain])).rows as { last_block: string }[];
  return r.length ? BigInt(r[0].last_block) : null;
}

/**
 * 온체인 검증된 브릿지 권한 주소 → Detector B allowlist 시드(설계 B#4).
 * bridge_authorities(xERC20 한도·MINTER_ROLE·OFT peer·CCIP 풀/원격)는 컨트랙트에서 직접 읽어 검증한 것 —
 * 이 주소로 향하는 mint 는 정상 크로스체인 인프라이지 무담보민팅 공격이 아니므로 정합 대상에서 제외(FP↓).
 * 공격자가 자기 주소로 민팅하면 여기 없으므로 여전히 잡힌다(안전).
 */
async function verifiedMintersFor(sym: string): Promise<Set<string>> {
  try {
    const rows = (await query(`SELECT DISTINCT lower(bridge_addr) AS addr FROM bridge_authorities WHERE token=$1`, [sym])).rows as { addr: string }[];
    return new Set(rows.map((r) => r.addr).filter(Boolean));
  } catch { return new Set(); }
}

async function ingest(token: string, chain: string, addr: string, allow: Set<string>): Promise<void> {
  const cursor = await getCursor(token, chain);
  const since = cursor != null ? cursor + 1n : 0n; // 0n → fetch 가 MAX_SCAN_BLOCKS 로 캡(최근만)
  const { latest, mints, burns } = await fetchNewTransfers(chain, addr, since, chain !== HOME);
  const events = [
    ...burns.map((e) => ({ e, kind: "burn" as const })),
    // authorized 수신자(정적 allowlist) + 검증된 브릿지 권한(동적 시드)로 가는 mint 는 정합 대상에서 제외 — FP 컷.
    ...mints.filter((e) => !isAllowlistedRecipient(token, e.to) && !allow.has((e.to ?? "").toLowerCase())).map((e) => ({ e, kind: "mint" as const })),
  ];
  for (const { e, kind } of events) {
    await query(
      `INSERT INTO mint_burn_ledger (token, chain, tx_hash, log_index, kind, amount, event_ts)
       VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7))
       ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
      [token, chain, e.txHash, e.logIndex, kind, e.amount.toString(), e.eventTsSec],
    ).catch(() => {});
  }
  if (latest > 0n) {
    await query(
      `INSERT INTO mint_burn_cursor (token, chain, last_block, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (token, chain) DO UPDATE SET last_block=EXCLUDED.last_block, updated_at=now()`,
      [token, chain, latest.toString()],
    );
  }
}

async function main() {
  if (!env.DATABASE_URL) { console.error("[mintburn] DATABASE_URL 필요"); process.exit(1); }
  await query(MINT_BURN_SCHEMA); // 스키마 idempotent 보장
  await query(`DELETE FROM mint_burn_ledger WHERE first_seen_ts < now() - interval '7 days'`).catch(() => {}); // 보존 한도(테이블 비대 방지)
  const tokens = await multichainTokens();
  console.log(`[mintburn] 멀티체인 토큰 ${tokens.length}개 점검 (window ${WINDOW_SEC}s)`);
  const nowSec = Math.floor(Date.now() / 1000);

  for (const { sym, byChain } of tokens) {
    try {
      const allow = await verifiedMintersFor(sym); // 검증된 브릿지 권한 → allowlist 시드(B#4)
      for (const [chain, addr] of byChain) {
        await ingest(sym, chain, addr, allow).catch((e) => console.warn(`[mintburn] ${sym}/${chain} ingest 실패:`, (e as Error).message));
      }
      const rows = (await query(
        `SELECT chain, tx_hash, log_index, kind, amount::text amount,
                extract(epoch from event_ts)::bigint event_ts, extract(epoch from first_seen_ts)::bigint first_seen
         FROM mint_burn_ledger WHERE token=$1`,
        [sym],
      )).rows as { chain: string; tx_hash: string; log_index: number; kind: "mint" | "burn"; amount: string; event_ts: string; first_seen: string }[];
      const ledger: LedgerRow[] = rows.map((r) => ({
        chain: r.chain, txHash: r.tx_hash, logIndex: r.log_index, kind: r.kind,
        amount: r.amount, eventTsSec: Number(r.event_ts), firstSeenSec: Number(r.first_seen),
      }));

      const { matchedPks, staleBurnPks, flagged } = reconcile(ledger, WINDOW_SEC, nowSec);
      for (const pk of [...matchedPks, ...staleBurnPks]) {
        await query(`DELETE FROM mint_burn_ledger WHERE chain=$1 AND tx_hash=$2 AND log_index=$3`, [pk.chain, pk.txHash, pk.logIndex]).catch(() => {});
      }

      if (flagged.length) {
        // backing 불일치(Detector A)와 동반되면 승격 — Kelp 식 무담보민팅의 복합 시그널.
        const corr = ((await query(
          `SELECT 1 FROM alerts WHERE upper(token)=upper($1) AND kind='unbacked_supply' AND created_at > now() - interval '48 hours' LIMIT 1`,
          [sym],
        )).rows.length) > 0;
        const maxAge = Math.max(...flagged.map((f) => f.ageSec));
        // 구조적 FP 컷: 일시적 미정합(크로스런/크로스체인 매칭 대기)은 알림 X — 지속(2×window)되거나 backing 동반일 때만.
        if (maxAge >= 2 * WINDOW_SEC || corr) {
          const msg = `미정합 mint ${flagged.length}건(소스 burn 없음) — 무담보민팅 의심${corr ? " · backing 불일치 동반(승격)" : ""}. 최대 age ${maxAge}s`;
          console.log(`[mintburn] 🚨 ${sym}: ${msg}`);
          await insertAlert({
            severity: corr ? "critical" : "warning",
            kind: "unmatched_mint",
            token: sym,
            message: msg,
            detail: { count: flagged.length, corroboratedByBacking: corr, windowSec: WINDOW_SEC, samples: flagged.slice(0, 5) },
            source: "mintburn-v1",
          });
        } else {
          console.log(`[mintburn] ${sym}: 미정합 ${flagged.length}건 관망(최대 age ${maxAge}s < ${2 * WINDOW_SEC}s — 매칭 대기)`);
        }
      } else {
        console.log(`[mintburn] ${sym}: 정합 OK (ledger ${ledger.length}행)`);
      }
    } catch (e) {
      console.error(`[mintburn] ${sym} 오류:`, (e as Error).message);
    }
  }
  console.log("[mintburn] 완료");
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
