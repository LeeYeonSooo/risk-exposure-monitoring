import type { GraphEdge, GraphNode, TopologyResponse } from "@/lib/api";
import { formatUsd } from "@/lib/api";
import { classifyBridge, MECH_LABEL, type BridgeMechanism } from "@/lib/bridge-meta";
import { protoShareDiameterPx } from "@/lib/node-size";

// 브릿지 메커니즘 → 엣지 타입(색). 방향은 화살표로 표시.
const mechEdge = (m: BridgeMechanism) => (m === "lock_mint" ? "bridge_lockmint" : m === "burn_mint" ? "bridge_burnmint" : "bridge_liquidity");

/**
 * 4-링 동심원 (체인별 원):
 *   링0 토큰(중심) → 링1 프로토콜 → 링2 마켓/풀 → 링3 볼트(큐레이터).
 * 각 체인 원 위에는 IslandHandle 체인 라벨(드래그=원 전체 이동). 마켓·볼트는 합성
 * DefiProtocol 노드라 GraphCanvas/RiskNode 가 그대로 렌더. 좌표 고정(staticLayout).
 *
 * 링2 마켓/풀 = 정밀 어댑터 topMarkets(Morpho: LTV/ouroboros + 큐레이터) 가 있으면 그걸,
 * 없으면 DeFiLlama 풀(poolsByKey: Aave 리저브·Compound Comet·DEX 페어 등 — 전 체인).
 * → 큐레이터가 거의 모든 익스포저(어느 체인·프로토콜·마켓·풀)를 한 화면에서 본다.
 *
 * 원 크기는 체인 TVL(log)에 비례 — 토큰이 어느 체인에 쏠렸는지 한눈에.
 */

export interface ConcRelation {
  edge: GraphEdge;
  otherId: string;
  otherLabel: string;
}

export interface PoolLike {
  symbol: string; tvlUsd: number;
  apy: number | null; apyBase: number | null; apyReward: number | null;
  exposure: string | null; ilRisk: string | null; poolMeta: string | null; stablecoin: boolean;
}
export interface MorphoMkt { loan: string; collateral: string; lltv: number | null; supplyUsd: number; utilization: number | null; ouroboros: boolean; vaults: string[]; role: "collateral" | "supply" }
export interface EulerVault { name: string; curator: string | null; allocationUsd: number }

const CAP_PROTO = 20, CAP_VAULT = 3;
const CHAIN_ORDER = ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis", "linea", "scroll"];
// Part5: 노드를 키운 만큼(원형 로고+아래 라벨) 겹침 없이 간격을 줄여 엣지를 짧게·빈 공간 최소화.
const CHAIN_GAP = 400;     // 체인 원 가장자리 사이 여백 (760→400)
const NODE_PAD = 140;      // 원 바깥 여백(라벨 공간) (180→140)
const RING_STEP_M = 214;   // 링1→링2 — 키운 프로토콜(반지름 ~132)이 마켓 링과 안 겹치게 여유 확대
const RING_STEP_V = 186;   // 링2→링3 (220→186: 볼트 부채꼴 호 길이 확보 — 인접마켓 볼트 겹침 방지)
const NODE_ARC = 150;      // 프로토콜 1개 호 길이(px)→링1 반경 (215→150: 노드를 토큰에 더 가깝게)
const VAULT_STAGGER = 52;  // 같은 마켓 큐레이터를 바깥으로 계단식 배치(겹침 원천 차단)
const MARKET_ROW_STEP = 116; // 한 호에 안 들어가는 마켓은 바깥 줄로 계단식(겹침 원천 차단)
// Chain Spiral — 프로토콜을 동심원 링 대신 아르키메데스 스파이럴로 감음.
//   각 프로토콜이 SWEEP/N 각도 wedge 를 소유(마켓이 그 안에 부채꼴) → 반경이 달라도 겹침 0.
//   SWEEP<2π 로 wrap(첫↔끝) 충돌 방지. 큰 프로토콜=안쪽, 바깥으로 갈수록 작아지며 감김.
const SPIRAL_SWEEP = Math.PI * 1.9; // 프로토콜이 도는 총 각도(≈342°, 한 바퀴 가까이) — 스파이럴 winding 가시화.
const SPIRAL_SPAN = 230;            // 반경 범위: 안쪽(작은 TVL) ~ 바깥(큰 TVL). 순위 선형 증가 = 매끄러운 스파이럴. (컴팩트)

const usdOf = (r: ConcRelation) => r.edge.attrs?.core?.amountUsd ?? r.edge.weight ?? 0;

// 같은 프로토콜이 DB(정밀)·DeFiLlama(breadth)에서 다른 슬러그로 와 이중 계상되는 것 병합.
//   예: "spark"(DB) vs "sparklend"(Llama) = 동일 SparkLend → 분포에 둘 다 ~30%로 떠 합계 왜곡.
const PROTO_ALIAS: Record<string, string> = {
  sparklend: "spark",        // Llama "sparklend" = DB "spark" (동일 SparkLend)
  morphoblue: "morpho-blue", // 표기 차이만
};

// "protocol:dl:aave-v3@base" / "protocol:aave_v3@base" → "aave-v3" (체인·접두·구분자 정규화)
function canonProto(otherId: string): string {
  const base = otherId.replace(/^protocol:/, "").replace(/^dl:/, "").split("@")[0].replace(/_/g, "-").toLowerCase();
  return PROTO_ALIAS[base] ?? base;
}
function poolLabel(sym: string): string {
  const s = (sym ?? "?").trim();
  return s; // 자르지 않고 전체 표시(… 절단 금지)
}

interface VaultLike { curator?: string | null; vault?: string | null; vaultAddress?: string | null; allocationUsd?: number | null; depositAsset?: string | null; market: string }
interface MEntry { label: string; sizeUsd: number; ouroboros: boolean; payload: Record<string, unknown>; edgeType: string; category: string; vaults: VaultLike[] }

interface ChainPlan {
  chain: string;
  protos: ConcRelation[];
  N: number;
  R1: number; R2: number; outer: number; rowStep: number;
  totalUsd: number;
  cx: number; cy: number; outward: number;
}

const CHAIN_KEYS = new Set(["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis", "linea", "scroll", "zksync", "mantle", "mode", "blast", "avalanche", "bsc", "sonic", "unichain"]);
function prettyBridge(name: string): string {
  const n = name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return CHAIN_KEYS.has(name.toLowerCase()) ? `${n} 브릿지` : n;
}
function fmtAmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function applyConcentricLayout(opts: {
  symbol: string;
  tokenIds: Set<string>;
  relations: ConcRelation[];
  dbNodes: Map<string, GraphNode>;
  /** 숨길 체인 집합(체크 해제된 체인). 비어있으면 전부 표시. */
  hiddenChains?: Set<string>;
  poolsByKey?: Map<string, PoolLike[]>;
  tokenAddrByChain?: Record<string, string>;
  includeMarkets?: boolean;
  /** 큐레이터(볼트) 링 표시 — 깊이 컨트롤(프로토콜/마켓/큐레이터)의 "큐레이터". 기본 true. */
  includeVaults?: boolean;
  morphoByChain?: Record<string, MorphoMkt[]>;
  eulerByChain?: Record<string, EulerVault[]>;
  supplyByChain?: Record<string, { supply: number; supplyUsd: number }>;
  /** 온체인 검증된 브릿지 mint 권한 (chain → 항목들). /api/bridge-authority. */
  bridgeAuthByChain?: Record<string, { bridgeAddr: string; authType: string; mintLimit: number | null; note: string | null }[]>;
  bridgeHub?: boolean;
}): { topology: TopologyResponse; ouroborosMarketIds: Set<string> } {
  const { symbol, tokenIds, relations, dbNodes, hiddenChains, poolsByKey = new Map<string, PoolLike[]>(), tokenAddrByChain = {}, morphoByChain = {}, eulerByChain = {}, supplyByChain = {}, bridgeAuthByChain = {}, bridgeHub = false } = opts;
  // 검증된 mint 권한 → 그 체인 브릿지 노드를 "추정"에서 "검증"으로 (가장 강한 권한 우선).
  const AUTH_MAP: Record<string, { mechanism: BridgeMechanism; protocol: string; tag: string }> = {
    xerc20: { mechanism: "burn_mint", protocol: "xERC20", tag: "xERC20" },
    ccip_pool: { mechanism: "burn_mint", protocol: "Chainlink CCIP", tag: "CCIP" },
    ccip_remote: { mechanism: "burn_mint", protocol: "Chainlink CCIP", tag: "CCIP↗" }, // 원격 풀(연결된 다른 체인의 컨트랙트)
    oft_peer: { mechanism: "burn_mint", protocol: "LayerZero OFT", tag: "LZ" },
    minter_role: { mechanism: "burn_mint", protocol: "MINTER_ROLE", tag: "MINTER" },
    cctp: { mechanism: "burn_mint", protocol: "Circle CCTP", tag: "CCTP" },
    wormhole_ntt: { mechanism: "burn_mint", protocol: "Wormhole NTT", tag: "NTT" },
    axelar_its: { mechanism: "burn_mint", protocol: "Axelar ITS", tag: "AXL" },
    hyperlane: { mechanism: "burn_mint", protocol: "Hyperlane", tag: "HYP" },
    op_bridge: { mechanism: "lock_mint", protocol: "OP Bridge", tag: "OP" },
    l2_canonical: { mechanism: "lock_mint", protocol: "L2 Canonical", tag: "L2" },
    polygon_pos: { mechanism: "lock_mint", protocol: "Polygon PoS", tag: "POS" },
    xerc20_lockbox: { mechanism: "lock_mint", protocol: "xERC20 Lockbox", tag: "xERC20-LB" },
    // 비-EVM 표준 브릿지 (bridge_detections — 파이썬 8계열 탐지기, 표준 인터페이스/금고 검증분만)
    wormhole: { mechanism: "lock_mint", protocol: "Wormhole", tag: "WH" },
    ibc: { mechanism: "lock_mint", protocol: "IBC Transfer", tag: "IBC" },
    starkgate: { mechanism: "lock_mint", protocol: "StarkGate", tag: "SG" },
    sui_bridge: { mechanism: "lock_mint", protocol: "Sui Bridge", tag: "SUI-B" },
    layerzero: { mechanism: "burn_mint", protocol: "LayerZero", tag: "LZ" },
  };
  const AUTH_ORDER: Record<string, number> = { xerc20: 0, ccip_pool: 1, oft_peer: 2, minter_role: 3, cctp: 4, wormhole_ntt: 5, axelar_its: 6, hyperlane: 7, op_bridge: 8, l2_canonical: 9, polygon_pos: 10, xerc20_lockbox: 11, ccip_remote: 12, wormhole: 13, ibc: 14, starkgate: 15, sui_bridge: 16, layerzero: 17 };
  const verifiedFor = (chain: string) => {
    // mint_event 는 추정(view-probe fallback)이라 "검증"으로 안 침 — 제외.
    const list = (bridgeAuthByChain[chain] ?? []).filter((x) => x.authType !== "mint_event");
    if (!list.length) return null;
    const best = list.slice().sort((a, b) => (AUTH_ORDER[a.authType] ?? 9) - (AUTH_ORDER[b.authType] ?? 9))[0];
    const m = AUTH_MAP[best.authType] ?? { mechanism: "burn_mint" as BridgeMechanism, protocol: best.authType, tag: best.authType };
    const mintLimit = list.map((x) => x.mintLimit).filter((v): v is number => v != null).sort((a, b) => b - a)[0] ?? null;
    return { ...m, mintLimit, count: list.length, types: [...new Set(list.map((x) => x.authType))] };
  };
  // 브릿지 허브 뷰에선 체인 간 흐름에 집중 — 마켓/볼트 끔(가독성). 단일체인 필터 시엔 허브 의미 없음 → 일반.
  // 마켓 표시: 토글(opts.includeMarkets)이 있으면 그대로 — 브릿지 허브에서도 on/off 가능. 기본 동심원 on/브릿지 off.
  const includeMarkets = opts.includeMarkets ?? !bridgeHub;
  const includeVaults = (opts.includeVaults ?? true) && includeMarkets; // 큐레이터 링(마켓 켜진 경우에만 의미)
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const ouroborosMarketIds = new Set<string>();
  // poolsByKey 는 Llama 원슬러그("sparklend") 키 — 별칭 병합으로 정밀 노드("spark")가 남으면
  // 직접 조회가 빗나가므로 역별칭으로도 찾는다(마켓 링2 유지).
  const poolsFor = (chain: string, otherId: string) => {
    const c = canonProto(otherId);
    const direct = poolsByKey.get(`${chain}|${c}`);
    if (direct?.length) return direct;
    for (const [from, to] of Object.entries(PROTO_ALIAS)) {
      if (to !== c) continue;
      const alt = poolsByKey.get(`${chain}|${from}`);
      if (alt?.length) return alt;
    }
    return [];
  };

  // 1) 프로토콜을 체인별로 그룹 (amountUsd>0)
  const byChain = new Map<string, ConcRelation[]>();
  for (const r of relations) {
    const chain = (dbNodes.get(r.otherId)?.metadata.chain as string) ?? "ethereum";
    if (hiddenChains?.has(chain)) continue; // 체크 해제된 체인 숨김
    if (usdOf(r) <= 0) continue;
    if (!byChain.has(chain)) byChain.set(chain, []);
    byChain.get(chain)!.push(r);
  }
  const chains = [...byChain.keys()].sort((a, b) => {
    const ra = CHAIN_ORDER.indexOf(a), rb = CHAIN_ORDER.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
  // 단일 체인만 보일 땐 마켓 깊게(10), 여러 체인이면 개요(4)
  const mcap = chains.length === 1 ? 10 : 4;

  // 2a) 체인별 dedup(정밀 우선) + protos + totalUsd
  const pre = chains.map((chain) => {
    const sorted = byChain.get(chain)!.slice().sort((a, b) => usdOf(b) - usdOf(a));
    const seen = new Map<string, ConcRelation>();
    for (const r of sorted) {
      const k = canonProto(r.otherId);
      const ex = seen.get(k);
      if (!ex) { seen.set(k, r); continue; }
      const exDl = ex.otherId.includes(":dl:");
      const rDl = r.otherId.includes(":dl:");
      if (exDl && !rDl) seen.set(k, r); // 정밀(non-dl) 어댑터 우선 (이미 USD 내림차순)
    }
    const protos = [...seen.values()].sort((a, b) => usdOf(b) - usdOf(a)).slice(0, CAP_PROTO);
    return { chain, protos, N: protos.length || 1, totalUsd: protos.reduce((s, p) => s + usdOf(p), 0) };
  });
  const grandTotalUsd = pre.reduce((s, p) => s + p.totalUsd, 0) || 1;

  // 2b) TVL → 원 크기 (log, 체인 간 상대). "이 토큰이 어느 체인에 많은지" 를 원 크기로 보여줌.
  const logs = pre.map((p) => Math.log10(Math.max(1, p.totalUsd)));
  const minLog = Math.min(...logs), maxLog = Math.max(...logs);
  const tvlRadius = (usd: number) => {
    if (!isFinite(minLog) || maxLog - minLog < 0.05) return 470; // 한 체인뿐/비슷하면 중간(단일체인 뷰는 영향 X)
    const t = (Math.log10(Math.max(1, usd)) - minLog) / (maxLog - minLog);
    return 300 + Math.pow(t, 1.5) * 470; // TVL 상대크기 유지하되 지배체인 반경↓ → 토큰→프로토콜 엣지 짧게 — 300 ~ 770
  };

  // 2c) 반경 확정 — 노드 겹침 방지 최소(N 비례)와 TVL 크기 중 큰 값.
  //    브릿지 허브 모드: 체인 원을 컴팩트하게(상위 6 프로토콜, TVL 스케일 X) → 중앙 허브가 안 묻힘.
  const plans: ChainPlan[] = pre.map(({ chain, protos: allProtos, totalUsd }) => {
    const protos = bridgeHub ? allProtos.slice(0, 6) : allProtos;
    const N = protos.length || 1;
    const Nmin = Math.max(bridgeHub ? 300 : 340, (N * NODE_ARC) / (2 * Math.PI));
    const R1 = bridgeHub ? Nmin : Math.max(Nmin, tvlRadius(totalUsd));
    const morphoMkts = morphoByChain[chain] ?? [];
    const hasMorpho = includeMarkets && morphoMkts.length > 0;
    const hasPrecise = includeMarkets && protos.some((p) => (p.edge.attrs?.topMarkets ?? []).some((m) => (m.marketSizeUsd ?? 0) > 0));
    const hasPools = includeMarkets && protos.some((p) => poolsFor(chain, p.otherId).length > 0);
    const hasEuler = includeMarkets && (eulerByChain[chain]?.length ?? 0) > 0;
    const hasVaults = includeVaults && (hasEuler || morphoMkts.some((m) => m.vaults.length > 0) || protos.some((p) => (p.edge.attrs?.topMarkets ?? []).some((m) => (m.fundingVaults ?? []).some((v) => v.curator || v.vaultName))));
    const R2 = R1 + RING_STEP_M;
    // 마켓이 한 호(R2)에 몇 개 들어가는지 → 못 들어가면 바깥 줄(MARKET_ROW_STEP)로 계단식.
    const hasMkts = hasMorpho || hasPrecise || hasPools;
    const slotP = (2 * Math.PI) / N;
    const mNodeAngP = 56 / R2;
    const maxWedgeP = Math.max(mNodeAngP, slotP - mNodeAngP * 1.3);
    const perRowP = Math.max(1, Math.floor(maxWedgeP / mNodeAngP) + 1);
    const marketRows = hasMkts ? Math.ceil((chains.length === 1 ? 10 : 4) / perRowP) : 0;
    // 볼트 있는 체인은 줄 간격을 안쪽 줄 볼트 끝까지 띄움(겹침 0). 없으면 컴팩트.
    const rowStep = hasVaults ? RING_STEP_V + 2 * VAULT_STAGGER + 44 : MARKET_ROW_STEP;
    const lastMktR = R2 + Math.max(0, marketRows - 1) * rowStep; // 가장 바깥 마켓 줄 반경
    // 스파이럴: 가장 큰 TVL 프로토콜이 R1+SPAN 까지 나가므로 그만큼 extent 가 더 큼.
    const outer = (hasVaults ? lastMktR + RING_STEP_V + 2 * VAULT_STAGGER + 30 : marketRows > 0 ? lastMktR + 30 : R1) + SPIRAL_SPAN;
    return { chain, protos, N, R1, R2, outer, rowStep, totalUsd, cx: 0, cy: 0, outward: -Math.PI / 2 };
  });

  // 3) 배치 — 동심원 그래프가 있으면 체인 원들을 "둥글게"(방사형) + 중앙에 브릿지 원. 한 체인이면 중앙.
  const NC = plans.length;
  let META_R = 0;
  const twoChain = bridgeHub && NC === 2; // 2체인은 방사형이면 세로로 길쭉 → 좌우로 (사이에 브릿지)
  if (twoChain) {
    const maxOuter = Math.max(...plans.map((p) => p.outer));
    META_R = maxOuter + 230; // 좌우 + 사이 브릿지 공간
    // 큰 체인(TVL) 왼쪽, 작은 체인 오른쪽
    const order = plans.slice().sort((a, b) => b.totalUsd - a.totalUsd);
    order[0].cx = -META_R; order[0].cy = 0; order[0].outward = Math.PI;
    order[1].cx = META_R; order[1].cy = 0; order[1].outward = 0;
  } else if (bridgeHub && NC > 1) {
    const maxOuter = Math.max(...plans.map((p) => p.outer));
    // 약간 타이트하게(1.35→1.18, 패딩 180→110) — 둥근 배치 유지하되 과하게 멀던 것 완화.
    META_R = Math.max(maxOuter * 1.18, (maxOuter * 2 + 110) / (2 * Math.sin(Math.PI / NC)));
    plans.forEach((pl, i) => {
      const th = -Math.PI / 2 + (2 * Math.PI * i) / NC;
      pl.cx = META_R * Math.cos(th); pl.cy = META_R * Math.sin(th); pl.outward = th;
    });
  } else {
    let acc = 0;
    plans.forEach((pl, ci) => {
      if (ci > 0) acc += plans[ci - 1].outer + NODE_PAD + CHAIN_GAP + pl.outer + NODE_PAD;
      pl.cx = acc; pl.cy = 0; pl.outward = -Math.PI / 2;
    });
  }

  // 4) 노드/엣지 생성
  for (const pl of plans) {
    const { chain, protos, N, R1, outer, rowStep, totalUsd, cx, cy, outward } = pl;

    // 체인 라벨(IslandHandle) — 원 바깥(outward 방향). 드래그하면 이 체인 노드 전체 이동.
    nodes.push({
      id: `island:${chain}`, type: "IslandHandle", label: chain,
      metadata: { chain, category: `${protos.length}개 프로토콜 · ${formatUsd(totalUsd)}`, sizeUsd: totalUsd, distributionPct: totalUsd / grandTotalUsd, distributionScope: "전체 분포" },
      // 체인 라벨을 토큰 가까이(상단)에 둠 — 스파이럴과 한 화면에 들어오게(전엔 outer+150 으로 너무 멀었음).
      active: true, position: { x: cx + Math.cos(outward) * (R1 * 0.5), y: cy + Math.sin(outward) * (R1 * 0.5) },
    } as GraphNode);

    // 링0: 토큰 (체인별 중심) — 주소로 토큰 로고
    const chainTokenId = [...tokenIds].find((id) => (dbNodes.get(id)?.metadata.chain as string) === chain) ?? [...tokenIds][0] ?? `token:${symbol}`;
    const baseTok = dbNodes.get(chainTokenId);
    const tokAddr = tokenAddrByChain[chain] ?? baseTok?.metadata.tokenAddr ?? baseTok?.metadata.address ?? null;
    // 토큰 지름 = 링 반경(R1)에 비례 → 원이 클수록(프로토콜 멀수록) 중심 토큰도 커져 가독성↑.
    // top-left 기준이라 -지름/2 로 옮겨 링 중심(cx,cy)에 정확히 센터링.
    const tokDia = Math.round(Math.min(560, Math.max(120, R1 * 0.5)));
    nodes.push({
      id: `c:${chain}:token`, type: "Token", label: symbol,
      metadata: { ...(baseTok?.metadata ?? {}), symbol, chain, address: tokAddr, sizeUsd: totalUsd, category: chain, tokenAddr: tokAddr, diameterPx: tokDia, distributionPct: totalUsd / grandTotalUsd, distributionScope: "전체 분포" },
      active: true, position: { x: cx - tokDia / 2, y: cy - tokDia / 2 },
    } as GraphNode);

    // 프로토콜 노드 지름 = 이 토큰 맵 내 노출 share(분포 비율) 상대 스케일 → 큰 프로토콜이 직관적으로 큼.
    const maxProtoExp = Math.max(1, ...protos.map(usdOf));
    // 스파이럴 배치 — 작은 TVL=안쪽, 큰 TVL=바깥(TVL 클수록 멀리). 반경을 순위에 따라 **매끄럽게
    //   선형 증가** + 일정 각도로 winding → 아르키메데스 스파이럴이 또렷이 보임. 각 프로토콜이
    //   angStep 각폭을 소유 → 마켓이 그 안에 부채꼴(반경 달라도 겹침 0).
    const spiralProtos = [...protos].sort((a, b) => usdOf(a) - usdOf(b)); // 작은 TVL 먼저(안쪽)
    const angStep = SPIRAL_SWEEP / N;
    spiralProtos.forEach((p, i) => {
      const angP = -Math.PI / 2 + angStep * i;                       // 일정 각도 winding
      const rP = R1 + (N <= 1 ? 0 : (i / (N - 1)) * SPIRAL_SPAN);    // 순위 선형 반경 = 매끄러운 스파이럴
      const R2p = rP + RING_STEP_M;          // 그 프로토콜의 마켓 링 반경
      const slotW = angStep;                 // 이 프로토콜의 각폭(마켓 부채꼴 한계)
      const protoNode = dbNodes.get(p.otherId);
      const pExp = usdOf(p);
      const pid = `c:${chain}:${p.otherId}`;
      nodes.push({
        id: pid, type: (protoNode?.type ?? "DefiProtocol") as GraphNode["type"], label: p.otherLabel,
        metadata: { ...(protoNode?.metadata ?? {}), address: protoNode?.metadata.address ?? protoNode?.metadata.coreContract ?? null, sizeUsd: pExp, chain, venue: protoNode?.metadata.venue, symbol: protoNode?.metadata.symbol, brandSlug: canonProto(p.otherId), diameterPx: protoShareDiameterPx(pExp, maxProtoExp), distributionPct: pExp / grandTotalUsd, distributionScope: "전체 분포" },
        active: true, position: { x: cx + Math.cos(angP) * rP, y: cy + Math.sin(angP) * rP },
      } as GraphNode);
      edges.push({ id: `e:${chainTokenId}:${pid}`, source: `c:${chain}:token`, target: pid, type: p.edge.type, weight: pExp, attrs: p.edge.attrs });

      // 링2 entries: 정밀 마켓(Morpho) 우선, 없으면 DeFiLlama 풀(전 프로토콜/체인)
      const tm = includeMarkets ? (p.edge.attrs?.topMarkets ?? []).filter((m) => (m.marketSizeUsd ?? 0) > 0)
        .sort((a, b) => (b.marketSizeUsd ?? 0) - (a.marketSizeUsd ?? 0)) : [];
      const isMorpho = canonProto(p.otherId).includes("morpho");
      const mm = includeMarkets && isMorpho ? (morphoByChain[chain] ?? []) : [];
      let entries: MEntry[];
      if (!includeMarkets) {
        entries = [];
      } else if (mm.length) {
        // 라이브 Morpho — 전 체인 실제 LLTV·큐레이터 (DeFiLlama 집계 풀보다 정밀)
        entries = mm.slice(0, mcap).map((m) => {
          const lbl = `${m.collateral}/${m.loan}`;
          const roleTxt = m.role === "supply" ? "공급" : "담보";
          return {
            label: lbl, sizeUsd: m.supplyUsd, ouroboros: m.ouroboros, edgeType: "collateral_isolated",
            category: `${roleTxt}${m.lltv != null ? ` · LLTV ${(m.lltv * 100).toFixed(0)}%` : ""}`,
            payload: { kind: "lending", role: m.role, lltv: m.lltv, sizeUsd: m.supplyUsd, utilization: m.utilization, ouroboros: m.ouroboros, protocol: p.otherLabel },
            vaults: m.vaults.slice(0, CAP_VAULT).map((name) => ({ curator: name, vault: name, market: lbl })),
          };
        });
      } else if (tm.length) {
        entries = tm.slice(0, mcap).map((m) => {
          const lbl = `${m.collateralAsset ?? "?"}/${m.loanAsset ?? "?"}`;
          return {
            label: lbl, sizeUsd: m.marketSizeUsd ?? 0, ouroboros: !!m.ouroborosRisk, edgeType: "collateral_isolated",
            category: `Market${m.lltv != null ? ` · LLTV ${(m.lltv * 100).toFixed(0)}%` : ""}`,
            payload: { kind: "lending", lltv: m.lltv, sizeUsd: m.marketSizeUsd, utilization: m.utilization, ouroboros: m.ouroborosRisk,
              aggLtv: m.collateralUsd && m.borrowUsd ? m.borrowUsd / m.collateralUsd : null, protocol: p.otherLabel,
              oracle: m.oracle ?? null, oracleAddress: m.oracleAddress ?? null },
            vaults: (m.fundingVaults ?? []).filter((v) => v.curator || v.vaultName)
              .sort((a, b) => (b.allocationUsd ?? 0) - (a.allocationUsd ?? 0)).slice(0, CAP_VAULT)
              .map((v) => ({ curator: v.curator, vault: v.vaultName, vaultAddress: v.vaultAddress, allocationUsd: v.allocationUsd, depositAsset: v.depositAsset, market: lbl })),
          };
        });
      } else {
        entries = poolsFor(chain, p.otherId).slice(0, mcap).map((pool) => ({
          label: poolLabel(pool.symbol), sizeUsd: pool.tvlUsd, ouroboros: false,
          edgeType: pool.exposure === "multi" ? "dex" : "collateral_isolated",
          category: `${pool.exposure === "multi" ? "LP 풀" : "담보/예치"}${pool.poolMeta ? ` · ${pool.poolMeta}` : ""}`,
          payload: { kind: "pool", sizeUsd: pool.tvlUsd, apy: pool.apy, apyBase: pool.apyBase, apyReward: pool.apyReward,
            exposure: pool.exposure, ilRisk: pool.ilRisk, poolMeta: pool.poolMeta, stablecoin: pool.stablecoin, protocol: p.otherLabel },
          vaults: [],
        }));
      }

      // Euler Earn 큐레이터 볼트(비-Morpho) — Euler 노드에 "Euler Earn" 마켓 1개로 묶어 큐레이터를 ring3 로.
      if (includeMarkets && canonProto(p.otherId).includes("euler")) {
        const ev = eulerByChain[chain] ?? [];
        if (ev.length) {
          const total = ev.reduce((s, v) => s + v.allocationUsd, 0);
          entries.push({
            label: "Euler Earn", sizeUsd: total, ouroboros: false, edgeType: "deposit_supply",
            category: "큐레이터 볼트",
            payload: { kind: "pool", sizeUsd: total, exposure: "single", poolMeta: "Euler Earn 큐레이터 볼트", protocol: p.otherLabel },
            vaults: ev.slice(0, CAP_VAULT).map((v) => ({ curator: v.name, vault: v.name, allocationUsd: v.allocationUsd, depositAsset: symbol, market: "Euler Earn" })),
          });
        }
      }

      // 마켓 배치 — 프로토콜의 스파이럴 wedge(angStep) 안의 한 호(R2p)에 부채꼴. 슬롯이 좁아 다 안 들어가면
      //   바깥 줄(rowStep)로 계단식 → 인접 프로토콜과도, 자기 마켓끼리도 안 겹침(반경 달라도 wedge 소유).
      const slot = slotW;
      const mNodeAngR2 = 56 / R2p;                                  // 마켓 1개가 R2p 호에서 차지하는 각도
      const maxWedge = Math.max(mNodeAngR2, slot - mNodeAngR2 * 1.3); // 옆 프로토콜과 안 겹치는 최대 각폭
      const perRow = entries.length <= 1 ? 1 : Math.max(1, Math.floor(maxWedge / mNodeAngR2) + 1); // 한 줄 수용 개수
      entries.forEach((e, j) => {
        const row = Math.floor(j / perRow);
        const inRow = Math.min(perRow, entries.length - row * perRow);    // 이 줄의 마켓 수
        const col = j % perRow;
        const rWedge = inRow <= 1 ? 0 : Math.min((inRow - 1) * mNodeAngR2, maxWedge);
        const angM = entries.length <= 1 ? angP : angP - rWedge / 2 + (inRow <= 1 ? 0 : (rWedge * col) / (inRow - 1));
        const mR = R2p + row * rowStep;                                   // 줄마다 바깥으로(rowStep=볼트 여유 반영)
        const mid = `${pid}:m${j}`;
        nodes.push({
          id: mid, type: "DefiProtocol", label: e.label,
          metadata: { category: e.category, sizeUsd: e.sizeUsd, chain, _market: e.payload, distributionPct: e.sizeUsd / grandTotalUsd, distributionScope: "전체 분포" },
          active: true, position: { x: cx + Math.cos(angM) * mR, y: cy + Math.sin(angM) * mR },
        } as GraphNode);
        if (e.ouroboros) ouroborosMarketIds.add(mid);
        edges.push({ id: `e:${pid}:${mid}`, source: pid, target: mid, type: e.edgeType, weight: e.sizeUsd } as GraphEdge);

        // 링3: 볼트(큐레이터) — 깊이=큐레이터일 때만(includeVaults). 해당 마켓 바깥으로 계단식 반경+안전 미세각.
        const nv = includeVaults ? e.vaults.length : 0;
        const vBaseR = mR + RING_STEP_V;
        const mAngInRow = inRow <= 1 ? slot : rWedge / Math.max(1, inRow - 1); // 이 줄 인접 마켓 각 간격
        const vFan = nv <= 1 ? 0 : Math.max(0, Math.min(0.03, (mAngInRow - 56 / vBaseR) / 2));
        (includeVaults ? e.vaults : []).forEach((v, k) => {
          const vr = vBaseR + k * VAULT_STAGGER;
          const angV = nv <= 1 ? angM : angM + (k - (nv - 1) / 2) * vFan;
          const vid = `${mid}:v${k}`;
          nodes.push({
            id: vid, type: "DefiProtocol", label: v.curator || v.vault || "vault",
            metadata: { category: "Vault · 큐레이터", sizeUsd: v.allocationUsd ?? 0, chain, address: v.vaultAddress ?? null, _vault: { curator: v.curator, vault: v.vault, vaultAddress: v.vaultAddress, allocationUsd: v.allocationUsd, depositAsset: v.depositAsset, market: v.market } },
            active: true, position: { x: cx + Math.cos(angV) * vr, y: cy + Math.sin(angV) * vr },
          } as GraphNode);
          edges.push({ id: `e:${mid}:${vid}`, source: mid, target: vid, type: "deposit_supply", weight: v.allocationUsd ?? 0 } as GraphEdge);
        });
      });
    });
  }

  // 5) 브릿지 허브 — 중앙에 브릿지 노드. 엣지 두색: bridge_in(체인→브릿지 잠김) / bridge_out(브릿지→체인 민팅).
  if (bridgeHub && NC > 1) {
    const chainSet = new Set(plans.map((p) => p.chain));
    const covered = new Set<string>(); // 이미 브릿지로 연결된 체인
    const hubR = Math.min(META_R * 0.24, 460); // 중앙 브릿지 원 반경

    // (a) OFT/멀티체인 메시 — 같은 주소 공유 체인들. L1(ethereum)=잠김(in), L2=민팅(out).
    const addrGroups = new Map<string, string[]>();
    for (const ch of chainSet) {
      const a = (tokenAddrByChain[ch] || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
      if (!addrGroups.has(a)) addrGroups.set(a, []);
      addrGroups.get(a)!.push(ch);
    }
    const meshChains = [...addrGroups.values()].filter((g) => g.length >= 2).flat();
    if (meshChains.length >= 2) {
      const members = new Set(meshChains);
      if (chainSet.has("ethereum")) members.add("ethereum");
      const bid = "bridge:oft";
      const cls = classifyBridge("", { oft: true });
      const et = mechEdge(cls.mechanism);
      const oftVerified = [...members].some((m) => (bridgeAuthByChain[m] ?? []).some((x) => x.authType === "oft_peer"));
      nodes.push({ id: bid, type: "Bridge", label: `동일주소 ${members.size}체인 메시`, metadata: { category: `${MECH_LABEL[cls.mechanism]} · 동일주소 ${members.size}체인${oftVerified ? " · ✓ 온체인 peer 검증" : ""}`, chain: "ethereum", bridgeKind: "oft", bridgeMechanism: cls.mechanism, bridgeProtocol: cls.protocol, bridgeTag: cls.tag, bridgeWeak: cls.weak, bridgeVerified: oftVerified }, active: true, position: { x: 0, y: 0 } } as GraphNode);
      for (const ch of members) {
        const isSrc = ch === "ethereum";
        edges.push({ id: `oft:${ch}`, source: isSrc ? `c:${ch}:token` : bid, target: isSrc ? bid : `c:${ch}:token`, type: et, weight: supplyByChain[ch]?.supplyUsd ?? 1 } as GraphEdge);
        covered.add(ch);
      }
    }

    // (b) 명시 브릿지(metadata.bridges, 이더리움 잠긴양). src→bridge=in, bridge→dest=out.
    const bagg = new Map<string, { name: string; amount: number; src: string; dest: string | null }>();
    for (const tid of tokenIds) {
      const bm = dbNodes.get(tid)?.metadata.bridges as Record<string, { bridge: string; lockedAmount: number; destChains?: string[] }[]> | undefined;
      if (!bm) continue;
      for (const [srcChain, list] of Object.entries(bm)) {
        if (!chainSet.has(srcChain)) continue;
        for (const b of list) {
          const key = (b.bridge || "").toLowerCase(); if (!key) continue;
          const cur = bagg.get(key) ?? { name: b.bridge, amount: 0, src: srcChain, dest: null };
          cur.amount += b.lockedAmount || 0;
          if (CHAIN_KEYS.has(key) && key !== srcChain && chainSet.has(key)) cur.dest = key;
          else if (b.destChains?.length) { const d = b.destChains.find((c) => chainSet.has(c)); if (d) cur.dest = d; }
          bagg.set(key, cur);
        }
      }
    }
    const explicit = [...bagg.values()].filter((b) => b.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 10);
    // 명시 브릿지가 덮는 체인 선표시(배치는 아래 "하나의 원"에서 통합)
    for (const b of explicit) { if (chainSet.has(b.src)) covered.add(b.src); if (b.dest) covered.add(b.dest); }
    // (c) 나머지 체인 = canonical(추정, 양 = 온체인 공급)
    const restChains = chainSet.has("ethereum") ? [...chainSet].filter((c) => c !== "ethereum" && !covered.has(c)) : [];

    // 브릿지 노드 = 도착 체인 원 "바로 바깥"(소스 쪽을 향해). 중점에 두면 사이 체인 토큰과 겹쳐서 →
    // 도착 체인에 붙여 연관 명확 + 다른 체인 위에 안 올라감. 같은 도착이 여러 개면 바깥으로 계단.
    // 브릿지들을 중앙에 "둥근 원"(반경 ringR)으로 균등 배치 — 체인 원들 사이 중앙 허브.
    const ringTotal = explicit.length + restChains.length;
    const ringR = Math.min(META_R * 0.5, Math.max(hubR, (ringTotal * 172) / (2 * Math.PI)));
    let ri = 0;
    const ringXY = () => {
      const i = ri++;
      if (twoChain) return { x: 0, y: (i - (ringTotal - 1) / 2) * 74 }; // 2체인: 좌우 체인 사이 세로 스택
      const ang = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, ringTotal);
      return { x: Math.cos(ang) * ringR, y: Math.sin(ang) * ringR };
    };
    for (const b of explicit) {
      const bid = `bridge:${b.name}`;
      const srcS = b.src === "ethereum" ? "ETH" : b.src;
      const cls = classifyBridge(b.name);
      const v = b.dest ? verifiedFor(b.dest) : null;
      const eff = v ?? cls;
      const et = mechEdge(eff.mechanism);
      const limTxt = v?.mintLimit != null ? ` · mint한도 ${formatUsd(v.mintLimit)}` : "";
      nodes.push({ id: bid, type: "Bridge", label: `${srcS} → ${b.dest ?? "멀티체인"}`, metadata: { category: `${eff.protocol} · ${MECH_LABEL[eff.mechanism]}${v ? " · ✓ 검증" : ""}${limTxt} · ${fmtAmt(b.amount)} ${symbol} 잠김`, chain: b.src, bridgeKind: v ? "verified" : "named", bridgeMechanism: eff.mechanism, bridgeProtocol: eff.protocol, bridgeTag: eff.tag, bridgeWeak: cls.weak, bridgeVerified: !!v, bridgeMintLimit: v?.mintLimit ?? null }, active: true, position: ringXY() } as GraphNode);
      if (chainSet.has(b.src)) edges.push({ id: `br:${bid}:s`, source: `c:${b.src}:token`, target: bid, type: et, weight: b.amount } as GraphEdge);
      if (b.dest) edges.push({ id: `br:${bid}:d`, source: bid, target: `c:${b.dest}:token`, type: et, weight: b.amount } as GraphEdge);
    }
    for (const c of restChains) {
      const bid = `bridge:canon:${c}`;
      const usd = supplyByChain[c]?.supplyUsd ?? 0;
      const cls = classifyBridge(c, { canonical: true });
      const v = verifiedFor(c);
      const eff = v ?? cls; // 검증되면 검증 메커니즘/프로토콜로 override
      // 회사·종류 — 검증되면 그 프로토콜, 아니면 "{체인} 캐노니컬"(여러 canonical 구분 + 회사=체인 표시).
      const protoName = v ? v.protocol : cls.protocol === "Canonical" ? `${c} 캐노니컬` : cls.protocol;
      const et = mechEdge(eff.mechanism);
      const limTxt = v?.mintLimit != null ? ` · mint한도 ${formatUsd(v.mintLimit)}` : "";
      nodes.push({ id: bid, type: "Bridge", label: `ETH → ${c}`, metadata: { category: `${protoName} · ${MECH_LABEL[eff.mechanism]}${v ? " · ✓ 검증" : "(추정)"}${limTxt}${usd ? ` · 공급 ${formatUsd(usd)}` : ""}`, chain: c, bridgeKind: v ? "verified" : "canonical", bridgeMechanism: eff.mechanism, bridgeProtocol: protoName, bridgeTag: eff.tag, bridgeWeak: cls.weak, bridgeVerified: !!v, bridgeMintLimit: v?.mintLimit ?? null }, active: true, position: ringXY() } as GraphNode);
      edges.push({ id: `cb:${c}:i`, source: `c:ethereum:token`, target: bid, type: et, weight: usd || 1 } as GraphEdge);
      edges.push({ id: `cb:${c}:o`, source: bid, target: `c:${c}:token`, type: et, weight: usd || 1 } as GraphEdge);
    }
  }

  return { topology: { nodes, edges }, ouroborosMarketIds };
}
