import { NextResponse } from "next/server";

import {
  ALCHEMY_NET, bestHopMatch, buildCounterpartyRegistry,
  fetchPrices, fetchTransfers, transferTs, type AlchemyTransfer, type CpTarget,
} from "@/lib/counterparties";
import { BASELINE_TARGET_SEC, MAX_FLOW_TARGETS, type FlowBaselineCoverage, type FlowBaselineRow } from "@/lib/flow-types";
import { LENDING_EVENT_LABELS, lendingEventRows } from "@/lib/lending-events";

/**
 * GET /api/flow-baseline?addrs=ethereum:0xabc..:WETH,..&nodes=chain:addr~label|..
 *
 * 흐름맵 "평소" 모드 — 최근 24h(목표) 실전송/이벤트를 엣지(토큰×카운터파티×방향)별로 집계해
 * 평소 흐름의 레이트(USD/h · tx/h)를 돌려준다. 카운터파티 **매칭 규칙은 실시간 피드와 동일**
 * (lib/counterparties — 온체인 레지스트리/그래프 노드만, 라벨 추측 0)이므로 두 모드가 "같은 엣지"를
 * 두고 평소↔지금을 비교할 수 있다. 단 랩/언랩·민트/소각은 토큰↔프로토콜 "엣지 흐름"이 아니라
 * 집계에서 제외(실시간에서도 입자 대상이 아니라 패널 전용).
 *
 * 정확성: 렌딩(aave·spark·compound·fluid·euler·lido·sky·ethena·ether.fi)+morpho 는 **프로토콜 이벤트
 * 로그 24h 전수**(lib/lending-events — 게이트+재시도+폴백으로 silent drop 방지) / DEX 는 클라이언트가
 * volumeUsd1d(진짜 24h)로 그래프 엣지에 보충 / 그 외는 전송 스캔(관측구간 정직 표기). EVM 전용.
 */
export const dynamic = "force-dynamic";
// 콜드 캐시 빌드는 24h getLogs+전송 페이지네이션+Morpho 8페이지라 실측 ~25s — 서버리스
// (Vercel Hobby 10s/Pro 15s 기본) 타임아웃에 잘리면 '평소 흐름 조회 실패'로 뜬다. 상한을 올린다(상주 Node 면 무영향). (2026-06-13 감사)
export const maxDuration = 60;

const KEY = process.env.ALCHEMY_API_KEY;
const BASE_MAX_PAGES = 12;         // 토큰당 최대 12,000 전송 — 24h 를 못 덮으면 관측구간 축소(정직 표기, DEX 는 일거래량으로 클라이언트가 보충)
const CACHE_TTL_MS = 20 * 60_000;  // 평소값은 천천히 변한다 — 20분 캐시 (Alchemy CU 예산)
const MIN_ROW_USD = 1;             // 가격 미상(price 0)으로 0이 된 행은 의미 없음 — 제외

interface BaselinePayload {
  rows: FlowBaselineRow[];
  coverage: FlowBaselineCoverage[];
  targetSec: number;
  generatedAt: string;
  error?: string;
}

const _cache = new Map<string, { at: number; data: BaselinePayload }>();
const _inflight = new Map<string, Promise<BaselinePayload>>();

async function build(targets: CpTarget[], nodesParam: string): Promise<BaselinePayload> {
  const nowSec = Math.floor(Date.now() / 1000);
  const hiTs = nowSec;
  const loTs = nowSec - BASELINE_TARGET_SEC;

  const [reg, prices] = await Promise.all([
    buildCounterpartyRegistry(targets, nodesParam),
    fetchPrices(targets.map(({ chain, addr }) => ({ chain, addr }))),
  ]);

  const rows: FlowBaselineRow[] = [];
  const coverage: FlowBaselineCoverage[] = [];
  // 렌딩(aave/spark/compound/fluid/morpho/euler)+lido+sky+ethena+ether.fi 는 프로토콜 이벤트 로그로 24h **전수** — 전송 스캔과 병행
  const eventRowsP = lendingEventRows(targets, prices);
  await Promise.all(targets.map(async ({ token, chain, addr }) => {
    const { transfers, covered } = await fetchTransfers(ALCHEMY_NET[chain], addr, { maxCount: 1000, maxPages: BASE_MAX_PAGES, stopBeforeTs: loTs });
    const price = prices.get(`${chain}:${addr}`)?.price ?? 0;
    // 관측 구간 — 윈도우를 다 못 덮었으면(covered=false: 페이지 캡·중간 실패) oldest 실수신
    // 전송 시각부터 (레이트 분모를 거짓말하지 않는다)
    let oldestTs = 0;
    const byHash = new Map<string, AlchemyTransfer[]>();
    for (const t of transfers) {
      const ts = transferTs(t);
      if (!ts || ts > hiTs || ts < loTs) continue;
      if (!oldestTs || ts < oldestTs) oldestTs = ts;
      const h = t.hash ?? ""; if (!h) continue;
      const a = byHash.get(h); if (a) a.push(t); else byHash.set(h, [t]);
    }
    const observedStart = !covered && oldestTs ? oldestTs : loTs;
    const observedSec = Math.max(1, hiTs - observedStart);
    coverage.push({ token, chain, observedSec, targetSec: BASELINE_TARGET_SEC, truncated: !covered });

    // (카운터파티, 방향)별 집계 — 매칭 규칙은 실시간 피드와 동일: bestHopMatch 를 먼저 평가하고
    // (민트 hop + 카운터파티 hop 이 한 tx 에 공존하는 zap 도 잡는다), 그 다음 검증된 랩 쌍을 본다.
    const agg = new Map<string, FlowBaselineRow>();
    for (const [hsh, hops] of byHash) {
      let maxVal = 0, from = "", to = "";
      for (const h of hops) { const v = h.value ?? 0; if (v > maxVal) { maxVal = v; from = (h.from ?? "").toLowerCase(); to = (h.to ?? "").toLowerCase(); } }
      const best = bestHopMatch(hops.map((h) => ({ from: (h.from ?? "").toLowerCase(), to: (h.to ?? "").toLowerCase(), value: h.value ?? 0 })), chain, reg);
      let row: { key: string; label: string; addrC: string | null; market: string | null; kind: FlowBaselineRow["kind"]; dir: "in" | "out"; v: number } | null = null;
      if (best) {
        row = { key: `${best.key}|${best.dir}`, label: best.label, addrC: best.addr, market: reg.pairHint.get(best.key) ?? null, kind: reg.dexAddrs.has(best.key) ? "swap" : best.dir === "in" ? "deposit" : "withdraw", dir: best.dir, v: best.v || maxVal };
      } else {
        // 검증된 랩 쌍 fast-path (실시간 피드와 동일 규칙 — reg.wrapPairs 는 온체인 검증분만)
        const wrapTo = reg.tokenSymByAddr.get(`${chain}:${to}`), wrapFrom = reg.tokenSymByAddr.get(`${chain}:${from}`);
        if (wrapTo && reg.wrapPairs.has(`${chain}:${to}:${addr}`)) row = { key: `wrap:${to}|in`, label: wrapTo, addrC: to, market: null, kind: "wrap", dir: "in", v: maxVal };
        else if (wrapFrom && reg.wrapPairs.has(`${chain}:${from}:${addr}`)) row = { key: `wrap:${from}|out`, label: wrapFrom, addrC: from, market: null, kind: "unwrap", dir: "out", v: maxVal };
      }
      if (!row) continue; // 미해석(순수 민트/소각·지갑간 전송) = 평소 엣지 흐름으로 집계하지 않음
      // DEX 스왑은 스캔에서 제외 — 고볼륨 토큰은 관측창이 수분으로 붕괴해 /h 외삽이 수백 배 부풀려진다
      // (실측 aerodrome $274M/h). DEX 흐름은 DeFiLlama volumeUsd1d(진짜 24h)로 그래프 엣지에 일원화된다.
      if (row.kind === "swap") continue;
      const usd = row.v * price;
      if (!(usd > 0)) continue;
      const cur = agg.get(row.key);
      if (cur) { cur.usd += usd; cur.count += 1; }
      else {
        agg.set(row.key, {
          token, chain, counterparty: row.label, counterpartyAddr: row.addrC,
          marketHint: row.market, kind: row.kind, direction: row.dir,
          usd, count: 1, usdPerHour: 0, txPerHour: 0, sampleTx: hsh,
        });
      }
    }
    const hours = observedSec / 3600;
    for (const r of agg.values()) {
      if (r.usd < MIN_ROW_USD) continue;
      r.usdPerHour = r.usd / hours;
      r.txPerHour = r.count / hours;
      rows.push(r);
    }
  }));

  // 이중 집계 방지: 이벤트 수집기가 커버하는 라벨(aave 예치 = Supply 이벤트 ∧ aToken 전송)은
  // 전송 스캔 행을 버리고 이벤트 행(24h 전수)을 쓴다. 스캔은 랩퍼·볼트 등 나머지 담당.
  const eventRows = await eventRowsP;
  const normL = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const covered = new Set(LENDING_EVENT_LABELS.map(normL));
  for (const r of eventRows) covered.add(normL(r.counterparty)); // MetaMorpho 볼트명 등 동적 커버 — 같은 흐름의 전송-스캔 행과 이중 집계 방지
  const scanKept = rows.filter((r) => !covered.has(normL(r.counterparty)));
  const all = [...scanKept, ...eventRows];

  all.sort((a, b) => b.usdPerHour - a.usdPerHour);
  return { rows: all, coverage, targetSec: BASELINE_TARGET_SEC, generatedAt: new Date().toISOString() };
}

export async function GET(req: Request) {
  if (!KEY) return NextResponse.json({ rows: [], coverage: [], targetSec: BASELINE_TARGET_SEC, generatedAt: new Date().toISOString(), error: "ALCHEMY_API_KEY not set" } satisfies BaselinePayload);
  const url = new URL(req.url);
  const addrParam = (url.searchParams.get("addrs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const nodesParam = url.searchParams.get("nodes") ?? "";

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
  // 공개·무인증 엔드포인트 보호 — chain:addr 중복 제거 + 개수 상한(제자리). /api/transactions 와 동일. (2026-06-13 감사)
  { const seen = new Set<string>(); let w = 0; for (const t of targets) { const k = `${t.chain}:${t.addr}`; if (seen.has(k) || w >= MAX_FLOW_TARGETS) continue; seen.add(k); targets[w++] = t; } targets.length = w; }
  if (!targets.length) return NextResponse.json({ rows: [], coverage: [], targetSec: BASELINE_TARGET_SEC, generatedAt: new Date().toISOString() } satisfies BaselinePayload);

  const cacheKey = `${addrParam.sort().join(",")}|${nodesParam}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.data);
  let p = _inflight.get(cacheKey);
  if (!p) {
    p = build(targets, nodesParam)
      .then((data) => {
        // 캐시 위생 — nodes 파라미터는 그래프 갱신마다 변형되므로 키가 계속 늘어난다:
        // 만료분 sweep + 사이즈 캡(FIFO) 없이는 장수 프로세스에서 단조 증가.
        for (const [k, v] of _cache) if (Date.now() - v.at >= CACHE_TTL_MS) _cache.delete(k);
        while (_cache.size >= 64) { const oldest = _cache.keys().next().value; if (oldest == null) break; _cache.delete(oldest); }
        _cache.set(cacheKey, { at: Date.now(), data });
        return data;
      })
      .finally(() => { _inflight.delete(cacheKey); });
    _inflight.set(cacheKey, p);
  }
  try {
    return NextResponse.json(await p);
  } catch (e) {
    return NextResponse.json({ rows: [], coverage: [], targetSec: BASELINE_TARGET_SEC, generatedAt: new Date().toISOString(), error: String(e).slice(0, 160) } satisfies BaselinePayload, { status: 200 });
  }
}
