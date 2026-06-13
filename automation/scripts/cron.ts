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
// 2026-06-12 스코프 축소: 이더리움·베이스·아비트럼만 (다른 EVM 은 3체인 완성 후 재추가).
const ROTATION = ["ethereum", "base", "arbitrum"];
let rotIdx = 0;

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

async function main() {
  const channels = activeChannels();
  console.log("[cron] starting — 20min staggered per-chain snapshots + daily discovery");
  console.log(`[cron] 알림 채널: ${channels.length ? channels.join(", ") : "없음(DB만 — env 설정 시 활성: DISCORD_WEBHOOK_URL·TELEGRAM_BOT_TOKEN+CHAT_ID·ALERT_WEBHOOK_URL)"}`);
  await loop(); // 즉시 첫 체인
  setInterval(loop, TWENTY_MIN_MS); // 20분마다 다음 코어 체인 (ethereum/base/arbitrum, 60분 주기)
  setInterval(discoveryLoop, ONE_DAY_MS);
  setInterval(classifyLoop, ONE_DAY_MS); // 1일마다 미지주소 자동 분류(B10) → 검토 큐
  await curatorLoop(); // 즉시 큐레이터 1회 (baseline)
  setInterval(curatorLoop, THIRTY_MIN_MS); // 30분마다 디리스킹 체크
  setInterval(chainSupplyLoop, ONE_HOUR_MS); // 1시간마다 체인별 공급 시계열 누적 (baseline 쌓기)
  setInterval(walletLoop, TWO_HOUR_MS); // 2시간마다 추적 지갑 밸류 (자금 이탈 감시)
  await bridgeAuthLoop(); // 즉시 1회 — 브릿지 권한/lockbox baseline (backing 의 입력)
  setInterval(bridgeAuthLoop, SIX_HOUR_MS); // 6시간마다 온체인 브릿지 mint 권한 검증
  await backingLoop(); // 즉시 1회 — 무담보 공급 baseline
  setInterval(backingLoop, ONE_HOUR_MS); // 1시간마다 Σremote ≤ backing 재검 (무담보 공급 알림)
  await mintburnLoop(); // 즉시 1회 — mint/burn ledger baseline
  setInterval(mintburnLoop, ONE_HOUR_MS); // 1시간마다 mint/burn 정합 (무담보민팅 알림)
  setInterval(valueDriftLoop, ONE_HOUR_MS); // 1시간마다 총가치 급락(밸류 유출) 감시 — chain_supply_samples 시계열 위 (P2-6)
  await reflexivityLoop(); // 즉시 1회 — 사기 루핑(오라클 reflexivity) baseline
  setInterval(reflexivityLoop, ONE_HOUR_MS); // 1시간마다 reflexivity 재계산 (loop_findings → 프론트 Tier0/상세그래프 라이브)
  void legoLoop(); // 즉시 1회 — 머니레고 구조(파생토큰·수용처) baseline
  setInterval(legoLoop, SIX_HOUR_MS); // 6시간마다 갱신 (만기 PT·신규 마켓 반영)
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
