import pg from "pg";

import { aerodromePoolsFor } from "./aerodrome-pools";
import { centrifugeEscrows } from "./centrifuge-escrows";
import { curveL2PoolsFor } from "./curve-l2-pools";
import { curvePoolsFor } from "./curve-pools";
import { dexForkPoolsFor } from "./dex-fork-pools";
import { topTokensByTvl } from "./flow-core";
import { compoundComets, compoundV2Markets, lendingReceiptAddrs, MORPHO_BLUE, UNISWAP_V4_POOL_MANAGER, wrappedUnderlying } from "./lending-pools";
import { mimswapPoolsFor } from "./mimswap-pools";
import { gatedJsonRpc } from "./rpc-gate";
import { uniswapPoolsFor } from "./uniswap-pools";

/**
 * 카운터파티 레지스트리 — /api/transactions(실시간 30분 트랜잭션 피드)의 매칭 모듈.
 * 원칙: 하드코딩 프로토콜 명단·이름 휴리스틱 없음,
 * 온체인으로 해석되는 실주소(CREATE2 풀·MetaRegistry·aToken·Comet·싱글톤)와 클라이언트가 넘긴
 * 그래프 노드 주소만 매칭한다. 미해석 = 라벨 없음 (거짓 라벨 0, 거짓 음성만 허용).
 */

// 팀 확정(2026-06-12): 이더리움 · Base · Arbitrum 3개만 — 타깃 파싱이 이 키 집합으로 게이트된다.
export const ALCHEMY_NET: Record<string, string> = {
  ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet",
};
// coins.llama.fi 가격 키의 체인 슬러그
export const CHAIN_PREFIX: Record<string, string> = {
  ethereum: "ethereum", base: "base", arbitrum: "arbitrum",
};

export const BUILTIN_TOKEN: Record<string, Record<string, string>> = {
  ethereum: {
    STETH: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", WSTETH: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    WEETH: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", WBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    USDE: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7", DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
  },
};
export const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const DATABASE_URL = process.env.DATABASE_URL;
const KEY = process.env.ALCHEMY_API_KEY;

let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  return _pool;
}

export interface CpTarget { token: string; chain: string; addr: string }

/**
 * address → structure-node label, straight from the DB nodes (real markets/vaults that carry an
 * address). Keys are `${chain}:${addr}` — the DB topology is mainnet-anchored, so these labels
 * apply to ethereum ONLY (the same address on another chain can be an unrelated contract).
 */
// DB 노드 라벨 ↔ 레지스트리 슬러그 정규화 — 같은 프로토콜이 "Curve"(DB)·"curve"(레지스트리) 두
// 버킷으로 갈라져 표시되던 흠 통일(색칠·라우팅은 resolver norm-매칭이라 원래 정상, 표시만 정리).
const LABEL_CANON: Record<string, string> = {
  "curve": "curve-dex", "morpho blue": "morpho-blue", "compound v3": "compound-v3",
  "compound": "compound-v3", "balancer": "balancer-v2",
};
const canonLabel = (l: string) => LABEL_CANON[l.toLowerCase().trim()] ?? l;

async function knownCounterparties(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const p = pool();
  if (p) {
    try {
      const r = await p.query<{ label: string; address: string }>(
        `SELECT label, address FROM nodes WHERE address IS NOT NULL AND type <> 'Token'`,
      );
      for (const row of r.rows) if (/^0x[0-9a-fA-F]{40}$/.test(row.address)) out.set(`ethereum:${row.address.toLowerCase()}`, canonLabel(row.label));
    } catch { /* ignore */ }
  }
  return out;
}

/** fallback symbol→address resolution (when the client didn't pass addrs) */
export async function resolveAddresses(symbols: string[], chain: string): Promise<{ token: string; addr: string }[]> {
  const out: { token: string; addr: string }[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    const a = BUILTIN_TOKEN[chain]?.[s.toUpperCase()];
    if (a) { out.push({ token: s, addr: a.toLowerCase() }); seen.add(s); }
  }
  const missing = symbols.filter((s) => !seen.has(s));
  const p = pool();
  if (p && missing.length && chain === "ethereum") {
    try {
      const r = await p.query<{ label: string; address: string }>(`SELECT label, address FROM nodes WHERE type='Token' AND address IS NOT NULL`);
      const bySym = new Map(r.rows.map((row) => [row.label.toUpperCase(), row.address.toLowerCase()] as const));
      for (const s of missing) { const a = bySym.get(s.toUpperCase()); if (a) out.push({ token: s, addr: a }); }
    } catch { /* ignore */ }
  }
  return out;
}

// Real top-TVL token addresses (with symbols) to use as pool "quote" partners. The ranked symbol
// list is real (DeFiLlama TVL) and the addresses come from the DB token nodes — no hardcoded list.
// Cached ~10 min so the 30s tx poll doesn't re-fetch DeFiLlama every time.
let _quoteCache: { at: number; quotes: { token: string; addr: string }[] } | null = null;
async function quoteAddrs(): Promise<{ token: string; addr: string }[]> {
  if (_quoteCache && Date.now() - _quoteCache.at < 10 * 60 * 1000) return _quoteCache.quotes;
  try {
    const top = await topTokensByTvl(30);
    const resolved = await resolveAddresses(top.map((t) => t.symbol), "ethereum");
    _quoteCache = { at: Date.now(), quotes: resolved };
    return resolved;
  } catch { return _quoteCache?.quotes ?? []; }
}

/** prices keyed `${chain}:${addr}` — 슬러그를 모르는 체인은 조회 자체를 생략 (이더리움 키로 다른 토큰
 *  가격을 가져다 붙이는 조작 금지), 같은 주소가 체인마다 다른 토큰인 경우도 섞이지 않는다. */
export async function fetchPrices(items: { chain: string; addr: string }[]): Promise<Map<string, { price: number; decimals: number | null }>> {
  const out = new Map<string, { price: number; decimals: number | null }>();
  const wanted = items.filter(({ chain }) => CHAIN_PREFIX[chain]);
  if (!wanted.length) return out;
  const byLlamaKey = new Map<string, string>(); // lowercase(llama key) → `${chain}:${addr}`
  const reqKeys: string[] = [];
  for (const { chain, addr } of wanted) {
    const a = addr.toLowerCase();
    const lk = `${CHAIN_PREFIX[chain]}:${a}`;
    if (!byLlamaKey.has(lk.toLowerCase())) { byLlamaKey.set(lk.toLowerCase(), `${chain}:${a}`); reqKeys.push(lk); }
  }
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${reqKeys.map(encodeURIComponent).join(",")}`, { cache: "no-store" });
    if (!r.ok) return out;
    const j = (await r.json()) as { coins?: Record<string, { price?: number; decimals?: number }> };
    for (const [k, v] of Object.entries(j.coins ?? {})) {
      const key = byLlamaKey.get(k.toLowerCase());
      if (key && v.price != null) out.set(key, { price: v.price, decimals: v.decimals ?? null });
    }
  } catch { /* ignore */ }
  return out;
}

export interface AlchemyTransfer { hash?: string; from?: string; to?: string; value?: number; asset?: string; metadata?: { blockTimestamp?: string } }
export const transferTs = (t: AlchemyTransfer): number =>
  t.metadata?.blockTimestamp ? Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000) : 0;

/**
 * alchemy_getAssetTransfers (desc) — pageKey 페이지네이션 지원. stopBeforeTs 이전 전송이 나오면
 * 윈도우를 다 덮은 것이므로 멈춘다.
 *
 * covered = "요청 윈도우 전체를 실제로 봤는가": (a) 윈도우 시작보다 오래된 전송을 봤거나
 * (b) pageKey 가 자연 소진(토큰 전 이력이 윈도우보다 짧음)된 경우만 true. 페이지 캡 도달·
 * fetch 실패는 false — 호출부가 부분 데이터를 완전한 것처럼 다루지 않게 한다(관측구간 정직).
 */
export async function fetchTransfers(net: string, contract: string, opts?: { maxCount?: number; maxPages?: number; stopBeforeTs?: number }): Promise<{ transfers: AlchemyTransfer[]; covered: boolean }> {
  if (!KEY) return { transfers: [], covered: false };
  const url = `https://${net}.g.alchemy.com/v2/${KEY}`;
  const maxCount = opts?.maxCount ?? 1000;
  const maxPages = opts?.maxPages ?? 1;
  const all: AlchemyTransfer[] = [];
  let pageKey: string | undefined;
  let covered = false;
  for (let page = 0; page < maxPages; page++) {
    // 게이트(호스트당 동시 3)+20s 타임아웃+429/5xx 재시도를 거친다 — raw fetch 였던 이 핫패스도 다른
    // RPC 와 동일한 보호를 받게 한다(2026-06-13 감사: ungated Alchemy 버스트가 429 로 윈도우를 조용히
    // 절단하고, 타임아웃 없는 hung 호출이 Promise.all 통째를 stall 시키던 결함). null = 비결론적
    // 실패/재시도 소진/결론적 에러 → break, covered=false 로 "부분 데이터"임을 호출부에 정직 표기.
    // attempts=5 (기본 3 대신) — 콜드 첫 폴에서 여러 토큰의 getAssetTransfers 가 동시 버스트로 429 를
    // 맞을 때, 백오프(250·500·1000·2000·4000ms ≈ 7.7s)로 레이트 윈도우를 타고 넘어가 피드가 비지 않게
    // 한다. "거래가 있는데 0으로 찍히는" false-empty 방지(2026-06-13).
    const result = await gatedJsonRpc<{ transfers?: AlchemyTransfer[]; pageKey?: string }>(
      url, "alchemy_getAssetTransfers",
      [{ contractAddresses: [contract], category: ["erc20"], order: "desc", maxCount: `0x${maxCount.toString(16)}`, withMetadata: true, excludeZeroValue: true, ...(pageKey ? { pageKey } : {}) }],
      5,
    );
    if (!result) break; // 실패/소진 — covered=false (이력 소진으로 오판하지 않는다)
    const batch = result.transfers ?? [];
    all.push(...batch);
    pageKey = result.pageKey;
    if (!batch.length || !pageKey) { covered = true; break; } // 이력 자연 소진 = 윈도우 전체 커버
    const oldest = transferTs(batch[batch.length - 1]);
    if (opts?.stopBeforeTs != null && oldest > 0 && oldest < opts.stopBeforeTs) { covered = true; break; } // 윈도우 시작 통과
  }
  return { transfers: all, covered };
}

export interface CpRegistry {
  /** `${chain}:${addr}` → 라벨 (rank 2 = 구조-특정: 볼트/DB 노드 · rank 1 = 프로토콜 레지스트리) */
  known: Map<string, string>;
  knownRank: Map<string, number>;
  dexAddrs: Set<string>;                 // swap 으로 분류할 카운터파티
  pairHint: Map<string, string>;         // `${chain}:${poolAddr}` → "SYMA-SYMB"
  tokenSymByAddr: Map<string, string>;   // `${chain}:${addr}` → 선택 토큰 심볼
  wrapPairs: Set<string>;                // `${chain}:${wrapperAddr}:${underlyingAddr}` (온체인 검증 쌍만)
}

/**
 * 타깃 토큰(체인:주소)들과 클라이언트가 넘긴 그래프 노드(`chain:addr~label`|…)로 레지스트리 구성.
 *  · Uniswap V2/V3 — CREATE2 per official chain factory (deterministic, keyless)
 *  · Uniswap V4 — official PoolManager singleton per chain
 *  · Curve — on-chain MetaRegistry (mainnet) incl the native-ETH sentinel
 *  · Aave V3 / Spark — aToken resolved LIVE via Pool.getReserveData
 *  · Compound V3 — 공식 Comet 후보를 baseToken() 으로 온체인 검증
 *  · Morpho Blue — canonical singleton escrow
 */
export async function buildCounterpartyRegistry(targets: CpTarget[], nodesParam: string): Promise<CpRegistry> {
  const known = await knownCounterparties();
  const knownRank = new Map<string, number>();
  for (const k of known.keys()) knownRank.set(k, 2);

  // graph node addresses passed by the client (vault contracts etc.) — chain-scoped so a base
  // transfer can never pick up a mainnet vault label that happens to share the address.
  for (const pair of nodesParam.split("|")) {
    const i = pair.indexOf("~"); if (i < 0) continue;
    let key = pair.slice(0, i).toLowerCase();
    const label = pair.slice(i + 1);
    if (!key.includes(":")) key = `ethereum:${key}`;
    const [kc, ka] = key.split(":");
    if (/^0x[0-9a-f]{40}$/.test(ka ?? "") && label && ALCHEMY_NET[kc]) { known.set(`${kc}:${ka}`, label); knownRank.set(`${kc}:${ka}`, 2); }
  }

  const dexAddrs = new Set<string>();
  const pairHint = new Map<string, string>();
  const chainsInPlay = [...new Set(targets.map((t) => t.chain))];
  const quotes = await quoteAddrs(); // real top-TVL quote partners (DEX numeraires) — mainnet pool expansion
  const tokenSymByAddr = new Map<string, string>();
  for (const t of targets) tokenSymByAddr.set(`${t.chain}:${t.addr}`, t.token);
  const symByChainAddr = new Map(tokenSymByAddr);
  for (const q of quotes) if (!symByChainAddr.has(`ethereum:${q.addr}`)) symByChainAddr.set(`ethereum:${q.addr}`, q.token.toUpperCase());
  symByChainAddr.set("ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "ETH");

  await Promise.all(chainsInPlay.map(async (chain) => {
    // all registries are CHAIN-SCOPED (`chain:addr` keys) — no cross-chain label bleed
    const addKnown = (addr: string, rawLabel: string, dex: boolean, pair?: [string, string]) => {
      const label = canonLabel(rawLabel); // 레지스트리 라벨도 슬러그로 통일 (curve→curve-dex 등)
      const k = `${chain}:${addr.toLowerCase()}`;
      if (!known.has(k)) known.set(k, label);
      if (dex) dexAddrs.add(k);
      if (pair) {
        const a = symByChainAddr.get(`${chain}:${pair[0]}`), b = symByChainAddr.get(`${chain}:${pair[1]}`);
        if (a && b && !pairHint.has(k)) pairHint.set(k, `${a}-${b}`); // 페어를 아는 풀 → 마켓 노드 매칭 힌트
      }
    };
    const chainAddrs = targets.filter((t) => t.chain === chain).map((t) => t.addr);
    const quoteAddrList = quotes.map((q) => q.addr);
    const uniUniverse = chain === "ethereum" ? [...new Set([...chainAddrs, ...quoteAddrList])] : chainAddrs;
    try { for (const { addr, label, pair } of uniswapPoolsFor(uniUniverse, chain)) addKnown(addr, label, true, pair); } catch { /* ignore */ }
    // Uniswap V2/V3 **포크** (pancakeswap·sushiswap·camelot) — 포크별 factory 에 getPool/getPair 온체인
    // 조회(주소 추측 0). 고볼륨 DEX 갭(pancakeswap base 일 $105M vol 등)을 색칠. 라벨=슬러그.
    try { for (const { addr, label, pair } of await dexForkPoolsFor(chainAddrs, chain)) addKnown(addr, label, true, pair); } catch { /* ignore */ }
    // Curve L2 (arbitrum·base) — MetaRegistry 가 L2 미배포라 api.curve.finance 풀리스트 사용(ethereum 은 위 curvePoolsFor 온체인).
    if (chain === "arbitrum" || chain === "base") { try { for (const { addr, label, pair } of await curveL2PoolsFor(chainAddrs, chain)) addKnown(addr, label, true, pair); } catch { /* ignore */ } }
    const pm = UNISWAP_V4_POOL_MANAGER[chain];
    if (pm) addKnown(pm, "uniswap-v4", true);
    if (chain === "ethereum") {
      const CURVE_NATIVE_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      // 쿼트 전체(top-30 mcap) 사용 — 8개 컷은 PYUSD-USDS 류 스테이블 페어 풀을 놓쳐
      // 실재하는 스왑이 "전송"으로 격하되던 원인 (MetaRegistry 조회는 페어별 영구 캐시라 비용 수렴)
      const curveUniverse = [...new Set([...chainAddrs, ...quoteAddrList, CURVE_NATIVE_ETH])];
      try { for (const { addr, label, pair } of await curvePoolsFor(curveUniverse)) addKnown(addr, label, true, pair); } catch { /* ignore */ }
      // Convex Booster 싱글톤 (공식 docs.convexfinance.com 배포 주소, 불변) — Curve LP 의 재예치
      // (steCRV→Convex 머니레고)가 여기로 들어간다. 그래프 노드 라벨(convex-finance)과 일치.
      addKnown("0xf403c135812408bfbe8713b5a23a04b3d48aae31", "convex-finance", false);
      // 큐레이트 ERC-4626 볼트 — 기초자산이 볼트 컨트랙트로 전송되는 게 예치(실시간 색칠).
      // 평소(24h) 모드는 lending-events.ts ERC4626_SAVINGS 가 동일 주소로 이벤트 수집 — 두 곳 동기 유지.
      addKnown("0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", "maple", false);        // syrupUSDC
      addKnown("0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d", "maple", false);        // syrupUSDT
      addKnown("0x0000000f2eb9f69274678c76222b35eec7588a65", "yo-protocol", false);  // yoUSD
      addKnown("0xd9a442856c234a39a81a089c06451ebaa4306a72", "puffer-stake", false); // pufETH
    }
    if (chain === "base") {
      // Aerodrome = base's main DEX — pools read live from the official factories (v1 + Slipstream)
      try { for (const { addr, label, pair } of await aerodromePoolsFor(chainAddrs)) addKnown(addr, label, true, pair); } catch { /* ignore */ }
    }
    if (chain === "arbitrum") {
      // GMX V2 공용 Vault 싱글톤 — 포지션 담보/유동성 inflow 가 여기로(134개 GM 마켓 대신 Vault 하나로
      // 전부 잡음). dataStore() 동일성으로 GMX 소속 온체인 검증(2026-06-13). dex=false(perps 담보, 거래량 아님).
      addKnown("0x31ef83a530fde1b38ee9a18093a333d8bbbc40d5", "gmx-v2-perps", false); // OrderVault (담보 압도적)
      addKnown("0xf89e77e8dc11691c9e8757e84aafbcd8a67d7a55", "gmx-v2-perps", false); // DepositVault
      addKnown("0x0628d46b5d145f183adb6ef1f2c97ed1c4701c55", "gmx-v2-perps", false); // WithdrawalVault
      // mim-swap (Abracadabra MagicLP) — MagicLPFactory 온체인 열거
      try { for (const { addr, label, pair } of await mimswapPoolsFor(chainAddrs, chain)) addKnown(addr, label, true, pair); } catch { /* ignore */ }
    }
    // Centrifuge V3 풀별 Escrow (eth·base·arb) — 공식 인덱서. 예치 토큰이 share 가 아니라 escrow 로 감.
    try { for (const { addr, label } of await centrifugeEscrows(chain)) addKnown(addr, label, false); } catch { /* ignore */ }
    try { for (const { addr, label } of await lendingReceiptAddrs(chain, chainAddrs)) addKnown(addr, label, false); } catch { /* ignore */ }
    // Compound V3 comets — official candidates, sanity-checked on-chain (baseToken()) before use
    try { for (const { addr, label } of await compoundComets(chain)) addKnown(addr, label, false); } catch { /* ignore */ }
    // Compound V2 **포크** cToken (moonwell·compound-v2) — Comptroller.getAllMarkets()→underlying() 검증분만 등록
    try { for (const { addr, label } of await compoundV2Markets(chain, chainAddrs)) addKnown(addr, label, false); } catch { /* ignore */ }
    const mb = MORPHO_BLUE[chain];
    if (mb) addKnown(mb, "morpho-blue", false);
    // ── 싱글톤 DEX/프로토콜 (멀티체인 동일주소, 불변) — 모든 스왑이 한 컨트랙트를 거치므로
    //    풀 유도(CREATE2) 없이 그 주소 하나로 전부 해석된다. 주소·실효 흐름 온체인 검증분(2026-06-13). ──
    addKnown("0xba12222222228d8ba445958a75a0704d566bf2c8", "balancer-v2", true); // Balancer V2 Vault (eth·base·arb 동일)
    addKnown("0xba1333333333a1ba1108e8412f11850a5c319ba9", "balancer-v3", true); // Balancer V3 Vault
    addKnown("0x888888888889758f76e7103c6cbf23abbf58f946", "pendle", true);      // Pendle Router V4 (PT/YT/SY 스왑 경유)
  }));

  // wrap/unwrap fast-path: 선택 토큰끼리의 검증된 랩 쌍 (asset()/stETH()/eETH() 가 원토큰을 반환).
  // 검증 안 되면 랩이라고 말하지 않는다.
  const wrapPairs = new Set<string>();
  await Promise.all(targets.map(async (t) => {
    const u = await wrappedUnderlying(t.chain, t.addr);
    if (u && tokenSymByAddr.has(`${t.chain}:${u}`)) wrapPairs.add(`${t.chain}:${t.addr}:${u}`);
  }));

  return { known, knownRank, dexAddrs, pairHint, tokenSymByAddr, wrapPairs };
}

export interface HopLite { from: string; to: string; value: number }
export interface HopMatch { label: string; addr: string; dir: "in" | "out"; key: string; rank: number; v: number }

/**
 * 한 tx 의 모든 hop 을 스캔해 가장 SPECIFIC 한 카운터파티를 채택 (rank2 볼트/DB 노드 >
 * rank1 프로토콜 레지스트리). v = 그 카운터파티를 실제로 거친 금액.
 */
export function bestHopMatch(hops: HopLite[], chain: string, reg: CpRegistry): HopMatch | null {
  let best: HopMatch | null = null;
  for (const h of hops) {
    const kt = `${chain}:${h.to}`, kf = `${chain}:${h.from}`;
    const mt = reg.known.get(kt);
    if (mt !== undefined) { const r = reg.knownRank.get(kt) ?? 1; if (!best || r > best.rank) best = { label: mt, addr: h.to, dir: "in", key: kt, rank: r, v: h.value }; }
    const mf = reg.known.get(kf);
    if (mf !== undefined) { const r = reg.knownRank.get(kf) ?? 1; if (!best || r > best.rank) best = { label: mf, addr: h.from, dir: "out", key: kf, rank: r, v: h.value }; }
  }
  return best;
}
