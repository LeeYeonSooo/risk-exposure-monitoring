/**
 * 크로스체인 공급 보존(supply_conservation) 러너 — Kelp DAO rsETH류 무담보 OFT mint 탐지.
 *
 * 불변식(escrow): Σ(관측 L2 공급) > 홈 OFT-Adapter lockbox 잔액(escrow) + slack → 무담보 mint 의심.
 *   기존 Detector A(unbacked_supply)와 동일 불변식이나 (a) OFT lock-mint LRT(rsETH/weETH/USDT0)를 명시 watch,
 *   (b) NAV backstop·USD 사이징, (c) 상태형 auto-resolve, (d) persistence/corroboration 으로 일반화.
 *   설계서: automation/docs/supply-conservation-detector-design.md
 *
 * STATE형: 조건 지속 시 standing alert, 해소 시 resolveStaleAlerts 로 자동 해소.
 * SHADOW 해제됨(2026-06): 관찰기간 종료 → 기본 active(warning/critical 발화). 이 디텍터가 Kelp(~$200M)
 *   정조준이라 breach 를 info 로만 캡하면 진짜 무담보 mint 가 page 안 됨. armed·persistence·corroboration·USD floor
 *   게이트가 FP 를 막으므로 노이즈 위험 낮음. 재-관찰 필요 시 SUPPLY_CONS_SHADOW=true 로 캡 복원.
 *
 * Usage: npm run snapshot:supplycons   (또는 tsx scripts/snapshot-supply-conservation.ts)
 * Env: DATABASE_URL(필수), ALCHEMY_API_KEY(권장), SUPPLY_CONS_SHADOW(기본 false=active; true 면 info 캡 복원)
 */
import process from "node:process";

import { RECOMMENDED_THRESHOLDS } from "@/config/alert-thresholds";
import { env, isActiveChain } from "@/config/chains";
import { closePool, query } from "@/db/client";
import { insertAlert, loadActiveAlertKeys, resolveStaleAlerts } from "@/db/upsert";
import { clientFor, fmtToken as fmt, publicClientFor } from "@/snapshot/scanner-kit";
import {
  CONSERVATION_WATCHES, readRate, readUnderlyingUsd, resolveLegEscrows, type ConservationWatch,
} from "@/snapshot/supply-conservation";
import { evaluateBacking, readBacking, readTotalSupply } from "@/snapshot/supply-backing";

const MANAGED_KINDS = ["supply_conservation"];
const SCAN_SOURCE = "supply-conservation-v1";
const SHADOW = process.env.SUPPLY_CONS_SHADOW === "true"; // 기본 false=active(warning/critical 발화). true 면 info 캡 복원
const T = RECOMMENDED_THRESHOLDS.supplyConservation;

// live totalSupply — Alchemy(clientFor) 실패 시 publicnode(publicClientFor) 폴백. 둘 다 실패 null. (Σ-integrity 이중화)
async function liveSupply(chain: string, token: string): Promise<bigint | null> {
  const a = clientFor(chain);
  let s = a ? await readTotalSupply(a, token) : null;
  if (s === null) { const p = publicClientFor(chain); if (p) s = await readTotalSupply(p, token); }
  return s;
}

async function corroborated(symbol: string): Promise<string[]> {
  const r = await query<{ kind: string }>(
    `SELECT DISTINCT kind FROM alerts
     WHERE kind IN ('supply_single_mint','chain_supply_spike','supply_spike')
       AND token = $1 AND resolved_at IS NULL AND created_at > now() - interval '48 hours'`,
    [symbol],
  ).catch(() => ({ rows: [] as { kind: string }[] }));
  return r.rows.map((x) => x.kind);
}

// ── escrow/그룹공급 시계열(chain_supply_samples 재사용, pseudo-chain) — escrow 급락(Kelp b) 탐지용 ──
async function lastSample(tokenNodeId: string, chain: string): Promise<number | null> {
  const r = await query<{ v: number }>(
    `SELECT total_supply v FROM chain_supply_samples WHERE token_node_id=$1 AND chain=$2 ORDER BY snapshot_ts DESC LIMIT 1`,
    [tokenNodeId, chain],
  ).catch(() => ({ rows: [] as { v: number }[] }));
  return r.rows[0]?.v ?? null;
}
async function recordSample(tokenNodeId: string, chain: string, value: number, ts: string): Promise<void> {
  await query(
    `INSERT INTO chain_supply_samples (snapshot_ts, token_node_id, chain, total_supply) VALUES ($1,$2,$3,$4)
     ON CONFLICT (token_node_id, chain, snapshot_ts) DO NOTHING`,
    [ts, tokenNodeId, chain, value],
  ).catch(() => {});
}

/**
 * 자동 워치 생성 — nodes 테이블에서 홈(ethereum)+관측 L2 둘 다 있는 토큰을 conservation watch 로.
 *   수동 주소 hunting 없음(graph 가 토큰을 알면 자동 감시). escrow 는 resolveLegEscrows 가 발견.
 *   curated(CONSERVATION_WATCHES) 와 wstETH(Detector A 소유)는 제외. rate 미상이라 % 축만(USD 사이징 생략).
 */
async function autoWatches(curatedSyms: Set<string>): Promise<ConservationWatch[]> {
  const r = await query<{ sym: string; chain: string; address: string }>(
    `SELECT upper(label) sym, chain, address FROM nodes
     WHERE type='Token' AND address IS NOT NULL AND chain IN ('ethereum','base','arbitrum')`,
  ).catch(() => ({ rows: [] as { sym: string; chain: string; address: string }[] }));
  const byTok = new Map<string, Record<string, string>>();
  for (const x of r.rows) { (byTok.get(x.sym) ?? byTok.set(x.sym, {}).get(x.sym)!)[x.chain] = x.address; }
  const out: ConservationWatch[] = [];
  for (const [sym, chains] of byTok) {
    if (curatedSyms.has(sym)) continue; // curated(rsETH/weETH/USDT0/wstETH) 중복 제외
    const home = chains.ethereum;
    const remotes = (["base", "arbitrum"] as const).filter((c) => chains[c]).map((c) => ({ chain: c, token: chains[c] }));
    if (!home || remotes.length === 0) continue; // 홈 canonical + 관측 L2 필요
    out.push({
      symbol: sym, homeChain: "ethereum", canonical: home, decimals: 18, remotes, tolBps: 50,
      underlyingPrice: { const: 0 }, confidence: "MEDIUM", note: "auto(nodes) — % 축만, rate 미상",
    });
  }
  return out;
}

async function processWatch(
  w: ConservationWatch,
  activeKeys: Set<string>,
  asserted: Set<string>,
  skipped: Set<string>,
): Promise<void> {
  const key = `supply_conservation|${w.symbol}|chain:multi`;
  const home = clientFor(w.homeChain);
  if (!home) { console.log(`[supplycons] ${w.symbol}: 홈 ${w.homeChain} RPC 없음 — skip(보존)`); skipped.add(key); return; }

  // ── 1) leg 별 escrow 역산(브릿지 무관: LZ peers / Arbitrum gateway / OP L1Bridge / override) ──
  const legs = await resolveLegEscrows({ home, homeChain: w.homeChain, canonical: w.canonical, remotes: w.remotes, clientFor, overrides: w.escrowOverrides });

  // ── 2) leg 별 live 공급 read(Σ-integrity: 하나라도 실패 시 watch skip) + escrow 별 그룹화 ──
  //   ★ 네이티브 게이트웨이=체인 전용 escrow → 1:1 tight 비교 · LZ 공유풀=그룹 loose 비교(타 체인 backing 포함).
  const supplyByLeg: Record<string, string> = {};
  const uncoveredLegs: string[] = [];
  const groups = new Map<string, { chains: string[]; supply: bigint; bridge: string }>();
  for (const leg of legs) {
    if (!isActiveChain(leg.chain)) continue;
    const s = await liveSupply(leg.chain, leg.token);
    if (s === null) { console.log(`[supplycons] ${w.symbol}: ${leg.chain} totalSupply 실패(live+public) — Σ-integrity skip(보존)`); skipped.add(key); return; }
    supplyByLeg[leg.chain] = s.toString();
    if (!leg.escrow) { uncoveredLegs.push(leg.chain); continue; } // escrow 미해결 = 그 leg 미감시(FN, FP 아님)
    const k = leg.escrow.toLowerCase();
    const g = groups.get(k) ?? { chains: [], supply: 0n, bridge: leg.bridge };
    g.chains.push(leg.chain); g.supply += s;
    groups.set(k, g);
  }
  if (groups.size === 0) { console.log(`[supplycons] ${w.symbol}: escrow 해결된 leg 0 — skip(보존; override 필요?)`); skipped.add(key); return; }

  // ── 3) 그룹별 평가 — (a) 절대 보존 Σremote>escrow(mint 메커니즘) + (b) escrow 급락 delta(release 메커니즘=실제 Kelp) ──
  const ts = new Date().toISOString();
  let totalExcess = 0n;
  let worstBps = 0;
  const breachGroups: { escrow: string; bridge: string; chains: string[]; supply: string; escrowBal: string; overageBps: number }[] = [];
  const releaseGroups: { escrow: string; bridge: string; chains: string[]; unexplainedTok: number; dropPct: number }[] = [];
  const groupSummary: Record<string, string> = {};
  for (const [addr, g] of groups) {
    const bal = await readBacking(home, [{ contract: w.canonical, method: "balanceOf" as const, holder: addr }]);
    if (bal === null) { console.log(`[supplycons] ${w.symbol}: escrow ${addr.slice(0, 8)} read 실패 — skip(보존)`); skipped.add(key); return; }
    groupSummary[`${g.bridge}:${addr.slice(0, 8)}`] = `${fmt(g.supply, w.decimals)}/${fmt(bal, w.decimals)} (${g.chains.join("+")})`;

    const balTok = Number(bal) / 10 ** w.decimals;
    const supTok = Number(g.supply) / 10 ** w.decimals;
    const prevBal = await lastSample(`token:${w.symbol}`, `escrow:${addr}`);
    const prevSup = await lastSample(`token:${w.symbol}`, `grpsup:${addr}`);
    await recordSample(`token:${w.symbol}`, `escrow:${addr}`, balTok, ts);
    await recordSample(`token:${w.symbol}`, `grpsup:${addr}`, supTok, ts);

    // ★ arming 게이트(시계열 health-gate): 직전 폴에 over-backed(escrow≥공급)였던 그룹만 breach 를 신뢰.
    //   WETH 처럼 escrow 가 canonical 을 안 들어 평시부터 under 인 모델-misfit·콜드스타트 FP 를 원천 차단.
    //   armed 가 아니면 평가 안 함(베이스라인만 적재). 정상이던 그룹이 무너질 때만 발화 = Kelp 의 두 메커니즘 다 포착.
    const armed = prevBal != null && prevSup != null && prevBal > 0 && prevBal >= prevSup;
    if (!armed) {
      if (bal < g.supply) uncoveredLegs.push(...g.chains); // 평시 under = 모델 misfit/미arm → 미감시 표시(FP 아님)
      continue;
    }

    // (a) 절대 보존 — 관측 공급이 escrow 초과(mint 메커니즘). 네이티브 게이트웨이는 tight.
    const f = evaluateBacking({ symbol: w.symbol, homeChain: w.homeChain, decimals: w.decimals, circulating: "remotes", tolBps: w.tolBps, backing: bal, remoteSum: g.supply, staleHome: false, breakdown: {} });
    if (f) { totalExcess += (g.supply - bal); worstBps = Math.max(worstBps, f.overageBps); breachGroups.push({ escrow: addr, bridge: g.bridge, chains: g.chains, supply: g.supply.toString(), escrowBal: bal.toString(), overageBps: f.overageBps }); }

    // (b) escrow 급락 delta — armed 그룹에서 escrow 가 관측공급 하락 동반 없이 급락 = 무단 release(Kelp 실제 메커니즘).
    //   정상 redeem 은 L2 burn(공급↓)+escrow unlock(↓) 동반이라 unexplained≈0. 미관측 체인 redeem 은 noise(→WATCH).
    const unexplained = (prevBal - balTok) - (prevSup - supTok);
    if ((prevBal - balTok) > 0 && unexplained / prevBal >= T.releaseDropPct) {
      releaseGroups.push({ escrow: addr, bridge: g.bridge, chains: g.chains, unexplainedTok: unexplained, dropPct: unexplained / prevBal });
    }
  }

  const effConfidence: "HIGH" | "MEDIUM" | "LOW" = uncoveredLegs.length > 0 && w.confidence === "HIGH" ? "MEDIUM" : w.confidence;
  console.log(`[supplycons] ${w.symbol}: 그룹 ${groups.size} [${Object.entries(groupSummary).map(([k, v]) => `${k} ${v}`).join(" · ")}]${uncoveredLegs.length ? ` · 미커버=${uncoveredLegs.join(",")}` : ""}`);

  if (breachGroups.length === 0 && releaseGroups.length === 0) {
    return; // 전 그룹 over-backed + escrow 급락 없음 → clean → resolveStaleAlerts 가 기존 active 해소
  }

  // ── 4) USD 사이징(토큰 DEX 가격 금지 — underlying×rate; const:0=가격미상→null) ──
  const rate = w.rate ? await readRate(home, w.rate) : 1;
  const underlyingUsd = await readUnderlyingUsd(home, w.underlyingPrice);
  const px = rate != null && underlyingUsd != null && underlyingUsd > 0 ? rate * underlyingUsd : null; // 토큰 1개 USD
  const excessTok = Number(totalExcess) / 10 ** w.decimals;
  const releaseTok = releaseGroups.reduce((s, r) => s + r.unexplainedTok, 0);
  const usd = px != null ? (excessTok + releaseTok) * px : null;

  // ── 5) severity: (a) % 축(최악 그룹 bps) + USD 축, (b) release 는 warning floor(redeem 모호 → 자동 critical 금지) ──
  let sev: "info" | "warning" | "critical" = "info";
  if (worstBps >= T.critPctBps) sev = "critical";
  else if (worstBps >= T.warnPctBps) sev = "warning";
  if (usd != null) {
    if (usd >= T.critUsd) sev = "critical";
    else if (usd >= T.warnUsd && sev === "info") sev = "warning";
  }
  const worstReleasePct = releaseGroups.reduce((m, r) => Math.max(m, r.dropPct), 0);
  if (releaseGroups.length && sev === "info") {
    const relUsd = px != null ? releaseTok * px : null;
    if (relUsd == null || relUsd >= T.releaseDropUsd) sev = "warning"; // 미설명 급락 = 최소 WATCH(redeem/release 확인)
  }

  // ── 6) persistence(1폴) — 첫 관측 info(WATCH), 다음 폴 지속 시 escalate. corroboration 동반 시 즉시 승격 ──
  const corrob = await corroborated(w.symbol);
  const firstSeen = !activeKeys.has(key);
  if (sev !== "info" && firstSeen && corrob.length === 0) sev = "info";
  if (SHADOW) sev = "info"; // 관찰 모드(SUPPLY_CONS_SHADOW=false 로 해제)

  asserted.add(key);
  const usdStr = usd != null ? ` / $${usd >= 1e6 ? `${(usd / 1e6).toFixed(1)}M` : usd.toFixed(0)}` : "";
  const mech = breachGroups.length && releaseGroups.length ? "mint+release" : breachGroups.length ? "mint" : "release";
  const parts: string[] = [];
  if (breachGroups.length) parts.push(`mint초과 ${fmt(totalExcess, w.decimals)} ${worstBps}bps`);
  if (releaseGroups.length) parts.push(`escrow급락 ${(worstReleasePct * 100).toFixed(1)}%`);
  const msg = `${w.symbol} — ${parts.join(" · ")}${usdStr}`;
  console.log(`[supplycons] 🚨 ${w.symbol}: ${msg}${corrob.length ? ` · 동반 ${corrob.join(",")}` : ""}`);

  await insertAlert({
    severity: sev,
    kind: "supply_conservation",
    token: w.symbol,
    protocolNodeId: "chain:multi",
    message: msg,
    detail: {
      backingModel: "escrow-per-bridge",
      mechanism: mech,
      breachGroups,                          // (a) 절대 보존 breach(브릿지/체인/공급/escrow/bps)
      releaseGroups,                         // (b) escrow 급락 그룹(미설명 하락/비율)
      totalExcessTokens: totalExcess.toString(),
      worstOverageBps: worstBps,
      worstReleasePct,
      usd, rate, supplyByLeg, groupSummary,
      uncoveredLegs,                         // escrow 미해결 leg(미감시 — FN, override 권장)
      confidence: effConfidence,             // 대문자 — 미커버 시 강등(coverageGapVeto 호환)
      verifiableOnchain: uncoveredLegs.length === 0,
      corroboratedBy: corrob.length ? corrob : null,
      shadow: SHADOW,
    },
    source: SCAN_SOURCE,
  });
}

async function main() {
  if (!env.DATABASE_URL) { console.error("[supplycons] DATABASE_URL 필요"); process.exit(1); }
  const activeKeys = await loadActiveAlertKeys(MANAGED_KINDS, SCAN_SOURCE);
  const asserted = new Set<string>(); // 평가완료-clean OR fire (resolve 후보 판단)
  const skipped = new Set<string>();  // 평가불가(데이터 무결성) — resolve 절대 금지(살아있는 breach 보존)

  const curatedSyms = new Set(CONSERVATION_WATCHES.map((w) => w.symbol.toUpperCase()));
  const auto = await autoWatches(curatedSyms).catch((e) => { console.warn("[supplycons] auto watch 실패:", (e as Error).message); return [] as ConservationWatch[]; });
  const watches = [...CONSERVATION_WATCHES, ...auto];
  console.log(`[supplycons] watch ${watches.length}개 (curated ${CONSERVATION_WATCHES.length} + auto-nodes ${auto.length}) · SHADOW=${SHADOW}`);
  for (const w of watches) {
    await processWatch(w, activeKeys, asserted, skipped).catch((e) => {
      console.error(`[supplycons] ${w.symbol} 오류:`, (e as Error).message);
      skipped.add(`supply_conservation|${w.symbol}|chain:multi`); // 오류=평가불가 → 보존
    });
  }

  // ★ skip(데이터 부재)된 키는 asserted 처럼 보존해 auto-resolve 금지(UI 깜빡임·재페이지 방지)
  const resolved = await resolveStaleAlerts(MANAGED_KINDS, new Set([...asserted, ...skipped]), SCAN_SOURCE);
  console.log(`[supplycons] 완료 — fire/clean ${asserted.size} · skip ${skipped.size} · auto-resolved ${resolved}`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
