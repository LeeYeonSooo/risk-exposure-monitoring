import { type Abi, getAddress, type PublicClient } from "viem";

import {
  ETH_USD_FEED, LIDO_ARBITRUM_GATEWAY, LIDO_BASE_BRIDGE, RSETH_LRT_ORACLE,
  WEETH_MAINNET, WSTETH_ARBITRUM, WSTETH_BASE, WSTETH_MAINNET,
} from "@/config/onchain-addresses";

/**
 * 크로스체인 공급 보존(supply_conservation) — Kelp DAO rsETH류 무담보 OFT mint 탐지.
 *
 * 불변식(escrow): 홈 체인 브릿지 escrow(= canonical 토큰이 잠긴 곳)들의 **합** = 원격 발행의 정당 backing.
 *   Σ(관측 L2 공급) > Σescrow + slack  →  무담보 mint 의심(Kelp 시그니처).
 *
 * ★ escrow 는 하드코딩하지 않고 **온체인 자동 발견**한다(유지보수·일반화):
 *   (a) remote OFT 의 LayerZero `peers(홈EID)` 역산 → home adapter(가장 흔한 OFT 브릿지),
 *   (b) `bridge_authorities` DB(브릿지 스냅샷이 적재) 의 홈체인 행,
 *   (c) escrowOverrides(비-LZ 네이티브 브릿지 등 자동발견 불가분 수동 보강 — escape hatch).
 *   발견된 후보는 balanceOf(canonical) > 0 검증 후 합산. **한 토큰이 여러 브릿지를 써도 전부 합산**.
 *
 * ★ 자가검증(calibration): 평시 Σescrow ≥ Σremote(over-backed) 여야 한다. 못 덮으면 = 발견 불완전(브릿지
 *   누락) 또는 실제 breach → 러너가 arm 보류/강등(FP 방지). 미커버 leg 존재 시 confidence 강등.
 *
 * ⚠️ 부분 체인 커버리지(ACTIVE_CHAINS=eth/base/arb): escrow 는 전 체인 backing 을 잡는데 우리는 base+arb 만
 *   합산 → 평시 over-backed 버퍼. ⇒ 관측 체인에서 버퍼 넘는 대형(Kelp급) 무단 mint 만 잡음(설계서 §8).
 */

/** LayerZero V2 EID — 홈 체인의 endpoint id(remote OFT peers() 역산용). */
export const LZ_EID: Record<string, number> = { ethereum: 30101 };

/** OP-Stack 표준 L1StandardBridge(escrow) — 홈=ethereum 기준. l2 토큰 l1Token()=canonical 이면 이 곳이 잠금. */
const OP_L1_STANDARD_BRIDGE: Record<string, string> = {
  base: "0x3154Cf16ccdb4C6d922629664174b904d80F2C35",
  optimism: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
};
/** Arbitrum L1GatewayRouter — getGateway(canonical) 가 그 토큰의 L1 escrow 게이트웨이를 준다. */
const ARB_L1_GATEWAY_ROUTER = "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef";

const PEERS_ABI: Abi = [{ type: "function", name: "peers", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "bytes32" }] }];
const ADDR_GETTER = (name: string): Abi => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const GET_GATEWAY_ABI: Abi = [{ type: "function", name: "getGateway", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }];
const uintAbi = (name: string): Abi => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
const RD_ABI: Abi = [{
  type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
  outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
}];

/** NAV backstop getter (홈 체인, uint256 @1e18). 없으면 % 축만으로 판정. */
export interface RateRead { contract: string; fn: string; }
/** 초과분 USD 환산용 underlying 가격원. chainlink=홈 ETH/USD(answer 8dp), const=USD-peg. */
export type UnderlyingPrice = { chainlink: string } | { const: number };

export interface ConservationWatch {
  symbol: string;
  homeChain: string;          // escrow·rate 가 있는 체인(보통 ethereum)
  canonical: string;          // escrow 가 잠그는 홈 canonical 토큰
  decimals: number;           // canonical = 원격 동일 decimals 가정(rsETH/weETH=18, USDT0=6)
  remotes: { chain: string; token: string }[]; // 관측 L2 leg(고정 주소, 홈 제외)
  tolBps: number;
  escrowOverrides?: Record<string, string>; // 체인 → escrow(자동발견 불가 브릿지 수동 보강, 검증됨만)
  rate?: RateRead;
  underlyingPrice: UnderlyingPrice;
  confidence: "HIGH" | "MEDIUM" | "LOW"; // 기본값 — 미커버 leg 존재 시 러너가 강등
  note?: string;
}

const b32ToAddress = (h: string): string | null => {
  if (!h || h.length < 66) return null;
  const a = "0x" + h.slice(-40);
  return /^0x0+$/.test(a) ? null : getAddress(a);
};

/** leg 한 개의 escrow 귀속 — 브릿지 종류별 resolver 로 역산. escrow=null 이면 미커버. */
export interface LegEscrow {
  chain: string;
  token: string;
  escrow: string | null; // 홈 체인 escrow(잠금) 주소
  bridge: string;        // "layerzero" | "arbitrum_native" | "op_native" | "override" | "unresolved"
}

/**
 * remote leg 마다 홈 escrow 를 **브릿지 종류와 무관하게** 역산(다중 resolver, 순서대로 시도):
 *   1) LayerZero OFT      — remote.peers(홈EID) → home adapter(공유풀: 전 LZ체인 backing)
 *   2) Arbitrum 네이티브  — remote.l1Address()==canonical → L1GatewayRouter.getGateway(canonical) (체인 전용 escrow)
 *   3) OP-Stack 네이티브   — remote.l1Token()/remoteToken()==canonical → 해당 체인 L1StandardBridge (체인 전용)
 *   4) override            — config 로 직접 지정(자동발견 불가 브릿지)
 * ★ escrow 별로 그룹화하면 네이티브(체인전용) leg 는 1:1 tight 비교, LZ(공유풀) leg 는 loose 비교가 된다.
 */
export async function resolveLegEscrows(opts: {
  home: PublicClient;
  homeChain: string;
  canonical: string;
  remotes: { chain: string; token: string }[];
  clientFor: (chain: string) => PublicClient | null;
  overrides?: Record<string, string>;
}): Promise<LegEscrow[]> {
  const eid = LZ_EID[opts.homeChain];
  const canon = opts.canonical.toLowerCase();
  const out: LegEscrow[] = [];

  for (const r of opts.remotes) {
    const ov = opts.overrides?.[r.chain];
    if (ov) { out.push({ chain: r.chain, token: r.token, escrow: getAddress(ov), bridge: "override" }); continue; }
    const rc = opts.clientFor(r.chain);
    let escrow: string | null = null;
    let bridge = "unresolved";

    // 1) LayerZero OFT
    if (rc && eid != null) {
      try {
        const peer = (await rc.readContract({ address: getAddress(r.token), abi: PEERS_ABI, functionName: "peers", args: [eid] })) as string;
        const a = b32ToAddress(peer);
        if (a) { escrow = a; bridge = "layerzero"; }
      } catch { /* 비-LZ */ }
    }
    // 2) Arbitrum 네이티브 (l1Address → gateway)
    if (escrow == null && rc && r.chain === "arbitrum") {
      try {
        const l1 = String(await rc.readContract({ address: getAddress(r.token), abi: ADDR_GETTER("l1Address"), functionName: "l1Address" }));
        if (l1.toLowerCase() === canon) {
          const gw = String(await opts.home.readContract({ address: getAddress(ARB_L1_GATEWAY_ROUTER), abi: GET_GATEWAY_ABI, functionName: "getGateway", args: [getAddress(opts.canonical)] }));
          if (gw && !/^0x0+$/.test(gw)) { escrow = getAddress(gw); bridge = "arbitrum_native"; }
        }
      } catch { /* 아님 */ }
    }
    // 3) OP-Stack 네이티브 (l1Token/remoteToken → L1StandardBridge)
    if (escrow == null && rc && OP_L1_STANDARD_BRIDGE[r.chain]) {
      for (const fn of ["l1Token", "remoteToken"]) {
        try {
          const l1 = String(await rc.readContract({ address: getAddress(r.token), abi: ADDR_GETTER(fn), functionName: fn }));
          if (l1.toLowerCase() === canon) { escrow = getAddress(OP_L1_STANDARD_BRIDGE[r.chain]); bridge = "op_native"; break; }
        } catch { /* 아님 */ }
      }
    }
    out.push({ chain: r.chain, token: r.token, escrow, bridge });
  }
  return out;
}

/** NAV rate(@1e18) → float. 실패 null. */
export async function readRate(client: PublicClient, r: RateRead): Promise<number | null> {
  try {
    const raw = (await client.readContract({ address: getAddress(r.contract), abi: uintAbi(r.fn), functionName: r.fn })) as bigint;
    return Number(raw) / 1e18;
  } catch { return null; }
}

/** underlying 자산 USD 가격. chainlink(answer/1e8) 또는 const. 실패 null. */
export async function readUnderlyingUsd(client: PublicClient, p: UnderlyingPrice): Promise<number | null> {
  if ("const" in p) return p.const;
  try {
    const rd = (await client.readContract({ address: getAddress(p.chainlink), abi: RD_ABI, functionName: "latestRoundData" })) as readonly bigint[];
    return Number(rd[1]) / 1e8;
  } catch { return null; }
}

/**
 * Phase 1 watch — escrow 는 **자동 발견**(하드코딩 X). config 는 토큰 정체성(canonical + 관측 L2 leg)만.
 *   토큰 추가 = 이 배열에 1행. escrow adapter 추적·수동 갱신 불필요(peers/bridge_authorities 자동).
 *   주소는 온체인 검증(2026-06, 프로젝트 Alchemy 키).
 */
export const CONSERVATION_WATCHES: ConservationWatch[] = [
  // ── rsETH (THE Kelp case) — Kelp LRT. base·arb 둘 다 LayerZero OFT → escrow 자동발견(peers→0x85d456B2). ──
  {
    symbol: "rsETH",
    homeChain: "ethereum",
    canonical: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7",
    decimals: 18,
    remotes: [
      { chain: "base", token: "0x1Bc71130A0e39942a7658878169764Bbd8A45993" },
      { chain: "arbitrum", token: "0x4186BFC76E2E237523CBC30FD220FE055156b41F" },
    ],
    tolBps: 50,
    rate: { contract: RSETH_LRT_ORACLE, fn: "rsETHPrice" }, // LRTOracle
    underlyingPrice: { chainlink: ETH_USD_FEED },           // Chainlink ETH/USD
    confidence: "HIGH",
  },

  // ── weETH — Ether.fi LRT. base=LayerZero(peers→0xcd2eb13D), arbitrum=비-LZ(네이티브) → uncovered 보고.
  //   override 로 arb 네이티브 escrow 를 보강하면 정확. 미보강 시 LZ escrow 가 over-backed 로 덮어 arm(MEDIUM 강등).
  {
    symbol: "weETH",
    homeChain: "ethereum",
    canonical: WEETH_MAINNET,
    decimals: 18,
    remotes: [
      { chain: "base", token: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A" },
      { chain: "arbitrum", token: "0x35751007a407ca6feffe80b3cb397736d2cf4dbe" }, // 비-LZ(Arbitrum 네이티브)
    ],
    tolBps: 50,
    rate: { contract: WEETH_MAINNET, fn: "getRate" }, // weETH.getRate()
    underlyingPrice: { chainlink: ETH_USD_FEED },
    confidence: "HIGH",
  },

  // ── wstETH — Lido LST. base/arb 는 Lido 커스텀 브릿지(표준 인터페이스 無) → 자동발견 불가, escrowOverrides 로 명시.
  //   (구 Detector A=unbacked_supply 를 흡수: 동일 escrow 불변식이나 per-bridge·release delta·arming 으로 상위호환.)
  {
    symbol: "wstETH",
    homeChain: "ethereum",
    canonical: WSTETH_MAINNET,
    decimals: 18,
    remotes: [
      { chain: "base", token: WSTETH_BASE },
      { chain: "arbitrum", token: WSTETH_ARBITRUM },
    ],
    tolBps: 50,
    escrowOverrides: {
      base: LIDO_BASE_BRIDGE,         // Lido Base L1 브릿지(체인 전용 escrow → tight)
      arbitrum: LIDO_ARBITRUM_GATEWAY, // Lido Arbitrum L1 게이트웨이
    },
    rate: { contract: WSTETH_MAINNET, fn: "stEthPerToken" }, // wstETH→stETH @1e18
    underlyingPrice: { chainlink: ETH_USD_FEED },           // stETH≈ETH/USD
    confidence: "HIGH",
  },

  // ── USDT0 — LayerZero OFT(USDT 기반), decimals=6. arb leg peers() 자동발견 시도, 실패 시 override 0x6C96. ──
  {
    symbol: "USDT0",
    homeChain: "ethereum",
    canonical: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT (6dp)
    decimals: 6,
    remotes: [
      { chain: "arbitrum", token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" }, // base 미배포
    ],
    tolBps: 50,
    escrowOverrides: { arbitrum: "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee" }, // USDT0 OFT Adapter(token()=USDT 검증). peers 자동 시 불필요하나 안전.
    underlyingPrice: { const: 1.0 },
    confidence: "MEDIUM",
    note: "over-backed 버퍼 큼(전 체인 USDT0 backing) — catastrophe-only.",
  },
];
