import { NextResponse } from "next/server";
import {
  AAVE_AMOUNT_WORD, AAVE_TOPIC, ACTION_DIR, BALANCER_PROTO, BALANCER_SWAP_TOPIC,
  COMPOUND_PROTO, COMPOUND_TOPIC, CURVE_API_REGISTRIES, CURVE_PROTO, CURVE_TE_TOPICS,
  DEX_PROTOS, EULER_PROTO, EULER_SUBGRAPH, EULER_TOPIC, FLOW_CHAINS, FLOW_CHAIN_BY_KEY, FLUID_LOGOPERATE, FLUID_PROTO,
  LEVER_MIN_USD, MATERIAL_PCT, MIN_ACTORS, MIN_USD, MORPHO_PROTO, N_BUCKETS, RECENT_BUCKETS, SHARE_MIN,
  SYSTEMIC_MIN_USD, TOKENS, TOKEN_BY_ADDR, TOKEN_BY_SYM, TOP_ACTOR_MAX, UNIV3_FEE_TIERS, UNIV3_GETPOOL_SEL,
  UNIV3_PROTO, UNIV3_QUOTE_SYMS, UNIV3_SWAP_TOPIC, UNIV4_ADDR, UNIV4_INIT_TOPIC, UNIV4_PROTO, UNIV4_SWAP_TOPIC,
  WHALE_MIN_USD, Z_TH, ZERO_ADDR, anomalyStat, groupOfSym,
  type FlowAction, type FlowChain, type FlowEdgeOut, type FlowKind, type FlowMapData, type FlowProtoOut,
  type FlowSummary, type FlowSummaryChain, type FlowTokenOut, type LeverOut, type TokenInfo,
} from "@/lib/flowmap";

/**
 * GET /api/flowmap[?chain=base][?ts=<unix>][?summary=1] — 실시간 상황판 (멀티체인).
 *
 * 체인 레지스트리(FLOW_CHAINS)는 scripts/probe_flowmap_chains.mjs 온체인 전수 검증 통과분만.
 * 메인넷 = 큐레이션 토큰 레지스트리(고정 링 59) 그대로. 그 외 체인 = **동적 레지스트리**:
 *   Aave getReservesList() + Comet baseToken() → 온체인 symbol()/decimals() 배치 → llama 가격.
 *   (손 타이핑 주소 0 — 전부 온체인에서 유도, 6h 캐시)
 * 윈도우는 체인별 blockSec 실측(latest vs latest-10000)으로 ≈6h 를 블록수로 환산, 버킷 72개 고정.
 * 이상치 게이트(systemic/whale)·레버 페어링은 체인 공통(검증된 수식 그대로).
 *
 * ?summary=1 → 전 체인 systemic/whale 집계(칩용). 캐시 스냅샷 즉답 + 오래된 체인은 백그라운드 수집.
 * ?ts=<unix> → 그 시각 기준 6h 리플레이(실데이터). 퍼블릭 RPC(publicnode), 60s 캐시/체인.
 */
export const dynamic = "force-dynamic";

const HDRS = { "content-type": "application/json", "user-agent": "Mozilla/5.0 chain-spiral/0.1" };
const MORPHO_GQL = "https://blue-api.morpho.org/graphql";
// 셀렉터 — viem keccak256 계산값 고정(프로브와 동일). 메모리 추정 금지.
const SEL_RESERVES = "0xd1946dbc"; // getReservesList()
const SEL_SYMBOL = "0x95d89b41";   // symbol()
const SEL_DECIMALS = "0x313ce567"; // decimals()
const SEL_BASETOKEN = "0xc55dae63"; // baseToken()

interface Log { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }

// 호스트별 동시 요청 세마포어 — 한 체인 RPC 에 9개 수집기×청크가 몰리면 쓰로틀(실측: arbitrum 전멸).
const sems = new Map<string, { n: number; q: (() => void)[] }>();
async function withSem<T>(key: string, max: number, fn: () => Promise<T>): Promise<T> {
  let s = sems.get(key);
  if (!s) { s = { n: 0, q: [] }; sems.set(key, s); }
  if (s.n >= max) await new Promise<void>((res) => s!.q.push(res));
  s.n++;
  try { return await fn(); } finally { s.n--; s.q.shift()?.(); }
}
const RPC_CONC_PER_HOST = 4;

async function rpc<T>(method: string, params: unknown[], urls: readonly string[]): Promise<T> {
  return withSem(urls[0], RPC_CONC_PER_HOST, async () => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) { // 일시 쓰로틀 대비 1회 재시도(백오프)
      if (attempt) await new Promise((r) => setTimeout(r, 600 + Math.floor(500 * (sems.get(urls[0])?.n ?? 1))));
      for (const url of urls) {
        try {
          const r = await fetch(url, { method: "POST", headers: HDRS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store", signal: AbortSignal.timeout(25_000) });
          if (!r.ok) { lastErr = `${url} http ${r.status}`; continue; }
          const j = await r.json();
          if (j.error) { lastErr = `${url} ${JSON.stringify(j.error).slice(0, 120)}`; continue; }
          return j.result as T;
        } catch (e) { lastErr = e; }
      }
    }
    throw new Error(`rpc ${method} failed: ${String(lastErr).slice(0, 200)}`);
  });
}
// 주소배열 getLogs — 메인넷 publicnode 는 배열 거부(실측) → mevblocker. 그 외 체인은 publicnode 허용(프로브).
const arrayRpcs = (cfg: FlowChain): readonly string[] => (cfg.key === "ethereum" ? ["https://rpc.mevblocker.io"] : cfg.rpcs);

// ── 체인 컨텍스트 — 디코더 전부가 이걸로 동작(메인넷 상수 직접 참조 금지) ────────────
interface Reg { list: TokenInfo[]; byAddr: Map<string, TokenInfo>; bySym: Map<string, TokenInfo>; price: Map<string, number> }
interface Ctx {
  cfg: FlowChain; latest: number; headTime: number; blockSec: number;
  windowBlocks: number; bucketBlocks: number;
  reg: Reg; errors: string[];
}
const price = (ctx: Ctx, sym: string) => ctx.reg.price.get(sym) ?? 0;

// blockSec 실측(6h 캐시) — 하드코딩 금지: BSC 0.45s·Metis 36s 같은 비정형도 자동 적응.
const timingCache = new Map<string, { ts: number; blockSec: number }>();
async function blockSecOf(cfg: FlowChain, latest: number): Promise<number> {
  const c = timingCache.get(cfg.key);
  if (c && Date.now() - c.ts < 6 * 3600_000) return c.blockSec;
  const span = Math.min(10_000, latest - 1);
  const [b1, b0] = await Promise.all([
    rpc<{ timestamp: string }>("eth_getBlockByNumber", ["0x" + latest.toString(16), false], cfg.rpcs),
    rpc<{ timestamp: string }>("eth_getBlockByNumber", ["0x" + (latest - span).toString(16), false], cfg.rpcs),
  ]);
  const blockSec = Math.max(0.05, (parseInt(b1.timestamp, 16) - parseInt(b0.timestamp, 16)) / span);
  timingCache.set(cfg.key, { ts: Date.now(), blockSec });
  return blockSec;
}

// ── 동적 토큰 레지스트리(비메인넷) — Aave 리저브 ∪ Comet 베이스 → symbol/decimals 배치 → llama 가격 ──
const regCache = new Map<string, { ts: number; reg: Reg }>();
const decStr = (ret: string | null): string | null => {
  if (!ret || ret === "0x") return null;
  const h = ret.slice(2);
  try {
    if (h.length <= 64) return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "").trim() || null; // bytes32 심볼(MKR류)
    const len = parseInt(h.slice(64, 128), 16);
    if (!(len > 0 && len < 64)) return null;
    return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8").trim() || null;
  } catch { return null; }
};
async function batchCalls(cfg: FlowChain, calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(calls.length).fill(null);
  for (let i = 0; i < calls.length; i += 100) {
    const chunk = calls.slice(i, i + 100);
    const body = chunk.map((c, j) => ({ jsonrpc: "2.0", id: j, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"] }));
    const r = await fetch(cfg.rpcs[0], { method: "POST", headers: HDRS, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(30_000) });
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error("batch eth_call 실패");
    for (const item of arr) if (item?.result) out[i + item.id] = item.result as string;
  }
  return out;
}
function parseAddrArray(ret: string | null): string[] {
  if (!ret || ret.length < 130) return [];
  const h = ret.slice(2);
  const n = parseInt(h.slice(64, 128), 16);
  const out: string[] = [];
  for (let i = 0; i < n && i < 200; i++) out.push("0x" + h.slice(128 + i * 64 + 24, 128 + (i + 1) * 64).toLowerCase());
  return out;
}
async function registryFor(cfg: FlowChain, errors: string[]): Promise<Reg> {
  if (cfg.key === "ethereum") {
    // 메인넷 — 큐레이션 레지스트리(고정 링) + 기존 가격 경로 유지
    const priceBySym = await mainnetPrices();
    return { list: TOKENS, byAddr: new Map(Object.entries(TOKEN_BY_ADDR)), bySym: new Map(Object.entries(TOKEN_BY_SYM)), price: priceBySym };
  }
  const c = regCache.get(cfg.key);
  if (c && Date.now() - c.ts < 6 * 3600_000) return c.reg;

  // 1) 주소 우주 = Aave getReservesList() ∪ Comet baseToken()
  const addrSet = new Set<string>();
  for (const inst of cfg.aave) {
    try {
      const ret = await rpc<string>("eth_call", [{ to: inst.addr, data: SEL_RESERVES }, "latest"], cfg.rpcs);
      for (const a of parseAddrArray(ret)) addrSet.add(a);
    } catch (e) { errors.push(`${cfg.key} ${inst.name} reserves: ${String(e).slice(0, 50)}`); }
  }
  for (const comet of cfg.comets) {
    try {
      const ret = await rpc<string>("eth_call", [{ to: comet, data: SEL_BASETOKEN }, "latest"], cfg.rpcs);
      const a = "0x" + ret.slice(-40).toLowerCase();
      if (!/^0x0{40}$/.test(a)) addrSet.add(a);
    } catch { /* comet 후보 실패 → 그 comet 은 resolveComets 에서 빠짐 */ }
  }
  const addrs = [...addrSet];
  if (!addrs.length) throw new Error(`${cfg.key}: 토큰 우주 유도 실패(리저브 0)`);

  // 2) symbol/decimals 배치
  const rets = await batchCalls(cfg, addrs.flatMap((a) => [{ to: a, data: SEL_SYMBOL }, { to: a, data: SEL_DECIMALS }]));
  // 3) llama 가격 (체인 슬러그는 프로브로 확정 — avax·xdai 주의)
  const priceByAddr = new Map<string, number>();
  for (let i = 0; i < addrs.length; i += 40) {
    const ids = addrs.slice(i, i + 40).map((a) => `${cfg.llamaSlug}:${a}`).join(",");
    try {
      const r = await fetch(`https://coins.llama.fi/prices/current/${ids}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const j = await r.json();
      for (const a of addrs.slice(i, i + 40)) {
        const p = j?.coins?.[`${cfg.llamaSlug}:${a}`]?.price;
        if (typeof p === "number" && p > 0) priceByAddr.set(a, p);
      }
    } catch { /* 가격 청크 실패 → 해당 토큰 미등록(아래에서 드롭) */ }
  }
  // 4) 조립 — 심볼·소수점·가격 전부 해석된 것만(가격 없는 토큰은 USD 환산 불가 → 정직하게 제외)
  const list: TokenInfo[] = [];
  const byAddr = new Map<string, TokenInfo>();
  const bySym = new Map<string, TokenInfo>();
  const priceMap = new Map<string, number>();
  let dropped = 0;
  for (let i = 0; i < addrs.length; i++) {
    const addr = addrs[i];
    let sym = decStr(rets[i * 2]);
    const dec = rets[i * 2 + 1] ? parseInt(rets[i * 2 + 1]!, 16) : NaN;
    const p = priceByAddr.get(addr);
    if (!sym || !Number.isFinite(dec) || dec > 30 || !p) { dropped++; continue; }
    // 심볼 충돌(예: 아비트럼 USDC.e 와 네이티브 USDC 둘 다 온체인 "USDC") — 드롭하면 큰 시장이
    // 통째로 빠지므로 접미사로 분리 추적. Morpho(심볼 해석)는 선착 매칭 — 주석으로 한계 명시.
    if (bySym.has(sym.toLowerCase())) {
      let n = 2;
      while (bySym.has(`${sym}(${n})`.toLowerCase())) n++;
      sym = `${sym}(${n})`;
    }
    const info: TokenInfo = { sym, addr, decimals: dec, group: groupOfSym(sym) };
    list.push(info); byAddr.set(addr, info); bySym.set(sym.toLowerCase(), info); priceMap.set(sym, p);
  }
  if (dropped) errors.push(`${cfg.key}: 토큰 ${dropped}개 제외(심볼/가격 미해석)`);
  if (!list.length) throw new Error(`${cfg.key}: 레지스트리 0 토큰`);
  const reg: Reg = { list, byAddr, bySym, price: priceMap };
  regCache.set(cfg.key, { ts: Date.now(), reg });
  return reg;
}

// 메인넷 가격(기존 경로 보존 — 정적 레지스트리 키)
let mainPriceCache: { ts: number; bySym: Map<string, number> } | null = null;
async function mainnetPrices(): Promise<Map<string, number>> {
  if (mainPriceCache && Date.now() - mainPriceCache.ts < 300_000) return mainPriceCache.bySym;
  const bySym = new Map<string, number>();
  try {
    for (let i = 0; i < TOKENS.length; i += 40) {
      const chunk = TOKENS.slice(i, i + 40);
      const ids = chunk.map((t) => `ethereum:${t.addr}`).join(",");
      const r = await fetch(`https://coins.llama.fi/prices/current/${ids}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const j = await r.json();
      for (const t of chunk) {
        const p = j?.coins?.[`ethereum:${t.addr}`]?.price;
        if (typeof p === "number") bySym.set(t.sym, p);
      }
    }
  } catch { /* 가격 실패 → 0 처리 */ }
  const weth = bySym.get("WETH");
  if (weth && !bySym.get("ETH")) bySym.set("ETH", weth); // Fluid 네이티브 ETH = WETH 준용(1:1)
  mainPriceCache = { ts: Date.now(), bySym };
  return bySym;
}

// Comet — baseToken() 런타임 해석(6h 캐시). 레지스트리에 베이스가 없으면 그 comet 제외(정직).
const cometCache = new Map<string, { ts: number; comets: { addr: string; baseSym: string }[] }>();
async function resolveComets(ctx: Ctx): Promise<{ addr: string; baseSym: string }[]> {
  const cfg = ctx.cfg;
  if (!cfg.comets.length) return [];
  const c = cometCache.get(cfg.key);
  if (c && Date.now() - c.ts < 6 * 3600_000) return c.comets;
  const out: { addr: string; baseSym: string }[] = [];
  for (const addr of cfg.comets) {
    try {
      const ret = await rpc<string>("eth_call", [{ to: addr, data: SEL_BASETOKEN }, "latest"], cfg.rpcs);
      const base = "0x" + ret.slice(-40).toLowerCase();
      const tok = ctx.reg.byAddr.get(base);
      if (tok) out.push({ addr, baseSym: tok.sym });
      else ctx.errors.push(`${cfg.key} comet ${addr.slice(0, 8)}: 베이스 미등록`);
    } catch (e) { ctx.errors.push(`${cfg.key} comet ${addr.slice(0, 8)}: ${String(e).slice(0, 40)}`); }
  }
  cometCache.set(cfg.key, { ts: Date.now(), comets: out });
  return out;
}

// 윈도우 getLogs — 체인별 블록수가 커서(arbitrum 6h≈86k) 청크 분할. minChunks 로 로그밀도 대응.
// tolerant: DEX 처럼 로그가 많은 소스는 실패 청크만 기록하고 계속(부분 데이터, 메인넷 기존 시맨틱).
//           렌딩은 strict(전부 아니면 없음) — 부분 baseline 왜곡보다 정직한 부재가 낫다.
// addrLimit: publicnode 는 getLogs 주소배열을 8개까지만 허용(실측, base·arbitrum·gnosis 동일)
//            → 8개 그룹으로 쪼개 동시 4그룹씩. 메인넷은 mevblocker 가 전체배열 허용이라 미사용.
const PUBLICNODE_ADDR_LIMIT = 8;
async function logsWindow(ctx: Ctx, address: string | string[], topics: (string | string[] | null)[] | undefined, opts?: { minChunks?: number; rpcs?: readonly string[]; tolerant?: string; addrLimit?: number }): Promise<Log[]> {
  if (Array.isArray(address) && opts?.addrLimit && address.length > opts.addrLimit) {
    const groups: string[][] = [];
    for (let i = 0; i < address.length; i += opts.addrLimit) groups.push(address.slice(i, i + opts.addrLimit));
    const all: Log[] = [];
    const CONC = 3; // 호스트 세마포어(4)와 함께 — 그룹 동시성은 보수적으로
    for (let i = 0; i < groups.length; i += CONC) {
      const parts = await Promise.all(groups.slice(i, i + CONC).map((g) => logsWindow(ctx, g, topics, { ...opts, addrLimit: undefined })));
      for (const p of parts) all.push(...p);
    }
    return all;
  }
  // 블록범위 상한 10,000 — arbitrum publicnode 실측("exceed maximum block range: 10000"). 전 체인 안전치.
  const chunks = Math.max(opts?.minChunks ?? 1, Math.ceil(ctx.windowBlocks / 10_000));
  const step = Math.ceil(ctx.windowBlocks / chunks);
  const from0 = ctx.latest - ctx.windowBlocks + 1;
  const all: Log[] = [];
  for (let i = 0; i < chunks; i++) {
    const f = from0 + i * step, t = Math.min(ctx.latest, f + step - 1);
    if (f > t) break;
    try {
      all.push(...await rpc<Log[]>("eth_getLogs", [{ address, fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16), ...(topics ? { topics } : {}) }], opts?.rpcs ?? ctx.cfg.rpcs));
    } catch (e) {
      if (!opts?.tolerant) throw e;
      ctx.errors.push(`${opts.tolerant} 청크 ${f}-${t}: ${String(e).slice(0, 50)}`);
    }
  }
  return all;
}

// ── 집계 컨테이너 ──────────────────────────────────────────────────────
type EdgeKey = string; // `${token}|${proto}|${action}`
const ekey = (t: string, p: string, a: FlowAction): EdgeKey => `${t}|${p}|${a}`;
const pkey = (t: string, p: string) => `${t}|${p}`;

interface Acc {
  buckets: Map<EdgeKey, number[]>;
  actors: Map<EdgeKey, Map<string, number>>;
  txc: Map<EdgeKey, Set<string>>;
  poolUsd: Map<string, number>;
  txActs: Map<string, { proto: string; actor: string; action: FlowAction; token: string; usd: number }[]>;
  untrackedUsd: number;
  recentStart: number;
  bucketSec: number; // 체인별 버킷 시간(bucketBlocks×blockSec≈300s)
}
function bucketsOf(acc: Acc, k: EdgeKey): number[] {
  let b = acc.buckets.get(k);
  if (!b) { b = new Array(N_BUCKETS).fill(0); acc.buckets.set(k, b); }
  return b;
}
function record(acc: Acc, token: string, proto: string, action: FlowAction, usd: number, evTime: number, headTime: number, actor: string, txHash: string) {
  const idx = N_BUCKETS - 1 - Math.floor((headTime - evTime) / acc.bucketSec);
  if (idx < 0 || idx >= N_BUCKETS) return;
  bucketsOf(acc, ekey(token, proto, action))[idx] += usd;
  if (evTime >= acc.recentStart) {
    const k = ekey(token, proto, action);
    const am = acc.actors.get(k) ?? acc.actors.set(k, new Map()).get(k)!;
    am.set(actor, (am.get(actor) ?? 0) + usd);
    (acc.txc.get(k) ?? acc.txc.set(k, new Set()).get(k)!).add(txHash);
  }
  const arr = acc.txActs.get(txHash) ?? [];
  arr.push({ proto, actor, action, token, usd });
  acc.txActs.set(txHash, arr);
}
const evTimeOf = (ctx: Ctx, l: Log) => ctx.headTime - (ctx.latest - parseInt(l.blockNumber, 16)) * ctx.blockSec;

// ── Aave 인스턴스 수집 (Spark 포크 포함 — 체인 공통 ABI) ───────────────────
async function collectAave(acc: Acc, ctx: Ctx) {
  await Promise.all(ctx.cfg.aave.map(async (inst) => {
    let logs: Log[];
    try {
      // 토픽 필터 필수 — Aave 풀은 ReserveDataUpdated 등 잡로그가 압도적(필터 없으면 큰 윈도우 체인 타임아웃)
      logs = await logsWindow(ctx, inst.addr, [Object.keys(AAVE_TOPIC)]);
    } catch (e) { ctx.errors.push(`${inst.name}: ${String(e).slice(0, 70)}`); return; }
    for (const l of logs) {
      const action = AAVE_TOPIC[l.topics[0]];
      if (!action || l.topics.length < 3) continue;
      const tok = ctx.reg.byAddr.get("0x" + l.topics[1].slice(-40).toLowerCase());
      if (!tok) continue;
      const w = (l.data.replace(/^0x/, "").match(/.{64}/g) ?? [])[AAVE_AMOUNT_WORD[action]];
      if (!w) continue;
      const usd = (Number(BigInt("0x" + w)) / 10 ** tok.decimals) * price(ctx, tok.sym);
      if (!(usd > 0)) continue;
      const actor = "0x" + (l.topics[2] ?? "").slice(-40).toLowerCase();
      record(acc, tok.sym, inst.name, action, usd, evTimeOf(ctx, l), ctx.headTime, actor, l.transactionHash);
    }
  }));
}

// ── Compound V3 수집 ───────────────────────────────────────────────────
async function collectCompound(acc: Acc, ctx: Ctx) {
  const comets = await resolveComets(ctx);
  await Promise.all(comets.map(async (comet) => {
    let logs: Log[];
    try {
      logs = await logsWindow(ctx, comet.addr, [Object.keys(COMPOUND_TOPIC)]);
    } catch (e) { ctx.errors.push(`Comet ${comet.baseSym}: ${String(e).slice(0, 60)}`); return; }
    for (const l of logs) {
      const map = COMPOUND_TOPIC[l.topics[0]];
      if (!map || l.topics.length < 3) continue;
      const tok = map.scope === "base" ? ctx.reg.bySym.get(comet.baseSym.toLowerCase()) : ctx.reg.byAddr.get("0x" + (l.topics[3] ?? "").slice(-40).toLowerCase());
      if (!tok) continue;
      const w = l.data.replace(/^0x/, "").slice(0, 64);
      if (!w) continue;
      const usd = (Number(BigInt("0x" + w)) / 10 ** tok.decimals) * price(ctx, tok.sym);
      if (!(usd > 0)) continue;
      const actor = "0x" + (l.topics[1] ?? "").slice(-40).toLowerCase();
      record(acc, tok.sym, COMPOUND_PROTO.name, map.action, usd, evTimeOf(ctx, l), ctx.headTime, actor, l.transactionHash);
    }
  }));
}

// ── Fluid 수집 — LogOperate 부호로 4액션 (동일주소 배포 확인 체인만) ─────────
function asSigned(word: string): bigint {
  const v = BigInt("0x" + word);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}
async function collectFluid(acc: Acc, ctx: Ctx) {
  if (!ctx.cfg.fluid) return;
  let logs: Log[];
  try {
    logs = await logsWindow(ctx, ctx.cfg.fluid, [FLUID_LOGOPERATE]);
  } catch (e) { ctx.errors.push(`Fluid: ${String(e).slice(0, 70)}`); return; }
  for (const l of logs) {
    if (l.topics.length < 3) continue;
    const tok = ctx.reg.byAddr.get("0x" + l.topics[2].slice(-40).toLowerCase());
    if (!tok) continue;
    const words = l.data.replace(/^0x/, "").match(/.{64}/g) ?? [];
    if (words.length < 2) continue;
    const p = price(ctx, tok.sym);
    if (!(p > 0)) continue;
    const evTime = evTimeOf(ctx, l);
    const actor = "0x" + l.topics[1].slice(-40).toLowerCase(); // 상위 프로토콜 컨트랙트 — 주체 과소집계(보수적)
    const sup = asSigned(words[0]!), bor = asSigned(words[1]!);
    const toUsd = (x: bigint) => (Number(x < 0n ? -x : x) / 10 ** tok.decimals) * p;
    if (sup !== 0n) record(acc, tok.sym, FLUID_PROTO.name, sup > 0n ? "supply" : "withdraw", toUsd(sup), evTime, ctx.headTime, actor, l.transactionHash);
    if (bor !== 0n) record(acc, tok.sym, FLUID_PROTO.name, bor > 0n ? "borrow" : "repay", toUsd(bor), evTime, ctx.headTime, actor, l.transactionHash);
  }
}

// ── Euler v2 수집 — 메인넷 전용(서브그래프 볼트 목록 + 온체인 로그) ─────────────
let eulerVaultCache: { ts: number; map: Map<string, string> } | null = null;
async function eulerVaults(errors: string[]): Promise<Map<string, string>> {
  if (eulerVaultCache && Date.now() - eulerVaultCache.ts < 6 * 3600_000) return eulerVaultCache.map;
  try {
    const r = await fetch(EULER_SUBGRAPH, { method: "POST", headers: HDRS, body: JSON.stringify({ query: "{ eulerVaults(first:1000){ id asset } }" }), cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const j = await r.json();
    const map = new Map<string, string>((j?.data?.eulerVaults ?? []).map((v: { id: string; asset: string }) => [v.id.toLowerCase(), v.asset.toLowerCase()]));
    if (map.size) eulerVaultCache = { ts: Date.now(), map };
    return map;
  } catch (e) { errors.push(`Euler vaults: ${String(e).slice(0, 60)}`); return eulerVaultCache?.map ?? new Map(); }
}
async function collectEuler(acc: Acc, ctx: Ctx) {
  if (!ctx.cfg.ethereumOnly?.euler) return;
  const vmap = await eulerVaults(ctx.errors);
  if (!vmap.size) return;
  let logs: Log[];
  try {
    logs = await logsWindow(ctx, [...vmap.keys()], [Object.keys(EULER_TOPIC)], { rpcs: arrayRpcs(ctx.cfg) });
  } catch (e) { ctx.errors.push(`Euler logs: ${String(e).slice(0, 70)}`); return; }
  for (const l of logs) {
    const map = EULER_TOPIC[l.topics[0]];
    if (!map) continue;
    const asset = vmap.get(l.address.toLowerCase());
    const tok = asset ? ctx.reg.byAddr.get(asset) : undefined;
    if (!tok) continue;
    const w = l.data.replace(/^0x/, "").slice(0, 64);
    if (!w) continue;
    const usd = (Number(BigInt("0x" + w)) / 10 ** tok.decimals) * price(ctx, tok.sym);
    if (!(usd > 0)) continue;
    const actor = "0x" + (l.topics[map.actorTopic] ?? "").slice(-40).toLowerCase();
    record(acc, tok.sym, EULER_PROTO.name, map.action, usd, evTimeOf(ctx, l), ctx.headTime, actor, l.transactionHash);
  }
}

// ── Uniswap V3 수집 — 팩토리 유도 풀(레지스트리 × 쿼트), Swap 부호로 매도/매수 ──
const univ3Cache = new Map<string, { ts: number; pools: Map<string, { t0: TokenInfo; t1: TokenInfo }> }>();
async function univ3Pools(ctx: Ctx): Promise<Map<string, { t0: TokenInfo; t1: TokenInfo }>> {
  const cfg = ctx.cfg;
  if (!cfg.univ3Factory) return new Map();
  const c = univ3Cache.get(cfg.key);
  if (c && Date.now() - c.ts < 6 * 3600_000) return c.pools;
  // 쿼트 = 레지스트리에서 메이저 심볼 해석(체인별 자동 — 손 주소 0)
  const quotes = ctx.reg.list.filter((t) => UNIV3_QUOTE_SYMS.has(t.sym.toUpperCase()));
  const pairs: { a: TokenInfo; b: TokenInfo }[] = [];
  const seen = new Set<string>();
  for (const t of ctx.reg.list) {
    if (t.sym === "ETH") continue; // 네이티브(0xeee…)는 ERC20 풀 없음
    for (const m of quotes) {
      if (t.sym === m.sym) continue;
      const k = [t.addr, m.addr].sort().join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push({ a: t, b: m });
    }
  }
  const calls: { pair: { a: TokenInfo; b: TokenInfo }; data: string }[] = [];
  for (const pair of pairs) for (const fee of UNIV3_FEE_TIERS) {
    const data = UNIV3_GETPOOL_SEL + pair.a.addr.slice(2).padStart(64, "0") + pair.b.addr.slice(2).padStart(64, "0") + fee.toString(16).padStart(64, "0");
    calls.push({ pair, data });
  }
  const pools = new Map<string, { t0: TokenInfo; t1: TokenInfo }>();
  try {
    for (let i = 0; i < calls.length; i += 150) {
      const chunk = calls.slice(i, i + 150);
      const body = chunk.map((c2, j) => ({ jsonrpc: "2.0", id: j, method: "eth_call", params: [{ to: cfg.univ3Factory, data: c2.data }, "latest"] }));
      const r = await fetch(cfg.rpcs[0], { method: "POST", headers: HDRS, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const arr = await r.json();
      if (!Array.isArray(arr)) throw new Error("batch eth_call 실패");
      for (const item of arr) {
        const pool = "0x" + String(item.result ?? "").slice(-40);
        if (!/^0x[0-9a-f]{40}$/.test(pool) || /^0x0{40}$/.test(pool)) continue;
        const { a, b } = chunk[item.id].pair;
        const [t0, t1] = a.addr < b.addr ? [a, b] : [b, a]; // Uniswap 규칙: token0 = 작은 주소
        pools.set(pool, { t0, t1 });
      }
    }
    if (pools.size) univ3Cache.set(cfg.key, { ts: Date.now(), pools });
  } catch (e) { ctx.errors.push(`UniV3 pools: ${String(e).slice(0, 60)}`); return univ3Cache.get(cfg.key)?.pools ?? new Map(); }
  return pools;
}
async function collectUniswap(acc: Acc, ctx: Ctx) {
  if (!ctx.cfg.univ3Factory) return;
  const pools = await univ3Pools(ctx);
  if (!pools.size) return;
  // 스왑 밀도 대응 — 시간 균등 청크(≈45분/청크, 체인 blockSec 무관). 실패 청크는 기록하고 계속(tolerant).
  const timeChunks = Math.max(4, Math.ceil((ctx.windowBlocks * ctx.blockSec) / 2700));
  const all = await logsWindow(ctx, [...pools.keys()], [UNIV3_SWAP_TOPIC], { minChunks: timeChunks, rpcs: arrayRpcs(ctx.cfg), tolerant: "UniV3", addrLimit: ctx.cfg.key === "ethereum" ? undefined : PUBLICNODE_ADDR_LIMIT });
  for (const l of all) {
    const p = pools.get(l.address.toLowerCase());
    if (!p || l.topics.length < 3) continue;
    const words = l.data.replace(/^0x/, "").match(/.{64}/g) ?? [];
    if (words.length < 2) continue;
    const evTime = evTimeOf(ctx, l);
    const actor = "0x" + l.topics[2].slice(-40).toLowerCase(); // recipient — 대부분 라우터(분류 제외)
    for (const [tok, w] of [[p.t0, words[0]!], [p.t1, words[1]!]] as const) {
      const amt = asSigned(w);
      if (amt === 0n) continue;
      const usd = (Number(amt < 0n ? -amt : amt) / 10 ** tok.decimals) * price(ctx, tok.sym);
      if (!(usd > 0)) continue;
      record(acc, tok.sym, UNIV3_PROTO.name, amt > 0n ? "sell" : "buy", usd, evTime, ctx.headTime, actor, l.transactionHash);
    }
  }
}

// ── Balancer V2 수집 — Vault 싱글톤(토픽에 tokenIn/Out 직접) ──────────────
async function collectBalancer(acc: Acc, ctx: Ctx) {
  if (!ctx.cfg.balancerVault) return;
  let logs: Log[];
  try {
    logs = await logsWindow(ctx, ctx.cfg.balancerVault, [BALANCER_SWAP_TOPIC]);
  } catch (e) { ctx.errors.push(`Balancer: ${String(e).slice(0, 60)}`); return; }
  for (const l of logs) {
    if (l.topics.length < 4) continue;
    const words = l.data.replace(/^0x/, "").match(/.{64}/g) ?? [];
    if (words.length < 2) continue;
    const evTime = evTimeOf(ctx, l);
    const actor = "0x" + l.topics[1].slice(-40);
    const legs = [
      { tok: ctx.reg.byAddr.get("0x" + l.topics[2].slice(-40).toLowerCase()), w: words[0]!, action: "sell" as const },
      { tok: ctx.reg.byAddr.get("0x" + l.topics[3].slice(-40).toLowerCase()), w: words[1]!, action: "buy" as const },
    ];
    for (const { tok, w, action } of legs) {
      if (!tok) continue;
      const usd = (Number(BigInt("0x" + w)) / 10 ** tok.decimals) * price(ctx, tok.sym);
      if (usd > 0) record(acc, tok.sym, BALANCER_PROTO.name, action, usd, evTime, ctx.headTime, actor, l.transactionHash);
    }
  }
}

// ── Uniswap V4 수집 — 메인넷 전용(PoolManager 전이력 Initialize 인덱스) ─────
let univ4PoolCache: { ts: number; map: Map<string, { t0: TokenInfo; t1: TokenInfo }> } | null = null;
async function univ4Pools(ctx: Ctx): Promise<Map<string, { t0: TokenInfo; t1: TokenInfo }>> {
  if (univ4PoolCache && Date.now() - univ4PoolCache.ts < 6 * 3600_000) return univ4PoolCache.map;
  const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
  const regPadded = [...ctx.reg.list.filter((t) => t.sym !== "ETH").map((t) => pad(t.addr)), pad(ZERO_ADDR)];
  try {
    const logs = await rpc<Log[]>("eth_getLogs", [{ address: UNIV4_ADDR, fromBlock: "0x0", toBlock: "latest", topics: [UNIV4_INIT_TOPIC, null, regPadded, regPadded] }], arrayRpcs(ctx.cfg));
    const map = new Map<string, { t0: TokenInfo; t1: TokenInfo }>();
    const ethTok = ctx.reg.bySym.get("eth");
    for (const l of logs) {
      const a0 = "0x" + l.topics[2].slice(-40).toLowerCase(), a1 = "0x" + l.topics[3].slice(-40).toLowerCase();
      const t0 = a0 === ZERO_ADDR ? ethTok : ctx.reg.byAddr.get(a0);
      const t1 = a1 === ZERO_ADDR ? ethTok : ctx.reg.byAddr.get(a1);
      if (t0 && t1) map.set(l.topics[1], { t0, t1 });
    }
    if (map.size) univ4PoolCache = { ts: Date.now(), map };
    return map;
  } catch (e) { ctx.errors.push(`UniV4 pools: ${String(e).slice(0, 60)}`); return univ4PoolCache?.map ?? new Map(); }
}
async function collectUniV4(acc: Acc, ctx: Ctx) {
  if (!ctx.cfg.ethereumOnly?.univ4) return;
  const pools = await univ4Pools(ctx);
  if (!pools.size) return;
  const logs = await logsWindow(ctx, UNIV4_ADDR, [UNIV4_SWAP_TOPIC], { minChunks: 3, tolerant: "UniV4" });
  for (const l of logs) {
    const p = pools.get(l.topics[1]);
    if (!p) continue; // 레지스트리-페어 풀만
    const words = l.data.replace(/^0x/, "").match(/.{64}/g) ?? [];
    if (words.length < 2) continue;
    const evTime = evTimeOf(ctx, l);
    const actor = "0x" + l.topics[2].slice(-40).toLowerCase();
    for (const [tok, w] of [[p.t0, words[0]!], [p.t1, words[1]!]] as const) {
      const amt = asSigned(w);
      if (amt === 0n) continue;
      const usd = (Number(amt < 0n ? -amt : amt) / 10 ** tok.decimals) * price(ctx, tok.sym);
      // V4 부호 실증: >0 = 풀에서 유출(매수), <0 = 풀로 유입(매도) — V3 와 반대!
      if (usd > 0) record(acc, tok.sym, UNIV4_PROTO.name, amt > 0n ? "buy" : "sell", usd, evTime, ctx.headTime, actor, l.transactionHash);
    }
  }
}

// ── Curve 수집 — 공식 API 풀 목록(체인 슬러그), TokenExchange 두 변형 ─────────
interface CurveCoin { sym: string; decimals: number }
const curveCache = new Map<string, { ts: number; pools: Map<string, CurveCoin[]> }>();
async function curvePools(ctx: Ctx): Promise<Map<string, CurveCoin[]>> {
  const cfg = ctx.cfg;
  if (!cfg.curveSlug) return new Map();
  const c = curveCache.get(cfg.key);
  if (c && Date.now() - c.ts < 6 * 3600_000) return c.pools;
  const pools = new Map<string, CurveCoin[]>();
  try {
    await Promise.all(CURVE_API_REGISTRIES.map(async (reg) => {
      const r = await fetch(`https://api.curve.finance/api/getPools/${cfg.curveSlug}/${reg}`, { headers: { "user-agent": HDRS["user-agent"] }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return; // 체인에 없는 레지스트리 — 정상 스킵
      const j = await r.json();
      for (const p of j?.data?.poolData ?? []) {
        if (!((p.usdTotal ?? 0) >= 300_000)) continue;
        const coins: CurveCoin[] = (p.coins ?? []).map((cc: { address?: string; decimals?: string | number }) => {
          const tok = ctx.reg.byAddr.get((cc.address ?? "").toLowerCase());
          return { sym: tok?.sym ?? "", decimals: Number(cc.decimals ?? 18) };
        });
        if (coins.some((cc) => cc.sym)) pools.set(String(p.address).toLowerCase(), coins);
      }
    }));
    if (pools.size) curveCache.set(cfg.key, { ts: Date.now(), pools });
  } catch (e) { ctx.errors.push(`Curve pools: ${String(e).slice(0, 60)}`); return curveCache.get(cfg.key)?.pools ?? new Map(); }
  return pools;
}
async function collectCurve(acc: Acc, ctx: Ctx) {
  if (!ctx.cfg.curveSlug) return;
  const pools = await curvePools(ctx);
  if (!pools.size) return;
  let logs: Log[];
  try {
    logs = await logsWindow(ctx, [...pools.keys()], [[...CURVE_TE_TOPICS]], { rpcs: arrayRpcs(ctx.cfg), addrLimit: ctx.cfg.key === "ethereum" ? undefined : PUBLICNODE_ADDR_LIMIT });
  } catch (e) { ctx.errors.push(`Curve logs: ${String(e).slice(0, 60)}`); return; }
  for (const l of logs) {
    const coins = pools.get(l.address.toLowerCase());
    if (!coins) continue;
    const words = l.data.replace(/^0x/, "").match(/.{64}/g) ?? [];
    if (words.length < 4) continue; // [sold_id, tokens_sold, bought_id, tokens_bought]
    const evTime = evTimeOf(ctx, l);
    const actor = "0x" + (l.topics[1] ?? "").slice(-40).toLowerCase();
    const legs = [
      { coin: coins[Number(BigInt("0x" + words[0]!))], w: words[1]!, action: "sell" as const },
      { coin: coins[Number(BigInt("0x" + words[2]!))], w: words[3]!, action: "buy" as const },
    ];
    for (const { coin, w, action } of legs) {
      if (!coin?.sym) continue;
      const usd = (Number(BigInt("0x" + w)) / 10 ** coin.decimals) * price(ctx, coin.sym);
      if (usd > 0) record(acc, coin.sym, CURVE_PROTO.name, action, usd, evTime, ctx.headTime, actor, l.transactionHash);
    }
  }
}

// ── Morpho 수집 (GraphQL — chainId 파라미터) ──────────────────────────────
interface MorphoTx {
  hash: string; type: string; timestamp: number; user: { address: string };
  data: { assetsUsd: number | null; market: { loanAsset: { symbol: string } | null; collateralAsset: { symbol: string } | null; state: { supplyAssetsUsd: number | null; collateralAssetsUsd: number | null } | null } | null } | null;
}
const MORPHO_ACTION: Record<string, { action: FlowAction; side: "loan" | "collat" }> = {
  MarketSupply: { action: "supply", side: "loan" }, MarketWithdraw: { action: "withdraw", side: "loan" },
  MarketBorrow: { action: "borrow", side: "loan" }, MarketRepay: { action: "repay", side: "loan" },
  MarketSupplyCollateral: { action: "supply", side: "collat" }, MarketWithdrawCollateral: { action: "withdraw", side: "collat" },
};
async function collectMorpho(acc: Acc, ctx: Ctx) {
  if (!ctx.cfg.morpho) return;
  const since = Math.floor(ctx.headTime - ctx.windowBlocks * ctx.blockSec);
  const all: MorphoTx[] = [];
  let truncated = false;
  try {
    const MAX_PAGES = 8;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = `{ transactions(first:1000, skip:${page * 1000}, orderBy:Timestamp, orderDirection:Desc, where:{ chainId_in:[${ctx.cfg.chainId}], timestamp_gte:${since}, timestamp_lte:${Math.floor(ctx.headTime)}, type_in:[MarketSupply,MarketWithdraw,MarketBorrow,MarketRepay,MarketSupplyCollateral,MarketWithdrawCollateral] }){ items{ hash type timestamp user{address} data{ ... on MarketTransferTransactionData{ assetsUsd market{ loanAsset{symbol} collateralAsset{symbol} state{ supplyAssetsUsd collateralAssetsUsd } } } ... on MarketCollateralTransferTransactionData{ assetsUsd market{ loanAsset{symbol} collateralAsset{symbol} state{ supplyAssetsUsd collateralAssetsUsd } } } } } } }`;
      const r = await fetch(MORPHO_GQL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }), cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 120));
      const items: MorphoTx[] = j?.data?.transactions?.items ?? [];
      all.push(...items);
      if (items.length < 1000) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
  } catch (e) { ctx.errors.push(`Morpho: ${String(e).slice(0, 80)}`); return; }
  if (truncated) ctx.errors.push(`Morpho 윈도우 잘림 — Morpho baseline 부정확 가능`);

  for (const t of all) {
    const map = MORPHO_ACTION[t.type];
    const usd = t.data?.assetsUsd ?? 0;
    const mkt = t.data?.market;
    if (!map || !(usd > 0) || !mkt) continue;
    const symRaw = map.side === "loan" ? mkt.loanAsset?.symbol : mkt.collateralAsset?.symbol;
    const tok = symRaw ? ctx.reg.bySym.get(symRaw.toLowerCase()) : undefined;
    if (!tok) { acc.untrackedUsd += usd; continue; }
    record(acc, tok.sym, MORPHO_PROTO.name, map.action, usd, t.timestamp, ctx.headTime, t.user.address.toLowerCase(), t.hash);
    const pool = map.side === "loan" ? mkt.state?.supplyAssetsUsd : mkt.state?.collateralAssetsUsd;
    if (pool && pool > 0) acc.poolUsd.set(pkey(tok.sym, MORPHO_PROTO.name), Math.max(acc.poolUsd.get(pkey(tok.sym, MORPHO_PROTO.name)) ?? 0, pool));
  }
}

// ── tx 페어링: (supply+borrow)=레버 / (repay+withdraw)=언와인드 ──
function pairLevers(acc: Acc): { levers: LeverOut[]; unwinds: LeverOut[] } {
  const lever = new Map<string, LeverOut>(), unwind = new Map<string, LeverOut>();
  for (const acts of acc.txActs.values()) {
    if (acts.length < 2) continue;
    const byGroup = new Map<string, typeof acts>();
    for (const a of acts) byGroup.set(`${a.proto}|${a.actor}`, [...(byGroup.get(`${a.proto}|${a.actor}`) ?? []), a]);
    for (const group of byGroup.values()) {
      const sup = group.filter((a) => a.action === "supply"), bor = group.filter((a) => a.action === "borrow");
      const rep = group.filter((a) => a.action === "repay"), wit = group.filter((a) => a.action === "withdraw");
      for (const b of bor) {
        if (b.usd < LEVER_MIN_USD) continue;
        const s = sup.filter((x) => x.token !== b.token).sort((x, y) => y.usd - x.usd)[0];
        if (!s) continue;
        const k = `${s.token}|${s.proto}|${b.token}`;
        const e = lever.get(k) ?? { collat: s.token, proto: s.proto, debt: b.token, usd: 0, count: 0 };
        e.usd += b.usd; e.count += 1; lever.set(k, e);
      }
      for (const r of rep) {
        if (r.usd < LEVER_MIN_USD) continue;
        const w = wit.filter((x) => x.token !== r.token).sort((x, y) => y.usd - x.usd)[0];
        if (!w) continue;
        const k = `${w.token}|${r.proto}|${r.token}`;
        const e = unwind.get(k) ?? { collat: w.token, proto: r.proto, debt: r.token, usd: 0, count: 0 };
        e.usd += r.usd; e.count += 1; unwind.set(k, e);
      }
    }
  }
  const top = (m: Map<string, LeverOut>) => [...m.values()].sort((a, b) => b.usd - a.usd).slice(0, 8);
  return { levers: top(lever), unwinds: top(unwind) };
}

// 체인별 흐름 디코딩 프로토콜 목록(링 고정 렌더 순서)
function protosFor(cfg: FlowChain): { name: string; slug: string }[] {
  const out: { name: string; slug: string }[] = cfg.aave.map((i) => ({ name: i.name, slug: i.slug }));
  if (cfg.morpho) out.push({ ...MORPHO_PROTO });
  if (cfg.comets.length) out.push({ ...COMPOUND_PROTO });
  if (cfg.fluid) out.push({ ...FLUID_PROTO });
  if (cfg.ethereumOnly?.euler) out.push({ ...EULER_PROTO });
  if (cfg.univ3Factory) out.push({ ...UNIV3_PROTO });
  if (cfg.ethereumOnly?.univ4) out.push({ ...UNIV4_PROTO });
  if (cfg.curveSlug) out.push({ ...CURVE_PROTO });
  if (cfg.balancerVault) out.push({ ...BALANCER_PROTO });
  return out;
}

// ── 본체 ───────────────────────────────────────────────────────────────
async function build(cfg: FlowChain, atTs?: number): Promise<FlowMapData> {
  const errors: string[] = [];
  const latestHex = await rpc<string>("eth_blockNumber", [], cfg.rpcs);
  let latest = parseInt(latestHex, 16);
  const blockSec = await blockSecOf(cfg, latest);
  // 버킷 72개 고정, 버킷 ≈5분 → 윈도우 ≈6h 를 체인 블록수로 환산 (메인넷: 25×72=1800 — 기존과 동일)
  const bucketBlocks = Math.max(2, Math.round(300 / blockSec));
  const windowBlocks = bucketBlocks * N_BUCKETS;

  let headTime: number;
  if (atTs) {
    const headNow = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [latestHex, false], cfg.rpcs);
    const nowT = parseInt(headNow.timestamp, 16);
    latest = Math.max(1, latest - Math.floor((nowT - atTs) / blockSec));
    const blk = await rpc<{ timestamp: string }>("eth_getBlockByNumber", ["0x" + latest.toString(16), false], cfg.rpcs);
    headTime = parseInt(blk.timestamp, 16);
  } else {
    const blk = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [latestHex, false], cfg.rpcs);
    headTime = parseInt(blk.timestamp, 16);
  }
  const reg = await registryFor(cfg, errors);
  const ctx: Ctx = { cfg, latest, headTime, blockSec, windowBlocks, bucketBlocks, reg, errors };
  const bucketSec = bucketBlocks * blockSec;
  const recentStart = headTime - (RECENT_BUCKETS + 1) * bucketSec;
  const recentEnd = headTime - bucketSec;
  const acc: Acc = { buckets: new Map(), actors: new Map(), txc: new Map(), poolUsd: new Map(), txActs: new Map(), untrackedUsd: 0, recentStart, bucketSec };

  await Promise.all([
    collectAave(acc, ctx),
    collectCompound(acc, ctx),
    collectMorpho(acc, ctx),
    collectFluid(acc, ctx),
    collectEuler(acc, ctx),
    collectUniswap(acc, ctx),
    collectUniV4(acc, ctx),
    collectCurve(acc, ctx),
    collectBalancer(acc, ctx),
  ]);

  // 엣지 산출 + 분류 (체인 공통 — 검증된 게이트 그대로)
  const tokenTotal = new Map<string, number>();
  const edgesRaw: (FlowEdgeOut & { _buckets: number[] })[] = [];
  for (const [k, buckets] of acc.buckets) {
    const [token, proto, action] = k.split("|") as [string, string, FlowAction];
    const windowUsd = buckets.reduce((s, x) => s + x, 0);
    if (!(windowUsd > 0)) continue;
    tokenTotal.set(token, (tokenTotal.get(token) ?? 0) + windowUsd);
    const st = anomalyStat(buckets);
    const am = acc.actors.get(k);
    const actors = am?.size ?? 0;
    const actorTot = am ? [...am.values()].reduce((s, x) => s + x, 0) : 0;
    const topShare = am && actorTot > 0 ? Math.max(...am.values()) / actorTot : 0;
    const txCount = acc.txc.get(k)?.size ?? 0;
    const poolUsd = acc.poolUsd.get(pkey(token, proto)) ?? 0;
    const pctPool = poolUsd > 0 ? st.recentUsd / poolUsd : 0;
    const isDex = DEX_PROTOS.has(proto);
    const statUnusual = st.z >= Z_TH && st.baseUsd > 0;
    const systemic = !isDex && statUnusual && actors >= MIN_ACTORS && topShare <= TOP_ACTOR_MAX && st.recentUsd >= SYSTEMIC_MIN_USD;
    const whale = !systemic && (isDex
      ? (statUnusual && st.recentUsd >= WHALE_MIN_USD)
      : actors > 0 && (topShare > TOP_ACTOR_MAX || actors <= 3) && (st.recentUsd >= WHALE_MIN_USD || (pctPool >= MATERIAL_PCT && st.recentUsd >= MIN_USD)));
    const kind: FlowKind = systemic ? "systemic" : whale ? "whale" : "normal";
    edgesRaw.push({ token, proto, action, dir: ACTION_DIR[action], recentUsd: st.recentUsd, baseUsd: st.baseUsd, baseMaxUsd: st.baseMaxUsd, z: st.z, ratio: st.ratio, share: 0, windowUsd, actors, topShare, txCount, poolUsd, pctPool, kind, anomalous: systemic, _buckets: buckets });
  }
  for (const e of edgesRaw) e.share = e.windowUsd / (tokenTotal.get(e.token) || 1);
  const edges: FlowEdgeOut[] = edgesRaw
    .filter((e) => e.share >= SHARE_MIN || e.kind !== "normal")
    .map(({ _buckets, ...e }) => { void _buckets; return e; })
    .sort((a, b) => b.recentUsd - a.recentUsd);

  // 토큰 노드 — 레지스트리 전체 항상(메인넷 59 고정 / 그 외 동적·정렬 안정)
  const tokAgg = new Map<string, FlowTokenOut>();
  for (const info of reg.list) tokAgg.set(info.sym, { sym: info.sym, addr: info.addr, group: info.group, inUsd: 0, outUsd: 0, anomalous: false });
  for (const e of edgesRaw) {
    const t = tokAgg.get(e.token); if (!t) continue;
    if (e.dir === "in") t.inUsd += e.windowUsd; else t.outUsd += e.windowUsd;
    t.anomalous ||= e.kind === "systemic";
  }
  const groupOrder = { eth: 0, btc: 1, stable: 2, other: 3 } as const;
  const regOrder = new Map(reg.list.map((t, i) => [t.sym, i]));
  const tokens = [...tokAgg.values()].sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || (regOrder.get(a.sym) ?? 99) - (regOrder.get(b.sym) ?? 99));

  // 프로토콜 노드 — 체인 지원 전체 항상
  const supported = protosFor(cfg);
  const protoOutSeries = new Map<string, number[]>();
  const protoAgg = new Map<string, FlowProtoOut>();
  for (const p of supported) protoAgg.set(p.name, { name: p.name, slug: p.slug, inUsd: 0, outUsd: 0, outZ: 0, state: "ok" });
  const systemicByProto = new Set(edges.filter((e) => e.kind === "systemic").map((e) => e.proto));
  for (const e of edgesRaw) {
    const p = protoAgg.get(e.proto) ?? { name: e.proto, slug: supported.find((s) => s.name === e.proto)?.slug ?? "aave-v3", inUsd: 0, outUsd: 0, outZ: 0, state: "ok" as const };
    if (e.dir === "in") p.inUsd += e.windowUsd; else p.outUsd += e.windowUsd;
    protoAgg.set(e.proto, p);
    if (e.dir === "out") {
      let s = protoOutSeries.get(e.proto);
      if (!s) { s = new Array(N_BUCKETS).fill(0); protoOutSeries.set(e.proto, s); }
      for (let i = 0; i < N_BUCKETS; i++) s[i] += e._buckets[i];
    }
  }
  for (const [name, series] of protoOutSeries) {
    const st = anomalyStat(series);
    const p = protoAgg.get(name)!;
    p.outZ = st.z;
    p.state = systemicByProto.has(name) ? "danger" : st.z >= 2 && st.baseUsd > 0 && st.recentUsd >= MIN_USD ? "warn" : "ok";
  }
  const supIdx = new Map(supported.map((p, i) => [p.name, i]));
  const protocols = [...protoAgg.values()].sort((a, b) => (supIdx.get(a.name) ?? 99) - (supIdx.get(b.name) ?? 99));

  const { levers, unwinds } = pairLevers(acc);

  // 에러 중복 정리(같은 메시지 청크 반복) + 상한 — 정직성 유지하되 페이로드 오염 방지
  const dedupErr = [...new Set(errors)];
  const errOut = dedupErr.length > 12 ? [...dedupErr.slice(0, 12), `… 외 ${dedupErr.length - 12}건`] : dedupErr;

  return {
    meta: {
      chain: cfg.key, chainId: cfg.chainId, chainLabel: cfg.label, blockSec: Math.round(blockSec * 1000) / 1000,
      latestBlock: latest, headTime, windowBlocks, bucketBlocks, recentBuckets: RECENT_BUCKETS,
      recentStartSec: recentStart, recentEndSec: recentEnd,
      fetchedAt: Math.floor(Date.now() / 1000), protocols: protocols.map((p) => p.name), minUsd: MIN_USD, minActors: MIN_ACTORS,
      untrackedUsd: Math.round(acc.untrackedUsd), historical: atTs ? latest : undefined,
      errors: errOut.length ? errOut : undefined,
    },
    tokens, protocols, edges, levers, unwinds,
  };
}

// ── 캐시(체인별) + summary — stale-while-revalidate ──────────────────────
// 무거운 체인(base UniV3 ~100s)도 사용자는 항상 즉답: 스냅샷이 있으면 그걸 주고 뒤에서 갱신.
const CHAIN_TTL = 120_000;       // 보고 있는 체인 갱신 주기
const SUMMARY_REFRESH = 300_000; // summary 가 트리거하는 백그라운드 수집 주기(13체인 — 퍼블릭 RPC 예의)
const cache = new Map<string, { ts: number; data: FlowMapData }>();
const inflight = new Map<string, Promise<FlowMapData>>();

function kick(cfg: FlowChain): Promise<FlowMapData> {
  let p = inflight.get(cfg.key);
  if (!p) {
    p = build(cfg)
      .then((data) => { cache.set(cfg.key, { ts: Date.now(), data }); return data; })
      .finally(() => { inflight.delete(cfg.key); });
    inflight.set(cfg.key, p);
  }
  return p;
}

function summarize(): FlowSummary {
  const chains: FlowSummaryChain[] = FLOW_CHAINS.map((cfg) => {
    const c = cache.get(cfg.key);
    if (!c) {
      kick(cfg).catch(() => {}); // 미수집 체인 — 백그라운드 수집 시작(즉답은 collecting)
      return { key: cfg.key, label: cfg.label, chainId: cfg.chainId, status: "collecting" as const, fetchedAt: null, systemic: 0, whale: 0, levers: 0, topAnomaly: null };
    }
    if (Date.now() - c.ts > SUMMARY_REFRESH) kick(cfg).catch(() => {}); // 신선도 유지(stale-while-revalidate)
    const sys = c.data.edges.filter((e) => e.kind === "systemic");
    const whales = c.data.edges.filter((e) => e.kind === "whale");
    const top = sys[0] ?? whales[0] ?? null;
    return {
      key: cfg.key, label: cfg.label, chainId: cfg.chainId, status: "ready" as const, fetchedAt: c.data.meta.fetchedAt,
      systemic: sys.length, whale: whales.length, levers: c.data.levers.length,
      topAnomaly: top ? { token: top.token, proto: top.proto, action: top.action, usd: top.recentUsd, z: top.z } : null,
    };
  });
  return { chains };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("summary") === "1") return NextResponse.json(summarize());

  const chainKey = url.searchParams.get("chain") ?? "ethereum";
  const cfg = FLOW_CHAIN_BY_KEY[chainKey];
  if (!cfg) return NextResponse.json({ error: `지원하지 않는 체인: ${chainKey}` }, { status: 400 });

  const ts = Number(url.searchParams.get("ts")) || undefined;
  if (ts) {
    try { return NextResponse.json(await build(cfg, ts)); }
    catch (e) { return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 502 }); }
  }
  const c = cache.get(cfg.key);
  if (c) {
    if (Date.now() - c.ts >= CHAIN_TTL) kick(cfg).catch(() => {}); // 뒤에서 갱신 — 응답은 즉시
    return NextResponse.json(c.data);
  }
  try {
    return NextResponse.json(await kick(cfg)); // 첫 수집만 대기
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 502 });
  }
}
