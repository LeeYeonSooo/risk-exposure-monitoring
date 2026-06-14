import { NextResponse } from "next/server";

import {
  ALCHEMY_NET, ZERO_ADDR, bestHopMatch, buildCounterpartyRegistry,
  fetchPrices, fetchTransfers, resolveAddresses, transferTs, type AlchemyTransfer, type CpTarget,
} from "@/lib/counterparties";
import { erc20Symbol, isContract, wrappedUnderlying } from "@/lib/lending-pools";
import { LIVE_DELAY_SEC, LIVE_WINDOW_SEC, MAX_FLOW_TARGETS, type FlowTx } from "@/lib/flow-types";

/**
 * GET /api/transactions?addrs=ethereum:0xabc..,base:0xdef..&tokens=stETH&chains=ethereum
 *
 * Near-real-time real transfer feed for the 흐름맵 (transaction flow). We surface transfers
 * whose block time is in [now-DELAY-WINDOW, now-DELAY] — 최근 30분 윈도우(1분 정산 버퍼).
 * Alchemy 페이지네이션(pageKey)으로 윈도우 시작까지 거슬러 받는다(페이지 캡에 걸리는
 * 극단적 버스트 토큰은 윈도우의 OLDEST 쪽이 잘릴 수 있음 — partial 로 정직 표기).
 *
 * **EVM 전용** (팀 결정 2026-06-12) — 비-EVM 어댑터(solana/tron/aptos/starknet/sui)는 제거됨.
 *
 * EVERY transfer is returned equally (no normal/suspicious split). Each carries its real
 * counterparty (resolved to a protocol/market/vault label when the address is one of our
 * graph nodes / on-chain registries) so the client can place the particle on the REAL edge.
 *
 * 카운터파티 레지스트리·가격·전송 페치는 lib/counterparties.ts (평소 모드 API 와 공용).
 */
export const dynamic = "force-dynamic";
// 콜드 폴(첫 수집)은 토큰당 최대 30페이지 Alchemy 페이지네이션이라 수 초가 걸릴 수 있다 — 서버리스
// (Vercel Hobby 10s/Pro 15s 기본) 타임아웃에 잘리지 않게 상한을 올린다. 상주 Node 면 무영향. (2026-06-13 감사)
export const maxDuration = 60;

const KEY = process.env.ALCHEMY_API_KEY;

const DELAY_SEC = LIVE_DELAY_SEC;   // 1-min settle (on-chain counterparty resolution is fast)
const WINDOW_SEC = LIVE_WINDOW_SEC; // 최근 30분 트레일링 윈도우 — 각 전송이 입자 하나
const MAX_RETURN = 1000;            // **최근 1000건** 표시 (사용자 확정) — 워터필로 토큰에 공정 분배.
                                   // 30분 윈도우 안에서 가장 최근 1000건(바쁜 뷰 ≈ 최근 20분), collected 로 캡 전 실수집량 노출.
// 증분 수집: 첫 폴은 깊게(30분 전체 — USDT 는 30분에 2만 건까지 실측, 30페이지로 전수 커버),
// 이후 폴은 직전 폴 newest 이후의 증분만(보통 1페이지). 윈도우 데이터는 프로세스 캐시에 유지·프룬.
const FIRST_PAGES = 30;
const POLL_PAGES = 5;

interface WinCache { transfers: AlchemyTransfer[]; newestTs: number; coveredFromTs: number }
const _winCache = new Map<string, WinCache>(); // `${chain}:${addr}` — 30분 슬라이딩 윈도우 전송 캐시

export async function GET(req: Request) {
  if (!KEY) return NextResponse.json({ txs: [], error: "ALCHEMY_API_KEY not set" });
  const url = new URL(req.url);

  // primary: explicit chain:addr pairs (real flow-core-resolved token addresses, all chains)
  const addrParam = (url.searchParams.get("addrs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const tokenParam = (url.searchParams.get("tokens") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const chainParam = (url.searchParams.get("chains") ?? "ethereum").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  // build the work list of { token, chain, addr }
  const targets: CpTarget[] = [];
  for (const pair of addrParam) {
    const [chain, addrEnc, sym] = pair.split(":");
    if (!chain || !addrEnc) continue;
    const c = chain.toLowerCase();
    let addr = addrEnc;
    try { addr = decodeURIComponent(addrEnc); } catch { /* 원문 유지 */ }
    const token = (sym ?? "").toUpperCase() || addr.slice(0, 6);
    if (ALCHEMY_NET[c]) targets.push({ token, chain: c, addr: addr.toLowerCase() }); // EVM 전용 — 그 외 체인은 스킵
  }
  if (!targets.length && tokenParam.length) {
    for (const chain of chainParam) {
      if (!ALCHEMY_NET[chain]) continue;
      for (const { token, addr } of await resolveAddresses(tokenParam, chain)) targets.push({ token: token.toUpperCase(), chain, addr });
    }
  }
  // 공개·무인증 엔드포인트 보호 — chain:addr 중복 제거 + 개수 상한(제자리). 무제한 addrs 가 unbounded
  // Alchemy fan-out(공유 CU 고갈/소켓 폭주)을 일으키지 못하게 한다. (2026-06-13 배포 준비성 감사)
  { const seen = new Set<string>(); let w = 0; for (const t of targets) { const k = `${t.chain}:${t.addr}`; if (seen.has(k) || w >= MAX_FLOW_TARGETS) continue; seen.add(k); targets[w++] = t; } targets.length = w; }
  if (!targets.length) return NextResponse.json({ txs: [] });

  const nowSec = Math.floor(Date.now() / 1000);
  const hiTs = nowSec - DELAY_SEC;              // newest allowed (1 min ago)
  const loTs = nowSec - DELAY_SEC - WINDOW_SEC; // oldest allowed (31 min ago = 1-min delay + 30-min window)

  const [reg, prices] = await Promise.all([
    buildCounterpartyRegistry(targets, url.searchParams.get("nodes") ?? ""),
    fetchPrices(targets.map(({ chain, addr }) => ({ chain, addr }))),
  ]);
  const { known, dexAddrs, pairHint, tokenSymByAddr, wrapPairs } = reg;

  // 토큰별로 따로 수집한다(활성 토큰이 조용한 토큰을 밀어내지 않게). 표시 예산(MAX_RETURN) 배분은
  // 아래서 max-min 워터필링으로 — 단순 floor(예산/N) 캡은 USDC 선택 시 딸려오는 파생/LP 토큰 수십
  // 개가 N을 키워 활성 토큰을 굶기던 문제(USDC 900건→40건)를 일으켰다(2026-06-13 감사).
  const isMatchedRow = (t: FlowTx) => t.counterparty != null || t.kind === "mint" || t.kind === "burn";
  const partialTokens: string[] = []; // 윈도우 전체를 못 본/표시 캡에 잘린 토큰 — 숨기지 않고 표기
  let collectedMatched = 0;           // 캡 적용 전 윈도우 내 실제 매칭 흐름 총수 (정직성 — total 과 비교)
  const perTarget = await Promise.all(targets.map(async ({ token, chain, addr }) => {
    // 30분 슬라이딩 윈도우 — 증분 수집: 캐시 newest 이후만 새로 받고(2분 오버랩), 윈도우 밖은 프룬.
    const ck = `${chain}:${addr}`;
    const cached = _winCache.get(ck);
    const sinceTs = cached ? Math.max(loTs, cached.newestTs - 120) : loTs;
    const { transfers: fresh, covered } = await fetchTransfers(ALCHEMY_NET[chain], addr, { maxCount: 1000, maxPages: cached ? POLL_PAGES : FIRST_PAGES, stopBeforeTs: sinceTs });
    const seenK = new Set<string>();
    const merged: AlchemyTransfer[] = [];
    for (const t of [...fresh, ...(cached?.transfers ?? [])]) {
      const ts = transferTs(t);
      if (!ts || ts < loTs) continue; // 윈도우 밖 프룬 (슬라이딩)
      const dk = `${t.hash}|${t.from}|${t.to}|${t.value}`; // 오버랩 구간 중복 제거
      if (seenK.has(dk)) continue;
      seenK.add(dk);
      merged.push(t);
    }
    let newestTs = cached?.newestTs ?? 0, oldestFresh = 0;
    for (const t of fresh) { const ts = transferTs(t); if (ts > newestTs) newestTs = ts; if (ts && (!oldestFresh || ts < oldestFresh)) oldestFresh = ts; }
    // coveredFrom = 이 시각 이후로는 빠짐없이 본 시점. covered=true 면 캐시의 기존 커버리지에 접합,
    // false(증분이 sinceTs 까지 못 닿음 — 폭주/실패)면 fresh 의 oldest 부터만 연속 보장.
    const coveredFromTs = covered ? Math.max(loTs, cached ? Math.min(cached.coveredFromTs, sinceTs) : loTs) : Math.max(loTs, oldestFresh || sinceTs);
    _winCache.set(ck, { transfers: merged, newestTs, coveredFromTs });
    if (coveredFromTs > loTs + 90) partialTokens.push(`${token}@${chain}`);
    const transfers = merged;
    const price = prices.get(`${chain}:${addr}`)?.price ?? 0;
    // group this token's transfers by tx hash → reconstruct the REAL movement chain (a swap routes
    // through several contracts in one tx; we scan ALL hops, not just one entry's from/to).
    const byHash = new Map<string, AlchemyTransfer[]>();
    for (const t of transfers) {
      const ts = transferTs(t);
      if (!ts || ts > hiTs || ts < loTs) continue; // delay window
      const h = t.hash ?? ""; if (!h) continue;
      const a = byHash.get(h); if (a) a.push(t); else byHash.set(h, [t]);
    }
    const local: FlowTx[] = [];
    const pending: { hsh: string; ts: number; maxVal: number; from: string; to: string }[] = [];
    for (const [hsh, hops] of byHash) {
      let maxVal = 0, ts = 0, from = "", to = "";
      for (const h of hops) {
        const hts = transferTs(h);
        if (hts > ts) ts = hts;
        const v = h.value ?? 0; if (v > maxVal) { maxVal = v; from = (h.from ?? "").toLowerCase(); to = (h.to ?? "").toLowerCase(); }
      }
      // 모든 hop 스캔 → 가장 SPECIFIC 한 매칭 (rank2 볼트/DB 노드 > rank1 프로토콜 레지스트리)
      const best = bestHopMatch(hops.map((h) => ({ from: (h.from ?? "").toLowerCase(), to: (h.to ?? "").toLowerCase(), value: h.value ?? 0 })), chain, reg);
      if (best) {
        local.push({
          hash: hsh, chain, token, from, to, valueUsd: (best.v || maxVal) * price, ts, direction: best.dir,
          kind: dexAddrs.has(best.key) ? "swap" : best.dir === "in" ? "deposit" : "withdraw",
          counterparty: best.label, counterpartyAddr: best.addr, marketHint: pairHint.get(best.key) ?? null, reasons: [],
        });
        continue;
      }
      if (from === ZERO_ADDR) { local.push({ hash: hsh, chain, token, from, to, valueUsd: maxVal * price, ts, direction: "in", kind: "mint", counterparty: null, counterpartyAddr: null, marketHint: null, reasons: [] }); continue; }
      if (to === ZERO_ADDR) { local.push({ hash: hsh, chain, token, from, to, valueUsd: maxVal * price, ts, direction: "out", kind: "burn", counterparty: null, counterpartyAddr: null, marketHint: null, reasons: [] }); continue; }
      // 선택 토큰끼리의 검증된 랩 쌍 fast-path
      const wrapTo = tokenSymByAddr.get(`${chain}:${to}`), wrapFrom = tokenSymByAddr.get(`${chain}:${from}`);
      if (wrapTo && wrapPairs.has(`${chain}:${to}:${addr}`)) { local.push({ hash: hsh, chain, token, from, to, valueUsd: maxVal * price, ts, direction: "in", kind: "wrap", counterparty: wrapTo, counterpartyAddr: to, marketHint: null, reasons: [] }); continue; }
      if (wrapFrom && wrapPairs.has(`${chain}:${from}:${addr}`)) { local.push({ hash: hsh, chain, token, from, to, valueUsd: maxVal * price, ts, direction: "out", kind: "unwrap", counterparty: wrapFrom, counterpartyAddr: from, marketHint: null, reasons: [] }); continue; }
      pending.push({ hsh, ts, maxVal, from, to });
    }
    // 2차 패스 — 미매칭 상대 중 금액 큰 순으로 소수만 온체인 프로브: 컨트랙트이고
    // asset()/stETH()/eETH() 가 정확히 이 토큰을 반환하면 검증된 랩(라벨 = 그 컨트랙트의 symbol()).
    // wstETH·sUSDe 같은 래퍼/4626 예치가 쌍 토큰을 선택하지 않아도 잡힌다. 결과는 영구 캐시.
    const MAX_PROBES = 8;
    const candOrder: string[] = [];
    for (const p of [...pending].sort((a, b) => b.maxVal - a.maxVal)) {
      for (const cand of [p.to, p.from]) if (cand && cand !== addr && !candOrder.includes(cand)) candOrder.push(cand);
      if (candOrder.length >= MAX_PROBES * 2) break;
    }
    const wrapLabelByAddr = new Map<string, string>();
    let probes = 0;
    for (const cand of candOrder) {
      if (probes >= MAX_PROBES) break;
      if (!(await isContract(chain, cand))) continue; // EOA 는 프로브 예산을 소모하지 않는다 (getCode 는 캐시됨)
      probes++;
      if ((await wrappedUnderlying(chain, cand)) !== addr) continue;
      const sym = await erc20Symbol(chain, cand);
      wrapLabelByAddr.set(cand, sym ?? `${cand.slice(0, 6)}…${cand.slice(-4)}`);
    }
    for (const p of pending) {
      const wTo = wrapLabelByAddr.get(p.to), wFrom = wrapLabelByAddr.get(p.from);
      if (wTo) local.push({ hash: p.hsh, chain, token, from: p.from, to: p.to, valueUsd: p.maxVal * price, ts: p.ts, direction: "in", kind: "wrap", counterparty: wTo, counterpartyAddr: p.to, marketHint: null, reasons: [] });
      else if (wFrom) local.push({ hash: p.hsh, chain, token, from: p.from, to: p.to, valueUsd: p.maxVal * price, ts: p.ts, direction: "out", kind: "unwrap", counterparty: wFrom, counterpartyAddr: p.from, marketHint: null, reasons: [] });
      // 그 외 = 지갑간/미식별 전송 — 숨기지 않고 패널에 kind:transfer 로 보여준다 (그래프엔 안 그림, 라벨 추측 없음)
      else local.push({ hash: p.hsh, chain, token, from: p.from, to: p.to, valueUsd: p.maxVal * price, ts: p.ts, direction: "out", kind: "transfer", counterparty: null, counterpartyAddr: null, marketHint: null, reasons: [] });
    }
    // 토큰별 매칭/지갑전송을 정렬만 해서 반환 — 예산 배분은 아래 워터필링이 담당.
    const matched = local.filter(isMatchedRow).sort((a, b) => b.ts - a.ts);
    const plain = local.filter((t) => !isMatchedRow(t)).sort((a, b) => b.ts - a.ts);
    return { token, chain, matched, plain };
  }));

  // ── 표시 예산(MAX_RETURN) 배분 — max-min 페어 워터필링: 보유량 적은 토큰부터 남은 예산을 남은
  //    토큰에 균등 분배하되 자기 보유분을 안 넘는다 → 조용한 토큰이 비운 슬롯이 활성 토큰으로 흘러가
  //    USDC(900건)를 40건이 아니라 거의 다 표시. 활성 토큰이 균형하게 많으면 자연히 균등 분배. ──
  const order = [...perTarget].sort((a, b) => a.matched.length - b.matched.length);
  const take = new Map<(typeof perTarget)[number], number>();
  let rem = MAX_RETURN, left = order.length;
  for (const t of order) { const share = left > 0 ? Math.floor(rem / left) : 0; const k = Math.min(t.matched.length, share); take.set(t, k); rem -= k; left--; }
  const matchedOut: FlowTx[] = [];
  for (const t of perTarget) {
    const k = take.get(t) ?? 0;
    collectedMatched += t.matched.length; // 캡 적용 전 실제 매칭 흐름 수 (정직성 — collected>total 이면 표시 잘림)
    // **표시 캡 정직 표기**: 워터필 몫(k)보다 매칭이 많으면 oldest 쪽이 표시상 잘린 것 → partial 로
    // 알린다(페치 커버리지 갭과 같은 "윈도우 끝 절단" 증상, 입자 1만개는 못 그림).
    if (t.matched.length > k && !partialTokens.includes(`${t.token}@${t.chain}`)) partialTokens.push(`${t.token}@${t.chain}`);
    matchedOut.push(...t.matched.slice(0, k));
  }
  // 지갑간 전송(미매칭)은 남는 예산 한도 내 토큰당 소량(≤8) — 활동 신호용, 매칭을 밀어내지 않음
  let plainBudget = Math.max(0, MAX_RETURN - matchedOut.length);
  const plainOut: FlowTx[] = [];
  for (const t of perTarget) { if (plainBudget <= 0) break; const room = Math.min(t.plain.length, 8, plainBudget); plainOut.push(...t.plain.slice(0, room)); plainBudget -= room; }
  const txs = [...matchedOut, ...plainOut].sort((a, b) => b.ts - a.ts).slice(0, MAX_RETURN);
  const total = txs.length;

  return NextResponse.json({
    txs,
    delaySec: DELAY_SEC, windowSec: WINDOW_SEC,
    generatedAt: new Date().toISOString(),
    // total = 표시 건수(캡 적용 후) · collected = 윈도우 내 실제 매칭 흐름 수(캡 전) — collected>total 이면 표시가 잘린 것
    counts: { total, returned: txs.length, collected: collectedMatched },
    // 30분 윈도우의 oldest 쪽이 잘렸을 수 있는 토큰(페치 커버리지 갭 ∪ 표시 캡 절단) — 클라이언트가 "불완전" 배지로 정직 표기
    partial: partialTokens.length ? partialTokens : undefined,
  });
}
