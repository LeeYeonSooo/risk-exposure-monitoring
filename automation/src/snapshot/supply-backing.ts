import { type Abi, type Address, getAddress, type PublicClient } from "viem";

import {
  LIDO_ARBITRUM_GATEWAY, LIDO_BASE_BRIDGE, WSTETH_ARBITRUM, WSTETH_BASE, WSTETH_MAINNET,
} from "@/config/onchain-addresses";
import { fmtToken } from "@/lib/fmt";

/**
 * Detector A — Supply ↔ Backing invariant (alarm-totalsupply 의 핵심 detector 포팅).
 *
 * 불변식: Σremote(+home if burn&mint) ≤ backing + slack.  **무담보 방향(Σ > backing)만** 알림.
 *   정상 인플라이트 브릿징은 항상 일시적 OVER-backed(lock/burn 이 mint 보다 먼저)라 under 가 안 남 → FP 0.
 *   → Kelp DAO rsETH 익스플로잇(목적지 체인에서 소스 락 없이 mint)의 정확한 실패모드를 잡는다.
 *
 * 순수 read(Multicall/eth_call) 기반 — 로그 불필요. (mint/burn 이벤트 정합 Detector B 는 이벤트
 * 기반이라 추후 확장.) 홈 backing 과 원격 wrapped 토큰이 같은 decimals 라고 가정(대부분의 wrapped/LRT).
 */

const BAL_ABI: Abi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const TS_ABI: Abi = [{ type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];

/** 홈 체인의 backing 소스 1개 — lockbox/escrow 잔액(balanceOf) 또는 reserve(totalSupply/view). */
export interface LockRead {
  /** 잔액을 읽을 컨트랙트(=토큰) 또는 reserve 컨트랙트 주소. */
  contract: string;
  method: "balanceOf" | "erc20_total_supply";
  /** method=balanceOf 일 때 잔액 보유자(=lockbox/bridge escrow 주소). */
  holder?: string;
}

export interface BackingWatch {
  symbol: string;
  decimals: number;
  homeChain: string;
  /** 홈 체인 backing 소스(여러 브릿지 lockbox 합산 가능). */
  lockReads: LockRead[];
  /** 원격(브릿지로 발행된) 토큰들 — 체인별 컨트랙트 주소. */
  remotes: { chain: string; token: string }[];
  /** remotes = lock&mint(홈은 lockbox 라 순환 X) · all = burn&mint(홈 공급도 순환). */
  circulating: "remotes" | "all";
  /** 정상 settlement 여유(bps). 기본 50bps(0.5%). */
  tolBps: number;
}

export interface BackingFinding {
  symbol: string;
  homeChain: string;
  remoteSum: bigint;
  backing: bigint;
  deficit: bigint;
  overageBps: number;
  staleHome: boolean;
  breakdown: Record<string, string>;
  message: string;
}

/**
 * read_backing 포팅 — Σ lockReads(balanceOf/totalSupply). **하나라도 실패하면 null**
 * (backing 을 못 읽으면 무담보로 오판하지 않도록 — 알림 skip).
 */
export async function readBacking(client: PublicClient, lockReads: LockRead[]): Promise<bigint | null> {
  let sum = 0n;
  for (const lr of lockReads) {
    try {
      let v: bigint;
      if (lr.method === "balanceOf") {
        if (!lr.holder) return null;
        v = (await client.readContract({ address: getAddress(lr.contract), abi: BAL_ABI, functionName: "balanceOf", args: [getAddress(lr.holder)] })) as bigint;
      } else {
        v = (await client.readContract({ address: getAddress(lr.contract), abi: TS_ABI, functionName: "totalSupply" })) as bigint;
      }
      sum += v;
    } catch {
      return null;
    }
  }
  return sum;
}

/** totalSupply 1콜. 실패 시 null. */
export async function readTotalSupply(client: PublicClient, token: string): Promise<bigint | null> {
  try {
    return (await client.readContract({ address: getAddress(token), abi: TS_ABI, functionName: "totalSupply" })) as bigint;
  } catch {
    return null;
  }
}

/**
 * 불변식 평가(순수 함수). deficit = remoteSum − backing − slack.
 *   ≤ 0 → balanced/over-backed(안전) → null.  > 0 → 무담보 finding.
 */
export function evaluateBacking(opts: {
  symbol: string; homeChain: string; decimals: number; circulating: "remotes" | "all"; tolBps: number;
  backing: bigint; remoteSum: bigint; staleHome: boolean; breakdown: Record<string, string>;
}): BackingFinding | null {
  const { symbol, homeChain, decimals, circulating, tolBps, backing, remoteSum, staleHome, breakdown } = opts;
  const slack = (backing * BigInt(tolBps)) / 10000n;
  const deficit = remoteSum - backing - slack;
  if (deficit <= 0n) return null; // balanced or OVER-backed = 안전 방향. finding 없음.

  const overageBps = backing === 0n ? 0 : Number(((remoteSum - backing) * 10000n) / backing);
  const scope = circulating === "all" ? "Σall-chain supply" : "Σremote supply";
  const fmt = (x: bigint) => fmtToken(x, decimals);
  let message = `${scope} ${fmt(remoteSum)} > backing ${fmt(backing)} (초과 ${fmt(remoteSum - backing)}, ${overageBps}bps; 허용 ${tolBps}bps) — 무담보 공급 의심`;
  if (staleHome) message += " [홈 스냅샷이 원격보다 늦음 — finality skew 가능]";

  return { symbol, homeChain, remoteSum, backing, deficit, overageBps, staleHome, breakdown, message };
}

/**
 * 감시 대상 토큰 설정 — alarm-totalsupply 의 YAML watch 에 해당.
 * 비어 있어도 동작(러너가 bridge_authorities 의 xERC20 lockbox 에서 자동 watch 도 만든다).
 * 백킹이 온체인으로 안 잡히는 토큰(예: USDC 오프체인 준비금)은 추가하지 말 것(무담보 오판 방지).
 *
 * 예시(구조):
 *   { symbol: "TKN", decimals: 18, homeChain: "ethereum",
 *     lockReads: [{ contract: "0x<canonical token>", method: "balanceOf", holder: "0x<lockbox/escrow>" }],
 *     remotes: [{ chain: "arbitrum", token: "0x<TKN@arb>" }, { chain: "base", token: "0x<TKN@base>" }],
 *     circulating: "remotes", tolBps: 50 }
 */
export const BACKING_WATCHES: BackingWatch[] = [
  // wstETH lock&mint (Lido 공식 L2 브릿지) — Detector A 라이브 활성 케이스.
  //   L1(ethereum)의 Lido 브릿지에 **잠긴 wstETH**(backing) ≥ Σ L2 wstETH 공급(arb/op/base) 이어야 정상.
  //   온체인 검증(2026-06): arbitrum 1.041 · optimism 1.006 · base 1.003 배 over-backed (건강).
  //   Lido 가 이 체인들의 canonical wstETH 브릿지라 L2 공급 전량을 L1 잠금이 백킹 — 단일 backing 소스로 정확.
  //   브릿지 메시지층 침해로 L2 에서 무담보 mint 가 일어나면 Σremote > backing → critical(unbacked_supply).
  {
    symbol: "wstETH",
    decimals: 18,
    homeChain: "ethereum",
    lockReads: [
      { contract: WSTETH_MAINNET, method: "balanceOf", holder: LIDO_ARBITRUM_GATEWAY }, // Arbitrum L1 게이트웨이(Lido)
      { contract: WSTETH_MAINNET, method: "balanceOf", holder: "0x76943C0D61395d8F2edF9060e1533529cAe05dE6" }, // Optimism L1 브릿지(Lido)
      { contract: WSTETH_MAINNET, method: "balanceOf", holder: LIDO_BASE_BRIDGE }, // Base L1 브릿지(Lido)
    ],
    remotes: [
      { chain: "arbitrum", token: WSTETH_ARBITRUM },
      { chain: "optimism", token: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb" },
      { chain: "base", token: WSTETH_BASE },
    ],
    circulating: "remotes",
    tolBps: 50,
  },
];
