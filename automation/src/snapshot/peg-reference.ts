import { type Abi, getAddress, type PublicClient } from "viem";

import { BTC_USD_FEED, ETH_USD_FEED, RSETH_LRT_ORACLE, WEETH_MAINNET, WSTETH_MAINNET } from "@/config/onchain-addresses";

/**
 * 비-USD 토큰의 peg 기준값(pegRef, USD) 해석 — depeg detector 일반화용.
 *   · LST/LRT : pegRef = ETH/USD(Chainlink) × NAV 교환비(토큰별 온체인 getter).  "시장가 vs NAV 괴리".
 *   · BTC 1:1 래퍼 : pegRef = BTC/USD(Chainlink).
 *   (USD 스테이블은 diff.ts checkDepeg 가 $1/baseline 로 직접 처리 — 여기 대상 아님.)
 *
 * ⚠️ CLAUDE.md 규칙1: LST 청산 오라클은 NAV 를 보므로 시장가 디페그 ≠ 청산위험. 이 신호는
 *   2차시장 스트레스/상환압력(예: stETH 2022 할인)으로 해석. getter 는 underlying(ETH) per token @1e18.
 */

// LST/LRT NAV 교환비 getter (홈=ethereum, uint256 @1e18 = ETH per token). 온체인 검증(2026-06).
//   미등록 LST(sfrxETH·msETH 등)는 getter 없거나 합성자산이라 resolve null → depeg skip(의도된 FN). osETH/ETHx/ezETH/wrsETH/OETH 는 2026-06 등록.
export const NAV_GETTERS: Record<string, { contract: string; fn: string; args?: readonly bigint[] } | "ONE"> = {
  WSTETH: { contract: WSTETH_MAINNET, fn: "stEthPerToken" }, // 1.2369
  RETH: { contract: "0xae78736Cd615f374D3085123A210448E74Fc6393", fn: "getExchangeRate" },  // 1.1653
  CBETH: { contract: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", fn: "exchangeRate" },     // 1.1325
  RSETH: { contract: RSETH_LRT_ORACLE, fn: "rsETHPrice" },        // LRTOracle 1.0737
  WEETH: { contract: WEETH_MAINNET, fn: "getRate" },           // 1.0970
  STETH: "ONE", // stETH 는 ETH 와 1:1(리베이스) → rate 1.0
  // FN 감사(2026-06) 추가 — 지원 LST 전종 depeg 커버. 전부 mainnet RPC 검증(에이전트 + 직접).
  EZETH: { contract: "0x387dBc0fB00b26fb085aa658527D5BE98302c84C", fn: "getRate" },          // Renzo rate provider 1.0797
  OSETH: { contract: "0x2A261e60FB14586B474C208b1B7AC6D0f5000306", fn: "convertToAssets", args: [10n ** 18n] }, // StakeWise osTokenVaultController 1.0732
  ETHX: { contract: "0xcf5EA1b38380f6aF39068375516Daf40Ed70D299", fn: "getExchangeRate" },   // Stader StakePoolsManager 1.0909
  WRSETH: { contract: RSETH_LRT_ORACLE, fn: "rsETHPrice" },     // wrapped rsETH ≈ rsETH(1:1 래퍼) 1.0737
  OETH: "ONE",  // Origin OETH 리베이스 1:1 ETH
};

// BTC 1:1 래퍼(peg = BTC/USD). classifyAsset 은 이들을 "major" 로 분류하므로 별도 식별 필요.
export const BTC_WRAPPERS = new Set(["WBTC", "CBBTC", "TBTC", "LBTC"]);

const UINT = (n: string, withArg = false): Abi => [{ type: "function", name: n, stateMutability: "view", inputs: withArg ? [{ type: "uint256" }] : [], outputs: [{ type: "uint256" }] }];
const RD_ABI: Abi = [{
  type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
  outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
}];

async function readChainlinkUsd(client: PublicClient, feed: string): Promise<number | null> {
  try {
    const rd = (await client.readContract({ address: getAddress(feed), abi: RD_ABI, functionName: "latestRoundData" })) as readonly bigint[];
    const v = Number(rd[1]) / 1e8;
    return v > 0 ? v : null;
  } catch { return null; }
}
async function readUintRate(client: PublicClient, contract: string, fn: string, args: readonly bigint[] = []): Promise<number | null> {
  try {
    const raw = (await client.readContract({ address: getAddress(contract), abi: UINT(fn, args.length > 0), functionName: fn, args })) as bigint;
    const v = Number(raw) / 1e18;
    return v > 0 ? v : null;
  } catch { return null; }
}

export interface PegRef {
  pegRefUsd: number;
  refKind: "eth_nav" | "btc";
  navRate?: number;  // LST 교환비(ETH per token)
  refUsd?: number;   // ETH/USD 또는 BTC/USD
}

/** 비-USD peg 기준값 해석. lst → ETH×NAV, BTC 래퍼 → BTC/USD. 해석 불가(getter/피드 실패·미등록)면 null → depeg skip. */
export async function resolvePegRefUsd(
  symbol: string,
  cls: "lst" | "btc_wrapper",
  client: PublicClient,
): Promise<PegRef | null> {
  const s = symbol.toUpperCase();
  if (cls === "btc_wrapper") {
    const btcUsd = await readChainlinkUsd(client, BTC_USD_FEED);
    return btcUsd == null ? null : { pegRefUsd: btcUsd, refKind: "btc", refUsd: btcUsd };
  }
  // lst
  const ethUsd = await readChainlinkUsd(client, ETH_USD_FEED);
  if (ethUsd == null) return null;
  const g = NAV_GETTERS[s];
  let rate: number | null;
  if (g === "ONE") rate = 1.0;
  else if (g) rate = await readUintRate(client, g.contract, g.fn, g.args);
  else rate = null; // 미등록 LST — getter 없음 → skip
  if (rate == null) return null;
  return { pegRefUsd: ethUsd * rate, refKind: "eth_nav", navRate: rate, refUsd: ethUsd };
}

/** BTC 1:1 래퍼인가(classifyAsset 이 major 로 묶는 것 중 BTC 페그). */
export function isBtcWrapper(symbol: string | null | undefined): boolean {
  return BTC_WRAPPERS.has((symbol ?? "").toUpperCase());
}
