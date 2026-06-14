/**
 * 머니레고 구조 스냅샷 — 토큰별 파생토큰(PT/YT/LP/aToken) + 수용처(Morpho 담보·Convex 스테이킹)를
 * 발견해 lego_nodes/lego_edges 에 replace 적재. (멘토 §8 "Pendle→Morpho 가 그래프에 떠야" 직접 해소)
 *
 * 직접 자금흐름 없이도 구조가 확인되면 잇는다(§9) — 모든 엣지에 evidence 기록, 추측 금지.
 * EOA 는 처음부터 후보가 아님 — 전 소스가 컨트랙트 레지스트리/API (§9 컨트랙트만).
 *
 * Usage:
 *   npm run snapshot:lego -- sUSDe stETH      # 지정 토큰
 *   npm run snapshot:lego -- --top 12         # 익스포저 상위 N (기본 12)
 */
import process from "node:process";

import { oracleTypeForCollateral } from "@/config/alert-thresholds";
import { closePool, query } from "@/db/client";
import { ACCEPTOR_ADAPTERS } from "@/lego/acceptors";
import { aaveATokenFor, convexLpMap, curveLpsFor, metamorphoVaultsFor, pendleMarketsFor } from "@/lego/discover";
import { symbolsOf } from "@/lego/onchain";
import { CHAIN_IDS, computeTerminalMark, derivNodeId, marketNodeId, type LegoEdge, type LegoNode } from "@/lego/types";
import { introspectOracle } from "@/oracle/introspect";

const CHAINS = ["ethereum", "base", "arbitrum"];

// 언더라잉/배킹 체인 레지스트리 — "토큰이 무엇으로 구성되는가"를 언더라잉 토큰→기반자산→리스테이킹 venue 까지 단계로 푼다.
//   (심볼 lowercase 키, 순서 = 즉시 언더라잉 → … → 기반 → venue. 모두 단일 노드 + backed_by 엣지로 체인.)
//   weETH→eETH→ETH→EigenLayer: 주소·관계 온체인 검증(weETH.eETH()=eETH rate 1.097, eETH←1.84M ETH ether.fi).
//   EigenLayer 멤버십은 정설 LRT(온체인 토큰 프로브 불가: stakerStrategyListLength(LRT)=0 — 리스테이킹은 프로토콜별
//     NodeDelegator/EigenPod 가 함, 연구 검증). sUSDe→USDe 는 sUSDe.asset()==USDe 온체인 검증.
//   ★가치★: 궁극 기반(ETH)·venue(EigenLayer) node id 가 체인 공유라 형제 토큰(weETH·rsETH·ezETH)이 같은 ETH·EigenLayer
//     노드를 공유 → 상류 공동위험이 한 노드로 모인다. venue 가 블랙박스로 끝나지 않고 언더라잉 토큰까지 연결된다.
interface ChainStep { symbol: string; address?: string; brandSlug: string; kind: "underlying" | "base" | "venue"; venueSlug?: string }
const UNDERLYING_CHAIN: Record<string, ChainStep[]> = {
  weeth: [
    { symbol: "eETH", address: "0x35fa164735182de50811e8e2e824cfb9b6118ac2", brandSlug: "etherfi", kind: "underlying" },
    { symbol: "ETH", brandSlug: "ethereum", kind: "base" },
    { symbol: "EigenLayer", brandSlug: "eigenlayer", kind: "venue", venueSlug: "eigenlayer" },
  ],
  ezeth: [{ symbol: "ETH", brandSlug: "ethereum", kind: "base" }, { symbol: "EigenLayer", brandSlug: "eigenlayer", kind: "venue", venueSlug: "eigenlayer" }],
  rseth: [{ symbol: "ETH", brandSlug: "ethereum", kind: "base" }, { symbol: "EigenLayer", brandSlug: "eigenlayer", kind: "venue", venueSlug: "eigenlayer" }],
  rsweth: [{ symbol: "ETH", brandSlug: "ethereum", kind: "base" }, { symbol: "EigenLayer", brandSlug: "eigenlayer", kind: "venue", venueSlug: "eigenlayer" }],
  pufeth: [{ symbol: "ETH", brandSlug: "ethereum", kind: "base" }, { symbol: "EigenLayer", brandSlug: "eigenlayer", kind: "venue", venueSlug: "eigenlayer" }],
  susde: [
    { symbol: "USDe", address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", brandSlug: "ethena", kind: "underlying" },
    { symbol: "Ethena", brandSlug: "ethena", kind: "venue", venueSlug: "ethena" },
  ],
  usde: [{ symbol: "Ethena", brandSlug: "ethena", kind: "venue", venueSlug: "ethena" }],
};
// 배킹 프로토콜 TVL(노드 크기) — DeFiLlama /protocol/{slug} currentChainTvls 합(차입/스테이킹 파생 제외). 슬러그별 캐시.
const _backingTvl = new Map<string, number | null>();
async function backingTvlUsd(slug: string): Promise<number | null> {
  if (_backingTvl.has(slug)) return _backingTvl.get(slug)!;
  let v: number | null = null;
  try {
    const r = await fetch(`https://api.llama.fi/protocol/${slug}`);
    if (r.ok) {
      const j = (await r.json()) as { currentChainTvls?: Record<string, number> };
      const t = j.currentChainTvls ?? {};
      const sum = Object.entries(t).filter(([k]) => !/-(borrowed|staking|pool2|vesting)/i.test(k)).reduce((s, [, n]) => s + (typeof n === "number" ? n : 0), 0);
      v = sum > 0 ? sum : null;
    }
  } catch { v = null; }
  _backingTvl.set(slug, v);
  return v;
}

interface TokenRow { node_id: string; address: string; chain: string; label: string }

async function tokensFor(sym: string): Promise<TokenRow[]> {
  const r = await query<TokenRow>(
    `SELECT node_id, address, chain, label FROM nodes
     WHERE type = 'Token' AND address IS NOT NULL
       AND (LOWER(node_id) = LOWER($1) OR LOWER(node_id) LIKE LOWER($1) || '@%')`,
    [`token:${sym}`],
  );
  return r.rows.filter((t) => CHAINS.includes(t.chain));
}

interface VariantRow { address: string; source_chain: string; via: string }
// 같은 체인에 사는 브릿지 래핑본(USDC.e 등) — kind='bridged_wrapped'. source_chain 에서 잠기고 이 체인에서 민팅된 변형.
// (B1 적재. ccip_remote 류는 원격 체인 토큰이라 같은 체인 동심원에 얹지 않음 → bridged_wrapped 만.)
async function bridgedVariantsFor(sym: string, chain: string): Promise<VariantRow[]> {
  const r = await query<VariantRow>(
    `SELECT DISTINCT address, source_chain, via FROM token_variants
     WHERE token = $1 AND chain = $2 AND kind = 'bridged_wrapped' AND address IS NOT NULL`,
    [sym, chain],
  );
  return r.rows;
}

async function topSymbols(n: number): Promise<string[]> {
  const r = await query<{ sym: string }>(
    `WITH latest AS (SELECT token_node_id, MAX(snapshot_ts) ts FROM edges GROUP BY token_node_id)
     SELECT split_part(replace(e.token_node_id, 'token:', ''), '@', 1) AS sym,
            SUM(COALESCE((e.attrs->'core'->>'amountUsd')::float, 0)) AS usd
     FROM edges e JOIN latest l ON e.token_node_id = l.token_node_id AND e.snapshot_ts = l.ts
     GROUP BY 1 ORDER BY usd DESC LIMIT $1`,
    [n],
  );
  return r.rows.map((x) => x.sym);
}

// 전체 추적 토큰(watchlist) — 기본 커버리지. 토큰별 하드코딩 없이 임의 토큰에 동일 알고리즘 적용
// (사용자: "다른 토큰을 봤을 때도 그 모든 게 잘 되어야"). 노출 큰 순으로 정렬.
async function allSymbols(): Promise<string[]> {
  const r = await query<{ sym: string }>(
    `WITH latest AS (SELECT token_node_id, MAX(snapshot_ts) ts FROM edges GROUP BY token_node_id)
     SELECT split_part(replace(e.token_node_id, 'token:', ''), '@', 1) AS sym,
            SUM(COALESCE((e.attrs->'core'->>'amountUsd')::float, 0)) AS usd
     FROM edges e JOIN latest l ON e.token_node_id = l.token_node_id AND e.snapshot_ts = l.ts
     GROUP BY 1 ORDER BY usd DESC`,
  );
  return r.rows.map((x) => x.sym);
}

/** 토큰 1개의 레고 서브그래프 생성 — {nodes, edges} (token 노드 자체는 기존 nodes 테이블 소유라 제외). */
async function buildFor(t: TokenRow): Promise<{ nodes: LegoNode[]; edges: LegoEdge[] }> {
  const nodes = new Map<string, LegoNode>();
  const edges = new Map<string, LegoEdge>();
  const chain = t.chain;
  const tokenId = t.node_id;
  const addDerivative = (addr: string, role: LegoNode["role"], protocol: string, label: string, meta: Record<string, unknown>) => {
    const id = derivNodeId(addr, chain);
    if (!nodes.has(id)) nodes.set(id, { id, chain, address: addr.toLowerCase(), kind: "derivative", role, label, symbol: null, protocol, parentToken: tokenId, meta });
    return id;
  };
  // 수용처 마켓 노드 — 파생을 받아주는 개별 마켓(Morpho 담보마켓·Convex 풀). 프로토콜 노드가 아님(사용자: "프로토콜로 가지말고").
  //   ★id 충돌 시 큰 sizeUsd 우선(회장 작업1)★: 같은 (담보-대출) 주소쌍이 오라클/IRM 만 달라 여러 Morpho 마켓일 때
  //   노드 id(legomkt:..{coll}-{loan}@chain)가 겹친다. id 형식은 보존(정책)하되, 빈($0) 중복이 실집중($41M) 마켓을
  //   덮어써 "집중허브가 먼지로" 보이던 문제를 막는다 — 결정적으로 sizeUsd 큰 쪽을 남긴다(추측 아님, 둘 다 실측).
  const sizeOf = (meta: Record<string, unknown>): number => (typeof meta.sizeUsd === "number" && meta.sizeUsd > 0 ? meta.sizeUsd : 0);
  const addMarket = (id: string, proto: string, label: string, meta: Record<string, unknown>) => {
    const prev = nodes.get(id);
    if (!prev) nodes.set(id, { id, chain, address: null, kind: "market", role: null, label, symbol: null, protocol: proto, parentToken: tokenId, meta });
    else if (sizeOf(meta) > sizeOf(prev.meta)) prev.meta = meta; // 더 큰 규모의 동일-id 마켓으로 교체(빈 중복 덮어쓰기 방지)
    return id;
  };
  const addEdge = (src: string, dst: string, relation: LegoEdge["relation"], weightUsd: number | null, evidence: Record<string, unknown>) => {
    const key = `${src}|${dst}|${relation}`;
    const prev = edges.get(key);
    // 동일 엣지 충돌 시 양의 weight 를 더 작은(또는 null) weight 가 덮지 않게 한다(마켓 노드 sizeUsd 보존과 정합).
    //   그 외(양쪽 다 null/0, 또는 새 weight 가 더 큼)는 기존대로 갱신 — evidence 최신화 동작 보존.
    if (prev && (prev.weightUsd ?? 0) > 0 && (weightUsd ?? 0) < (prev.weightUsd ?? 0)) return;
    edges.set(key, { src, dst, relation, chain, weightUsd, evidence });
  };

  // ① Pendle — PT/YT/LP (멘토 §8: PT 가 핵심 파생)
  const pendle = await pendleMarketsFor(chain, t.address);
  for (const m of pendle) {
    const ptId = addDerivative(m.pt, "pt", "pendle", `PT ${m.name} (${m.expiry})`, { market: m.market, expiry: m.expiry });
    const ytId = addDerivative(m.yt, "yt", "pendle", `YT ${m.name} (${m.expiry})`, { market: m.market, expiry: m.expiry });
    const lpId = addDerivative(m.market, "lp", "pendle", `Pendle LP ${m.name} (${m.expiry})`, { expiry: m.expiry, liquidityUsd: m.liquidityUsd });
    addEdge(tokenId, ptId, "issues", null, { source: "pendle-api", market: m.market });
    addEdge(tokenId, ytId, "issues", null, { source: "pendle-api", market: m.market });
    addEdge(tokenId, lpId, "lp_of", m.liquidityUsd || null, { source: "pendle-api" });
    addEdge(ptId, lpId, "lp_of", null, { source: "pendle-api", note: "PT-SY pool" });
  }

  // ② Aave V3 — 예치 영수증(aToken)
  const aToken = await aaveATokenFor(chain, t.address);
  if (aToken) {
    const aId = addDerivative(aToken, "receipt", "aave_v3", `aToken`, {});
    addEdge(tokenId, aId, "issues", null, { source: "onchain", method: "Pool.getReserveData" });
  }

  // ③ Curve LP (이더리움만 — MetaRegistry)
  if (chain === "ethereum") {
    const lps = await curveLpsFor(t.address);
    for (const { pool, lp, quote, sizeUsd } of lps) {
      const lpId = addDerivative(lp, "lp", "curve", `Curve LP`, { pool, quote, sizeUsd });
      // lp_of weight = 그 풀에 든 viewed 토큰 잔액 USD(온체인 balanceOf×가격). null=미측정·0=빈풀.
      addEdge(tokenId, lpId, "lp_of", sizeUsd, { source: "onchain", method: "MetaRegistry.find_pools_for_coins", sizing: "token.balanceOf(pool)*price", pool, quote });
    }
  }

  // ③' MetaMorpho 볼트 쉐어 — 큐레이터 ERC-4626 볼트(steakUSDC·gtUSDC 등)를 wrapper 파생으로 적재.
  //    전염 주경로: 이 쉐어가 다시 담보로 돈다 → 아래 ④ 수용처 질의(derivAddrs)에 쉐어 주소가 포함돼 쉐어→마켓 엣지도 잡힘.
  for (const v of await metamorphoVaultsFor(chain, t.address)) {
    const vId = addDerivative(v.address, "wrapper", "metamorpho", v.symbol ?? v.name ?? "MetaMorpho 볼트", {
      totalAssetsUsd: v.totalAssetsUsd, name: v.name, venue: "MetaMorpho",
    });
    addEdge(tokenId, vId, "issues", v.totalAssetsUsd || null, { source: "morpho-graphql", kind: "metamorpho-vault", totalAssetsUsd: v.totalAssetsUsd });
  }

  // ③'' 브릿지 래핑본 — 같은 체인에 사는 lock&mint 변형(USDC.e 등)을 wrapper 파생으로 적재 (A6).
  //    "브릿지 노드에서 끊기던 엣지" 해소: 래핑본도 다시 담보로 돈다 → 아래 ④ 수용처 질의에 주소가 포함돼
  //    래핑본→마켓 collateral_at 엣지까지 잡힘(예: USDC.e@arbitrum → Morpho arbitrum). 라벨은 온체인 symbol().
  const sym = t.node_id.replace(/^token:/i, "").split("@")[0];
  for (const v of await bridgedVariantsFor(sym, chain)) {
    addDerivative(v.address, "wrapper", "bridge", `${sym}(${v.via})`, {
      via: v.via, sourceChain: v.source_chain, venue: "bridge", kind: "bridged-wrapped",
    });
    addEdge(tokenId, derivNodeId(v.address, chain), "issues", null,
      { source: "token_variants", kind: "bridged_wrapped", via: v.via, sourceChain: v.source_chain });
  }

  // 라벨 확정 — 실제 symbol() 일괄 읽기 (PT-sUSDE-13AUG2026, aEthsUSDe, steCRV …)
  const derivAddrs = [...nodes.values()].filter((n) => n.kind === "derivative").map((n) => n.address!) as string[];
  const syms = await symbolsOf(chain, derivAddrs);
  for (const n of nodes.values()) {
    if (n.kind !== "derivative" || !n.address) continue;
    const s = syms.get(n.address) ?? null;
    n.symbol = s;
    // PT/YT 는 온체인 심볼이 가장 읽기 좋다. LP/영수증은 심볼이 빈약하면 만든 라벨 유지.
    if (s && (n.role === "pt" || n.role === "yt" || n.role === "receipt")) n.label = s;
    else if (s && n.label === "Curve LP") n.label = s;
    // 브릿지 래핑본: 온체인 symbol() + via 로 라벨(레거시 USDC.e 는 symbol()이 "USDC"라 정규 토큰과 안 헷갈리게 via 병기).
    else if (n.protocol === "bridge" && n.role === "wrapper") n.label = s ? `${s}(${(n.meta.via as string) ?? "bridge"})` : n.label;
  }

  // ④ 수용처 발견 — 어댑터 레지스트리(acceptors.ts) 순회로 "받아주는 개별 마켓"에 연결(프로토콜 X). 멘토 §8·§9.
  //    재사용 가능(레벨2 재귀에서 영수증 토큰에도 호출). 마켓 = (담보=파생, 대출=loan) 쌍.
  //    새 수용처는 ACCEPTOR_ADAPTERS 에 어댑터만 추가 — 여기는 손대지 않는다.
  const addAcceptorsFor = async (addrs: string[]): Promise<void> => {
    const list = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a) && nodes.has(derivNodeId(a, chain)));
    if (!list.length) return;
    for (const adapter of ACCEPTOR_ADAPTERS) {
      if (!adapter.chains.includes(chain)) continue;
      for (const m of await adapter.accepting(chain, list)) {
        const dId = derivNodeId(m.collateral, chain);
        if (!nodes.has(dId)) continue;
        const mId = marketNodeId(m.protocol, m.marketKey, chain);
        // 담보 심볼 보강(회장 작업2) — 어댑터는 담보 주소만 안다. 담보 파생노드의 symbol 을 meta.collateral 에 실어
        //   알림 조인(collateral|loan|lltv 변별)이 USDC|0.915 충돌 없이 이 마켓만 집게 한다(추측 없음 — 이미 읽은 온체인 심볼).
        const collSym = nodes.get(dId)?.symbol ?? null;
        // 마켓별 자체 오라클 주소를 meta 로 보존(어댑터가 실으면) → 후처리 ⑥'' 가 introspect. 일반화 지점.
        const meta = { ...m.meta, ...(collSym ? { collateral: collSym } : {}), ...(m.oracleAddress ? { oracleAddress: m.oracleAddress } : {}) };
        addMarket(mId, m.protocol, m.label, meta);
        addEdge(dId, mId, "collateral_at", m.sizeUsd, m.evidence);
      }
    }
  };
  await addAcceptorsFor(derivAddrs);

  // ④' viewed 베이스 토큰 자체의 수용처 — Fluid 등 "파생이 아니라 베이스 토큰을 담보로 받는" 수용처 포착.
  //     (파생 주소만 넘기면 Fluid 류가 안 잡힘 — 사용자 2026-06-13). 엣지 src = 동심원 토큰 노드(token:sym).
  //     프론트 overlay 가 동심원에 이미 있는 수용처(Aave/Morpho)는 중복으로 스킵하고, 무명 수용처만 프로토콜로 1급화.
  const addBaseAcceptors = async (baseAddr: string, tokenNodeId: string): Promise<void> => {
    const la = baseAddr.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(la)) return;
    const baseSym = viewedSymbolOf(tokenNodeId); // 베이스 토큰이 담보 → 담보 심볼 = viewed 심볼
    for (const adapter of ACCEPTOR_ADAPTERS) {
      if (!adapter.chains.includes(chain)) continue;
      for (const m of await adapter.accepting(chain, [la])) {
        if (m.collateral.toLowerCase() !== la) continue;
        const mId = marketNodeId(m.protocol, m.marketKey, chain);
        const meta = { ...m.meta, ...(baseSym ? { collateral: baseSym } : {}), ...(m.oracleAddress ? { oracleAddress: m.oracleAddress } : {}) }; // 담보 심볼 + 마켓 오라클 주소 보강
        addMarket(mId, m.protocol, m.label, meta);
        addEdge(tokenNodeId, mId, "collateral_at", m.sizeUsd, m.evidence);
      }
    }
  };
  await addBaseAcceptors(t.address, t.node_id);

  // ⑤ 수용처 — Convex 스테이킹 풀 (Curve LP → 그 LP 를 받아주는 Convex 풀). 멘토 §6 stETH→Curve→Convex.
  //    재귀(B8): Convex 영수증 토큰(cvxLP)을 레벨2 파생으로 추가 → 그게 또 어디 담보로 쓰이는지 추적.
  const recurseAddrs: string[] = [];
  if (chain === "ethereum") {
    const cvx = await convexLpMap();
    for (const n of [...nodes.values()]) {
      if (n.kind !== "derivative" || n.protocol !== "curve" || !n.address) continue;
      const hit = cvx.get(n.address);
      if (!hit) continue;
      const mId = marketNodeId("convex", String(hit.pid), chain);
      addMarket(mId, "convex", `Convex 풀 #${hit.pid}`, { kind: "pool", venue: "Convex", pid: hit.pid, category: "Convex 스테이킹 풀" });
      addEdge(n.id, mId, "staked_in", null, { source: "onchain", method: "Booster.poolInfo", pid: hit.pid });
      // Convex 예치 영수증(cvxLP) — 레벨2 파생. 이게 또 담보로 쓰이면 체인이 한 단계 더 깊어짐.
      if (hit.depositToken && /^0x[0-9a-f]{40}$/.test(hit.depositToken) && !nodes.has(derivNodeId(hit.depositToken, chain))) {
        const rId = addDerivative(hit.depositToken, "receipt", "convex", `Convex 영수증`, { pid: hit.pid, ofLp: n.address });
        addEdge(mId, rId, "issues", null, { source: "onchain", method: "Booster.poolInfo.token", pid: hit.pid });
        recurseAddrs.push(hit.depositToken);
      }
    }
  }

  // ⑥ B8 레벨2 재귀 — 레벨1 파생 중 "또 다른 파생을 낳는 것"(LP 가 Pendle 기초자산이면 그 LP 의 PT) +
  //    Convex 영수증 → 그것들의 수용처를 다시 추적(depth 2). 임의 깊이로 확장 가능하나 실DeFi 는 보통 2~3홉.
  if (chain === "ethereum") {
    const lpAddrs = [...nodes.values()].filter((n) => n.kind === "derivative" && n.role === "lp" && n.address).map((n) => n.address!) as string[];
    for (const lp of lpAddrs) {
      for (const m of await pendleMarketsFor(chain, lp)) { // LP 가 Pendle 기초자산인 경우(LP→PT)
        const ptId = addDerivative(m.pt, "pt", "pendle", `PT ${m.name} (${m.expiry})`, { market: m.market, expiry: m.expiry, ofLp: lp });
        addEdge(derivNodeId(lp, chain), ptId, "issues", null, { source: "pendle-api", note: "LP→PT (레벨2)" });
        recurseAddrs.push(m.pt);
      }
    }
    // 레벨2 파생 심볼 라벨 + 수용처
    if (recurseAddrs.length) {
      const syms2 = await symbolsOf(chain, recurseAddrs);
      for (const a of recurseAddrs) { const n = nodes.get(derivNodeId(a, chain)); if (n) { const s = syms2.get(a.toLowerCase()); if (s) { n.symbol = s; if (n.label === "Convex 영수증" || /^PT /.test(n.label)) n.label = s; } } }
      await addAcceptorsFor(recurseAddrs);
    }
  }

  // ⑥' 큐레이터 조인 — vault_allocations(snapshot:curators 적재분)와 Morpho 마켓을 (담보·대출·LLTV)로 조인해
  //     market.meta.curators 와 per-curator supply_usd 를 채운다. 이래야 종착의 큐레이터 볼트 부채꼴(addMarketNode)이
  //     12개→대부분 마켓으로 확장돼 "X 큐레이터 볼트가 이 마켓에 $N" 가 관계맵에서 읽힌다(제품 고유가치).
  //     추측 없음 — 이미 DB 에 있는 무료 소스(Morpho GraphQL 적재분) 조인일 뿐. 매칭 실패 마켓은 손대지 않음.
  await attachCurators(chain, viewedSymbolOf(tokenId), nodes);

  // ⑥'' 마켓 오라클 introspection — "마켓마다 자체 오라클"인 수용처(Morpho Blue 등)는 meta.oracleAddress 를 싣는다.
  //      그 주소를 *온체인* introspect(시장가/교환비/NAV/고정 분류)해 meta.oracle(종류)·oracleProvider·oracleDescription
  //      에 per-market 로 채운다. 프론트 GraphCanvas 가 이미 `_market.oracle` 을 읽어 엣지 위 오라클 원을 그린다 →
  //      프론트 무변경으로 Morpho 같은 자체오라클 마켓도 원이 붙는다. 추측 없음: 기존 introspectOracle(description()
  //      +합성 BASE/QUOTE_FEED+Etherscan 이름) 재사용. 비용 가드: introspectOracle 내부 주소캐시 + 신규 호출 상한.
  //      ★일반화★: 어떤 수용처 어댑터든 oracleAddress 만 실으면 여기서 자동으로 오라클이 분류·표시된다.
  {
    const chainId = CHAIN_IDS[chain] ?? 1;
    // 한 토큰·체인 스냅샷당 신규 introspect 상한(서로 다른 오라클 주소 기준). 나머지는 심볼 휴리스틱.
    //   여러 수용처(Morpho·Euler·Fluid·Silo…)가 oracleAddress 를 싣게 되면 토큰당 고유 오라클이 늘어나므로
    //   여유를 둔다. introspectOracle 은 프로세스 전역 주소캐시라, 토큰들이 공유하는 오라클은 1회만 든다
    //   (cron legoLoop 은 전체 watchlist 를 한 프로세스로 순회 → 누적 비용은 "전체 고유 오라클 수"로 수렴).
    const ORACLE_CAP = 36;
    let attempts = 0;
    const seen = new Map<string, { type: string; provider: string | null; description: string | null; verified: boolean }>();
    // 규모순 — 신규 introspect 상한을 큰 마켓에 먼저 쓴다(작은 마켓은 심볼 휴리스틱). 메인 어댑터와 동일 원칙.
    const mkts = [...nodes.values()]
      .filter((n) => n.kind === "market" && /^0x[0-9a-f]{40}$/i.test((n.meta?.oracleAddress as string | undefined) ?? ""))
      .sort((a, b) => ((b.meta?.sizeUsd as number) ?? 0) - ((a.meta?.sizeUsd as number) ?? 0));
    for (const n of mkts) {
      const oaddr = n.meta?.oracleAddress as string | undefined;
      if (!oaddr || !/^0x[0-9a-f]{40}$/i.test(oaddr)) continue;
      const key = oaddr.toLowerCase();
      let info = seen.get(key);
      if (!info) {
        const collSym = (n.meta?.collateral as string | undefined) ?? null;
        const collAddr = (n.meta?.collateralAddress as string | undefined) ?? undefined;
        let oi: Awaited<ReturnType<typeof introspectOracle>> | null = null;
        if (attempts < ORACLE_CAP) {
          oi = await introspectOracle(oaddr as `0x${string}`, chainId, collSym ?? undefined, collAddr).catch(() => null);
          attempts++;
        }
        info = {
          type: oi?.type ?? oracleTypeForCollateral(collSym), // 미검증/상한초과 → 심볼 휴리스틱(verified=false 로 표시)
          provider: oi?.verified ? oi.provider : null,
          description: oi?.description ?? null,
          verified: oi?.verified ?? false,
        };
        seen.set(key, info);
      }
      // meta.oracle = 종류 문자열(GraphCanvas omkt.oracle 입력). 나머지는 hover/감사용.
      n.meta = { ...n.meta, oracle: info.type, oracleProvider: info.provider, oracleDescription: info.description, oracleVerified: info.verified };
    }
  }

  // ⑥''' 언더라잉/배킹 체인 — "토큰이 무엇으로 구성되는가"를 언더라잉 토큰→기반→venue 단일노드 체인으로(backed_by).
  //   weETH→eETH→ETH→EigenLayer. 프로토콜 껍데기 안 만든다(중복 방지) — 프론트 backed_by 블록이 단일노드 체인으로 렌더.
  //   기반(ETH)·venue(EigenLayer) id 체인 공유 → 형제 토큰이 같은 노드로 모임. venue tvl=DeFiLlama.
  {
    const sym = viewedSymbolOf(tokenId).toLowerCase();
    const steps = UNDERLYING_CHAIN[sym];
    if (steps?.length) {
      let prevId = tokenId;
      for (const s of steps) {
        const id = s.kind === "venue" ? marketNodeId(s.venueSlug!, "backing", chain) : `legochain:${s.symbol.toLowerCase()}@${chain}`;
        let meta: Record<string, unknown>;
        if (s.kind === "venue") {
          const tvl = await backingTvlUsd(s.venueSlug!);
          meta = { kind: "backing", venue: s.symbol, brandSlug: s.brandSlug, upstreamBacking: true, sizeUsd: tvl, category: `${s.symbol} · 상류 배킹(공유 기반)` };
        } else if (s.kind === "base") {
          meta = { kind: "underlying", baseAsset: true, brandSlug: s.brandSlug, symbol: s.symbol, category: `${s.symbol} · 기반 자산(궁극 언더라잉)` };
        } else {
          meta = { kind: "underlying", brandSlug: s.brandSlug, address: s.address, symbol: s.symbol, category: `${s.symbol} · 언더라잉 토큰` };
        }
        addMarket(id, s.brandSlug, s.symbol, meta);
        addEdge(prevId, id, "backed_by", null, { source: "underlying-registry", symbol: s.symbol, stepKind: s.kind, ...(s.address ? { address: s.address } : {}) });
        prevId = id;
      }
    }
  }

  // ⑦ 종착 표식 — 다음 홉(예치방향 out엣지)이 없는 노드가 "설계상 진짜 끝"인지 데이터로 확정해 meta 에 얹는다.
  //    트리에서 '끝(종착)'과 '단절(미완)'을 구분하기 위함(감사관 [추궁]). 판정 로직은 types.computeTerminalMark
  //    한 곳에 모았다(snapshot-lego ⑦ 와 backfill-terminal 가 동일 규칙 공유 — 전역 정합).
  const outSrc = new Set([...edges.values()].map((e) => e.src));
  const inStakedIn = new Set([...edges.values()].filter((e) => e.relation === "staked_in").map((e) => e.dst));
  const viewedSym = viewedSymbolOf(tokenId);
  for (const n of nodes.values()) {
    const mark = computeTerminalMark(n, outSrc.has(n.id), inStakedIn.has(n.id), viewedSym);
    if (mark) n.meta = { ...n.meta, ...mark };
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** token:sUSDe / token:sUSDe@base → "sUSDe" (종착 이유 문구의 기초자산 이름용). */
function viewedSymbolOf(tokenId: string): string {
  return tokenId.replace(/^token:/i, "").split("@")[0];
}

/**
 * ⑥' vault_allocations 조인 — 이 토큰을 담보로 받는 Morpho 마켓에 큐레이터·per-curator supply 를 얹는다.
 *   매칭키 = (담보심볼|대출심볼|LLTV3). vault_allocations.market_key = `{coll}|{loan}|{lltvWei}`,
 *   lego 마켓 meta.lltv = 소수(0.915), 담보 = 마켓 id 의 collateral 주소 → 파생/베이스 노드 심볼로 해석.
 *
 *   ★커버리지 확장(회장 작업2)★: 기존엔 collateral=viewed(베이스 심볼)로만 조인해 베이스-담보 마켓만 매칭됐다.
 *   하지만 한 토큰 맵의 Morpho 마켓은 담보가 베이스(USDe)뿐 아니라 파생(sUSDe·PT-sUSDE…)이기도 하다.
 *   → 이 맵에 실재하는 모든 담보 심볼(베이스+파생 노드 심볼)로 vault_allocations 를 한 번에 끌어와
 *      (담보|대출|LLTV3) 3중키로 마켓별 정확 조인한다. 담보를 키에 넣어 cross-collateral 오염을 막는다(결정론).
 *
 *   취약키 정밀화: 대출 심볼은 대소문자·공백 정규화 + 별칭(USD₮0/USDT0→USDT 등) 맞춤,
 *   LLTV 는 wei·소수 어느 쪽이든 3자리 키로 통일. 매칭 실패 마켓은 손대지 않음(추측 금지).
 *   meta.curators = supply 큰 순 큐레이터(중복 제거, 상한 4) — addMarketNode 볼트 부채꼴 입력.
 *   meta.curatorAllocs = [{curator, vault, supplyUsd}] — overlay 가 큐레이터 볼트 엣지 weight 로 실음.
 */
async function attachCurators(chain: string, collateralSym: string, nodes: Map<string, LegoNode>): Promise<void> {
  const morphoMkts = [...nodes.values()].filter((n) => n.kind === "market" && n.protocol === "morpho_blue" && n.chain === chain);
  if (!morphoMkts.length) return;

  // 마켓 담보 주소 → 심볼: 베이스 토큰(viewed) + 파생 노드(symbol). 주소는 마켓 id 에서 추출.
  //   id = legomkt:morpho_blue:{collAddr}-{loanAddr}@chain → collAddr.
  const symByAddr = new Map<string, string>();
  for (const n of nodes.values()) {
    if (n.kind === "derivative" && n.address && n.symbol) symByAddr.set(n.address.toLowerCase(), n.symbol);
  }
  const collOfMarket = (m: LegoNode): { addr: string | null; sym: string | null } => {
    const mm = /^legomkt:[^:]+:([^-@]+)-/.exec(m.id);
    const addr = mm ? mm[1].toLowerCase() : null;
    // 파생 심볼 우선, 없으면 베이스(이 토큰을 직접 담보로 받는 마켓 = collateralSym).
    const sym = (addr && symByAddr.get(addr)) ?? collateralSym;
    return { addr, sym };
  };

  // 이 맵의 모든 담보 심볼(베이스 + 파생) — vault_allocations 단일 질의 IN 절.
  const collSyms = new Set<string>([collateralSym]);
  for (const m of morphoMkts) { const s = collOfMarket(m).sym; if (s) collSyms.add(s); }

  const r = await query<{ market_key: string; collateral: string; curator: string; vault_name: string; supply_usd: number }>(
    `SELECT DISTINCT ON (vault_address, market_key) market_key, collateral, curator, vault_name, supply_usd
     FROM vault_allocations
     WHERE chain = $1 AND UPPER(collateral) = ANY($2::text[])
     ORDER BY vault_address, market_key, snapshot_ts DESC`,
    [chain, [...collSyms].map((s) => s.toUpperCase())],
  );
  if (!r.rows.length) return;

  // (담보|대출|lltv3) → 큐레이터 할당 목록. 담보를 키에 포함해 다른 담보 마켓 오염 차단.
  const byKey = new Map<string, { curator: string; vault: string; supplyUsd: number }[]>();
  for (const row of r.rows) {
    if ((row.supply_usd ?? 0) <= 0) continue;
    const parts = row.market_key.split("|"); // {coll}|{loan}|{lltvWei}
    // 담보 키는 market_key 의 coll 보다 collateral 컬럼을 신뢰(둘 다 같지만 컬럼이 정본).
    const coll = loanKey(row.collateral || parts[0]);
    const loan = loanKey(parts[1]);
    const lltv3 = lltvKey(parts[2]);
    if (!coll || !loan || !lltv3) continue;
    const key = `${coll}|${loan}|${lltv3}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ curator: row.curator, vault: row.vault_name, supplyUsd: row.supply_usd });
  }
  for (const m of morphoMkts) {
    const coll = loanKey(collOfMarket(m).sym ?? "");
    const loan = loanKey(String(m.meta.loan ?? ""));
    const lltv3 = m.meta.lltv != null ? lltvKey(String(Number(m.meta.lltv) >= 1e15 ? m.meta.lltv : Number(m.meta.lltv) * 1e18)) : "";
    if (!coll || !loan || !lltv3) continue;
    const allocs = byKey.get(`${coll}|${loan}|${lltv3}`);
    if (!allocs || !allocs.length) continue;
    const sorted = [...allocs].sort((a, b) => b.supplyUsd - a.supplyUsd);
    const curators = [...new Set(sorted.map((a) => a.curator).filter((c) => c && c !== "Unknown"))].slice(0, 4);
    // ★ 쓰기시점 sizeUsd 무결성 검증(회장 작업1) ★
    //   마켓 sizeUsd(=Morpho supplyAssetsUsd) 와 그 마켓에 공급한 큐레이터 볼트 supply 합을 대조한다.
    //   MetaMorpho 볼트 공급은 마켓 총공급의 부분집합이라 sumAllocs ≤ sizeUsd 가 정상 — 자릿수(10배) 이상
    //   엇나가면 스케일 손상 의심으로 meta._sizeMismatch 플래그(렌더는 막지 않되 사람이 추적 가능하게 기록).
    //   추측 없음: 두 값 다 이미 DB 의 무료 소스(Morpho GraphQL·vault_allocations) 실측치.
    const sumAllocs = sorted.reduce((s, a) => s + (a.supplyUsd > 0 ? a.supplyUsd : 0), 0);
    const sizeUsd = typeof m.meta.sizeUsd === "number" ? m.meta.sizeUsd : null;
    let sizeMismatch: { sizeUsd: number; sumCuratorSupplyUsd: number; ratio: number } | undefined;
    if (sizeUsd != null && sizeUsd > 0 && sumAllocs > 0) {
      // 볼트 합이 마켓 규모보다 10배 이상 크면(=sizeUsd 가 비정상적으로 작음) 스케일 손상 의심.
      const ratio = sumAllocs / sizeUsd;
      if (ratio > 10) {
        sizeMismatch = { sizeUsd, sumCuratorSupplyUsd: sumAllocs, ratio };
        console.warn(`[lego] sizeUsd 무결성 경고 ${m.id}: sizeUsd ${sizeUsd.toFixed(0)} ≪ 큐레이터 공급합 ${sumAllocs.toFixed(0)} (×${ratio.toFixed(1)}) — 스케일 손상 의심`);
      }
    }
    m.meta = {
      ...m.meta,
      curators,
      curatorAllocs: sorted.slice(0, 4).map((a) => ({ curator: a.curator, vault: a.vault, supplyUsd: a.supplyUsd })),
      ...(sizeMismatch ? { _sizeMismatch: sizeMismatch } : {}),
    };
  }
}

/** 대출/담보 심볼 정규화 — 대문자·공백제거 + 흔한 별칭 통일(USDT0/USD₮0→USDT). 결정론적 동치 비교용. */
function loanKey(sym: string | undefined): string {
  if (!sym) return "";
  let s = sym.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  s = s.replace(/₮/g, "T"); // USD₮ → USDT 표기 흡수
  const ALIAS: Record<string, string> = { USDT0: "USDT", "USD₮0": "USDT" };
  return ALIAS[s] ?? s;
}

/** LLTV wei("915000000000000000") → 소수 3자리 키("0.915"). lego 마켓 meta.lltv(0.915) 와 맞춤. */
function lltvKey(wei: string | number | undefined): string {
  const n = Number(wei);
  if (!Number.isFinite(n) || n <= 0) return "";
  return (n / 1e18).toFixed(3);
}

async function persist(t: TokenRow, nodes: LegoNode[], edges: LegoEdge[]): Promise<void> {
  // replace 갱신: 이 토큰의 파생노드 + 그 노드가 닿는 엣지 + 토큰 발 엣지를 지우고 새로 적재
  // (만기 PT·해체된 풀이 자연 소멸). protocol 허브 노드는 공유라 upsert 만.
  await query(
    `DELETE FROM lego_edges WHERE src = $1
       OR src IN (SELECT id FROM lego_nodes WHERE parent_token = $1)
       OR dst IN (SELECT id FROM lego_nodes WHERE parent_token = $1)`,
    [t.node_id],
  );
  await query(`DELETE FROM lego_nodes WHERE parent_token = $1`, [t.node_id]);
  for (const n of nodes) {
    await query(
      `INSERT INTO lego_nodes (id, chain, address, kind, role, label, symbol, protocol, parent_token, meta, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, symbol = EXCLUDED.symbol, meta = EXCLUDED.meta, updated_at = now()`,
      [n.id, n.chain, n.address, n.kind, n.role, n.label, n.symbol, n.protocol, n.parentToken, JSON.stringify(n.meta)],
    );
  }
  for (const e of edges) {
    await query(
      `INSERT INTO lego_edges (src, dst, relation, chain, weight_usd, evidence, snapshot_ts)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (src, dst, relation) DO UPDATE SET weight_usd = EXCLUDED.weight_usd, evidence = EXCLUDED.evidence, snapshot_ts = now()`,
      [e.src, e.dst, e.relation, e.chain, e.weightUsd, JSON.stringify(e.evidence)],
    );
  }
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  let symbols: string[];
  const topIdx = argv.indexOf("--top");
  if (topIdx >= 0) symbols = await topSymbols(Number(argv[topIdx + 1] ?? 12));
  else if (argv.length) symbols = argv;
  else symbols = await allSymbols(); // 기본 = 전체 watchlist (임의 토큰 일반화)

  console.log(`[lego] 대상 토큰 ${symbols.length}개: ${symbols.join(", ")}`);
  let totalNodes = 0, totalEdges = 0;
  for (const sym of symbols) {
    const rows = await tokensFor(sym);
    if (!rows.length) { console.log(`[lego] ${sym}: DB 토큰노드/주소 없음 — 건너뜀`); continue; }
    for (const t of rows) {
      try {
        const { nodes, edges } = await buildFor(t);
        await persist(t, nodes, edges);
        totalNodes += nodes.length; totalEdges += edges.length;
        const pt = nodes.filter((n) => n.role === "pt").length;
        const lp = nodes.filter((n) => n.role === "lp").length;
        const brg = nodes.filter((n) => n.role === "wrapper" && n.protocol === "bridge").length;
        const morpho = edges.filter((e) => e.relation === "collateral_at").length;
        const cvx = edges.filter((e) => e.relation === "staked_in").length;
        console.log(`[lego] ${t.node_id}: 노드 ${nodes.length} (PT ${pt}·LP ${lp}·브릿지래핑 ${brg}) · 엣지 ${edges.length} (담보 ${morpho}·Convex ${cvx})`);
      } catch (e) {
        console.error(`[lego] ${t.node_id} 실패:`, (e as Error).message);
      }
    }
  }
  console.log(`[lego] 완료 — 노드 ${totalNodes} · 엣지 ${totalEdges}`);
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
