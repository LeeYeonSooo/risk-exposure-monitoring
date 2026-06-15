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

import { env, EVM_CHAIN_KEYS, isActiveChain } from "@/config/chains";
import { closePool, query } from "@/db/client";
import { insertAlert } from "@/db/upsert";
import { fetchNewTransfers, isAllowlistedRecipient, type LedgerRow, MINT_BURN_SCHEMA, reconcile } from "@/snapshot/mint-burn-recon";
import { BACKING_WATCHES, readTotalSupply } from "@/snapshot/supply-backing";
import { RECOMMENDED_THRESHOLDS } from "@/config/alert-thresholds";
import { type Address, getAddress } from "viem";

import { publicClientFor } from "@/lib/public-rpc";
import { getTokenPriceUsd } from "@/lib/prices";

const HOME = "ethereum"; // 홈 mint=발행(예치) → 매칭 불필요
// 매칭 창은 config(mintBurn.matchWindowSeconds) 가 기본값 — env 로 override 가능.
const WINDOW_SEC = Number(process.env.MINTBURN_WINDOW_SEC ?? RECOMMENDED_THRESHOLDS.mintBurn.matchWindowSeconds);
const PROBE_CHAINS = EVM_CHAIN_KEYS.filter(isActiveChain); // 2026-06: eth/base/arb 만 지원(비활성 체인 제외)
const MAX_TOKENS = Number(process.env.MINTBURN_MAX ?? 8);

// Detector B = burn&mint 메시 가정. 모델이 다른 토큰은 구조적 FP 라 제외(헤더 설계 의도의 구현):
//   ① 네이티브 발행 스테이블(Circle/Tether/PayPal) — 발행사가 체인별 직접 mint(소스 burn 없음)가 일상.
//      이들의 무담보 감시는 Detector A(backing)·chain_supply_spike 담당.
//   ② Detector A 수동 watch 토큰(BACKING_WATCHES) — lock&mint 라 A 가 권위(소스는 burn 이 아니라 lock).
//   (WETH = 체인별 독립 wrap 컨트랙트(deposit mint/withdraw burn), cbBTC = Coinbase 체인별 네이티브 발행 — 동일 클래스.)
// WEETH(LayerZero OFT lock&mint, 홈=Adapter lock)·LBTC(컨소시엄 네이티브 발행 + CCIP) 추가 —
// 소스 burn 이 원리적으로 없어 burn&mint 매칭에서 영원히 미정합(FP 검증 2026-06: 라이브 6건 전부 오탐).
// burn&mint 메시가 아닌 토큰 — 소스 체인에 burn 이 원리적으로 없어 정상 브릿지 mint 가 영구 미정합(가짜 unmatched_mint).
//   USDC/USDT/PYUSD/EURC=네이티브 per-chain 발행, WETH/WEETH/LBTC/CBBTC=래핑/네이티브,
//   2026-06 감사 추가: DAI/WBTC=canonical lock&mint(Polygon PoS 등), LINK/GHO=CCIP, USDT0=LayerZero OFT.
//   ※ 이들의 무담보 감시는 Detector A(backing)·chain_supply_spike 가 담당 → B 에서 빠져도 커버리지 손실 없음.
const NATIVE_ISSUANCE_SKIP = new Set([
  "USDC", "USDT", "PYUSD", "EURC", "WETH", "CBBTC", "WEETH", "LBTC",
  "DAI", "WBTC", "LINK", "GHO", "USDT0",
  // USDe/sUSDe: Ethena LayerZero OFT(burn&mint) — out-bound burn 이 inbound mint 의 짝이 아니라
  //   USDT0 와 동일 FP 클래스. 무담보 감시는 backing·chain_supply_spike 가 담당.
  "USDE", "SUSDE",
  // TBTC: Threshold tBTC v2 — L2 는 권한 minter(owner) 가 canonical-mint(소스 burn 없음, OP-Stack 표준 인터페이스도
  //   없어 구조탐지 불가). LBTC 와 동급 커스텀 브릿지 → 영구 미정합 FP(2026-06 검증, base 6건). PoR/backing 별도.
  "TBTC",
]);
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

// ── lock&mint(네이티브 브릿지) 표현 구조탐지(2026-06 FP 수정) ──────────────────────────────────────
// OP-Stack(l1Token/remoteToken/REMOTE_TOKEN)·Arbitrum(l1Address) L2 토큰은 소스가 burn 아니라 **L1 잠금**이라
//   burn&mint 정합 대상이 아니다(소스 burn 영구 부재 → 가짜 unmatched_mint). backing·conservation(Detector A)이 권위.
//   rETH@base·AAVE@base 등 자동 skip, rsETH/ezETH OFT(이 인터페이스 없음→native=false)는 정합 유지(per-chain 정확).
const _nativeRepCache = new Map<string, boolean>();
async function isNativeBridgeRep(addr: string, chain: string): Promise<boolean> {
  if (chain === HOME) return false;
  const key = `${chain}:${addr.toLowerCase()}`;
  const cached = _nativeRepCache.get(key);
  if (cached !== undefined) return cached;
  const client = publicClientFor(chain);
  let native = false;
  if (client) {
    for (const fn of ["l1Token", "remoteToken", "REMOTE_TOKEN", "l1Address"]) {
      try {
        const v = (await client.readContract({
          address: getAddress(addr),
          abi: [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
          functionName: fn,
        })) as string;
        if (/^0x[0-9a-fA-F]{40}$/.test(v) && v !== "0x0000000000000000000000000000000000000000") { native = true; break; }
      } catch { /* 이 인터페이스 아님 */ }
    }
  }
  _nativeRepCache.set(key, native);
  return native;
}

const _decCache = new Map<string, number>();
async function readDecimals(addr: string, chain: string): Promise<number> {
  const key = `${chain}:${addr.toLowerCase()}`;
  const cached = _decCache.get(key);
  if (cached !== undefined) return cached;
  const client = publicClientFor(chain);
  let dec = 18;
  if (client) {
    try {
      dec = Number(await client.readContract({ address: getAddress(addr), abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }], functionName: "decimals" }));
    } catch { /* 18 폴백 */ }
  }
  _decCache.set(key, dec);
  return dec;
}

async function ingest(token: string, chain: string, addr: string, allow: Set<string>): Promise<void> {
  const cursor = await getCursor(token, chain);
  const since = cursor != null ? cursor + 1n : 0n; // 0n → fetch 가 MAX_SCAN_BLOCKS 로 캡(최근만)
  // mint 수집은 burn&mint 체인만 — 홈(발행) + 네이티브 lock&mint 표현(소스 burn 없음)은 제외(FP 차단). burn 은 전부 수집.
  const native = chain !== HOME && (await isNativeBridgeRep(addr, chain));
  if (native) {
    // 네이티브 lock&mint 체인의 기존 ledger mint 제거 — 구조탐지 도입 전 누적된 영구 미정합 FP 청소(rETH@base 등).
    await query(`DELETE FROM mint_burn_ledger WHERE token=$1 AND chain=$2 AND kind='mint'`, [token, chain]).catch(() => {});
  }
  const { latest, mints, burns } = await fetchNewTransfers(chain, addr, since, chain !== HOME && !native);
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

const MINT_USD_FLOOR = Number(process.env.MINT_USD_FLOOR ?? 10_000_000); // d10: Kelp 규모만 발화 — 소형 체인 정상발행 제외

/** 체인별 토큰 공급의 USD 가치 (chain_supply_samples 최신). 없으면 null. */
async function chainSupplyUsd(sym: string, chain: string): Promise<number | null> {
  try {
    // ⚠️ 케이스 무관 매칭(FN 수정 2026-06): mintWatchTokens 가 sym 을 .toUpperCase() 하므로 `token:USDE` 로
    //   조회하지만 chain_supply_samples 는 노드 원본 케이스(`token:USDe`)로 적재 → 정확매칭이면 mixed-case 토큰
    //   (USDe/cbBTC/sUSDe/weETH = 바로 이 디텍터의 타깃 LRT/exotic)의 supplyUsd 가 항상 null 이 돼 영구 skip.
    const r = (await query(`SELECT supply_usd FROM chain_supply_samples WHERE upper(token_node_id)=upper($1) AND chain=$2 ORDER BY snapshot_ts DESC LIMIT 1`, [`token:${sym}`, chain])).rows as { supply_usd: string | number | null }[];
    const v = r[0]?.supply_usd;
    return v != null ? Number(v) : null;
  } catch { return null; }
}

/**
 * d10(risk_rules) 포팅 — mid-interval 대량 무단 mint 스캔. burn&mint 매칭과 **독립**:
 * 어느 체인이든 supply 의 singleTxPctBps(5%) 이상을 비인가 주소로 단일 mint = 무한민팅 시그니처(Kelp 패턴).
 * main 의 1-블록 diff(diff.ts checkTotalSupply)가 놓치던 mid-interval mint 를 mint 이벤트(amount+to) provenance
 * 로 직접 잡는다. skip-list(weETH/LBTC 등)도 포함 — single-mint 은 모델 무관. 홈(ethereum) 발행은 예치 기반 제외.
 */
async function scanLargeMints(sym: string, chain: string, addr: string, allow: Set<string>): Promise<number> {
  if (chain === HOME) return 0; // Kelp 패턴 = 목적지 체인 mint (홈 발행은 예치 기반)
  const res = await fetchNewTransfers(chain, addr, 0n, true).catch(() => null);
  const mints = res?.mints ?? [];
  if (!mints.length) return 0;
  const client = publicClientFor(chain);
  const supply = client ? await readTotalSupply(client, addr).catch(() => null) : null;
  if (!supply || supply <= 0n) return 0;
  // 절대 USD 규모 = Kelp($200M)와 소형 체인 정상발행(EURC 10%=$600k)의 진짜 구분자(% 만으론 소형 체인 FP).
  const supplyUsd = await chainSupplyUsd(sym, chain);
  const ts = RECOMMENDED_THRESHOLDS.totalSupply;
  let n = 0;
  for (const m of mints) {
    const to = (m.to ?? "").toLowerCase();
    if (m.amount <= 0n || isAllowlistedRecipient(sym, m.to) || allow.has(to)) continue; // 인가 minter = 정상
    const bps = Number((m.amount * 10000n) / supply);
    if (bps < ts.singleTxPctBps) continue;
    const mintUsd = supplyUsd != null ? (bps / 10000) * supplyUsd : null;
    if (mintUsd != null) { if (mintUsd < MINT_USD_FLOOR) continue; } // 소형 발행 — 무시(FP 방지)
    else if (allow.size === 0) continue; // USD 모름 + 인가 minter 데이터 없음 → 판단 불가 skip
    const sev: "warning" | "critical" = bps >= ts.largeSingleMintBps ? "critical" : "warning";
    console.log(`[mintburn] 🚨 ${sym}@${chain}: 단일 mint ${(bps / 100).toFixed(2)}% of supply → ${to.slice(0, 10)}… (tx ${m.txHash.slice(0, 12)}…)`);
    await insertAlert({
      severity: sev,
      kind: "supply_single_mint",
      token: sym,
      message: `${chain} ${sym} — 단일 mint +${(bps / 100).toFixed(2)}% → ${to.slice(0, 10)}…`,
      detail: { chain, amountRaw: m.amount.toString(), supplyRaw: supply.toString(), bps, to, tx: m.txHash, block: m.block, detector: "mid_interval_single_mint" },
      source: "mintburn-v1",
    });
    n++;
  }
  return n;
}

/** single-mint 감시 대상 — 멀티체인 토큰 전체(burn&mint skip 무관, single-mint 은 모델 독립). 비-홈 1체인+ 보유. */
async function mintWatchTokens(): Promise<{ sym: string; byChain: Map<string, string> }[]> {
  const rows = (await query(`SELECT label, chain, address FROM nodes WHERE type='Token' AND address IS NOT NULL`)).rows as { label: string; chain: string; address: string }[];
  const m = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!PROBE_CHAINS.includes(r.chain)) continue;
    const sym = r.label.toUpperCase();
    if (!m.has(sym)) m.set(sym, new Map());
    m.get(sym)!.set(r.chain, r.address);
  }
  return [...m.entries()]
    .filter(([, c]) => [...c.keys()].some((ch) => ch !== HOME))
    .map(([sym, byChain]) => ({ sym, byChain }))
    .slice(0, Number(process.env.MINTWATCH_MAX ?? 10));
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
        // USD floor(MINT_USD_FLOOR=$10M) 배선(2026-06: 정의만 돼있고 미적용이던 죽은 게이트) — 미정합 총액이
        //   Kelp 규모일 때만 발화, 소형(정상 브릿지 잔여·테스트 mint) 컷. ⚠️ 가격 미확인 시엔 보수적으로 발화(FN 방지),
        //   backing 동반(corr)이면 규모 무관 승격.
        const homeAddr = byChain.get(HOME);
        let priced = false, totalUsd = 0;
        if (homeAddr) {
          const price = await getTokenPriceUsd(homeAddr as Address).catch(() => null);
          if (price && price > 0) { priced = true; const dec = await readDecimals(homeAddr, HOME); totalUsd = flagged.reduce((s, f) => s + (Number(f.amount) / 10 ** dec) * price, 0); }
        }
        const belowFloor = priced && totalUsd < MINT_USD_FLOOR;
        // 구조적 FP 컷: 지속(2×window) + (Kelp 규모 USD floor 또는 backing 동반)일 때만 발화.
        if ((maxAge >= 2 * WINDOW_SEC || corr) && (!belowFloor || corr)) {
          const usdNote = priced ? ` · ~$${(totalUsd / 1e6).toFixed(2)}M` : "";
          const msg = `${sym} — 미정합 ${flagged.length}건${usdNote}${corr ? " · backing 동반" : ""}`;
          console.log(`[mintburn] 🚨 ${sym}: ${msg}`);
          await insertAlert({
            severity: corr ? "critical" : "warning",
            kind: "unmatched_mint",
            token: sym,
            message: msg,
            detail: { count: flagged.length, totalUsd: priced ? totalUsd : null, corroboratedByBacking: corr, windowSec: WINDOW_SEC, samples: flagged.slice(0, 5) },
            source: "mintburn-v1",
          });
        } else {
          console.log(`[mintburn] ${sym}: 미정합 ${flagged.length}건 보류(age ${maxAge}s${belowFloor ? ` · $${(totalUsd / 1e6).toFixed(2)}M < floor` : " · 매칭 대기"})`);
        }
      } else {
        console.log(`[mintburn] ${sym}: 정합 OK (ledger ${ledger.length}행)`);
      }
    } catch (e) {
      console.error(`[mintburn] ${sym} 오류:`, (e as Error).message);
    }
  }

  // d10 포팅 — mid-interval 대량 무단 mint 스캔(FN 공백 닫기: Kelp 패턴 + weETH/LBTC 등 skip 토큰 포함).
  const watch = await mintWatchTokens();
  let bigMints = 0;
  for (const { sym, byChain } of watch) {
    const allow = await verifiedMintersFor(sym).catch(() => new Set<string>());
    for (const [chain, addr] of byChain) bigMints += await scanLargeMints(sym, chain, addr, allow).catch(() => 0);
  }
  console.log(`[mintburn] large-mint 스캔: ${watch.length}토큰 → ${bigMints}건 발화`);

  console.log("[mintburn] 완료");
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
