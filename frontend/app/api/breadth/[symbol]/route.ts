import { NextResponse } from "next/server";

/**
 * GET /api/breadth/[symbol]  — 토큰 하나의 "전 체인 익스포저" 라이브 수집 (으아아악).
 *
 * DeFiLlama yields(/pools, 무료)에서 해당 토큰을 담은 모든 풀을 전 체인에서 긁어
 * (체인 × 프로토콜)별로 묶고, 각 프로토콜의 개별 마켓/풀(pools[]) 까지 그대로 돌려준다.
 * → 큐레이터가 Aave·Compound·DEX 등 모든 프로토콜의 세부 마켓/풀(담보·LP·APY·IL)을
 *   체인 막론하고 한 화면에서 본다. DB 정밀(Morpho 마켓/큐레이터)과 합쳐짐.
 * 온체인 미검증이라 그래프에선 점선(unverified)으로 정직 표시.
 *
 * 30분 캐시(revalidate) — 10MB 풀 목록 풀 다운로드를 토큰마다 매번 하지 않게.
 */

export const revalidate = 1800;

// DeFiLlama 체인명 → 우리 체인 키. 신규/L2/비-EVM 까지 폭넓게 — 신토큰일수록 비-이더리움
// 체인(MegaETH·Plasma·Hyperliquid·Solana 등)에 TVL 이 쏠려서, 안 매핑하면 익스포저를 통째로 놓침.
// 매핑 없는 체인만 제외(완전 듣보 체인 dust 컷). EVM 아닌 체인도 익스포저 정직성 위해 포함(토큰 로고만 폴백).
const CHAIN_MAP: Record<string, string> = {
  Ethereum: "ethereum", Arbitrum: "arbitrum", Base: "base", "OP Mainnet": "optimism", Optimism: "optimism",
  Polygon: "polygon", "Polygon zkEVM": "polygon-zkevm", Avalanche: "avalanche", BSC: "bsc", Gnosis: "gnosis",
  Linea: "linea", Scroll: "scroll", "ZKsync Era": "zksync", Mantle: "mantle", Mode: "mode", Blast: "blast",
  Sonic: "sonic", Fraxtal: "fraxtal", Unichain: "unichain", Ink: "ink", Soneium: "soneium", "World Chain": "wc",
  Taiko: "taiko", Manta: "manta", Celo: "celo", Cronos: "cronos", Kava: "kava", Bob: "bob", Flare: "flare",
  Berachain: "berachain", Sei: "sei", Katana: "katana", Plasma: "plasma", "Hyperliquid L1": "hyperliquid",
  HyperEVM: "hyperliquid", Monad: "monad", MegaETH: "megaeth", "Plume Mainnet": "plume", Plume: "plume",
  Pharos: "pharos", Hemi: "hemi", Swellchain: "swell", Corn: "corn", Lisk: "lisk", Metis: "metis",
  Rootstock: "rootstock", Opbnb: "opbnb", Abstract: "abstract",
  // 비-EVM (익스포저 완결성 — 토큰 로고는 폴백). Solana/Sui 는 USDC/USDe 의 핵심 체인.
  Solana: "solana", Sui: "sui", Aptos: "aptos", Starknet: "starknet", Osmosis: "osmosis", Tron: "tron",
  Stellar: "stellar", Stacks: "stacks", Near: "near", TON: "ton",
};

// 검증된 정식주소 오버라이드 — DeFiLlama 풀 메타로 주소를 못 얻는 비-EVM 핵심 배포분
// (USDT@tron ~$89B 등 무한민팅 감시 필수 체인). 전부 해당 체인 RPC totalSupply 직독으로 검증된 주소만 등재.
const ADDR_OVERRIDES: Record<string, Record<string, string>> = {
  USDT: { tron: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", solana: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  USDC: { solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", sui: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC" },
  USDE: { solana: "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT" },
};

const CHAIN_TVL_MIN = 250_000;   // 체인 단위 dust 컷 (낮춤 — 더 많은 체인)
const PROTO_TVL_MIN = 20_000;    // 프로토콜 단위 dust 컷 (낮춤)
const MAX_CHAINS = 12;           // 상위 체인 (늘림)
const POOLS_PER_PROTO = 12;      // 프로토콜당 마켓/풀 상한 (늘림 — 단일체인 뷰에서 깊게)

interface Pool {
  chain?: string; project?: string; symbol?: string; tvlUsd?: number;
  apy?: number | null; apyBase?: number | null; apyReward?: number | null;
  exposure?: string | null; ilRisk?: string | null; poolMeta?: string | null;
  stablecoin?: boolean; underlyingTokens?: string[] | null; category?: string | null;
}
export interface BreadthPool {
  symbol: string; tvlUsd: number; apy: number | null; apyBase: number | null; apyReward: number | null;
  exposure: string | null; ilRisk: string | null; poolMeta: string | null; stablecoin: boolean;
}
export interface BreadthItem { chain: string; project: string; tvlUsd: number; category: string | null; pools: BreadthPool[] }
export interface MorphoMkt { loan: string; collateral: string; lltv: number | null; supplyUsd: number; utilization: number | null; ouroboros: boolean; vaults: string[]; role: "collateral" | "supply" }
export interface EulerVault { name: string; curator: string | null; allocationUsd: number }

// chainId → 우리 체인 키 (Morpho chain.id 가 가장 확실 — network 는 "OP Mainnet" 같은 표시명이라 매칭 깨짐)
const CHAINID_KEY: Record<number, string> = {
  1: "ethereum", 10: "optimism", 56: "bsc", 100: "gnosis", 130: "unichain", 137: "polygon", 143: "monad",
  146: "sonic", 252: "fraxtal", 480: "wc", 1135: "lisk", 1868: "soneium", 5000: "mantle", 8453: "base",
  34443: "mode", 42161: "arbitrum", 43114: "avalanche", 57073: "ink", 59144: "linea", 60808: "bob",
  80094: "berachain", 534352: "scroll", 747474: "katana", 999: "hyperliquid", 21000000: "corn",
};
const NAME_KEY: Record<string, string> = { "OP Mainnet": "optimism", "Arbitrum One": "arbitrum" };
const morphoChainKey = (id?: number, net?: string) =>
  (id != null && CHAINID_KEY[id]) || (net && NAME_KEY[net]) || (net || "").toLowerCase().split(" ")[0] || null;
// (sameFamily 제거 — ouroboros 신호 전면 제외)

type MItem = { lltv?: string; loanAsset?: { symbol?: string }; collateralAsset?: { symbol?: string }; state?: { supplyAssetsUsd?: number; collateralAssetsUsd?: number; utilization?: number }; chain?: { id?: number; network?: string }; supplyingVaults?: { name?: string }[] };
async function morphoQuery(filter: string, addrs: string[], revalidateS: number): Promise<MItem[]> {
  const query = `{ markets(first: 300, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { ${filter}: ${JSON.stringify(addrs)} }) { items { lltv loanAsset { symbol } collateralAsset { symbol } state { supplyAssetsUsd collateralAssetsUsd utilization } chain { id network } supplyingVaults { name } } } }`;
  try {
    const r = await fetch("https://blue-api.morpho.org/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), next: { revalidate: revalidateS } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.data?.markets?.items ?? []) as MItem[];
  } catch { return []; }
}

// 토큰이 담보 OR 공급(loan)인 Morpho 마켓을 전 체인에서. 토큰 종류에 따라 익스포저 측이 다름:
//  담보형(wstETH 등) → collateralAssetsUsd(잠긴 토큰), 공급형(USDe·USDC 등) → supplyAssetsUsd(공급된 토큰).
async function fetchMorphoMarkets(addrs: string[], revalidateS: number): Promise<Record<string, MorphoMkt[]>> {
  if (!addrs.length) return {};
  const out: Record<string, MorphoMkt[]> = {};
  const [asColl, asLoan] = await Promise.all([
    morphoQuery("collateralAssetAddress_in", addrs, revalidateS),
    morphoQuery("loanAssetAddress_in", addrs, revalidateS),
  ]);
  const push = (m: MItem, role: "collateral" | "supply") => {
    const chain = morphoChainKey(m.chain?.id, m.chain?.network);
    const loan = m.loanAsset?.symbol ?? "?", coll = m.collateralAsset?.symbol ?? "?";
    const size = role === "collateral" ? (m.state?.collateralAssetsUsd ?? 0) : (m.state?.supplyAssetsUsd ?? 0);
    if (!chain || size <= 0) return;
    (out[chain] ??= []).push({
      loan, collateral: coll, lltv: m.lltv ? Number(m.lltv) / 1e18 : null,
      supplyUsd: size, utilization: m.state?.utilization ?? null, ouroboros: false, role,
      vaults: (m.supplyingVaults ?? []).map((v) => v.name ?? "").filter(Boolean).slice(0, 5),
    });
  };
  for (const m of asColl) push(m, "collateral");
  for (const m of asLoan) push(m, "supply");
  for (const k of Object.keys(out)) { // 같은 마켓 양쪽 매칭 dedupe + 규모순
    const seen = new Set<string>();
    out[k] = out[k].filter((m) => { const key = `${m.collateral}/${m.loan}/${m.lltv}`; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => b.supplyUsd - a.supplyUsd);
  }
  return out;
}

// ── Euler Earn 큐레이터 볼트 (비-Morpho 큐레이터) — 공용 Goldsky 서브그래프 (무키, 멀티체인) ──
// 슬러그 전수 프로브(2026-06-10): 실볼트 sonic·avalanche·bsc·unichain·swell·linea·plasma(+기존 3),
// 빈 응답(미래 대비 포함) berachain·bob·gnosis·optimism·ink·hyperevm·worldchain. avax·polygon 슬러그는 404.
const eulerSub = (slug: string) => `https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-${slug}/latest/gn`;
const EULER_ENDPOINTS: Record<string, string> = {
  ethereum: eulerSub("mainnet"), base: eulerSub("base"), arbitrum: eulerSub("arbitrum"),
  sonic: eulerSub("sonic"), avalanche: eulerSub("avalanche"), bsc: eulerSub("bsc"),
  berachain: eulerSub("berachain"), unichain: eulerSub("unichain"), swell: eulerSub("swell"),
  bob: eulerSub("bob"), gnosis: eulerSub("gnosis"), optimism: eulerSub("optimism"),
  linea: eulerSub("linea"), ink: eulerSub("ink"), hyperliquid: eulerSub("hyperevm"),
  plasma: eulerSub("plasma"), wc: eulerSub("worldchain"),
};

// DeFiLlama coins API — 토큰 가격+소수점 (Euler totalAssets 토큰단위 → USD 환산용)
// 비-EVM 도 llama coins 가 지원하는 체인 슬러그(solana:mint, sui:0x…::t::T, tron:T…, starknet, aptos)는
// 같이 조회 — 체인별 supplyUsd 환산에 쓰임. 모르는 키는 응답에서 빠질 뿐(무해).
const NONEVM_PRICE_CHAINS = new Set(["solana", "sui", "tron", "starknet", "aptos"]);
async function fetchTokenPrices(addrByChain: Record<string, string>, revalidateS: number): Promise<Record<string, { price: number; decimals: number }>> {
  const keys = Object.entries(addrByChain).filter(([c, a]) => /^0x[0-9a-fA-F]{40}$/.test(a) || NONEVM_PRICE_CHAINS.has(c)).map(([c, a]) => `${c}:${a}`);
  if (!keys.length) return {};
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}`, { next: { revalidate: revalidateS } });
    if (!r.ok) return {};
    const j = (await r.json()) as { coins?: Record<string, { price?: number; decimals?: number }> };
    const out: Record<string, { price: number; decimals: number }> = {};
    for (const [k, v] of Object.entries(j.coins ?? {})) {
      if (v.price != null && v.decimals != null) out[k.split(":")[0]] = { price: v.price, decimals: v.decimals };
    }
    return out;
  } catch { return {}; }
}

async function fetchEulerVaults(addrByChain: Record<string, string>, prices: Record<string, { price: number; decimals: number }>, revalidateS: number): Promise<Record<string, EulerVault[]>> {
  const out: Record<string, EulerVault[]> = {};
  const chains = Object.keys(addrByChain).filter((c) => EULER_ENDPOINTS[c] && /^0x[0-9a-fA-F]{40}$/.test(addrByChain[c]) && prices[c]);
  await Promise.all(chains.map(async (chain) => {
    const addr = addrByChain[chain].toLowerCase();
    const query = `{ eulerEarnVaults(first: 50, where: { asset: "${addr}" }) { name curator totalAssets } }`;
    try {
      const r = await fetch(EULER_ENDPOINTS[chain], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), next: { revalidate: revalidateS } });
      if (!r.ok) return;
      const j = (await r.json()) as { data?: { eulerEarnVaults?: { name?: string; curator?: string; totalAssets?: string }[] } };
      const { price, decimals } = prices[chain];
      const vaults: EulerVault[] = (j.data?.eulerEarnVaults ?? [])
        .map((v) => ({
          name: v.name || "Euler Earn vault",
          curator: v.curator && !/^0x0+$/.test(v.curator) ? v.curator : null,
          allocationUsd: (Number(v.totalAssets ?? 0) / Math.pow(10, decimals)) * price,
        }))
        .filter((v) => v.allocationUsd >= 50_000)
        .sort((a, b) => b.allocationUsd - a.allocationUsd);
      if (vaults.length) out[chain] = vaults;
    } catch { /* skip chain */ }
  }));
  return out;
}

// ── 체인별 온체인 총공급(eth_call totalSupply) — Alchemy 우선(신뢰도/레이트), publicnode 폴백 ──
// 토큰의 *모든* 체인 supply 를 직접 읽어야 크로스체인 무담보/무한민팅을 잡는다(DeFiLlama 추정 아님, 면담 #1 신호).
// 체인 발견(어디 있나·주소)=DeFiLlama, 값=on-chain. 비-EVM(Sui/Solana/Tron 등)은 eth_call 불가 → 생략(별도 RPC 필요).
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
// Alchemy 지원 EVM 체인 → 네트워크 서브도메인 (실키로 eth_chainId 응답 전수 검증됨). 한 키로 전부 커버.
const ALCHEMY_SLUG: Record<string, string> = {
  ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet", optimism: "opt-mainnet",
  polygon: "polygon-mainnet", avalanche: "avax-mainnet", bsc: "bnb-mainnet", gnosis: "gnosis-mainnet",
  linea: "linea-mainnet", scroll: "scroll-mainnet", zksync: "zksync-mainnet", mantle: "mantle-mainnet",
  blast: "blast-mainnet", berachain: "berachain-mainnet", unichain: "unichain-mainnet", sonic: "sonic-mainnet",
  soneium: "soneium-mainnet", ink: "ink-mainnet", wc: "worldchain-mainnet",
  metis: "metis-mainnet", celo: "celo-mainnet", sei: "sei-mainnet", fraxtal: "frax-mainnet",
  "polygon-zkevm": "polygonzkevm-mainnet", monad: "monad-mainnet", rootstock: "rootstock-mainnet",
  opbnb: "opbnb-mainnet", abstract: "abstract-mainnet",
};
// publicnode 폴백(무료, 키 불요) — Alchemy 미지원 체인 + Alchemy 일시 실패 시.
const PUBLIC_RPC: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com", base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com", optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com", gnosis: "https://gnosis-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com", avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
  linea: "https://linea-rpc.publicnode.com", scroll: "https://scroll-rpc.publicnode.com",
  mantle: "https://mantle-rpc.publicnode.com", sonic: "https://sonic-rpc.publicnode.com",
  unichain: "https://unichain-rpc.publicnode.com", berachain: "https://berachain-rpc.publicnode.com",
  blast: "https://blast-rpc.publicnode.com", zksync: "https://zksync-evm-rpc.publicnode.com",
  mode: "https://mode-rpc.publicnode.com", fraxtal: "https://fraxtal-rpc.publicnode.com",
  metis: "https://metis-rpc.publicnode.com", celo: "https://celo-rpc.publicnode.com",
  // 신규/누락 EVM (실키/엔드포인트로 검증). megaeth·plasma·hyperliquid 는 신토큰 쏠림 체인.
  hyperliquid: "https://rpc.hyperliquid.xyz/evm", plasma: "https://rpc.plasma.to", megaeth: "https://carrot.megaeth.com/rpc",
};
/** 체인 RPC 후보 — Alchemy(키 있으면) 우선, publicnode 폴백. 순서대로 시도. */
function rpcUrlsFor(chain: string): string[] {
  const urls: string[] = [];
  if (ALCHEMY_KEY && ALCHEMY_SLUG[chain]) urls.push(`https://${ALCHEMY_SLUG[chain]}.g.alchemy.com/v2/${ALCHEMY_KEY}`);
  if (PUBLIC_RPC[chain]) urls.push(PUBLIC_RPC[chain]);
  return urls;
}
async function callTotalSupply(url: string, token: string, revalidateS: number): Promise<string | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: "0x18160ddd" }, "latest"] }), next: { revalidate: revalidateS } });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string };
    return j.result && j.result !== "0x" ? j.result : null;
  } catch { return null; }
}
/** ERC20 decimals() 온체인 직독 — llama 가격(=decimals 메타)이 없는 체인용. */
async function callDecimals(url: string, token: string, revalidateS: number): Promise<number | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: "0x313ce567" }, "latest"] }), next: { revalidate: revalidateS } });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string };
    if (!j.result || j.result === "0x") return null;
    const d = Number(BigInt(j.result));
    return Number.isFinite(d) && d >= 0 && d <= 36 ? d : null;
  } catch { return null; }
}
// ── 비-EVM supply — eth_call 안 되는 체인은 체인별 RPC·메서드로 직접 (면담 "전 체인" 요구: Solana/Sui) ──
const SOLANA_RPC = ALCHEMY_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "https://api.mainnet-beta.solana.com";
// Alchemy 가 Sui 도 지원(suix_* JSON-RPC 검증됨) → 같은 키로. 공개 풀노드는 폴백.
const SUI_RPC = ALCHEMY_KEY ? `https://sui-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "https://fullnode.mainnet.sui.io:443";
const SUI_RPC_FALLBACK = "https://fullnode.mainnet.sui.io:443";

/** Solana SPL totalSupply — getTokenSupply(mint). uiAmount = decimals 반영된 값. Alchemy→public 폴백. */
async function solanaSupply(mint: string, revalidateS: number): Promise<number | null> {
  for (const url of [SOLANA_RPC, "https://api.mainnet-beta.solana.com"]) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [mint] }), next: { revalidate: revalidateS } });
      if (!r.ok) continue;
      const j = (await r.json()) as { result?: { value?: { uiAmount?: number | null } } };
      const ui = j.result?.value?.uiAmount;
      if (ui != null && ui > 0) return ui;
    } catch { /* try next */ }
  }
  return null;
}

/** Sui coin totalSupply — suix_getTotalSupply(coinType) raw + suix_getCoinMetadata decimals. */
async function suiSupply(coinType: string, revalidateS: number): Promise<number | null> {
  for (const url of [SUI_RPC, SUI_RPC_FALLBACK]) {
    try {
      const tot = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "suix_getTotalSupply", params: [coinType] }), next: { revalidate: revalidateS } });
      if (!tot.ok) continue;
      const tj = (await tot.json()) as { result?: { value?: string } };
      const raw = tj.result?.value;
      if (raw == null) continue;
      let decimals = 9;
      try {
        const meta = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "suix_getCoinMetadata", params: [coinType] }), next: { revalidate: revalidateS } });
        const mj = (await meta.json()) as { result?: { decimals?: number } };
        if (mj.result?.decimals != null) decimals = mj.result.decimals;
      } catch { /* default 9 */ }
      const supply = Number(BigInt(raw)) / Math.pow(10, decimals);
      if (supply > 0) return supply;
    } catch { /* try next */ }
  }
  return null;
}

/** Tron TRC20 totalSupply — TronGrid triggerconstantcontract(EVM 셀렉터 totalSupply()/decimals(), visible:true 로 base58 직접).
 *  Tron USDT(~$89B)는 최대 단일 스테이블 배포 → 무한민팅 감시 필수. 값=온체인(EVM 과 동일 원칙). */
async function tronSupply(contract: string, revalidateS: number): Promise<number | null> {
  const call = async (selector: string): Promise<bigint | null> => {
    try {
      const r = await fetch("https://api.trongrid.io/wallet/triggerconstantcontract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_address: contract, contract_address: contract, function_selector: selector, visible: true }),
        next: { revalidate: revalidateS },
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { constant_result?: string[] };
      const hex = j.constant_result?.[0];
      return hex && /^[0-9a-fA-F]+$/.test(hex) ? BigInt("0x" + hex) : null;
    } catch { return null; }
  };
  const [rawSupply, rawDec] = await Promise.all([call("totalSupply()"), call("decimals()")]);
  if (rawSupply == null) return null;
  const decimals = rawDec != null ? Number(rawDec) : 6; // Tron USDT/USDC = 6
  const supply = Number(rawSupply) / Math.pow(10, decimals);
  return supply > 0 ? supply : null;
}

/** Aptos totalSupply — view 콜. Alchemy(키, /v1 REST 검증됨) 우선, 공개 풀노드 폴백.
 *  FA 표준(fungible_asset::supply, 0x64hex object) + 레거시 coin 표준(coin::supply<T>, 0x…::mod::T). */
const APTOS_VIEW_URLS = [
  ...(ALCHEMY_KEY ? [`https://aptos-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}/v1/view`] : []),
  "https://fullnode.mainnet.aptoslabs.com/v1/view",
];
async function aptosSupply(token: string, revalidateS: number): Promise<number | null> {
  const view = async (fn: string, typeArgs: string[], args: string[]): Promise<unknown[] | null> => {
    for (const NODE of APTOS_VIEW_URLS) {
      try {
        const r = await fetch(NODE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ function: fn, type_arguments: typeArgs, arguments: args }), next: { revalidate: revalidateS } });
        if (!r.ok) continue;
        return (await r.json()) as unknown[];
      } catch { /* 다음 노드 */ }
    }
    return null;
  };
  const isCoin = token.includes("::");
  const [supFn, decFn, ta, ar]: [string, string, string[], string[]] = isCoin
    ? ["0x1::coin::supply", "0x1::coin::decimals", [token], []]
    : ["0x1::fungible_asset::supply", "0x1::fungible_asset::decimals", ["0x1::fungible_asset::Metadata"], [token]];
  const [sup, dec] = await Promise.all([view(supFn, ta, ar), view(decFn, ta, ar)]);
  const rawSupply = (sup?.[0] as { vec?: string[] } | undefined)?.vec?.[0] ?? null;
  if (rawSupply == null) return null;
  const decimals = dec?.[0] != null ? Number(dec[0]) : 6;
  const supply = Number(BigInt(rawSupply)) / Math.pow(10, decimals);
  return supply > 0 ? supply : null;
}

// ── Starknet ERC20 totalSupply — starknet_call(Alchemy 지원·실키 검증: ETH/USDC 응답 확인) ──
// sn_keccak(이름) = keccak256 하위 250비트. 라이브 검증값을 상수로 고정(camelCase·snake_case 둘 다 존재).
const STARKNET_RPCS = [
  ...(ALCHEMY_KEY ? [`https://starknet-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`] : []),
  "https://free-rpc.nethermind.io/mainnet-juno",
];
const SN_SEL = {
  totalSupply: "0x80aa9fdbfaf9615e4afc7f5f722e265daca5ccc655360fa5ccacf9c267936d",
  total_supply: "0x1557182e4359a1f0c6301278e8f5b35a776ab58d39892581e357578fb287836",
  decimals: "0x4c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9",
};
async function starknetCall(url: string, token: string, selector: string, revalidateS: number): Promise<string[] | null> {
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_call", params: [{ contract_address: token, entry_point_selector: selector, calldata: [] }, "latest"] }),
      next: { revalidate: revalidateS },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string[] };
    return Array.isArray(j.result) ? j.result : null;
  } catch { return null; }
}
/** Starknet ERC20 totalSupply — 반환 Uint256 = [low, high] 2펠트. */
async function starknetSupply(token: string, revalidateS: number): Promise<number | null> {
  for (const url of STARKNET_RPCS) {
    for (const sel of [SN_SEL.totalSupply, SN_SEL.total_supply]) {
      const res = await starknetCall(url, token, sel, revalidateS);
      if (!res?.length) continue;
      const raw = BigInt(res[0] ?? "0x0") + (BigInt(res[1] ?? "0x0") << 128n);
      if (raw <= 0n) continue;
      const dec = await starknetCall(url, token, SN_SEL.decimals, revalidateS);
      const decimals = dec?.[0] ? Number(BigInt(dec[0])) : 18;
      const supply = Number(raw) / Math.pow(10, decimals);
      if (supply > 0) return supply;
    }
  }
  return null;
}

// (TON supply 리더 없음 — Alchemy 가 TON 을 지원하지 않음(대시보드 전수 확인). TON 익스포저는
//  DeFiLlama 풀 매핑(CHAIN_MAP)으로만 표시, 온체인 supply 검증은 비대상.)

export interface ChainSupply { supply: number; supplyUsd: number }
async function fetchChainSupplies(addrByChain: Record<string, string>, prices: Record<string, { price: number; decimals: number }>, revalidateS: number): Promise<Record<string, ChainSupply>> {
  const out: Record<string, ChainSupply> = {};
  // 토큰 가격은 체인 불문 ≈동일 → 비-EVM/미가격 EVM 은 레퍼런스 가격·소수점으로 USD 환산(supply 자체는 정확).
  const priced = Object.values(prices).filter((p) => p.price > 0);
  const refPrice = prices.ethereum?.price ?? (priced.length ? [...priced].map((p) => p.price).sort((a, b) => a - b)[Math.floor(priced.length / 2)] : 0);
  const refDecimals = prices.ethereum?.decimals ?? (priced[0]?.decimals ?? 18);
  const usd = (chain: string, supply: number) => supply * (prices[chain]?.price ?? refPrice);

  await Promise.all(Object.keys(addrByChain).map(async (chain) => {
    const addr = addrByChain[chain];
    // ① Solana (SPL mint = base58)
    if (chain === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
      const s = await solanaSupply(addr, revalidateS);
      if (s) out[chain] = { supply: s, supplyUsd: usd(chain, s) };
      return;
    }
    // ② Sui (coin type = 0x…::module::TYPE)
    if (chain === "sui" && addr.includes("::")) {
      const s = await suiSupply(addr, revalidateS);
      if (s) out[chain] = { supply: s, supplyUsd: usd(chain, s) };
      return;
    }
    // ②' Starknet (felt 주소 — EVM 40hex 보다 김)
    if (chain === "starknet" && /^0x[0-9a-fA-F]{10,64}$/.test(addr)) {
      const s = await starknetSupply(addr, revalidateS);
      if (s) out[chain] = { supply: s, supplyUsd: usd(chain, s) };
      return;
    }
    // ③ Tron (TRC20, base58 T…) — USDT $89B 최대 체인
    if (chain === "tron") {
      const s = await tronSupply(addr, revalidateS);
      if (s) out[chain] = { supply: s, supplyUsd: usd(chain, s) };
      return;
    }
    // ④ Aptos (FA object 0x64hex 또는 coin type 0x…::mod::T)
    if (chain === "aptos") {
      const s = await aptosSupply(addr, revalidateS);
      if (s) out[chain] = { supply: s, supplyUsd: usd(chain, s) };
      return;
    }
    // ⑤ EVM (eth_call totalSupply) — Alchemy→publicnode 폴백.
    // decimals: llama 메타 → 온체인 decimals() → 레퍼런스 순. ⚠️ 같은 심볼도 체인별 decimals 가 다름
    // (ETH USDT=6, BSC/opBNB/Rootstock USDT=18) — 레퍼런스만 믿으면 supply 가 1e12 배 튄다.
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || rpcUrlsFor(chain).length === 0) return;
    for (const url of rpcUrlsFor(chain)) {
      const hex = await callTotalSupply(url, addr, revalidateS);
      if (!hex) continue;
      const decimals = prices[chain]?.decimals ?? (await callDecimals(url, addr, revalidateS)) ?? refDecimals;
      const supply = Number(BigInt(hex)) / Math.pow(10, decimals);
      if (supply > 0) { out[chain] = { supply, supplyUsd: usd(chain, supply) }; return; }
    }
  }));
  return out;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const want = decodeURIComponent(symbol).toUpperCase();

  let pools: Pool[] = [];
  try {
    const res = await fetch("https://yields.llama.fi/pools", { next: { revalidate } });
    if (!res.ok) throw new Error(`llama ${res.status}`);
    const json = (await res.json()) as { data?: Pool[] };
    pools = json.data ?? [];
  } catch (e) {
    return NextResponse.json({ symbol: want, items: [], chains: [], tokenAddrByChain: {}, error: String(e) }, { status: 200 });
  }

  // 토큰을 "온전한 토큰"으로 포함하는 풀만 (WSTETH-WETH → [WSTETH,WETH] 매칭; 오탐 방지)
  const symMatches = pools.filter((p) => {
    const parts = (p.symbol ?? "").toUpperCase().split(/[-/\s+.]+/).filter(Boolean);
    return parts.includes(want);
  });

  // 정식 토큰 주소(체인별) — 단일자산(=실제 그 토큰) 풀 중 TVL 최대 기준(낮은 TVL 동명이토큰 콜리전 방지).
  const norm = (a: string) => (/^0x/i.test(a) ? a.toLowerCase() : a); // EVM 만 소문자, 비-EVM(Solana base58)은 그대로
  const canonByChain = new Map<string, Set<string>>();
  const tokenAddrByChain: Record<string, string> = {};
  const singles = symMatches
    .filter((p) => p.exposure === "single" && Array.isArray(p.underlyingTokens) && p.underlyingTokens.length === 1 && p.underlyingTokens[0])
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  for (const p of singles) {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain) continue;
    const addr = p.underlyingTokens![0]!;
    if (!canonByChain.has(chain)) canonByChain.set(chain, new Set());
    canonByChain.get(chain)!.add(norm(addr));
    if (!tokenAddrByChain[chain]) tokenAddrByChain[chain] = addr; // TVL 내림차순 정렬 → 첫 주소 = 최대 풀의 주소
  }
  // 2차: exposure 표기는 없지만 underlyingTokens 가 정확히 1개인 풀 — 비-EVM(Sui/Tron 등)은 풀 메타가
  // 부실해 1차(single 표기)에서 주소를 못 얻는 체인이 많다. 이미 resolve 된 체인은 건드리지 않음.
  const oneUnderlying = symMatches
    .filter((p) => Array.isArray(p.underlyingTokens) && p.underlyingTokens.length === 1 && p.underlyingTokens[0])
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  for (const p of oneUnderlying) {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain || tokenAddrByChain[chain]) continue;
    const addr = p.underlyingTokens![0]!;
    if (!canonByChain.has(chain)) canonByChain.set(chain, new Set());
    canonByChain.get(chain)!.add(norm(addr));
    tokenAddrByChain[chain] = addr;
  }
  // 3차: 검증된 오버라이드 — 풀 메타로 끝내 못 얻은 핵심 배포분만 채움 (USDT@tron 등).
  for (const [chain, addr] of Object.entries(ADDR_OVERRIDES[want] ?? {})) {
    if (tokenAddrByChain[chain]) continue;
    tokenAddrByChain[chain] = addr;
    if (!canonByChain.has(chain)) canonByChain.set(chain, new Set());
    canonByChain.get(chain)!.add(norm(addr));
  }

  // 주소 검증 — 같은 심볼 다른 토큰(콜리전) 제거. 그 체인의 정식주소를 아는 경우에만 검증
  // (모르면 심볼매치 유지 — 과필터로 정상 익스포저 누락 방지).
  const matches = symMatches.filter((p) => {
    const chain = CHAIN_MAP[p.chain ?? ""]; if (!chain) return false;
    const canon = canonByChain.get(chain);
    if (!canon || !canon.size) return true; // 정식주소 모름 → 유지
    const ut = (p.underlyingTokens ?? []).map(norm);
    return ut.length === 0 ? true : ut.some((a) => canon.has(a));
  });

  // (체인 × 프로토콜) 그룹 → 개별 풀 보존
  const byProto = new Map<string, { chain: string; project: string; category: string | null; raw: Pool[] }>();
  for (const p of matches) {
    const chain = CHAIN_MAP[p.chain ?? ""];
    if (!chain || !p.project) continue;
    const key = `${chain}|${p.project}`;
    const cur = byProto.get(key) ?? { chain, project: p.project, category: p.category ?? null, raw: [] };
    cur.raw.push(p);
    byProto.set(key, cur);
  }

  let items: BreadthItem[] = [...byProto.values()].map((g) => {
    const tvlUsd = g.raw.reduce((s, p) => s + (p.tvlUsd ?? 0), 0);
    const pools = g.raw
      .filter((p) => (p.tvlUsd ?? 0) > 0)
      .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
      .slice(0, POOLS_PER_PROTO)
      .map((p) => ({
        symbol: p.symbol ?? "?", tvlUsd: p.tvlUsd ?? 0,
        apy: p.apy ?? null, apyBase: p.apyBase ?? null, apyReward: p.apyReward ?? null,
        exposure: p.exposure ?? null, ilRisk: p.ilRisk ?? null, poolMeta: p.poolMeta ?? null, stablecoin: !!p.stablecoin,
      }));
    return { chain: g.chain, project: g.project, category: g.category, tvlUsd, pools };
  }).filter((x) => x.tvlUsd >= PROTO_TVL_MIN);

  // 체인별 TVL → dust 체인 제거 + 상위 MAX_CHAINS 만
  const chainTvl = new Map<string, number>();
  for (const it of items) chainTvl.set(it.chain, (chainTvl.get(it.chain) ?? 0) + it.tvlUsd);
  const keepChains = new Set(
    [...chainTvl.entries()].filter(([, v]) => v >= CHAIN_TVL_MIN).sort((a, b) => b[1] - a[1]).slice(0, MAX_CHAINS).map(([c]) => c),
  );
  items = items.filter((it) => keepChains.has(it.chain)).sort((a, b) => b.tvlUsd - a.tvlUsd);

  const chains = [...keepChains].map((c) => ({ chain: c, tvlUsd: chainTvl.get(c) ?? 0, protocols: items.filter((i) => i.chain === c).length }));

  // 전 체인 Morpho 마켓 (실제 LLTV·큐레이터) — DeFiLlama 집계 풀보다 정밀.
  // EVM 주소만 (Solana 등 비-EVM 주소는 Morpho Address 스칼라가 거부 → 쿼리 전체 실패하므로 제외).
  const evmAddrs = [...new Set(Object.values(tokenAddrByChain))].filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const [morphoMarkets, prices] = await Promise.all([
    fetchMorphoMarkets(evmAddrs, revalidate),
    fetchTokenPrices(tokenAddrByChain, revalidate),
  ]);
  // Euler Earn 큐레이터 볼트(비-Morpho) + 체인별 온체인 총공급(L2 브릿지 양 근사) — 둘 다 가격 필요, 병렬.
  const [eulerVaults, supplyByChain] = await Promise.all([
    fetchEulerVaults(tokenAddrByChain, prices, revalidate),
    fetchChainSupplies(tokenAddrByChain, prices, revalidate),
  ]);

  return NextResponse.json({ symbol: want, items, chains, tokenAddrByChain, morphoMarkets, eulerVaults, supplyByChain, totalPools: matches.length });
}
