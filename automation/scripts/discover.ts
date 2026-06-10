/**
 * Discovery — 자동 워치리스트 후보 발굴.
 *
 *   소스 2개:
 *     1. Morpho Blue  — Σ collateralAssetsUsd 담보 순위
 *     2. Aave V3      — aToken supply × oracle price (USD) 순위
 *
 *   결과는 임계(누적 커버리지 DISCOVERY_COVERAGE + 최소 USD) 통과 시 active=TRUE 로 **즉시 등록**
 *   (승인 게이트 없음) → 다음 snapshot 부터 추적. 임계 아래로 떨어진 자동수집 토큰은 active=FALSE 로
 *   sync(deactivateDiscoveredExcept, 수동 reason='manual' 핀 제외). 관리자 exclude 토큰만 건너뜀.
 *
 *   RWA 필터: real-estate 류 제외, stablecoin 류 통과 (rwa-filter.ts).
 *
 * Usage:
 *   npm run discover            (DB 에 제안 기록 + Discord)
 *   npm run discover:dry        (DB 없이 랭킹만 출력 — 검증용)
 */
import { env } from "@/config/chains";
import { closePool } from "@/db/client";
import { deactivateDiscoveredExcept, getExcludedAddresses, upsertWatchlist } from "@/db/upsert";
import { fetchAaveTopReserves } from "@/discovery/aave-reserves";
import { fetchDefiLlamaTopTokens } from "@/discovery/defillama-top-tokens";
import { fetchMorphoTopTokens } from "@/discovery/morpho-top-tokens";
import { postDiscord } from "@/lib/discord-alert";

const MIN_USD = env.DISCOVERY_MIN_USD;

interface Candidate {
  address: string;
  symbol: string;
  metricUsd: number;
  sources: string[];
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("[discover] fetching Morpho + Aave rankings…");
  const [morpho, aave, defi] = await Promise.all([
    fetchMorphoTopTokens(env.WATCH_LIST_SIZE, MIN_USD, env.DISCOVERY_COVERAGE).catch((e) => {
      console.warn("[discover] morpho failed:", (e as Error).message);
      return [];
    }),
    fetchAaveTopReserves(env.WATCH_LIST_SIZE, MIN_USD, env.DISCOVERY_COVERAGE).catch((e) => {
      console.warn("[discover] aave failed:", (e as Error).message);
      return [];
    }),
    fetchDefiLlamaTopTokens(env.WATCH_LIST_SIZE, MIN_USD, env.DISCOVERY_DEFI_COVERAGE).catch((e) => {
      console.warn("[discover] defillama failed:", (e as Error).message);
      return [];
    }),
  ]);

  console.log(`[discover] Morpho: ${morpho.length}, Aave: ${aave.length}, 전체DeFi: ${defi.length}`);

  // Merge by address — metric = max(소스별 metric), sources 합침
  const merged = new Map<string, Candidate>();
  const add = (address: string, symbol: string, metric: number, source: string) => {
    const a = address.toLowerCase();
    const prev = merged.get(a);
    if (prev) {
      prev.metricUsd = Math.max(prev.metricUsd, metric);
      if (!prev.sources.includes(source)) prev.sources.push(source);
    } else {
      merged.set(a, { address: a, symbol, metricUsd: metric, sources: [source] });
    }
  };
  for (const t of morpho) add(t.address, t.symbol, t.collateralUsd, "morpho_collateral");
  for (const t of aave) add(t.address, t.symbol, t.collateralUsd, "aave_reserve");
  for (const t of defi) add(t.address, t.symbol, t.collateralUsd, "defillama_footprint");

  const ranked = [...merged.values()].sort((a, b) => b.metricUsd - a.metricUsd);

  console.log(`\n=== 통합 담보 랭킹 (${ranked.length}개, 누적 커버리지 ${(env.DISCOVERY_COVERAGE * 100).toFixed(0)}% ∧ ≥ ${fmtUsd(MIN_USD)}) ===`);
  for (const c of ranked) {
    console.log(
      `  ${c.symbol.padEnd(14)} ${fmtUsd(c.metricUsd).padStart(10)}  ` +
        `[${c.sources.join("+")}]  ${c.address}`,
    );
  }

  if (dryRun) {
    console.log("\n[discover] --dry-run: DB 기록 생략.");
    return;
  }

  if (!env.DATABASE_URL) {
    console.error("\n[discover] DATABASE_URL 미설정. (--dry-run 으로 랭킹만 확인 가능)");
    process.exit(1);
  }

  // ── 임계값 기반 자동 모니터링 (승인 게이트 없음) ──────────────
  //    임계 통과 = active=TRUE 로 즉시 등록 → 다음 snapshot 부터 추적.
  //    단, 관리자가 제외(exclude)한 토큰은 건너뜀.
  //    임계 아래로 떨어진 자동수집 토큰은 active=FALSE 로 sync (수동 핀 제외).
  const excluded = await getExcludedAddresses();
  const activated = ranked.filter((c) => !excluded.has(c.address));
  const skippedExcluded = ranked.length - activated.length;
  const passAddrs = activated.map((c) => c.address);
  for (const c of activated) {
    await upsertWatchlist(c.address, c.symbol, c.sources.join("+"));
  }
  // 안전가드 — 소스가 하나라도 0건이면 일시 장애(레이트리밋/네트워크)로 보고 비활성화 sync 를 스킵.
  // (활성화는 그대로 반영.) 과거 사고: 소스 전멸 → deactivateDiscoveredExcept([]) 가 자동발굴 토큰 전원
  // active=FALSE 처리 → 그래프가 수동 시드만 남고 붕괴. 정상 시 각 소스는 수십 건을 반환한다.
  const failedSources = [morpho, aave, defi].filter((s) => s.length === 0).length;
  let dropped = 0;
  if (failedSources > 0) {
    console.warn(`[discover] ⚠️ ${failedSources}/3 소스 0건 — 비활성화 sync 스킵 (워치리스트 보존, 활성화만 반영)`);
  } else {
    dropped = await deactivateDiscoveredExcept(passAddrs);
  }

  console.log(
    `\n[discover] 자동 모니터링: ${activated.length}개 active (임계 통과)` +
      (skippedExcluded > 0 ? `, ${skippedExcluded}개 관리자 제외` : "") +
      (dropped > 0 ? `, ${dropped}개 임계미달로 해제` : ""),
  );

  if (dropped > 0 || activated.length > 0) {
    await postDiscord({
      title: `🔍 watchlist 갱신: ${activated.length} active${dropped > 0 ? `, ${dropped} 해제` : ""}`,
      body: `누적 커버리지 ${(env.DISCOVERY_COVERAGE * 100).toFixed(0)}% 토큰 자동 모니터링.`,
    }).catch(() => {});
  }
  await closePool().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
