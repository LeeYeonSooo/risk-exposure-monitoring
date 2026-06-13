import type { CpTarget } from "./counterparties";
import { fluidDexSet } from "./fluid-dexes";
import type { FlowBaselineRow } from "./flow-types";
import { gatedGql, gatedJsonRpc } from "./rpc-gate";

/**
 * 평소 모드의 렌딩 흐름 — **프로토콜 이벤트 로그 24h 전수**.
 *
 * 왜 전송 스캔이 아니라 이벤트인가: USDC/USDT 는 토큰 Transfer 가 30분에 1만+ 건이라 전송
 * 스캔으로는 24h 를 못 덮는다(관측창 0.2h). 반면 프로토콜의 Supply/Withdraw/Borrow/Repay
 * 이벤트는 수백 배 희소해서 getLogs 로 24h 전체가 덮인다 — "평소 평균"의 분모가 진짜 24시간.
 *
 * 이벤트 토픽은 전부 실증 상수 — 메인넷 receipt 역산(구 lib/flowmap.ts) 또는 viem 계산 + 메인넷
 * getLogs 라이브 검증(Lido·sUSDS·sUSDe·eETH). 추정 토픽 0.
 * 커버: Aave V3(Core·Prime·EtherFi)·Spark·Compound V3 Comet·Fluid·Euler v2(3체인) + Morpho(GraphQL)
 *      + Lido 스테이크/출금요청 + Sky 저축(sUSDS)·Ethena(sUSDe ERC-4626) + ether.fi(eETH 민트/소각).
 * 체인: ethereum · base · arbitrum.
 *
 * 견고성: 모든 RPC 는 lib/rpc-gate(호스트 게이트 + 백오프 재시도)를 거치고, getLogs 는 1차 publicnode
 * 실패 시 2차(mevblocker/공식)로 폴백(rpcFB) — 한 엔드포인트 429 가 프로토콜 하나를 통째로 회색으로
 * 지우던 버그(2026-06-12)의 구조적 수정.
 */

const PUBLICNODE: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
};
// 폴백 엔드포인트(서로 다른 IP·한도) — 무료 단일 RPC 는 16토큰 부하에서 게이트+재시도로도 한
// 수집기를 가끔 떨어뜨린다(실측 lido·fluid). 1차가 끝내 막히면 2차가 받아 silent drop 을 없앤다.
const RPC = PUBLICNODE;
const RPC_ALT: Record<string, string> = {
  ethereum: "https://rpc.mevblocker.io",
  base: "https://mainnet.base.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
};
const DAY_SEC = 24 * 3600;

// ── 검증된 이벤트 토픽 (메인넷 receipt 역산 실증 — 추정 금지) ──────────────
type LendAction = "supply" | "withdraw" | "borrow" | "repay";
const ACTION_DIR: Record<LendAction, "in" | "out"> = { supply: "in", repay: "in", withdraw: "out", borrow: "out" };
const AAVE_TOPIC: Record<string, LendAction> = {
  "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": "supply",   // Supply — amount=data word1
  "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7": "withdraw", // Withdraw — word0
  "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0": "borrow",   // Borrow — word1
  "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": "repay",    // Repay — word0
};
const AAVE_AMOUNT_WORD: Record<LendAction, number> = { supply: 1, withdraw: 0, borrow: 1, repay: 0 };
const COMPOUND_TOPIC: Record<string, { action: LendAction; scope: "base" | "collat" }> = {
  "0xd1cf3d156d5f8f0d50f6c122ed609cec09d35c9b9fb3fff6ea0959134dae424e": { action: "supply", scope: "base" },
  "0x9b1bfa7fa9ee420a16e124f794c35ac9f90472acc99140eb2f6447c714cad8eb": { action: "withdraw", scope: "base" }, // base 인출/차입 혼재 — 방향만 정확
  "0xfa56f7b24f17183d81894d3ac2ee654e3c26388d17a28dbd9549b8114304e1f4": { action: "supply", scope: "collat" },
  "0xd6d480d5b3068db003533b170d67561494d72e3bf9fa40a266471351ebba9e16": { action: "withdraw", scope: "collat" },
};
const FLUID_LOGOPERATE = "0x4d93b232a24e82b284ced7461bf4deacffe66759d5c24513e6f29e571ad78d15"; // supply±/borrow± 부호 4액션
const EULER_TOPIC: Record<string, LendAction> = {
  "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7": "supply",   // Deposit — assets=word0
  "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db": "withdraw", // Withdraw — word0
  "0xcbc04eca7e9da35cb1393a6135a199ca52e450d5e9251cbd99f7847d33a36750": "borrow",   // Borrow — word0
  "0x5c16de4f8b59bd9caf0f49a545f25819a895ed223294290b408242e72a594231": "repay",    // Repay — word0
};
const EULER_SUBGRAPHS: Record<string, string> = {
  ethereum: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn",
  base: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-base/latest/gn",
  arbitrum: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-arbitrum/latest/gn",
};
// 주소배열 getLogs 를 받아주는 RPC + 블록범위/배열크기 한계(2026-06-12 실측): 메인넷 publicnode 는
// 주소배열 거부 → mevblocker; Base=공식 base.org(40주소·1만블록), Arb=공식 arb.io(40주소·5만블록+).
const EULER_LOG: Record<string, { url: string; step: number; batch: number }> = {
  ethereum: { url: "https://rpc.mevblocker.io", step: 1800, batch: 1000 },
  base: { url: "https://mainnet.base.org", step: 9000, batch: 40 },
  arbitrum: { url: "https://arb1.arbitrum.io/rpc", step: 45000, batch: 40 },
};

// ── Lido — stETH 스테이킹은 민트(0x0)·출금은 큐 소각이라 전송 스캔이 못 보는 흐름 → 공식 이벤트가
//    유일한 정직 출처. 토픽은 viem toEventSelector + 메인넷 getLogs 라이브 검증(2026-06-12). ──
const LIDO_STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const LIDO_WQ = "0x889edc2edab5f40e902b864ad4d7ade8e412f9b1"; // WithdrawalQueue(unstETH)
const LIDO_SUBMITTED = "0x96a25c8ce0baabc1fdefd93e9ed25d8e092a3332f3aa9a41722b5697231d1d1a"; // Submitted(sender,amount,referral) — amount=word0
const LIDO_WD_REQUESTED = "0xf0cb471f23fb74ea44b8252eb1881a2dca546288d9f6e90d1a0e82fe0ed342ab"; // WithdrawalRequested — amountOfStETH=word0

// ── ERC-4626 저축 볼트 — Deposit/Withdraw(EULER_TOPIC supply/withdraw 와 동일 해시). **볼트 컨트랙트
//    주소로 귀속**하므로 동명 마켓(aave 의 sUSDS 리저브 등) 오귀속이 구조적으로 불가. ──
const ERC4626_DEPOSIT = "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7";
const ERC4626_WITHDRAW = "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db";
// vault = ERC-4626 share 토큰 주소, asset = 기초자산, label = DeFiLlama 슬러그(노드 매칭용).
// 전부 asset()·symbol()·Deposit/Withdraw 이벤트 온체인 검증분(2026-06-13). 신규 추가 시 라벨은
// 반드시 슬러그와 일치 + flow-adapters.ts COVERED 동반 추가 + counterparties 큐레이트 등록(실시간).
const ERC4626_SAVINGS: { chain: string; vault: string; asset: string; label: string }[] = [
  { chain: "ethereum", vault: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", asset: "0xdc035d45d973e3ec169d2276ddab16f1e407384f", label: "sky-lending" },   // sUSDS·asset()=USDS
  { chain: "ethereum", vault: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", asset: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", label: "ethena-usde" }, // sUSDe·asset()=USDe (쿨다운 출금도 표준 Withdraw)
  { chain: "ethereum", vault: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", label: "maple" },        // syrupUSDC·asset()=USDC
  { chain: "ethereum", vault: "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d", asset: "0xdac17f958d2ee523a2206206994597c13d831ec7", label: "maple" },        // syrupUSDT·asset()=USDT
  { chain: "ethereum", vault: "0x0000000f2eb9f69274678c76222b35eec7588a65", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", label: "yo-protocol" },  // yoUSD·asset()=USDC
  { chain: "ethereum", vault: "0xd9a442856c234a39a81a089c06451ebaa4306a72", asset: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", label: "puffer-stake" }, // pufETH·asset()=WETH
];

// ── ether.fi — eETH 민트(=스테이크 유입)/소각(=출금 유출). 홀드 엣지가 weETH→ether.fi-stake 라
//    weETH 심볼로 귀속, USD 는 eETH 가격(동일자산이라 환산비 무관). 2026-06-12 온체인 실증. ──
const ETHERFI_EETH = "0x35fa164735182de50811e8e2e824cfb9b6118ac2";
const ETHERFI_WEETH = "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ── 프로토콜 배치 주소 (공식 배포 — lending-pools 와 동일 출처) ─────────────
const AAVE_POOLS: Record<string, { addr: string; label: string }[]> = {
  ethereum: [
    { addr: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", label: "aave-v3" }, // Core
    { addr: "0x4e033931ad43597d96d6bcc25c280717730b58b1", label: "aave-v3" }, // Prime(Lido)
    { addr: "0x0aa97c284e98396202b6a04024f5e2c65026f3c0", label: "aave-v3" }, // EtherFi
    { addr: "0xc13e21b648a5ee794902342038ff3adab66be987", label: "spark" },   // SparkLend (동일 ABI)
  ],
  base: [{ addr: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5", label: "aave-v3" }],
  arbitrum: [{ addr: "0x794a61358d6845594f94dc1db02a252b5b4814ad", label: "aave-v3" }],
};
const COMETS: Record<string, string[]> = {
  ethereum: ["0xc3d688b66703497daa19211eedff47f25384cdc3", "0xa17581a9e3356d9a858b789d68b4d866e593ae94", "0x3afdc9bca9213a35503b077a6072f3d0d5ab0840"],
  base: ["0xb125e6687d4313864e53df431d5425969c15eb2f", "0x46e6b214b524310239732d51387075e0e70970bf", "0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf"],
  arbitrum: ["0xa5edbdd9646f8dff606d7448e414884c7d905dca"],
};
const FLUID_ADDR = "0x52aa899454998be5b000ad077a46bbe360f4e497"; // 동일주소 배포 (eth·base·arb 코드+로그 확인분)
const MORPHO_CHAIN_ID: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161 };

/** 이벤트 수집기가 커버하는 카운터파티 라벨 — 전송 스캔의 같은 라벨 행은 드롭(이중 집계 방지).
 *  "fluid" 포함 이유: Fluid 리퀴디티 싱글톤이 스캔에서 "Fluid" 라벨로도 잡혀 이벤트 행과 이중 집계됐던 것 적발. */
export const LENDING_EVENT_LABELS = ["aave-v3", "spark", "compound-v3", "fluid-lending", "fluid", "fluid-dex", "morpho-blue", "morpho blue", "lido", "sky-lending", "ethena-usde", "euler-v2", "ether.fi-stake", "etherfi"];

// ── RPC 유틸 ──────────────────────────────────────────────────────────
interface Log { address: string; topics: string[]; data: string; transactionHash: string }
// JSON-RPC = 공용 게이트 + 백오프 재시도(lib/rpc-gate). publicnode 호스트 게이트를 lending-pools 와
// 전역 공유해 합산 동시성도 캡된다.
const rpc = gatedJsonRpc;
/** 폴백 체인: 1차(publicnode) → 2차(mevblocker/공식). null(실패)이면 다음 엔드포인트, 배열(빈 것 포함)이면 채택. */
async function rpcFB<T>(chain: string, method: string, params: unknown[]): Promise<T | null> {
  const r = await rpc<T>(RPC[chain], method, params);
  if (r !== null) return r;
  const alt = RPC_ALT[chain];
  return alt ? await rpc<T>(alt, method, params) : null;
}
const word = (data: string, i: number) => { const h = data.replace(/^0x/, ""); return h.length >= (i + 1) * 64 ? "0x" + h.slice(i * 64, (i + 1) * 64) : null; };
const asSigned = (w: string) => { const v = BigInt(w); return v >= 1n << 255n ? v - (1n << 256n) : v; };
const topicAddr = (t: string | undefined) => (t ? "0x" + t.slice(-40).toLowerCase() : "");

// 체인별 24h 블록수 — blockSec 실측(latest vs latest-20000, 6h 캐시). 하드코딩 금지(arbitrum ~0.25s 등 비정형).
const _timing = new Map<string, { at: number; latest: number; dayBlocks: number }>();
async function chainWindow(chain: string): Promise<{ latest: number; fromBlock: number } | null> {
  if (!RPC[chain]) return null;
  const hit = _timing.get(chain);
  const latestHex = await rpcFB<string>(chain, "eth_blockNumber", []);
  if (!latestHex) return null;
  const latest = parseInt(latestHex, 16);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return { latest, fromBlock: Math.max(0, latest - hit.dayBlocks) };
  const span = Math.min(20_000, latest - 1);
  const [b1, b0] = await Promise.all([
    rpcFB<{ timestamp: string }>(chain, "eth_getBlockByNumber", ["0x" + latest.toString(16), false]),
    rpcFB<{ timestamp: string }>(chain, "eth_getBlockByNumber", ["0x" + (latest - span).toString(16), false]),
  ]);
  if (!b1?.timestamp || !b0?.timestamp) return null;
  const blockSec = Math.max(0.05, (parseInt(b1.timestamp, 16) - parseInt(b0.timestamp, 16)) / span);
  const dayBlocks = Math.ceil(DAY_SEC / blockSec);
  _timing.set(chain, { at: Date.now(), latest, dayBlocks });
  return { latest, fromBlock: Math.max(0, latest - dayBlocks) };
}

/** 24h getLogs — 10k 블록 청크(publicnode 한계), 동시 4청크, 폴백 경유. 실패 청크는 건너뜀(부분 데이터).
 *  topics 에 null 허용(인덱스 와일드카드 — eETH 소각의 to=0x0 처럼 topic2 만 고정할 때). */
async function logs24h(chain: string, address: string, topics: (string | string[] | null)[]): Promise<Log[]> {
  const win = await chainWindow(chain);
  if (!RPC[chain] || !win) return [];
  const STEP = 10_000;
  const ranges: [number, number][] = [];
  for (let f = win.fromBlock; f <= win.latest; f += STEP) ranges.push([f, Math.min(win.latest, f + STEP - 1)]);
  const out: Log[] = [];
  for (let i = 0; i < ranges.length; i += 4) {
    const part = await Promise.all(ranges.slice(i, i + 4).map(([f, t]) =>
      rpcFB<Log[]>(chain, "eth_getLogs", [{ address, fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16), topics }])));
    for (const p of part) if (p) out.push(...p);
  }
  return out;
}

interface Agg { usd: number; count: number; sample: string | null }
const akey = (token: string, chain: string, label: string, dir: "in" | "out", market: string | null) => `${token}|${chain}|${label}|${dir}|${market ?? ""}`;
function inc(m: Map<string, Agg>, k: string, usd: number, tx: string) {
  const cur = m.get(k);
  if (cur) { cur.usd += usd; cur.count += 1; }
  else m.set(k, { usd, count: 1, sample: tx });
}

// Euler 볼트 목록 (Goldsky 서브그래프 — **목록만**(vault→asset), 흐름은 전부 온체인 로그. 체인별 6h 캐시)
const _eulerVaults = new Map<string, { at: number; map: Map<string, string> }>();
async function eulerVaults(chain: string): Promise<Map<string, string>> {
  const url = EULER_SUBGRAPHS[chain];
  if (!url) return new Map();
  const hit = _eulerVaults.get(chain);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.map;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ query: "{ eulerVaults(first:1000){ id asset } }" }), signal: AbortSignal.timeout(20_000) });
    const j = (await r.json()) as { data?: { eulerVaults?: { id: string; asset: string }[] } };
    const map = new Map((j.data?.eulerVaults ?? []).map((v) => [v.id.toLowerCase(), v.asset.toLowerCase()] as const));
    if (map.size) _eulerVaults.set(chain, { at: Date.now(), map });
    return map;
  } catch { return _eulerVaults.get(chain)?.map ?? new Map(); }
}

// Comet baseToken (불변 → 영구 캐시) — base-scope 이벤트의 자산 식별
const _cometBase = new Map<string, string | null>();
async function cometBaseToken(chain: string, comet: string): Promise<string | null> {
  const key = `${chain}|${comet}`;
  if (_cometBase.has(key)) return _cometBase.get(key)!;
  const ret = await rpcFB<string>(chain, "eth_call", [{ to: comet, data: "0xc55dae63" }, "latest"]); // baseToken()
  if (ret === null) return null; // 양 엔드포인트 실패 = 비결론 — 캐시 안 함(다음 호출 재시도)
  const a = ret.length >= 42 ? "0x" + ret.slice(-40).toLowerCase() : null;
  const ok = a && !/^0x0{40}$/.test(a) ? a : null;
  _cometBase.set(key, ok);
  return ok;
}

/**
 * 선택 토큰들의 24h 렌딩 흐름 → FlowBaselineRow[] (관측구간 = 정확히 24h).
 * targets 의 (chain, addr) 와 일치하는 reserve 이벤트만 집계 — 미선택 자산은 버린다.
 */
export async function lendingEventRows(targets: CpTarget[], prices: Map<string, { price: number; decimals: number | null }>): Promise<FlowBaselineRow[]> {
  const byChainAddr = new Map<string, string>(); // `${chain}:${addr}` → 토큰 심볼
  for (const t of targets) if (RPC[t.chain]) byChainAddr.set(`${t.chain}:${t.addr}`, t.token);
  const chains = [...new Set(targets.map((t) => t.chain).filter((c) => RPC[c]))];
  if (!chains.length) return [];
  const agg = new Map<string, Agg>();
  const toUsd = (chain: string, addr: string, rawWord: string): number | null => {
    const pi = prices.get(`${chain}:${addr}`);
    if (!pi || pi.decimals == null) return null; // 가격/소수점 미상 — 지어내지 않음
    return (Number(BigInt(rawWord) & ((1n << 255n) - 1n)) / 10 ** pi.decimals) * pi.price;
  };

  await Promise.all(chains.map(async (chain) => {
    // ── Aave V3 / Spark — reserve=topic1, 토픽 4종 한 필터 ──
    await Promise.all((AAVE_POOLS[chain] ?? []).map(async ({ addr, label }) => {
      for (const l of await logs24h(chain, addr, [Object.keys(AAVE_TOPIC)])) {
        const action = AAVE_TOPIC[l.topics[0]];
        if (!action) continue;
        const sym = byChainAddr.get(`${chain}:${topicAddr(l.topics[1])}`);
        if (!sym) continue;
        const w = word(l.data, AAVE_AMOUNT_WORD[action]);
        if (!w) continue;
        const usd = toUsd(chain, topicAddr(l.topics[1]), w);
        if (usd == null || !(usd > 0)) continue;
        inc(agg, akey(sym, chain, label, ACTION_DIR[action], null), usd, l.transactionHash);
      }
    }));
    // ── Compound V3 Comet — base 자산은 baseToken(), 담보는 topic3 ──
    await Promise.all((COMETS[chain] ?? []).map(async (comet) => {
      const base = await cometBaseToken(chain, comet);
      for (const l of await logs24h(chain, comet, [Object.keys(COMPOUND_TOPIC)])) {
        const map = COMPOUND_TOPIC[l.topics[0]];
        if (!map) continue;
        const asset = map.scope === "base" ? base : topicAddr(l.topics[3]);
        if (!asset) continue;
        const sym = byChainAddr.get(`${chain}:${asset}`);
        if (!sym) continue;
        const w = word(l.data, 0);
        if (!w) continue;
        const usd = toUsd(chain, asset, w);
        if (usd == null || !(usd > 0)) continue;
        inc(agg, akey(sym, chain, "compound-v3", ACTION_DIR[map.action], null), usd, l.transactionHash);
      }
    }));
    // ── Fluid — LogOperate 부호로 supply±/borrow± (token=topic2). user(topic1) 가 Fluid DEX 컨트랙트면
    //    'fluid-dex', 아니면 'fluid-lending' 으로 분기 — 같은 LogOperate 를 공유하므로 DEX 볼륨이
    //    lending 에 섞이던 오라벨을 푼다(2026-06-13). dexSet 은 DexFactory 온체인 열거(실패 시 전부 lending 폴백). ──
    const fluidDexes = await fluidDexSet(chain);
    for (const l of await logs24h(chain, FLUID_ADDR, [FLUID_LOGOPERATE])) {
      const asset = topicAddr(l.topics[2]);
      const sym = byChainAddr.get(`${chain}:${asset}`);
      if (!sym) continue;
      const label = fluidDexes.has(topicAddr(l.topics[1])) ? "fluid-dex" : "fluid-lending";
      const w0 = word(l.data, 0), w1 = word(l.data, 1);
      const pi = prices.get(`${chain}:${asset}`);
      if (!pi || pi.decimals == null) continue;
      const toU = (v: bigint) => (Number(v < 0n ? -v : v) / 10 ** pi.decimals!) * pi.price;
      if (w0) { const s = asSigned(w0); if (s !== 0n) inc(agg, akey(sym, chain, label, s > 0n ? "in" : "out", null), toU(s), l.transactionHash); }
      if (w1) { const b = asSigned(w1); if (b !== 0n) inc(agg, akey(sym, chain, label, b > 0n ? "out" : "in", null), toU(b), l.transactionHash); }
    }
    // ── Euler v2 — **3체인 전부**: 선택 토큰을 담은 볼트만 주소배열 getLogs(284볼트 전수 스캔 방지).
    //    RPC/한계는 EULER_LOG(메인넷 mevblocker, L2 공식). (배열 배치 × 블록 청크) 4병렬, 실패 청크 스킵. ──
    const ecfg = EULER_LOG[chain];
    if (ecfg) {
      const vmap = await eulerVaults(chain);
      const addrs = [...vmap.entries()].filter(([, asset]) => byChainAddr.has(`${chain}:${asset}`)).map(([v]) => v);
      const win = addrs.length ? await chainWindow(chain) : null;
      if (addrs.length && win) {
        const batches: string[][] = [];
        for (let i = 0; i < addrs.length; i += ecfg.batch) batches.push(addrs.slice(i, i + ecfg.batch));
        const jobs: { f: number; t: number; addrs: string[] }[] = [];
        for (let f = win.fromBlock; f <= win.latest; f += ecfg.step) {
          const t = Math.min(win.latest, f + ecfg.step - 1);
          for (const b of batches) jobs.push({ f, t, addrs: b });
        }
        for (let i = 0; i < jobs.length; i += 4) {
          const part = await Promise.all(jobs.slice(i, i + 4).map((j) =>
            rpc<Log[]>(ecfg.url, "eth_getLogs", [{ address: j.addrs, fromBlock: "0x" + j.f.toString(16), toBlock: "0x" + j.t.toString(16), topics: [Object.keys(EULER_TOPIC)] }])));
          for (const logs of part) {
            if (!logs) continue;
            for (const l of logs) {
              const action = EULER_TOPIC[l.topics[0]];
              if (!action) continue;
              const asset = vmap.get(l.address.toLowerCase());
              const sym = asset ? byChainAddr.get(`${chain}:${asset}`) : undefined;
              if (!sym || !asset) continue;
              const w = word(l.data, 0);
              if (!w) continue;
              const usd = toUsd(chain, asset, w);
              if (usd == null || !(usd > 0)) continue;
              inc(agg, akey(sym, chain, "euler-v2", ACTION_DIR[action], null), usd, l.transactionHash);
            }
          }
        }
      }
    }
    // ── Lido (메인넷) — Submitted=스테이크 유입, WithdrawalRequested=출금 유출. ETH 단위지만 stETH≈ETH ──
    const stSym = byChainAddr.get(`${chain}:${LIDO_STETH}`);
    if (chain === "ethereum" && stSym) {
      const [subs, wreq] = await Promise.all([
        logs24h(chain, LIDO_STETH, [LIDO_SUBMITTED]),
        logs24h(chain, LIDO_WQ, [LIDO_WD_REQUESTED]),
      ]);
      for (const l of subs) { const w = word(l.data, 0); if (w) { const u = toUsd(chain, LIDO_STETH, w); if (u != null && u > 0) inc(agg, akey(stSym, chain, "lido", "in", null), u, l.transactionHash); } }
      for (const l of wreq) { const w = word(l.data, 0); if (w) { const u = toUsd(chain, LIDO_STETH, w); if (u != null && u > 0) inc(agg, akey(stSym, chain, "lido", "out", null), u, l.transactionHash); } }
    }
    // ── ether.fi (메인넷) — eETH 민트(from 0x0)=스테이크 유입, 소각(to 0x0)=출금 유출. weETH 심볼로 귀속. ──
    const efSym = byChainAddr.get(`${chain}:${ETHERFI_WEETH}`) ?? byChainAddr.get(`${chain}:${ETHERFI_EETH}`);
    if (chain === "ethereum" && efSym) {
      const pe = prices.get(`ethereum:${ETHERFI_EETH}`) ?? prices.get(`ethereum:${ETHERFI_WEETH}`);
      if (pe && pe.decimals != null) {
        const dec = pe.decimals, px = pe.price;
        const [mints, burns] = await Promise.all([
          logs24h(chain, ETHERFI_EETH, [TRANSFER_TOPIC, ZERO_TOPIC]),       // from = 0x0 (민트)
          logs24h(chain, ETHERFI_EETH, [TRANSFER_TOPIC, null, ZERO_TOPIC]), // to   = 0x0 (소각)
        ]);
        const toU = (w: string) => (Number(BigInt(w) & ((1n << 255n) - 1n)) / 10 ** dec) * px;
        for (const l of mints) { const w = word(l.data, 0); if (w) { const u = toU(w); if (u > 0) inc(agg, akey(efSym, chain, "ether.fi-stake", "in", null), u, l.transactionHash); } }
        for (const l of burns) { const w = word(l.data, 0); if (w) { const u = toU(w); if (u > 0) inc(agg, akey(efSym, chain, "ether.fi-stake", "out", null), u, l.transactionHash); } }
      }
    }
    // ── ERC-4626 저축 (sky sUSDS·ethena sUSDe) — 기초자산이 선택 토큰일 때만, 컨트랙트 주소로 귀속 ──
    for (const sv of ERC4626_SAVINGS) {
      if (sv.chain !== chain) continue;
      const sym = byChainAddr.get(`${chain}:${sv.asset}`);
      if (!sym) continue;
      for (const l of await logs24h(chain, sv.vault, [[ERC4626_DEPOSIT, ERC4626_WITHDRAW]])) {
        const w = word(l.data, 0); // assets — 기초자산 단위
        if (!w) continue;
        const usd = toUsd(chain, sv.asset, w);
        if (usd == null || !(usd > 0)) continue;
        inc(agg, akey(sym, chain, sv.label, l.topics[0] === ERC4626_DEPOSIT ? "in" : "out", null), usd, l.transactionHash);
      }
    }
  }));

  // ── Morpho Blue — blue-api GraphQL 24h (assetsUsd 가 이미 USD, 마켓 단위 → marketHint). 게이트+재시도 경유. ──
  const morphoIds = chains.map((c) => MORPHO_CHAIN_ID[c]).filter(Boolean);
  if (morphoIds.length) {
    const since = Math.floor(Date.now() / 1000) - DAY_SEC;
    const symByUpper = new Map<string, { sym: string; chain: string }[]>();
    for (const t of targets) {
      const arr = symByUpper.get(t.token.toUpperCase()) ?? [];
      if (!arr.length) symByUpper.set(t.token.toUpperCase(), arr);
      arr.push({ sym: t.token, chain: t.chain });
    }
    const idToChain = new Map(Object.entries(MORPHO_CHAIN_ID).map(([k, v]) => [v, k] as const));
    interface MTx {
      hash: string; type: string; chain?: { id?: number };
      data?: {
        assetsUsd?: number | null;
        market?: { loanAsset?: { symbol?: string } | null; collateralAsset?: { symbol?: string } | null } | null;
        vault?: { name?: string | null; asset?: { symbol?: string } | null } | null; // MetaMorpho 볼트 예치/출금
      } | null;
    }
    const ACT: Record<string, { dir: "in" | "out"; side: "loan" | "collat" | "vault" }> = {
      MarketSupply: { dir: "in", side: "loan" }, MarketWithdraw: { dir: "out", side: "loan" },
      MarketBorrow: { dir: "out", side: "loan" }, MarketRepay: { dir: "in", side: "loan" },
      MarketSupplyCollateral: { dir: "in", side: "collat" }, MarketWithdrawCollateral: { dir: "out", side: "collat" },
      MetaMorphoDeposit: { dir: "in", side: "vault" }, MetaMorphoWithdraw: { dir: "out", side: "vault" },
    };
    for (let page = 0; page < 8; page++) {
      const q = `{ transactions(first:1000, skip:${page * 1000}, orderBy:Timestamp, orderDirection:Desc, where:{ chainId_in:[${morphoIds.join(",")}], timestamp_gte:${since}, type_in:[MarketSupply,MarketWithdraw,MarketBorrow,MarketRepay,MarketSupplyCollateral,MarketWithdrawCollateral,MetaMorphoDeposit,MetaMorphoWithdraw] }){ items{ hash type chain{id} data{ ... on MarketTransferTransactionData{ assetsUsd market{ loanAsset{symbol} collateralAsset{symbol} } } ... on MarketCollateralTransferTransactionData{ assetsUsd market{ loanAsset{symbol} collateralAsset{symbol} } } ... on VaultTransactionData{ assetsUsd vault{ name asset{symbol} } } } } } }`;
      const j = await gatedGql<{ data?: { transactions?: { items?: MTx[] } } }>("https://blue-api.morpho.org/graphql", q);
      if (!j) break; // 재시도 후에도 실패 = 부분 데이터(정직)
      const items = j.data?.transactions?.items ?? [];
      for (const t of items) {
        const act = ACT[t.type];
        const usd = t.data?.assetsUsd ?? 0;
        const chain = idToChain.get(t.chain?.id ?? -1);
        if (!act || !(usd > 0) || !chain) continue;
        if (act.side === "vault") {
          const symRaw = t.data?.vault?.asset?.symbol;
          const vaultName = (t.data?.vault?.name ?? "").replace(/\|/g, "/"); // akey 구분자 보호
          if (!symRaw || !vaultName) continue;
          const hit = (symByUpper.get(symRaw.toUpperCase()) ?? []).find((x) => x.chain === chain);
          if (!hit) continue;
          inc(agg, akey(hit.sym, chain, vaultName, act.dir, null), usd, t.hash);
          continue;
        }
        const mkt = t.data?.market;
        if (!mkt) continue;
        const symRaw = act.side === "loan" ? mkt.loanAsset?.symbol : mkt.collateralAsset?.symbol;
        if (!symRaw) continue;
        const hit = (symByUpper.get(symRaw.toUpperCase()) ?? []).find((x) => x.chain === chain);
        if (!hit) continue;
        const market = mkt.collateralAsset?.symbol && mkt.loanAsset?.symbol ? `${mkt.collateralAsset.symbol}-${mkt.loanAsset.symbol}` : null;
        inc(agg, akey(hit.sym, chain, "morpho-blue", act.dir, market), usd, t.hash);
      }
      if (items.length < 1000) break;
    }
  }

  const rows: FlowBaselineRow[] = [];
  for (const [k, a] of agg) {
    const [token, chain, label, dir, market] = k.split("|");
    rows.push({
      token, chain, counterparty: label, counterpartyAddr: null,
      marketHint: market || null,
      kind: dir === "in" ? "deposit" : "withdraw",
      direction: dir as "in" | "out",
      usd: a.usd, count: a.count,
      usdPerHour: a.usd / 24, txPerHour: a.count / 24,
      sampleTx: a.sample, observedSec: DAY_SEC, // 이벤트 로그는 24h 전수 — 분모가 진짜 하루
    });
  }
  return rows;
}
