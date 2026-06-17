/**
 * Long-running cron loop:
 *   - Every hour: snapshot all watched tokens
 *   - Every 24h:  refresh discovery list
 *
 * Use systemd timer / Docker / pm2 to keep this alive in prod.
 * Usage: npm run cron
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { activeChannels } from "@/lib/notify";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const TWENTY_MIN_MS = 20 * 60 * 1000;
// 탐지 시급성 티어(2026-06): 🔴빠른파국 5분 · 🟡중간 10분 · 🟢구조 30분.
const FIVE_MIN_MS = 5 * 60 * 1000;   // 🔴 무담보mint(conservation/mintburn/chainsupply)·로테이션(depeg·oracle·liquidity diff)
const TEN_MIN_MS = 10 * 60 * 1000;   // 🟡 near_liq(scan)·value_drift·curator
const SCRIPT_TIMEOUT_MS = 8 * 60 * 1000; // 18→8분: 빠른 주기서 hang 과도점유 방지(실 스냅샷 ~3-4분). 로테이션 겹침은 in-flight 가드가 차단.
// 3체인(eth/base/arb)을 **동시 병렬**로 5분마다 스냅샷 — 각 체인 진짜 5분 갱신(사용자 요청 2026-06: "체인 동시에").
//   ⚠️ 종전엔 RPC 부하분산 위해 엇갈렸으나(각 체인 60분), 5분/체인 위해 병렬 전환. eth/base/arb 는 서로 다른 Alchemy 엔드포인트라
//      엔드포인트는 분산되지만 CU 는 계정 공유 — 부하·동시요청 상한 주의.
// 2026-06-12 스코프: 이더리움·베이스·아비트럼만.
const CHAINS_PARALLEL = ["ethereum", "base", "arbitrum"];
// 추가 EVM 체인 — eth·base·arb 와 동일 방식(Morpho GraphQL + Aave reserve self-discovery).
// ⚠️ 2026-06: eth/base/arb 3체인만 지원 → 추가 체인 **비활성**. 확장 시 EXTRA_CHAINS 에 아래 목록을 다시 채우면 됨.
//   목록은 보존(삭제 X) — 코드 변경 없이 재활성 가능.
const EXTRA_CHAINS_AVAILABLE = [
  "optimism", "polygon", "avalanche", "bsc", "gnosis", "scroll", "unichain", "worldchain", "metis",
  "linea", "zksync", "sonic", "celo", "soneium",
];
const EXTRA_CHAINS: string[] = []; // 활성: 없음(eth/base/arb 만). 확장: = EXTRA_CHAINS_AVAILABLE
let extraIdx = 0;
void EXTRA_CHAINS_AVAILABLE; // 보존용 — 미사용 경고 방지

const _warnedMissing = new Set<string>();
function runScript(name: string, args: string[] = [], timeoutMs = SCRIPT_TIMEOUT_MS): Promise<void> {
  return new Promise((res, rej) => {
    const script = resolve(__dirname, name);
    // 삭제된 스크립트(팀 리팩터로 제거된 snapshot-flows·snapshot-bridge-detect·discover-curator-wallets 등)를 cron 이
    //   여전히 스케줄하면 매 주기 npx tsx 가 ERR_MODULE_NOT_FOUND 로 실패한다 — 무의미한 child spawn + 에러 로그 스팸.
    //   파일 부재면 1회만 경고하고 no-op(스크립트가 복원되면 자동 재개 — 비파괴적, 기능 운명은 미결정).
    if (!existsSync(script)) {
      if (!_warnedMissing.has(name)) { console.warn(`[cron] 스크립트 없음, skip: ${name} (삭제됨? 복원 시 자동 재개)`); _warnedMissing.add(name); }
      res();
      return;
    }
    const child = spawn("npx", ["tsx", script, ...args], { stdio: "inherit" });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rej(new Error(`${name} timed out after ${Math.round(timeoutMs / 60_000)}m`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) res();
      else rej(new Error(signal ? `${name} killed by ${signal}` : `${name} exit ${code}`));
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      rej(e);
    });
  });
}

// 5분마다 **3체인 동시(병렬)** 스냅샷 — 각 체인 5분 갱신. ⚠️ in-flight 가드 — 직전 배치 안 끝났으면 틱 skip(겹침=RPC 폭주 차단).
//   병렬 wall-clock = 가장 느린 체인(보통 eth snapshot-all ~3-4분) ≈ 5분 안. 체인 1곳 실패는 batch 안 깨고 로그만.
let snapshotBusy = false;
async function loop() {
  if (snapshotBusy) { console.warn("[cron] 직전 스냅샷 배치 진행 중 — 이번 틱 skip(겹침 방지)"); return; }
  snapshotBusy = true;
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — snapshot: 3체인 동시 (${CHAINS_PARALLEL.join(" · ")}) ══════`);
  try {
    await Promise.all(CHAINS_PARALLEL.map((chain) =>
      (chain === "ethereum" ? runScript("snapshot-all.ts") : runScript("snapshot-chain.ts", [chain]))
        .catch((e) => console.error(`[cron] snapshot ${chain} failed:`, (e as Error).message)),
    ));
  } finally {
    snapshotBusy = false;
  }
}

// 추가 EVM 체인 순환 — 코어 루프와 분리(코어 60분 cadence 보존). 20분마다 1체인(각 ~3시간 주기).
// Morpho(GraphQL) + Aave(pap reserve self-discovery). 공개 RPC 위주라 코어와 엔드포인트 거의 안 겹침.
async function extraChainLoop() {
  if (EXTRA_CHAINS.length === 0) return; // 비활성(eth/base/arb 만 지원) — 확장 시 EXTRA_CHAINS 채우면 자동 동작
  const chain = EXTRA_CHAINS[extraIdx % EXTRA_CHAINS.length];
  extraIdx++;
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — snapshot(extra): ${chain} ══════`);
  try {
    await runScript("snapshot-chain.ts", [chain]);
  } catch (e) {
    console.error(`[cron] snapshot(extra) ${chain} failed:`, (e as Error).message);
  }
}

async function discoveryLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — discovery cycle ══════`);
  try {
    await runScript("discover.ts");
  } catch (e) {
    console.error("[cron] discover failed:", (e as Error).message);
  }
}

// 미지주소 자동 분류(B10) — 1일마다. unknown_addresses 큐를 classify(프록시·셀렉터·Etherscan)로 추정 라벨링
// → `npm run review` 로 사람이 확인 → 확정분 protocol-registry 반영.
async function classifyLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — classify unknowns ══════`);
  try {
    await runScript("classify-unknowns.ts");
  } catch (e) {
    console.error("[cron] classify failed:", (e as Error).message);
  }
}

// 큐레이터 볼트 스냅샷 + 디리스킹 신호 — 30분마다 (Morpho API only, 경량).
const THIRTY_MIN_MS = 30 * 60 * 1000;
async function curatorLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — curators ══════`);
  try {
    await runScript("snapshot-curators.ts");
  } catch (e) {
    console.error("[cron] curators failed:", (e as Error).message);
  }
}

// 체인별 totalSupply 스냅샷(전 체인 onchain) — 1시간마다 상위 토큰. 시계열 누적 → 체인 단위 무한민팅 z-score.
// breadth API(프론트) 의존: 미가동 시 토큰별 graceful skip(크래시 X).
async function chainSupplyLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — chain supply ══════`);
  try {
    await runScript("snapshot-chain-supply.ts");
  } catch (e) {
    console.error("[cron] chain-supply failed:", (e as Error).message);
  }
}

// 추적 지갑(tracked_wallets) 스냅샷 — 2시간마다. DeBank(가능시)+온체인 매핑 가치 → 밸류 급감 알림.
// tracked_wallets 비어있으면 즉시 no-op. 차단 환경은 WALLET_SKIP_DEBANK=1 로 온체인-매핑만.
const TWO_HOUR_MS = 2 * ONE_HOUR_MS;
async function walletLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — tracked wallets ══════`);
  try {
    await runScript("snapshot-wallets.ts");
  } catch (e) {
    console.error("[cron] wallets failed:", (e as Error).message);
  }
}

// 추적 지갑 watch-list 시드(Dune 탑홀더 → tracked_wallets). ⚠️ FN 수정 2026-06: 이 생산자 단계가 cron 에
//   없어 tracked_wallets 가 영구 빈 채로 → walletLoop 이 매번 즉시 no-op → wallet_value_drop 영구 미발화였다.
//   DUNE_API_KEY 필요(이제 ~/.env 폴백 로드). 하루 1회 갱신 + 부팅 시 1회 시드(walletLoop 첫 실행 전).
async function walletSeedLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — wallet watch-list 시드(Dune 탑홀더) ══════`);
  try {
    await runScript("discover-curator-wallets.ts", ["wstETH", "weETH", "rsETH", "ezETH", "cbBTC", "WBTC", "USDe", "sUSDe"]);
  } catch (e) {
    console.error("[cron] wallet-seed failed:", (e as Error).message);
  }
}

// 검증된 브릿지 mint 권한(온체인) — 6시간마다 상위 토큰. xERC20 한도/MINTER/OFT/CCIP 를 토큰 컨트랙트서 직접 읽어 적재.
const SIX_HOUR_MS = 6 * ONE_HOUR_MS;
async function bridgeAuthLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — bridge authority ══════`);
  try {
    await runScript("snapshot-bridge-authority.ts");
  } catch (e) {
    console.error("[cron] bridge-authority failed:", (e as Error).message);
  }
}

// 비-EVM 표준 브릿지 탐지 — 6시간마다. (관계맵·흐름맵 브릿지 노드 입력) — 머지 시 자동머지로 정의가 유실돼 복원(2026-06).
async function bridgeDetectLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — bridge detect (non-EVM) ══════`);
  try {
    await runScript("snapshot-bridge-detect.ts");
  } catch (e) {
    console.error("[cron] bridge-detect failed:", (e as Error).message);
  }
}

// 무담보 공급 점검(Detector A, alarm-totalsupply 포팅) — Σremote ≤ backing(lockbox) 위반 시 unbacked_supply 알림.
// bridge-authority 가 적재한 xERC20 lockbox 를 입력으로 자동 watch. (Kelp rsETH류 무한민팅 감시)
// (구 backingLoop=Detector A/unbacked_supply 제거 2026-06: supply_conservation 가 동일 escrow 불변식을
//  per-bridge·release delta·arming·auto-watch 로 상위호환 흡수. wstETH 는 supply-conservation.ts 의 curated watch.)

// mint/burn 정합(Detector B) — 1시간마다. 크로스체인 미정합 mint = 무담보민팅 의심(Kelp 직접 시그니처).
async function mintburnLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — mint/burn recon ══════`);
  try {
    await runScript("snapshot-mintburn.ts");
  } catch (e) {
    console.error("[cron] mintburn failed:", (e as Error).message);
  }
}

// 크로스체인 공급 보존 — Σ(관측 L2 공급) > 홈 OFT-Adapter escrow → 무담보 mint(Kelp rsETH류). 가벼운 eth_call.
async function supplyConservationLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — supply conservation (크로스체인 무담보 mint) ══════`);
  try {
    await runScript("snapshot-supply-conservation.ts");
  } catch (e) {
    console.error("[cron] supply-conservation failed:", (e as Error).message);
  }
}

async function valueDriftLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — value drift ══════`);
  try {
    await runScript("snapshot-value-drift.ts");
  } catch (e) {
    console.error("[cron] value-drift failed:", (e as Error).message);
  }
}

// 머니레고 구조 — 6시간마다 전체 watchlist 토큰의 파생토큰(PT/YT/LP/aToken)·수용처 마켓(Morpho 담보마켓·Convex 풀)을
// 갱신 적재(만기 PT 자연 소멸). 관계맵 파생 레이어 입력. (멘토 §8·§9, 임의 토큰 일반화)
async function legoLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — money lego (전체 watchlist) ══════`);
  try {
    await runScript("snapshot-lego.ts"); // 인자 없음 = 전체 watchlist
  } catch (e) {
    console.error("[cron] lego failed:", (e as Error).message);
  }
}

// Reflexivity(사기 루핑) — 1시간마다. 토큰 담보 Morpho 마켓 오라클 introspect → grade/oracle_class/looping
// → loop_findings(reflexivity-v1). dossier.loops 가 서빙 → 프론트 Tier0 판결 + 상세그래프 라이브 소비.
async function reflexivityLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — reflexivity (사기 루핑) ══════`);
  try {
    await runScript("snapshot-reflexivity.ts");
  } catch (e) {
    console.error("[cron] reflexivity failed:", (e as Error).message);
  }
}

// 비-EVM 렌딩 — 1시간마다. Solana(Kamino·Solend·MarginFi·Drift) / Sui(Suilend·NAVI·Scallop) /
// Tron(JustLend) / Aptos(Echelon 등, DeFiLlama lendBorrow). reserve 이용률/LTV → high_utilization·high_lltv
// (EVM 과 동일 임계·alerts 계약, source=`{protocol}-v1`).
async function nonevmLendingLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — non-EVM 렌딩 (Solana/Sui) ══════`);
  try {
    await runScript("snapshot-nonevm-lending.ts");
  } catch (e) {
    console.error("[cron] nonevm-lending failed:", (e as Error).message);
  }
}

// 트랜잭션 플로우(Dune, kuromi flow_trace 포팅) — 24시간마다 상위 토큰의 코어 행위자/흐름 엣지 갱신.
// Dune 크레딧 사용(토큰당 ~2): 일 1회 × 6토큰. DUNE_API_KEY 미설정이면 스크립트가 안내 후 종료(무해).
async function flowsLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — transaction flows (Dune) ══════`);
  try {
    await runScript("snapshot-flows.ts", ["--top", "6"]);
  } catch (e) {
    console.error("[cron] flows failed:", (e as Error).message);
  }
}

// 현재 상태 스캔(EVM) — 최신 edges 스냅샷에서 reserve_frozen·high_lltv_market·near_liquidation·
// unverified_large_exposure 를 1시간마다 적재. 그간 cron 미등록이라 이 상태형 알림들이 라이브 미생성이던
// 커버리지 공백을 닫음(2026-06 감사 C). dedup 쿨다운(warning 12h·info 24h)이 재발화를 묶음.
async function scanRisksLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — current-risk scan (EVM 상태형) ══════`);
  try {
    await runScript("scan-current-risks.ts");
  } catch (e) {
    console.error("[cron] scan-risks failed:", (e as Error).message);
  }
}

// 관찰 자동수집 — 1시간마다 직전 윈도의 알림 생성·해소·스톰·신규kind 를 fp-audit/observe.jsonl 에 적재.
//   24h 돌려두면 FP/FN 후보가 쌓여 사후 검증 가능.
async function observeLoop() {
  try {
    await runScript("observe-alerts.ts");
  } catch (e) {
    console.error("[cron] observe failed:", (e as Error).message);
  }
}

// 이벤트형 알림 TTL 만료 스윕 — 1시간마다. 종료된 이벤트(util_jump·liquidity_drop·depeg·oracle 등)가 DB 에
// 영구 잔존하던 것 정리(STATE 디텍터는 resolveStaleAlerts 가 담당하므로 제외).
async function expireEventsLoop() {
  try {
    await runScript("resolve-expired-events.ts");
  } catch (e) {
    console.error("[cron] expire-events failed:", (e as Error).message);
  }
}

function kickAfter(delayMs: number, fn: () => Promise<void>) {
  setTimeout(() => { void fn(); }, delayMs);
}

// 5분 주기 루프의 in-flight 가드 — SCRIPT_TIMEOUT(8분) > 주기(5분)라 스크립트가 hang 하면 다음 틱이 두 번째 자식을
//   spawn 해 RPC/DB 동시부하가 겹친다(loop() 의 snapshotBusy 와 동일 취지). 직전 실행 안 끝났으면 이번 틱 skip.
const _loopBusy = new Set<string>();
function guarded(name: string, fn: () => Promise<void>): () => void {
  return () => {
    if (_loopBusy.has(name)) { console.warn(`[cron] ${name} 직전 실행 진행 중 — 이번 틱 skip(겹침 방지)`); return; }
    _loopBusy.add(name);
    void fn().finally(() => _loopBusy.delete(name));
  };
}

async function main() {
  const channels = activeChannels();
  console.log("[cron] starting — 5min parallel 3-chain snapshots (eth·base·arb) + tiered detectors (🔴5m/🟡10m/🟢30m+) + daily discovery");
  console.log(`[cron] 알림 채널: ${channels.length ? channels.join(", ") : "없음(DB만 — env 설정 시 활성: DISCORD_WEBHOOK_URL·TELEGRAM_BOT_TOKEN+CHAT_ID·ALERT_WEBHOOK_URL)"}`);

  setInterval(loop, FIVE_MIN_MS); // 🔴 5분마다 **3체인 동시** 스냅샷(각 체인 5분). diff RED(depeg·oracle·liquidity·supply_spike)·GREEN(new_market 등) 동반 — in-flight 가드로 겹침 차단
  setInterval(discoveryLoop, ONE_DAY_MS);
  setInterval(classifyLoop, ONE_DAY_MS); // 1일마다 미지주소 자동 분류(B10) → 검토 큐 (main 병합)
  setInterval(curatorLoop, TEN_MIN_MS); // 🟡 10분마다 디리스킹 체크(curator_derisk)
  setInterval(guarded("chainSupply", chainSupplyLoop), FIVE_MIN_MS); // 🔴 5분마다 체인별 공급 시계열(chain_supply_spike 무단민트 감시) — in-flight 가드
  setInterval(walletSeedLoop, ONE_DAY_MS); // 하루 1회 watch-list 시드(Dune 탑홀더) — walletLoop 의 생산자
  setInterval(walletLoop, TWO_HOUR_MS); // 2시간마다 추적 지갑 밸류 (자금 이탈 감시)
  setInterval(bridgeAuthLoop, SIX_HOUR_MS); // 6시간마다 온체인 브릿지 mint 권한 검증
  setInterval(bridgeDetectLoop, SIX_HOUR_MS);
  setInterval(guarded("supplyConservation", supplyConservationLoop), FIVE_MIN_MS); // 🔴 5분마다(15→5) 크로스체인 공급보존(escrow) — Kelp 무담보 mint/release. 최우선 빠른 파국 — in-flight 가드
  setInterval(guarded("mintburn", mintburnLoop), FIVE_MIN_MS); // 🔴 5분마다 mint/burn 정합 (unmatched_mint 무담보민팅) — in-flight 가드
  setInterval(valueDriftLoop, TEN_MIN_MS); // 🟡 10분마다 총가치 급락(value_drift 리뎀션런/뱅크런) — chain_supply_samples 시계열 위
  setInterval(reflexivityLoop, ONE_HOUR_MS); // 1시간마다 reflexivity 재계산 (loop_findings → 프론트 Tier0/상세그래프 라이브)
  // setInterval(nonevmLendingLoop, ONE_HOUR_MS); // 비활성(2026-06: EVM eth/base/arb 만 지원). 재활성 시 주석 해제
  setInterval(scanRisksLoop, TEN_MIN_MS); // 🟡 10분마다 EVM 상태형(near_liq=YELLOW 기준; reserve_frozen·high_util=GREEN 동반, 저비용 DB스캔이라 무방) — auto-resolve 내장
  setInterval(flowsLoop, ONE_DAY_MS); // 24시간마다 상위 토큰 플로우 갱신 (Dune 크레딧 보호)

  void loop(); // 즉시 첫 체인
  kickAfter(30 * 1000, walletSeedLoop); // 즉시 1회 — wallet watch-list 시드(walletLoop 첫 스냅샷 전 tracked_wallets 채움)
  kickAfter(1 * 60 * 1000, curatorLoop); // 즉시 큐레이터 1회 (baseline)
  kickAfter(2 * 60 * 1000, bridgeAuthLoop); // 즉시 1회 — 브릿지 권한/lockbox baseline (backing 의 입력)
  kickAfter(4 * 60 * 1000, bridgeDetectLoop); // 즉시 1회 — 비-EVM 표준 브릿지 탐지 (관계맵·흐름맵 브릿지 노드 입력)
  kickAfter(13 * 60 * 1000, supplyConservationLoop); // 즉시 1회 — 공급보존 baseline(체인 스냅샷 후; 구 backing 흡수)
  kickAfter(8 * 60 * 1000, mintburnLoop); // 즉시 1회 — mint/burn ledger baseline
  kickAfter(10 * 60 * 1000, reflexivityLoop); // 즉시 1회 — 사기 루핑(오라클 reflexivity) baseline
  // kickAfter(12 * 60 * 1000, nonevmLendingLoop); // 비활성(EVM 3체인만). 재활성 시 주석 해제
  kickAfter(14 * 60 * 1000, flowsLoop); // 즉시 1회 시도 — DUNE_API_KEY 없으면 안내만(상세그래프 플로우 레이어 데이터)
  kickAfter(16 * 60 * 1000, scanRisksLoop); // 즉시 1회 — EVM 상태형 baseline (체인 스냅샷 후라 edges 최신)
  setInterval(observeLoop, ONE_HOUR_MS); // 1시간마다 알림 관찰 자동수집 (fp-audit/observe.jsonl)
  kickAfter(18 * 60 * 1000, observeLoop); // 즉시 1회 — 관찰 baseline
  setInterval(expireEventsLoop, ONE_HOUR_MS); // 1시간마다 이벤트형 TTL 만료 스윕(종료 이벤트 잔존 정리)
  kickAfter(20 * 60 * 1000, expireEventsLoop); // 즉시 1회
  void legoLoop(); // 즉시 1회 — 머니레고 구조(파생토큰·수용처) baseline (main 병합)
  setInterval(legoLoop, SIX_HOUR_MS); // 6시간마다 갱신 (만기 PT·신규 마켓 반영)
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
