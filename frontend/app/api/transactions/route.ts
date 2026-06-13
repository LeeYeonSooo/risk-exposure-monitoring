import { NextResponse } from "next/server";
import pg from "pg";

import type { FlowTx } from "@/lib/flow-types";
import { uniswapPoolsFor } from "@/lib/uniswap-pools";
import { curvePoolsFor } from "@/lib/curve-pools";
import { compoundComets, erc20Symbol, isContract, lendingReceiptAddrs, MORPHO_BLUE, UNISWAP_V4_POOL_MANAGER, wrappedUnderlying } from "@/lib/lending-pools";
import { aerodromePoolsFor } from "@/lib/aerodrome-pools";
import { topTokensByTvl } from "@/lib/flow-core";

/**
 * GET /api/transactions?addrs=ethereum:0xabc..,base:0xdef..&tokens=stETH&chains=ethereum
 *
 * Near-real-time real transfer feed for the 흐름맵 (transaction flow). We surface transfers
 * whose block time is in [now-DELAY-WINDOW, now-DELAY] from the newest 1000 transfers per
 * token (single Alchemy page) — extreme-burst tokens may have the OLDEST part of the window
 * truncated. DELAY is just a tiny settle buffer (1 min).
 *
 * EVERY transfer is returned equally (no normal/suspicious split). Each carries its real
 * counterparty (resolved to a protocol/market/vault label when the address is one of our
 * graph nodes) so the client can place the particle on the REAL edge, and its real USD
 * size so the particle size + frequency reflect actual on-chain activity.
 *
 * Source: Alchemy alchemy_getAssetTransfers (needs ALCHEMY_API_KEY). Prices: DeFiLlama.
 */
export const dynamic = "force-dynamic";

const KEY = process.env.ALCHEMY_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const DELAY_SEC = 60;            // 1-min settle (on-chain counterparty resolution is fast — no need for 5 min)
const WINDOW_SEC = 5 * 60;       // show a 5-min trailing window of transfers, each as a particle
const MAX_RETURN = 600;

// Alchemy-supported networks (others are skipped, not faked)
// 2026-06-12 스코프 축소: 이더리움·베이스·아비트럼 3체인 (비EVM 경로 제거).
const ALCHEMY_NET: Record<string, string> = {
  ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet",
};
const CHAIN_PREFIX: Record<string, string> = {
  ethereum: "ethereum", base: "base", arbitrum: "arbitrum",
};

const BUILTIN_TOKEN: Record<string, Record<string, string>> = {
  ethereum: {
    STETH: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", WSTETH: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    WEETH: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", WBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    USDE: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7", DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
  },
};
const ZERO = "0x0000000000000000000000000000000000000000";

// NO hardcoded protocol registry, NO name()/brand heuristics. Counterparties are matched ONLY to the
// REAL structure-node addresses the client passes (vaults etc.) + addresses resolved live ON-CHAIN
// (Curve MetaRegistry, Uniswap factory, lending-protocol receipt tokens). Anything unmatched is dropped.

let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  return _pool;
}

/**
 * address → structure-node label, straight from the DB nodes (real markets/vaults that carry an
 * address). Keys are `${chain}:${addr}` — the DB topology is mainnet-anchored, so these labels
 * apply to ethereum ONLY (the same address on another chain can be an unrelated contract).
 */
async function knownCounterparties(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const p = pool();
  if (p) {
    try {
      const r = await p.query<{ label: string; address: string }>(
        `SELECT label, address FROM nodes WHERE address IS NOT NULL AND type <> 'Token'`,
      );
      for (const row of r.rows) if (/^0x[0-9a-fA-F]{40}$/.test(row.address)) out.set(`ethereum:${row.address.toLowerCase()}`, row.label);
    } catch { /* ignore */ }
  }
  return out;
}

/** fallback symbol→address resolution (when the client didn't pass addrs) */
async function resolveAddresses(symbols: string[], chain: string): Promise<{ token: string; addr: string }[]> {
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
async function fetchPrices(items: { chain: string; addr: string }[]): Promise<Map<string, { price: number; decimals: number | null }>> {
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

interface AlchemyTransfer { hash?: string; from?: string; to?: string; value?: number; asset?: string; metadata?: { blockTimestamp?: string } }
async function fetchTransfers(net: string, contract: string, maxCount = 1000): Promise<AlchemyTransfer[]> {
  const url = `https://${net}.g.alchemy.com/v2/${KEY}`;
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers",
        params: [{ contractAddresses: [contract], category: ["erc20"], order: "desc", maxCount: `0x${maxCount.toString(16)}`, withMetadata: true, excludeZeroValue: true }],
      }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { result?: { transfers?: AlchemyTransfer[] } };
    return j.result?.transfers ?? [];
  } catch { return []; }
}

export async function GET(req: Request) {
  if (!KEY) return NextResponse.json({ txs: [], error: "ALCHEMY_API_KEY not set" });
  const url = new URL(req.url);

  // primary: explicit chain:addr pairs (real flow-core-resolved token addresses, all chains)
  const addrParam = (url.searchParams.get("addrs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const tokenParam = (url.searchParams.get("tokens") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const chainParam = (url.searchParams.get("chains") ?? "ethereum").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  // build the work list of { token, chain, addr }
  const targets: { token: string; chain: string; addr: string }[] = [];
  for (const pair of addrParam) {
    const [chain, addrEnc, sym] = pair.split(":");
    if (!chain || !addrEnc) continue;
    const c = chain.toLowerCase();
    let addr = addrEnc;
    try { addr = decodeURIComponent(addrEnc); } catch { /* 원문 유지 */ }
    const token = (sym ?? "").toUpperCase() || addr.slice(0, 6);
    if (ALCHEMY_NET[c]) targets.push({ token, chain: c, addr: addr.toLowerCase() });
  }
  if (!targets.length && tokenParam.length) {
    for (const chain of chainParam) {
      if (!ALCHEMY_NET[chain]) continue;
      for (const { token, addr } of await resolveAddresses(tokenParam, chain)) targets.push({ token: token.toUpperCase(), chain, addr });
    }
  }
  if (!targets.length) return NextResponse.json({ txs: [] });

  const nowSec = Math.floor(Date.now() / 1000);
  const hiTs = nowSec - DELAY_SEC;              // newest allowed (1 min ago)
  const loTs = nowSec - DELAY_SEC - WINDOW_SEC; // oldest allowed (6 min ago = 1-min delay + 5-min window)

  const [known, prices] = await Promise.all([
    knownCounterparties(),
    fetchPrices(targets.map(({ chain, addr }) => ({ chain, addr }))),
  ]);
  // rank 2 = 구조-특정 라벨(볼트/마켓 — DB·그래프 노드), rank 1 = 프로토콜 수준 레지스트리.
  // 한 tx 가 [지갑→볼트→모르포 싱글톤] 처럼 두 카운터파티를 거치면 더 특정한(볼트) 쪽을 채택.
  const knownRank = new Map<string, number>();
  for (const k of known.keys()) knownRank.set(k, 2);
  // graph node addresses passed by the client (vault contracts etc.) → match transfers to them too.
  // format `chain:addr~label` (legacy `addr~label` = ethereum). chain-scoped so a base transfer
  // can never pick up a mainnet vault label that happens to share the address.
  for (const pair of (url.searchParams.get("nodes") ?? "").split("|")) {
    const i = pair.indexOf("~"); if (i < 0) continue;
    let key = pair.slice(0, i).toLowerCase();
    const label = pair.slice(i + 1);
    if (!key.includes(":")) key = `ethereum:${key}`;
    const [kc, ka] = key.split(":");
    if (/^0x[0-9a-f]{40}$/.test(ka ?? "") && label && ALCHEMY_NET[kc]) { known.set(`${kc}:${ka}`, label); knownRank.set(`${kc}:${ka}`, 2); }
  }
  // ── PER-CHAIN real counterparty registries (이더리움 전용이던 매칭을 전 체인으로) ──
  //  · Uniswap V2/V3 — CREATE2 per official chain factory (deterministic, keyless)
  //  · Uniswap V4 — official PoolManager singleton per chain
  //  · Curve — on-chain MetaRegistry (mainnet) incl the native-ETH sentinel (stETH/ETH-type pools)
  //  · Aave V3 / Spark — aToken resolved LIVE via Pool.getReserveData (deposit = transfer to aToken)
  //  · Morpho Blue — canonical singleton escrow
  // dexAddrs = swap counterparties; lending receipts stay deposit/withdraw — keeps the kind honest.
  const evmTargets = targets;
  const dexAddrs = new Set<string>();
  const pairHint = new Map<string, string>(); // `${chain}:${poolAddr}` → "SYMA-SYMB" (파생 풀의 알려진 페어)
  const chainsInPlay = [...new Set(evmTargets.map((t) => t.chain))];
  const quotes = await quoteAddrs(); // real top-TVL quote partners (DEX numeraires) — mainnet pool expansion
  // 심볼 맵: 선택 토큰(체인별) + 상위 TVL 쿼트(메인넷) + 커브 네이티브 ETH 표기
  const tokenSymByAddr = new Map<string, string>(); // `${chain}:${addr}` → symbol
  for (const t of targets) tokenSymByAddr.set(`${t.chain}:${t.addr}`, t.token);
  const symByChainAddr = new Map(tokenSymByAddr);
  for (const q of quotes) if (!symByChainAddr.has(`ethereum:${q.addr}`)) symByChainAddr.set(`ethereum:${q.addr}`, q.token.toUpperCase());
  symByChainAddr.set("ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "ETH");
  await Promise.all(chainsInPlay.map(async (chain) => {
    // all registries are CHAIN-SCOPED (`chain:addr` keys) — no cross-chain label bleed
    const addKnown = (addr: string, label: string, dex: boolean, pair?: [string, string]) => {
      const k = `${chain}:${addr.toLowerCase()}`;
      if (!known.has(k)) known.set(k, label);
      if (dex) dexAddrs.add(k);
      if (pair) {
        const a = symByChainAddr.get(`${chain}:${pair[0]}`), b = symByChainAddr.get(`${chain}:${pair[1]}`);
        if (a && b && !pairHint.has(k)) pairHint.set(k, `${a}-${b}`); // 페어를 아는 풀 → 마켓 노드 매칭 힌트
      }
    };
    const chainAddrs = evmTargets.filter((t) => t.chain === chain).map((t) => t.addr);
    const quoteAddrList = quotes.map((q) => q.addr);
    const uniUniverse = chain === "ethereum" ? [...new Set([...chainAddrs, ...quoteAddrList])] : chainAddrs;
    try { for (const { addr, label, pair } of uniswapPoolsFor(uniUniverse, chain)) addKnown(addr, label, true, pair); } catch { /* ignore */ }
    const pm = UNISWAP_V4_POOL_MANAGER[chain];
    if (pm) addKnown(pm, "uniswap-v4", true);
    if (chain === "ethereum") {
      const CURVE_NATIVE_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const curveUniverse = [...new Set([...chainAddrs, ...quoteAddrList.slice(0, 8), CURVE_NATIVE_ETH])];
      try { for (const { addr, label, pair } of await curvePoolsFor(curveUniverse)) addKnown(addr, label, true, pair); } catch { /* ignore */ }
    }
    if (chain === "base") {
      // Aerodrome = base's main DEX — pools read live from the official factories (v1 + Slipstream)
      try { for (const { addr, label, pair } of await aerodromePoolsFor(chainAddrs)) addKnown(addr, label, true, pair); } catch { /* ignore */ }
    }
    try { for (const { addr, label } of await lendingReceiptAddrs(chain, chainAddrs)) addKnown(addr, label, false); } catch { /* ignore */ }
    // Compound V3 comets — official candidates, sanity-checked on-chain (baseToken()) before use
    try { for (const { addr, label } of await compoundComets(chain)) addKnown(addr, label, false); } catch { /* ignore */ }
    const mb = MORPHO_BLUE[chain];
    if (mb) addKnown(mb, "morpho-blue", false);
  }));
  // wrap/unwrap fast-path: 선택 토큰끼리의 검증된 랩 쌍 (asset()/stETH()/eETH() 가 원토큰을 반환).
  // 검증 안 되면 랩이라고 말하지 않는다 (USDC를 USDT 컨트랙트로 잘못 보낸 전송 ≠ 랩).
  const wrapPairs = new Set<string>(); // `${chain}:${wrapperAddr}:${underlyingAddr}`
  await Promise.all(targets.map(async (t) => {
    const u = await wrappedUnderlying(t.chain, t.addr);
    if (u && tokenSymByAddr.has(`${t.chain}:${u}`)) wrapPairs.add(`${t.chain}:${t.addr}:${u}`);
  }));

  // collect PER TARGET so every token is represented (a hyper-active token like WETH can't
  // crowd a quieter one like wstETH out of the response). The cap derives from the global
  // budget so the final MAX_RETURN slice can never undo this fairness.
  const PER_TOKEN_CAP = Math.max(1, Math.min(200, Math.floor(MAX_RETURN / targets.length)));
  const isMatchedRow = (t: FlowTx) => t.counterparty != null || t.kind === "mint" || t.kind === "burn";
  const perTarget = await Promise.all(evmTargets.map(async ({ token, chain, addr }) => {
    const transfers = await fetchTransfers(ALCHEMY_NET[chain], addr, 1000);
    const price = prices.get(`${chain}:${addr}`)?.price ?? 0;
    // group this token's transfers by tx hash → reconstruct the REAL movement chain (a swap routes
    // through several contracts in one tx; we scan ALL hops, not just one entry's from/to).
    const byHash = new Map<string, AlchemyTransfer[]>();
    for (const t of transfers) {
      const ts = t.metadata?.blockTimestamp ? Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000) : 0;
      if (!ts || ts > hiTs || ts < loTs) continue; // delay window
      const h = t.hash ?? ""; if (!h) continue;
      const a = byHash.get(h); if (a) a.push(t); else byHash.set(h, [t]);
    }
    const local: FlowTx[] = [];
    const pending: { hsh: string; ts: number; maxVal: number; from: string; to: string }[] = [];
    for (const [hsh, hops] of byHash) {
      // 모든 hop 을 스캔해 가장 SPECIFIC 한 매칭을 채택 (볼트/DB 노드 rank2 > 프로토콜 레지스트리
      // rank1). cpVal = 그 카운터파티를 실제로 거친 금액 — 입자 크기는 실제 흐름.
      let best: { label: string; addr: string; dir: "in" | "out"; key: string; rank: number; v: number } | null = null;
      let maxVal = 0, ts = 0, from = "", to = "";
      for (const h of hops) {
        const hts = h.metadata?.blockTimestamp ? Math.floor(new Date(h.metadata.blockTimestamp).getTime() / 1000) : 0;
        if (hts > ts) ts = hts;
        const v = h.value ?? 0; if (v > maxVal) { maxVal = v; from = (h.from ?? "").toLowerCase(); to = (h.to ?? "").toLowerCase(); }
        const hf = (h.from ?? "").toLowerCase(), ht = (h.to ?? "").toLowerCase();
        const kt = `${chain}:${ht}`, kf = `${chain}:${hf}`;
        const mt = known.get(kt);
        if (mt !== undefined) { const r = knownRank.get(kt) ?? 1; if (!best || r > best.rank) best = { label: mt, addr: ht, dir: "in", key: kt, rank: r, v }; }
        const mf = known.get(kf);
        if (mf !== undefined) { const r = knownRank.get(kf) ?? 1; if (!best || r > best.rank) best = { label: mf, addr: hf, dir: "out", key: kf, rank: r, v }; }
      }
      if (best) {
        local.push({
          hash: hsh, chain, token, from, to, valueUsd: (best.v || maxVal) * price, ts, direction: best.dir,
          kind: dexAddrs.has(best.key) ? "swap" : best.dir === "in" ? "deposit" : "withdraw",
          counterparty: best.label, counterpartyAddr: best.addr, marketHint: pairHint.get(best.key) ?? null, reasons: [],
        });
        continue;
      }
      if (from === ZERO) { local.push({ hash: hsh, chain, token, from, to, valueUsd: maxVal * price, ts, direction: "in", kind: "mint", counterparty: null, counterpartyAddr: null, marketHint: null, reasons: [] }); continue; }
      if (to === ZERO) { local.push({ hash: hsh, chain, token, from, to, valueUsd: maxVal * price, ts, direction: "out", kind: "burn", counterparty: null, counterpartyAddr: null, marketHint: null, reasons: [] }); continue; }
      // 선택 토큰끼리의 검증된 랩 쌍 fast-path
      const wrapTo = tokenSymByAddr.get(`${chain}:${to}`), wrapFrom = tokenSymByAddr.get(`${chain}:${from}`);
      if (wrapTo && wrapPairs.has(`${chain}:${to}:${addr}`)) { local.push({ hash: hsh, chain, token, from, to, valueUsd: maxVal * price, ts, direction: "in", kind: "wrap", counterparty: wrapTo, counterpartyAddr: to, marketHint: null, reasons: [] }); continue; }
      if (wrapFrom && wrapPairs.has(`${chain}:${from}:${addr}`)) { local.push({ hash: hsh, chain, token, from, to, valueUsd: maxVal * price, ts, direction: "out", kind: "unwrap", counterparty: wrapFrom, counterpartyAddr: from, marketHint: null, reasons: [] }); continue; }
      pending.push({ hsh, ts, maxVal, from, to });
    }
    // 2차 패스 — 미매칭 상대 중 금액 큰 순으로 소수만 온체인 프로브: 컨트랙트이고
    // asset()/stETH()/eETH() 가 정확히 이 토큰을 반환하면 검증된 랩(라벨 = 그 컨트랙트의 symbol()).
    // wstETH·sUSDe 같은 래퍼/4626 예치가 쌍 토큰을 선택하지 않아도 잡힌다. 결과는 영구 캐시.
    const MAX_PROBES = 8;
    const candOrder: string[] = [];
    for (const p of [...pending].sort((a, b) => b.maxVal - a.maxVal)) {
      for (const cand of [p.to, p.from]) if (cand && cand !== addr && !candOrder.includes(cand)) candOrder.push(cand);
      if (candOrder.length >= MAX_PROBES * 2) break;
    }
    const wrapLabelByAddr = new Map<string, string>();
    let probes = 0;
    for (const cand of candOrder) {
      if (probes >= MAX_PROBES) break;
      if (!(await isContract(chain, cand))) continue; // EOA 는 프로브 예산을 소모하지 않는다 (getCode 는 캐시됨)
      probes++;
      if ((await wrappedUnderlying(chain, cand)) !== addr) continue;
      const sym = await erc20Symbol(chain, cand);
      wrapLabelByAddr.set(cand, sym ?? `${cand.slice(0, 6)}…${cand.slice(-4)}`);
    }
    for (const p of pending) {
      const wTo = wrapLabelByAddr.get(p.to), wFrom = wrapLabelByAddr.get(p.from);
      if (wTo) local.push({ hash: p.hsh, chain, token, from: p.from, to: p.to, valueUsd: p.maxVal * price, ts: p.ts, direction: "in", kind: "wrap", counterparty: wTo, counterpartyAddr: p.to, marketHint: null, reasons: [] });
      else if (wFrom) local.push({ hash: p.hsh, chain, token, from: p.from, to: p.to, valueUsd: p.maxVal * price, ts: p.ts, direction: "out", kind: "unwrap", counterparty: wFrom, counterpartyAddr: p.from, marketHint: null, reasons: [] });
      // 그 외 = 지갑간/미식별 전송 — 숨기지 않고 패널에 kind:transfer 로 보여준다 (그래프엔 안 그림, 라벨 추측 없음)
      else local.push({ hash: p.hsh, chain, token, from: p.from, to: p.to, valueUsd: p.maxVal * price, ts: p.ts, direction: "out", kind: "transfer", counterparty: null, counterpartyAddr: null, marketHint: null, reasons: [] });
    }
    // 매칭 흐름 우선 + 지갑 전송은 토큰당 최대 40건 (활동은 보이되 매칭 흐름을 밀어내지 않게)
    const matchedRows = local.filter(isMatchedRow).sort((a, b) => b.ts - a.ts).slice(0, PER_TOKEN_CAP);
    const plainRows = local.filter((t) => !isMatchedRow(t)).sort((a, b) => b.ts - a.ts).slice(0, Math.max(0, Math.min(40, PER_TOKEN_CAP - matchedRows.length)));
    return [...matchedRows, ...plainRows];
  }));
  const allTargets = perTarget;
  const total = allTargets.reduce((s, a) => s + a.length, 0);
  const txs = allTargets.flat().sort((a, b) => b.ts - a.ts).slice(0, MAX_RETURN);

  return NextResponse.json({
    txs,
    delaySec: DELAY_SEC, windowSec: WINDOW_SEC,
    generatedAt: new Date().toISOString(),
    counts: { total, returned: txs.length },
  });
}
