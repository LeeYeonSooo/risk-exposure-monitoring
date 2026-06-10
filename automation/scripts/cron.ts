/**
 * Long-running cron loop:
 *   - Every hour: snapshot all watched tokens
 *   - Every 24h:  refresh discovery list
 *
 * Use systemd timer / Docker / pm2 to keep this alive in prod.
 * Usage: npm run cron
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { activeChannels } from "@/lib/notify";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const TWENTY_MIN_MS = 20 * 60 * 1000;
// 한 번에 세 체인 RPC 동시 X — 20분마다 한 체인씩 엇갈려 돌림 (각 체인 60분 주기, 부하 분산).
// 코어 = 렌딩 TVL 최대 3체인(60분 cadence 유지). 추가 EVM 체인은 별도 루프로 순환(아래 EXTRA_CHAINS).
const ROTATION = ["ethereum", "base", "arbitrum"];
let rotIdx = 0;
// 추가 EVM 체인 — eth·base·arb 와 동일 방식(Morpho GraphQL + Aave reserve self-discovery)을 전 체인 적용.
// 코어와 분리된 루프(코어 cadence 보존)로 순환. snapshot-chain.ts 의 CHAINS 와 일치해야 함.
// 14체인 × 20분 = 체인당 ~4.7시간 주기 (L2 정밀 그래프는 시간 민감도 낮음 — 코어 3체인이 60분 담당).
const EXTRA_CHAINS = [
  "optimism", "polygon", "avalanche", "bsc", "gnosis", "scroll", "unichain", "worldchain", "metis",
  "linea", "zksync", "sonic", "celo", "soneium",
];
let extraIdx = 0;

function runScript(name: string, args: string[] = []): Promise<void> {
  return new Promise((res, rej) => {
    const script = resolve(__dirname, name);
    const child = spawn("npx", ["tsx", script, ...args], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${name} exit ${code}`))));
    child.on("error", rej);
  });
}

// 20분마다 회전 체인 1개만 스냅샷 (RPC 부하 엇갈리게)
async function loop() {
  const chain = ROTATION[rotIdx % ROTATION.length];
  rotIdx++;
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — snapshot: ${chain} ══════`);
  try {
    if (chain === "ethereum") await runScript("snapshot-all.ts"); // 온체인 어댑터(Alchemy)
    else await runScript("snapshot-chain.ts", [chain]); // Base/Arbitrum (Morpho API + Aave 공개RPC+Multicall3)
  } catch (e) {
    console.error(`[cron] snapshot ${chain} failed:`, (e as Error).message);
  }
}

// 추가 EVM 체인 순환 — 코어 루프와 분리(코어 60분 cadence 보존). 20분마다 1체인(각 ~3시간 주기).
// Morpho(GraphQL) + Aave(pap reserve self-discovery). 공개 RPC 위주라 코어와 엔드포인트 거의 안 겹침.
async function extraChainLoop() {
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

// 비-EVM 브릿지 탐지(파이썬 8계열 도구) — 6시간마다. CCTP·Wormhole·IBC·StarkGate 등 표준 브릿지.
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
async function backingLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — supply backing ══════`);
  try {
    await runScript("snapshot-backing.ts");
  } catch (e) {
    console.error("[cron] backing failed:", (e as Error).message);
  }
}

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

async function valueDriftLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — value drift ══════`);
  try {
    await runScript("snapshot-value-drift.ts");
  } catch (e) {
    console.error("[cron] value-drift failed:", (e as Error).message);
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

async function main() {
  const channels = activeChannels();
  console.log("[cron] starting — 20min staggered per-chain snapshots + daily discovery");
  console.log(`[cron] 알림 채널: ${channels.length ? channels.join(", ") : "없음(DB만 — env 설정 시 활성: DISCORD_WEBHOOK_URL·TELEGRAM_BOT_TOKEN+CHAT_ID·ALERT_WEBHOOK_URL)"}`);
  await loop(); // 즉시 첫 체인
  setInterval(loop, TWENTY_MIN_MS); // 20분마다 다음 코어 체인 (ethereum/base/arbitrum, 60분 주기)
  // 추가 EVM 체인(optimism·polygon·avalanche·bsc·gnosis·scroll·unichain·worldchain·metis) — 코어와 10분 오프셋.
  setTimeout(() => { void extraChainLoop(); setInterval(extraChainLoop, TWENTY_MIN_MS); }, 10 * 60 * 1000);
  setInterval(discoveryLoop, ONE_DAY_MS);
  await curatorLoop(); // 즉시 큐레이터 1회 (baseline)
  setInterval(curatorLoop, THIRTY_MIN_MS); // 30분마다 디리스킹 체크
  setInterval(chainSupplyLoop, ONE_HOUR_MS); // 1시간마다 체인별 공급 시계열 누적 (baseline 쌓기)
  setInterval(walletLoop, TWO_HOUR_MS); // 2시간마다 추적 지갑 밸류 (자금 이탈 감시)
  await bridgeAuthLoop(); // 즉시 1회 — 브릿지 권한/lockbox baseline (backing 의 입력)
  setInterval(bridgeAuthLoop, SIX_HOUR_MS); // 6시간마다 온체인 브릿지 mint 권한 검증
  await bridgeDetectLoop(); // 즉시 1회 — 비-EVM 표준 브릿지 탐지 (관계맵·흐름맵 브릿지 노드 입력)
  setInterval(bridgeDetectLoop, SIX_HOUR_MS);
  await backingLoop(); // 즉시 1회 — 무담보 공급 baseline
  setInterval(backingLoop, ONE_HOUR_MS); // 1시간마다 Σremote ≤ backing 재검 (무담보 공급 알림)
  await mintburnLoop(); // 즉시 1회 — mint/burn ledger baseline
  setInterval(mintburnLoop, ONE_HOUR_MS); // 1시간마다 mint/burn 정합 (무담보민팅 알림)
  setInterval(valueDriftLoop, ONE_HOUR_MS); // 1시간마다 총가치 급락(밸류 유출) 감시 — chain_supply_samples 시계열 위 (P2-6)
  await reflexivityLoop(); // 즉시 1회 — 사기 루핑(오라클 reflexivity) baseline
  setInterval(reflexivityLoop, ONE_HOUR_MS); // 1시간마다 reflexivity 재계산 (loop_findings → 프론트 Tier0/상세그래프 라이브)
  await nonevmLendingLoop(); // 즉시 1회 — 비-EVM 렌딩(Solana/Sui 6프로토콜) baseline
  setInterval(nonevmLendingLoop, ONE_HOUR_MS); // 1시간마다 비-EVM reserve 이용률/LTV 알림
  void flowsLoop(); // 즉시 1회 시도 — DUNE_API_KEY 없으면 안내만(상세그래프 플로우 레이어 데이터)
  setInterval(flowsLoop, ONE_DAY_MS); // 24시간마다 상위 토큰 플로우 갱신 (Dune 크레딧 보호)
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
