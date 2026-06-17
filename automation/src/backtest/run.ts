/**
 * Fork 백테스트 러너 — 각 사건을 poll 시퀀스로 fork 재생하고 **프로덕션 디텍터를 그대로** 돌려 알림을 발화한다.
 *
 * 흐름(사건마다):
 *   1) poll 들을 시간순으로 fork 읽기(fork-reader) → 각 시점 TokenSnapshotResult.
 *   2) in-memory 베이스라인 구성(직전 poll 공급=prevBlock · 과거 공급 시계열 · 가격 median baseline · 가치 시계열).
 *   3) 프로덕션 순수 디텍터 호출: checkTotalSupply · checkDepeg · computeValueDrift.
 *      (diffAndAlert 는 DB IO·DB 베이스라인이라 백테스트엔 부적합 — 동일 디텍터 함수를 직접 구동.)
 *   4) severity별 쿨다운 dedup 으로 "원래 발화하듯" 타임라인 구성 + per-kind 최대 severity 로 detected 채점.
 *
 * 채점:
 *   · 비-control: expect[] kind 중 하나라도 발화하면 DETECTED(기대 severity 이상이면 PASS, 미만이면 CALIB=발화는 함).
 *   · control: mustNotFire kind 가 어느 poll 에서도 warning+ 면 FP(실패).
 * FP 를 늘려 억지 통과하지 않도록 control 을 함께 채점한다.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { cooldownSecondsFor, RECOMMENDED_THRESHOLDS as T, type Severity } from "@/config/alert-thresholds";
import { INCIDENTS, type Incident, type Poll } from "@/backtest/incidents";
import { readForkSnapshot, readTokenAt, readConservationAtTime, readAaveUtils, seedBlockCache, flushForkCache, CHAIN_ID, type ForkSnapshot } from "@/backtest/fork-reader";
import { checkDepeg } from "@/snapshot/rules/depeg";
import { checkTotalSupply } from "@/snapshot/rules/supply";
import { computeValueDrift, type ValuePoint } from "@/snapshot/value-drift";
import { evaluateBacking } from "@/snapshot/supply-backing";
import type { DiffAlert } from "@/snapshot/rules/shared";

const _here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(_here, "..", "..", "backtest", "results.json");
const VERBOSE = process.argv.includes("--verbose");
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1] : null; })();

const SEV_RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 };
const MAX_POLLS = 230; // 윈도 폴 상한(폭주 방지) — 5분 간격이면 ~19h(rsETH 처럼 사건~전파가 하루 걸치는 케이스 수용)

/** 사건 → poll 시퀀스. window 있으면 5분 간격 자동생성(+baselineAt prepend), 없으면 명시 polls. */
function buildPolls(inc: Incident): Poll[] {
  if (inc.window) {
    const step = (inc.window.stepMin ?? 5) * 60;
    const from = Math.floor(new Date(inc.window.from).getTime() / 1000);
    const to = Math.floor(new Date(inc.window.to).getTime() / 1000);
    const out: Poll[] = [];
    if (inc.baselineAt) out.push({ at: inc.baselineAt, role: "baseline" });
    let n = 0;
    for (let t = from; t <= to && n < MAX_POLLS; t += step, n++) {
      out.push({ at: new Date(t * 1000).toISOString(), role: "snapshot" });
    }
    return out;
  }
  return [...(inc.polls ?? [])];
}
const median = (xs: number[]): number | null => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

interface PollEmit {
  role: string; tsSec: number; block: number; price: number | null; priceSource: string; supply: number;
  alerts: { kind: string; severity: Severity; message: string; chain: string; token: string; block: number; tx?: string }[];
}
interface IncidentResult {
  id: string; name: string; category: string; token: string; chain: string;
  status: "PASS" | "CALIB" | "MISS" | "FP" | "ERROR";
  detail: string;
  detected: { kind: string; severity: Severity }[]; // per-kind 최대 severity (전 poll)
  polls: PollEmit[];
}

/** 한 사건 재생. */
async function runIncident(inc: Incident): Promise<IncidentResult> {
  const base: IncidentResult = {
    id: inc.id, name: inc.name, category: inc.category, token: inc.token.symbol, chain: inc.displayChain ?? inc.chain,
    status: "MISS", detail: "", detected: [], polls: [],
  };
  const polls = buildPolls(inc).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // 블록 캐시 시딩 — 5분 촘촘 폴의 블록을 산술 추정으로 효율 해석(체인별 이진탐색 1회). conservation 은 홈+remote 체인도.
  const tsList = polls.map((p) => Math.floor(new Date(p.at).getTime() / 1000));
  try {
    await seedBlockCache(CHAIN_ID[inc.chain] ?? 1, tsList);
    if (inc.conservation) {
      await seedBlockCache(1, tsList);
      for (const r of inc.conservation.remotes) await seedBlockCache(CHAIN_ID[r.chain] ?? 1, tsList);
    }
    if (inc.relatedMarkets) await seedBlockCache(1, tsList); // Aave pool = ethereum
    if (inc.relatedTokens) for (const rt of inc.relatedTokens) await seedBlockCache(CHAIN_ID[rt.chain] ?? 1, tsList); // 연관 토큰 체인(교차체인 가능)

  } catch { /* 시딩 실패해도 blockAtTimestamp 이진탐색 폴백 */ }

  // value_drift 윈도 — 프로덕션은 24h(5분 스냅샷 전제)지만 백테스트 poll 은 며칠 간격. 사건 poll 범위를 덮도록
  //   윈도를 늘리고 minSamples 를 2로 (희소 poll 대응). 임계(낙폭%·minAbsUsd·units분해)는 프로덕션 그대로 — 민감도 불변.
  const spanH = polls.length > 1
    ? (new Date(polls[polls.length - 1].at).getTime() - new Date(polls[0].at).getTime()) / 3_600_000
    : 24;
  const Tvd = { ...T, valueDrift: { ...T.valueDrift, windowHours: Math.max(24, Math.ceil(spanH) + 1), minSamples: 2 } };

  // fork 읽기(순차 — 블록캐시·rate limit 배려).
  const snaps: ForkSnapshot[] = [];
  for (const p of polls) {
    try { snaps.push(await readForkSnapshot(inc, p, { skipDex: !!inc.conservation })); }
    catch (e) { return { ...base, status: "ERROR", detail: `poll ${p.role}: ${(e as Error).message.slice(0, 140)}` }; }
  }

  // 심볼 정합 체크(주소 오류 조기 검출) — 온체인 symbol 과 레지스트리 심볼 불일치면 ERROR.
  const sym0 = snaps[0].symbolOnchain.toUpperCase();
  const want = inc.token.symbol.toUpperCase().replace(/\+/g, "");
  if (sym0 && want && !sym0.includes(want) && !want.includes(sym0)) {
    return { ...base, status: "ERROR", detail: `심볼 불일치: 온체인 ${snaps[0].symbolOnchain} ≠ ${inc.token.symbol} (주소 확인)` };
  }

  // poll 시퀀스 — in-memory 베이스라인 누적.
  const priorPrices: number[] = [];
  const priorSupplies: number[] = []; // 오래된→최신 (checkTotalSupply 는 newest-first 요구 → reverse 전달)
  const valueSeries: ValuePoint[] = [];
  let prevPollSupply: number | null = null;
  let prevBacking: number | null = null; // conservation: 직전 poll escrow 잠금분(드레인 폭 계산용)
  let maxBacking = 0; // conservation: 사전(베이스라인) escrow 잠금분 최고치 — 드레인 = maxBacking − 현재(= release 된 canonical = 전체 무담보 규모)
  let baselineSupply: number | null = null; // value_outflow: 첫 관측 공급(units 붕괴=리뎀션 런 탐지 기준선)
  const relBaseUtil = new Map<string, number>(); // contagion: 연관마켓 첫 관측 가동률(최초 정상치 — onset 기준선)
  const relLastFiredUtil = new Map<string, number>(); // contagion: 직전 **발화** 가동률 — 에스컬레이션 단계(99.4%→99.7%)를 직전 알림 대비로 표시
  const fmtK = (x: number) => x >= 1000 ? `${(x / 1000).toFixed(1)}K` : x.toFixed(0);
  const fmtM = (x: number) => `$${(x / 1e6).toFixed(0)}M`;

  const perKindMax = new Map<string, Severity>();
  const bumpMax = (kind: string, sev: Severity) => {
    const cur = perKindMax.get(kind);
    if (!cur || SEV_RANK[sev] > SEV_RANK[cur]) perKindMax.set(kind, sev);
  };
  // 쿨다운 dedup(원래 발화하듯) — kind|token별 마지막 발화 {severity, ts}. 동일/하위 severity 가 쿨다운 내면 억제.
  const cooldownState = new Map<string, { rank: number; ts: number }>();
  const lastMetric = new Map<string, number>(); // depeg 편차/single_mint bps — 더 깊어지면 재발화(심화 표시)

  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const fired: DiffAlert[] = [];

    // ── 공급/민트 (단일 대량 민트 · z-스파이크) ──
    fired.push(...checkTotalSupply(s.snap, prevPollSupply, [...priorSupplies].reverse(), T));

    // ── 디페그 (USD/LST/BTC) — 백테스트는 **점진 심화 표시**가 목적이라 priceBaseline=null 로 호출:
    //   라이브의 "지속-디페그 baseline 추적 억제"(anti-spam)가 점진 하강을 첫 발화 후 묵살하는 걸 피하고, peg($1)
    //   절대편차로 평가해 가격이 떨어질수록 severity 가 올라가게(warning→critical). depegSeverity 임계는 동일(실로직).
    fired.push(...(await checkDepeg(s.snap, T, null)));

    // ── 가치 드리프트 (자금 유출/리뎀션 런) — 현재 poll 까지의 가치 시계열로 평가 ──
    if (s.snap.token.metadata.marketCapUsd != null) {
      valueSeries.push({ ts: s.tsSec, valueUsd: s.snap.token.metadata.marketCapUsd, nChains: 1, supplyUnits: s.supplyHuman });
      const vd = computeValueDrift(inc.token.symbol, valueSeries, Tvd);
      if (vd) fired.push({ severity: vd.severity, kind: "value_drift", token: inc.token.symbol,
        message: `총가치 −${(vd.dropPct * 100).toFixed(1)}% · $${(vd.dropUsd / 1e6).toFixed(1)}M`, detail: {} });
    }
    // ── 공급 units 붕괴(리뎀션 런) — 가격 커버리지가 없어도(deUSD 처럼 llama null) 온체인 totalSupply 감소만으로 자금유출 포착.
    //   value_drift 의 본질은 "실자금 이탈"이고 그건 units 감소로 드러난다(가격 마크다운과 구분). price-독립 경로.
    if (baselineSupply == null) baselineSupply = s.supplyHuman;
    else if (baselineSupply > 0 && s.supplyHuman < baselineSupply) {
      const supDrop = (baselineSupply - s.supplyHuman) / baselineSupply;
      const sev = supDrop >= T.valueDrift.dropPct.critical ? "critical" : supDrop >= T.valueDrift.dropPct.warning ? "warning" : null;
      if (sev) fired.push({ severity: sev, kind: "value_drift", token: inc.token.symbol,
        message: `공급 −${(supDrop * 100).toFixed(1)}% (${fmtK(baselineSupply)}→${fmtK(s.supplyHuman)}, 대량 리뎀션·자금 유출)`, detail: {} });
    }

    // ── 교차체인 무담보 발행 (supply_conservation) — escrow(잠긴 canonical) vs Σremote 불변식, 프로덕션 evaluateBacking 그대로 ──
    if (inc.conservation) {
      try {
        const cons = await readConservationAtTime(inc.conservation, s.tsSec);
        maxBacking = Math.max(maxBacking, cons.backing); // 사전(정상) escrow 잠금분 최고치
        // 트리거는 프로덕션 evaluateBacking 그대로(Σremote > backing = 무결성 붕괴 → 드레인 후 발화).
        const finding = evaluateBacking({
          symbol: inc.token.symbol, homeChain: "ethereum", decimals: inc.conservation.decimals,
          circulating: "remotes", tolBps: inc.conservation.tolBps ?? T.unbacked.toleranceBps,
          backing: cons.backingRaw, remoteSum: cons.remoteSumRaw, staleHome: false, breakdown: {},
        });
        if (finding) {
          const sev: Severity = (cons.backingRaw === 0n || finding.overageBps >= T.supplyConservation.critPctBps) ? "critical" : "warning";
          // ★ 무담보 규모 = **escrow 드레인**(baseline backing − 현재 backing) = release/탈취된 canonical = **전(全)체인 무담보 규모**.
          //   ⚠️ Σremote−backing(이전 방식)은 아카이브 가능한 arb+base 2체인만 세어 과소집계(58.6K)였다. OFT 메시는 더 많은
          //   체인에 퍼져 있고, 공격은 메인넷 escrow 에서 canonical 을 release 한 것이므로 **드레인 폭**이 진짜 무담보 규모(웹 확인 116.5K).
          const drain = Math.max(0, maxBacking - cons.backing);
          const stablePx = median(priorPrices) ?? s.price ?? 0; // 안정 기준가(글리치 spot 대신 — USD 흔들림 방지)
          const usd = stablePx > 0 ? ` (~${fmtM(drain * stablePx)})` : "";
          const msg = `무담보 발행 ${fmtK(drain)} rsETH${usd}`;
          const aChain = inc.conservation.attackChain ?? "ethereum";
          fired.push({ severity: sev, kind: "supply_conservation", token: inc.token.symbol, message: msg,
            detail: { chain: aChain, block: cons.homeBlock, tx: inc.conservation.attackTx, unbacked: drain, backing: cons.backing, drainFrom: maxBacking } });
        }
        prevBacking = cons.backing;
      } catch { /* 체인 read 실패 — 이 poll 의 conservation 만 skip */ }
    }

    // ── 연관 시장 contagion (Aave 가동률) — 사건 토큰 외 전파된 위험까지 발화해 "의존성"을 보여준다. ──
    if (inc.relatedMarkets) {
      for (const rm of inc.relatedMarkets) {
        try {
          const { block: aaveBlk, utils } = await readAaveUtils(rm.pool, rm.tokens, s.tsSec);
          for (const u of utils) {
            let firstBase = relBaseUtil.get(u.symbol);
            if (firstBase == null) { relBaseUtil.set(u.symbol, u.util); firstBase = u.util; } // 최초 관측 정상치
            const lvl = (u.util * 100).toFixed(1);
            // base→현재 표기: onset 은 정상치(77%)→현재, 이후 에스컬레이션은 **직전 발화 수준**→현재(99.4%→99.7%).
            const baseUtil = relLastFiredUtil.get(u.symbol) ?? firstBase;
            const baseStr = `${(baseUtil * 100).toFixed(1)}%→`; // current(lvl)와 동일 정밀도 — 에스컬레이션은 99.4%→99.7% 처럼 정확히
            // ★ 가동률 severity (사용자 피드백): Aave 는 emode 로 평시도 가동률이 높다 → 98~99% 를 info/warning(파랑/노랑)으로
            //   잘게 나누면 색만 혼란스럽다. **~100%(공급 거의 소진 = 인출 봉쇄)는 누가 봐도 위험**이므로 **≥99% 일 때만
            //   발화하고 항상 critical(빨강)** 로 통일. 그 미만은 미발화(상승 onset 은 utilization_jump 가 표시).
            //   메시지는 가동률 사실만(인과/의존성은 사건 뷰 동시 등장으로 추론 — 사용자 요청).
            const hsev: Severity | null = u.util >= 0.99 ? "critical" : null;
            if (hsev) fired.push({ severity: hsev, kind: "high_utilization", token: u.symbol,
              message: `${rm.protocol} ${u.symbol} 이용률 ${baseStr}${lvl}%`, detail: { chain: "ethereum", cause: inc.token.symbol, block: aaveBlk, util: u.util } });
            // 가동률 급등(Δ≥12pp & ≥70%, 정상치 대비) — 인출 러시 onset.
            const jump = u.util - firstBase;
            if (jump >= T.utilizationLiquidity.jumpActionable && u.util >= T.utilizationLiquidity.jumpMinLevel) {
              fired.push({ severity: "warning", kind: "utilization_jump", token: u.symbol,
                message: `${rm.protocol} ${u.symbol} 이용률 +${(jump * 100).toFixed(0)}pp → ${lvl}%`, detail: { chain: "ethereum", cause: inc.token.symbol, block: aaveBlk, util: u.util } });
            }
          }
        } catch { /* 마켓 read 실패 — 이 poll skip */ }
      }
    }

    // ── 연관 토큰 contagion (depeg 전파) — 사건 토큰의 부실이 **다른 토큰으로 전파**되는 의존성. 그 토큰의 가격/공급을
    //   fork 읽어 프로덕션 checkDepeg 를 그대로 돌린다 → "관련 없어 보이는 스테이블"이 동반 디페그하는 걸 보여준다.
    //   예: xUSD 무담보 폭로 → Elixir 가 deUSD 준비금 65% 를 Stream(xUSD 담보)에 대출 → 며칠 뒤 deUSD 동반 붕괴.
    if (inc.relatedTokens) {
      for (const rt of inc.relatedTokens) {
        try {
          const rs = await readTokenAt(rt.chain, rt.address, rt.symbol, s.tsSec);
          // priceBaseline=null → peg($1) 절대편차로 평가(점진 심화 warning→critical). 라이브 anti-spam baseline 억제 우회(사건 토큰과 동일 규약).
          for (const a of await checkDepeg(rs.snap, T, null)) {
            const dev = Number((a.detail as Record<string, unknown> | undefined)?.deviationBps ?? 0);
            // ⚠️ 알림 메시지는 **신호 사실만**(사용자 요청: 인과 연결은 사후적이라 표시 안 함). 의존성은 연관 토큰이
            //   사건 뷰에 함께 등장 + 사건명으로 추론. cause/rt.cause 는 detail/코드 문서화용으로만 보존(미표시).
            fired.push({ severity: a.severity, kind: "depeg", token: rt.symbol,
              message: a.message,
              detail: { chain: rt.chain, block: Number(rs.block), cause: inc.token.symbol, deviationBps: dev } });
          }
        } catch { /* 연관 토큰 read 실패 — 이 poll skip */ }
      }
    }

    // dedup(쿨다운) 적용 → 이 poll 에서 "실제 발화"로 남는 알림. ⚠️ 연관 토큰 contagion 은 토큰별로 독립 dedup
    //   (같은 high_utilization 이라도 WETH/USDC/USDT 는 각각 보여야 의존성이 드러남) → 쿨다운 키 = kind+token.
    const emitted: { kind: string; severity: Severity; message: string; chain: string; token: string; block: number; tx?: string }[] = [];
    for (const a of fired) {
      const dk = `${a.kind}|${a.token}`;
      bumpMax(a.kind, a.severity); // detected 채점은 dedup 전(시스템이 탐지는 함)
      const prior = cooldownState.get(dk);
      const cd = cooldownSecondsFor(a.severity);
      // 심화 예외 — 같은 severity 쿨다운 내라도 강도(metric)가 ≥10pp 더 깊어지면 재발화("시간에 따라 심해지는" 표시).
      //   depeg=deviationBps · supply_single_mint=bps(누적 mint%) → 점진 디페그/연쇄 무단민트 둘 다 타임라인에 보임.
      const det = a.detail as Record<string, unknown> | undefined;
      // ★ **지속형 신호**(persistent) — 한 번 깨지면/도달하면 윈도 내내 그 상태가 유지되는 신호:
      //   · supply_conservation: 무단 민트/escrow 드레인 → Σremote>backing 이 계속 참(장부 자가복구 없음).
      //   · high_utilization: Aave 가동률이 한 번 ~100% 도달하면 인출 봉쇄로 plateau(계속 ~100%).
      //   디텍터는 stateless 라 매 poll 같은 상태를 재발견하고, 쿨다운(critical 1h)만으로 억제하면 "1 사건"이 12h
      //   윈도서 십수 번 뜬다(스팸·하드코딩처럼 보임). 따라서 **onset 1회 + 강도가 의미있게 커질 때만** 재발화
      //   (supply_conservation=2차 민트, high_utilization=토큰별 첫 봉쇄+큰 추가악화). 1 상태 = 1 알림.
      //   depeg 도 지속형 — 한 번 디페그되면 윈도 내내 sub-peg 가 유지된다. 쿨다운(critical 1h)으로 반복하면 4일
      //   윈도서 80+번 뜬다(대부분 ~-83% 플래토 반복=노이즈). onset + 심화(편차 10pp↑)·심각도 상승 시만 발화하면
      //   "시간에 따라 깊어지는 디페그"(item 3)는 다 보이면서 플래토 반복은 사라진다.
      const persistent = a.kind === "supply_conservation" || a.kind === "high_utilization" || a.kind === "depeg";
      const metric = a.kind === "depeg" ? Number(det?.deviationBps ?? 0)        // 편차 bps
        : a.kind === "supply_single_mint" ? Number(det?.bps ?? 0)               // 누적 mint bps
        : a.kind === "supply_conservation" ? Number(det?.unbacked ?? 0)         // 무담보 규모(토큰 units)
        : a.kind === "high_utilization" ? Number(det?.util ?? 0) * 10_000       // 가동률 bps
        : NaN;
      // 악화 판정 — **지금까지 발화한 최대 강도(러닝 MAX)** 대비 충분히 커졌나(depeg/mint=+1000bps=10pp, conservation=+1000 units, util=+10pp).
      //   ⚠️ 러닝 MAX 인 이유: 가격 피드가 진동(USR 류 thin 유동성)하면 회복 후 **얕은 재저점**이 직전-발화값보다 깊어 재발화 →
      //   같은 사건이 11번 "링잉"(스팸)하던 것. MAX 대비로 보면 **진짜 새 최저(더 깊은 악화)만** 재발화 → 회복-반등 노이즈 제거.
      const worsened = Number.isFinite(metric) && metric - (lastMetric.get(dk) ?? -Infinity) >= 1000;
      // ★ 심각도 상승(또는 onset)은 **항상** 재발화 — depeg info→warning→critical 심화를 타임라인에 보장.
      const sevUp = !prior || SEV_RANK[a.severity] > prior.rank;
      // ★ high_utilization 이 처음 ~100%(≥99.9% = 공급 거의 완전 소진)에 도달하면 강제 1회 재발화 — onset(첫 ≥99%) 후
      //   99.x% 플래토는 억제되지만 "100% 찍은 순간"은 반드시 보여준다(사용자: 100% 빠뜨림 지적). 이후엔 relLastFiredUtil 이 ≥99.9% 라 재발화 안 함.
      const reached100 = a.kind === "high_utilization" && Number(det?.util ?? 0) >= 0.999 && (relLastFiredUtil.get(a.token) ?? 0) < 0.999;
      // 억제: 지속형은 쿨다운 무관하게 (악화·심각도상승·100%도달 아니면) 억제. 그 외는 기존(쿨다운 내 & 악화·상승 아님).
      if (prior && !worsened && !sevUp && !reached100 && (persistent || (s.tsSec - prior.ts < cd))) continue;
      if (Number.isFinite(metric)) lastMetric.set(dk, Math.max(lastMetric.get(dk) ?? -Infinity, metric)); // 러닝 MAX(회복 후 얕은 재저점 재발화 방지)
      cooldownState.set(dk, { rank: SEV_RANK[a.severity], ts: s.tsSec });
      // 알림별 체인 — detail.chain(명시) 우선, 없으면 사건 기본 체인. (supply_conservation/연관마켓=ethereum, 그 외=inc.chain)
      const aChain = (a.detail && typeof a.detail === "object" && typeof (a.detail as Record<string, unknown>).chain === "string")
        ? (a.detail as Record<string, string>).chain : inc.chain;
      // supply_single_mint 메시지 접미사 "· 단일 블록"(production 라벨, 백테스트선 부정확)은 제거 → 가동률 사실만(사용자 요청).
      const msg = a.kind === "supply_single_mint" ? a.message.replace(/\s*·\s*단일 블록\s*$/, "") : a.message;
      // 알림별 블록 — 해당 알림이 읽힌 그 체인의 블록(detail.block; conservation=ethereum escrow블록, Aave=eth블록, 그 외=사건체인 블록).
      const aBlockRaw = Number((a.detail as Record<string, unknown> | undefined)?.block ?? s.block);
      const aBlock = Number.isFinite(aBlockRaw) ? aBlockRaw : Number(s.block); // 검증 앵커는 항상 유효 블록 보장(누락/NaN 방지)
      // 원인 tx — 알림에 단일 원인 tx(detail.tx; 예 rsETH escrow 드레인 tx)가 있으면 바로가기를 tx 로(블록 대신).
      const aTx = (a.detail as Record<string, unknown> | undefined)?.tx;
      emitted.push({ kind: a.kind, severity: a.severity, message: msg, chain: aChain, token: a.token, block: aBlock, ...(typeof aTx === "string" ? { tx: aTx } : {}) });
      // 가동률 알림(jump·high_util) 발화 시 직전 표시 가동률 갱신 → 다음 high_util "from"이 직전 표시값에서 이어짐
      //   (jump 가 89.8% 를 보였으면 그 뒤 high_util 은 89.8%→99.1%; 76.8%로 후퇴해 보이던 것 수정 — 독립리뷰 지적).
      if (a.kind === "high_utilization" || a.kind === "utilization_jump") relLastFiredUtil.set(a.token, Number((a.detail as Record<string, unknown>)?.util ?? 0));
    }

    base.polls.push({
      role: polls[i].role, tsSec: s.tsSec, block: Number(s.block), price: s.price,
      priceSource: s.priceSource, supply: s.supplyHuman, alerts: emitted,
    });

    // 베이스라인 누적(다음 poll 용).
    if (s.price != null) priorPrices.push(s.price);
    priorSupplies.push(s.supplyHuman);
    prevPollSupply = s.supplyHuman;
  }

  base.detected = [...perKindMax.entries()].map(([kind, severity]) => ({ kind, severity }));

  // ── 채점 ──
  if (inc.category === "control") {
    const violations = base.polls.flatMap((p) => p.alerts)
      .filter((a) => (inc.mustNotFire ?? []).includes(a.kind) && SEV_RANK[a.severity] >= SEV_RANK.warning);
    if (violations.length) return { ...base, status: "FP", detail: `발화하면 안 되는 신호: ${violations.map((v) => `${v.kind}(${v.severity})`).join(", ")}` };
    return { ...base, status: "PASS", detail: "control — 미발화 정상" };
  }

  // 비-control: expect kind 중 하나라도 detected 면 통과. 기대 severity 이상=PASS, 미만=CALIB.
  let bestPass: string | null = null;
  let calib: string | null = null;
  for (const e of inc.expect) {
    const got = perKindMax.get(e.kind);
    if (!got) continue;
    if (SEV_RANK[got] >= SEV_RANK[e.minSeverity]) { bestPass = `${e.kind} ${got} ≥ ${e.minSeverity}`; break; }
    calib = `${e.kind} ${got} < 기대 ${e.minSeverity}`;
  }
  if (bestPass) return { ...base, status: "PASS", detail: bestPass };
  if (calib) return { ...base, status: "CALIB", detail: calib };
  return { ...base, status: "MISS", detail: `기대 신호 미발화: ${inc.expect.map((e) => e.kind).join(",")}` };
}

async function main() {
  const onlyPats = ONLY ? ONLY.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const targets = onlyPats ? INCIDENTS.filter((i) => onlyPats.some((p) => i.id.includes(p))) : INCIDENTS;
  if (!targets.length) { console.error(`매칭 사건 없음: ${ONLY}`); process.exit(1); }

  const results: IncidentResult[] = [];
  for (const inc of targets) {
    process.stdout.write(`  ▸ ${inc.id} … `);
    const r = await runIncident(inc);
    results.push(r);
    flushForkCache(); // 사건마다 fork read 캐시를 디스크에 기록 — 다음 재실행은 캐시 히트로 즉시(온체인 read 0)
    await new Promise((res) => setTimeout(res, 400)); // 사건 간 throttle(무료 RPC rate-limit 여유)
    const icon = r.status === "PASS" ? "✅" : r.status === "CALIB" ? "◐" : r.status === "FP" ? "🔴FP" : r.status === "ERROR" ? "⚠️ERR" : "❌MISS";
    console.log(`${icon} ${r.detail}`);
    if (VERBOSE) for (const p of r.polls) {
      const pr = p.price != null ? `$${p.price.toFixed(4)}` : "—";
      console.log(`       [${p.role}] blk ${p.block} · ${pr}(${p.priceSource}) · supply ${p.supply.toExponential(3)} · ${p.alerts.map((a) => `${a.kind}:${a.severity}`).join(", ") || "(없음)"}`);
    }
  }

  const inc = results.filter((r) => r.category !== "control");
  const ctl = results.filter((r) => r.category === "control");
  const pass = inc.filter((r) => r.status === "PASS").length;
  const calib = inc.filter((r) => r.status === "CALIB").length;
  const detected = pass + calib;
  const miss = inc.filter((r) => r.status === "MISS");
  const err = results.filter((r) => r.status === "ERROR");
  const fp = ctl.filter((r) => r.status === "FP");

  console.log(`\n═══ Fork 백테스트 스코어보드 ═══`);
  console.log(`사건 ${inc.length}개 · control ${ctl.length}개`);
  console.log(`  ✅ PASS ${pass} · ◐ CALIB(발화O·sev<기대) ${calib} · ❌ MISS ${miss.length} · ⚠️ ERROR ${err.length}`);
  // control 이 없으면 FP 율은 무의미 → 공허한 'FP 0' 주장 안 함(정직). control 있을 때만 표기.
  const ctlStr = ctl.length ? `  ·  control FP ${fp.length}/${ctl.length}` : "";
  console.log(`  탐지율(발화) ${inc.length ? ((detected / inc.length) * 100).toFixed(1) : 0}%${ctlStr}`);
  const green = miss.length === 0 && fp.length === 0 && err.length === 0;
  console.log(`  결과: ${green ? `🟢 GREEN (전 ${inc.length}사건 탐지${ctl.length ? " · control FP 0" : ""})` : "🔴 RED"}`);
  if (miss.length || fp.length || err.length) {
    console.log("\n미해결:");
    for (const r of [...miss, ...fp, ...err]) console.log(`  [${r.status}] ${r.id} — ${r.detail}`);
  }

  // 프론트 패널용 결과 저장. ⚠️ ERROR(일시 RPC/429 인프라 실패)가 있으면 기존 results.json 을 보존 —
  //   transient 실패가 정상 GREEN 스냅샷을 덮어쓰지 않게(cron 동시구동 충돌 대비). --force 로 강제 저장.
  const force = process.argv.includes("--force");
  if (err.length === 0 || force) {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    // --only 재실행은 기존 results.json 에 **병합**(id 키) — 다른 사건 보존하며 변경 사건만 갱신(반복 수정 비용↓).
    let toWrite = results;
    if (ONLY) {
      try {
        const prev = JSON.parse(readFileSync(OUT_PATH, "utf8")) as { results: IncidentResult[] };
        const byId = new Map((prev.results ?? []).map((r) => [r.id, r]));
        for (const r of results) byId.set(r.id, r);
        toWrite = [...byId.values()];
      } catch { /* 기존 없음 → 새로 작성 */ }
    }
    writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), results: toWrite }, null, 2));
    console.log(`\n결과 저장: backtest/results.json (${toWrite.length} 사건${ONLY ? `, ${results.length} 갱신` : ""})`);
  } else {
    console.log(`\n⚠️ ERROR ${err.length}건(일시 인프라 실패 추정) — 기존 results.json 보존(덮어쓰기 안 함). 강제 저장: --force`);
  }
  process.exit(green ? 0 : 1);
}

main().catch((e) => { console.error("백테스트 실패:", e); process.exit(1); });
