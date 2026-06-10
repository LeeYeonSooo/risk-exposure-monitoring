/**
 * 오라클 온체인 introspection — 주소만 알던 오라클을 "실제로 호출"해서
 * 종류·제공자·피드 설명·depeg 민감도를 *실데이터*로 채운다. (kuromi reflexivity_scan 포팅)
 *
 * 신호 3종:
 *   1) on-chain description()  — Chainlink AggregatorV3·Compound 커스텀 피드
 *   2) 합성 오라클 BASE/QUOTE_FEED → 하위 피드 description() + Etherscan 이름 재귀
 *   3) Etherscan 컨트랙트 검증 이름 — description 없는 오라클(Spark·고정가 등)도 식별  ★핵심
 *   (+ 비표준은 바이트코드가 담보 주소를 참조하는지로 self-NAV 판정)
 *
 * 분류(kuromi euler_scan 순서): 실물앵커 > 시장망피드 > 고정/하드코딩 > NAV > description.
 *   - 실물앵커/시장망 → MARKET(디페그 잡힘)
 *   - 고정/하드코딩   → ORACLE_FREE(가격 동결, 디페그 안 잡힘 — bad-debt 위험)  ★
 *   - NAV/펀더멘털    → NAV(자가보고, reflexive)
 *
 * Etherscan 키 없으면 이름 신호는 비고 description/심볼 기반으로 graceful 폴백.
 * 주소별 캐시(스냅샷 1회 내).
 */

import type { Address } from "viem";

import { oracleTypeForCollateral } from "@/config/alert-thresholds";
import { getContractName } from "@/lib/etherscan";
import { batch } from "@/lib/multicall";
import { rpcFor } from "@/lib/rpc";
import type { OracleType } from "@/types/edge-schema";

const ZERO = "0x0000000000000000000000000000000000000000";

const ABI = [
  { name: "description", inputs: [], outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { name: "latestRoundData", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], stateMutability: "view", type: "function" },
  { name: "latestAnswer", inputs: [], outputs: [{ type: "int256" }], stateMutability: "view", type: "function" },
  { name: "BASE_FEED_1", inputs: [], outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { name: "BASE_FEED_2", inputs: [], outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { name: "QUOTE_FEED_1", inputs: [], outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { name: "QUOTE_FEED_2", inputs: [], outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { name: "read", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view", type: "function" },
  { name: "peek", inputs: [], outputs: [{ type: "bytes32" }, { type: "bool" }], stateMutability: "view", type: "function" },
] as const;

const DESC_ABI = [{ name: "description", inputs: [], outputs: [{ type: "string" }], stateMutability: "view", type: "function" }] as const;

// 실물 앵커(가격사슬이 닿으면 시장가·안전) + 깊은 독립 스테이블
const REAL = new Set(["ETH", "WETH", "STETH", "WSTETH", "RETH", "WEETH", "RSETH", "EZETH", "CBETH", "OSETH", "SFRXETH", "ETHX", "BTC", "WBTC", "CBBTC", "TBTC", "LBTC", "SOLVBTC", "XAU", "XAUT", "PAXG", "GOLD"]);
const STABLE = new Set(["USDC", "USDT", "DAI"]);
const NET_LABEL: Record<string, string> = { chainlink: "Chainlink", pyth: "Pyth", redstone: "RedStone", chronicle: "Chronicle", stork: "Stork", api3: "API3" };

export interface OracleIntrospection {
  description: string | null;
  provider: string | null;
  type: OracleType;
  depegSensitive: boolean;
  verified: boolean;
}

const _cache = new Map<string, OracleIntrospection>();

function typeFromDescription(desc: string): { type: OracleType; depeg: boolean } {
  const d = desc.toUpperCase();
  if (/\bNAV\b/.test(d)) return { type: "NAV", depeg: false };
  if (/EXCHANGE.?RATE|\bRATE\b|REDEMPTION/.test(d)) return { type: "EXCHANGE_RATE", depeg: false };
  return { type: "MARKET", depeg: true };
}

function fallback(symbol?: string): OracleIntrospection {
  const type = oracleTypeForCollateral(symbol);
  return { description: null, provider: null, type, depegSensitive: type === "MARKET", verified: false };
}

async function readDescription(addr: Address, chainId: number): Promise<string | null> {
  const [d] = (await batch([{ address: addr, abi: DESC_ABI, functionName: "description" }], { allowFailure: true, chainId })) as [string | null];
  return d && d.length ? d : null;
}

/** 이름들 + 설명들 → (type·provider·depeg·description). 신호 부족하면 null(호출부가 더 폴백). */
function classify(names: string[], descs: string[]): { type: OracleType; provider: string | null; depeg: boolean; description: string | null } | null {
  const nameStr = names.filter(Boolean).join(" ").toLowerCase();
  const descStr = descs.filter(Boolean).join(" ").trim();
  const descLow = descStr.toLowerCase();
  const words = new Set(descStr.toUpperCase().split(/[^A-Z0-9+]+/).filter(Boolean));
  const realAnchor = [...words].some((w) => REAL.has(w) || STABLE.has(w));
  const fixed = /fixedrate|fixedprice|fixed[_ ]?price|hardcoded|constant[_ ]?price/.test(nameStr);
  const nav = /fundamental|naked/.test(descLow) || /fundamental/.test(nameStr);
  const netKey = Object.keys(NET_LABEL).find((nw) => nameStr.includes(nw) || descLow.includes(nw));
  const net = netKey ? NET_LABEL[netKey] : null;
  const cname = names.find(Boolean) || null;
  const description = descStr || cname;
  const provider = net ?? cname;

  // 우선순위 (kuromi): 실물앵커 > 시장망 > 고정 > NAV > description
  if (realAnchor) return { type: "MARKET", provider: provider ?? "시장 피드(실물 앵커)", depeg: true, description };
  if (net && !nav && !fixed) return { type: "MARKET", provider: net, depeg: true, description };
  if (fixed) return { type: "ORACLE_FREE", provider: cname ?? "고정가(하드코딩)", depeg: false, description };
  if (nav) return { type: "NAV", provider: cname ?? "NAV/펀더멘털", depeg: false, description };
  if (descStr) { const t = typeFromDescription(descStr); return { type: t.type, provider, depeg: t.depeg, description }; }
  return null;
}

/** 오라클 주소를 온체인+Etherscan introspection 해 실제 종류/제공자/설명을 읽는다. */
export async function introspectOracle(address: Address, chainId = 1, fallbackSymbol?: string, collatAddr?: string): Promise<OracleIntrospection> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = _cache.get(key);
  if (hit) return hit;

  let result: OracleIntrospection;
  try {
    const r = await batch(
      [
        { address, abi: ABI, functionName: "description" },
        { address, abi: ABI, functionName: "latestRoundData" },
        { address, abi: ABI, functionName: "latestAnswer" },
        { address, abi: ABI, functionName: "BASE_FEED_1" },
        { address, abi: ABI, functionName: "BASE_FEED_2" },
        { address, abi: ABI, functionName: "QUOTE_FEED_1" },
        { address, abi: ABI, functionName: "QUOTE_FEED_2" },
        { address, abi: ABI, functionName: "read" },
        { address, abi: ABI, functionName: "peek" },
      ],
      { allowFailure: true, chainId },
    );
    const desc = r[0] as string | null;
    const lrd = r[1];
    const lans = r[2] as bigint | null;
    const feeds = [r[3], r[4], r[5], r[6]].filter((f): f is Address => !!f && (f as string) !== ZERO) as Address[];
    const rd = r[7];
    const pk = r[8];

    const descs: string[] = [];
    const names: string[] = [];
    names.push(await getContractName(address, chainId)); // 오라클 자체 이름 (★핵심 신호)
    if (desc) descs.push(desc);
    for (const f of feeds) {
      const [fd, fn] = await Promise.all([readDescription(f, chainId), getContractName(f, chainId)]);
      if (fd) descs.push(fd);
      if (fn) names.push(fn);
    }

    const cl = classify(names, descs);
    const onchain = !!(desc || feeds.length || lans != null || lrd != null || rd != null || pk != null);
    const hasName = names.some(Boolean);

    if (cl) {
      result = { description: cl.description, provider: cl.provider, type: cl.type, depegSensitive: cl.depeg, verified: onchain || hasName };
    } else if (lans != null || lrd != null) {
      result = { description: names.find(Boolean) || null, provider: names.find(Boolean) || "온체인 가격피드", type: "MARKET", depegSensitive: true, verified: true };
    } else if (rd != null || pk != null) {
      result = { description: names.find(Boolean) || null, provider: names.find(Boolean) || "Maker/Chronicle", type: "MARKET", depegSensitive: true, verified: true };
    } else if (collatAddr) {
      // 비표준 오라클 — 바이트코드가 담보 주소를 참조하면 self-NAV(reflexive).
      const code = ((await rpcFor(chainId).getBytecode({ address }).catch(() => null)) || "").toLowerCase();
      const refs = code.includes(collatAddr.slice(2).toLowerCase());
      result = refs
        ? { description: names.find(Boolean) || "self-referential", provider: names.find(Boolean) || "self-NAV (바이트코드 담보참조)", type: "NAV", depegSensitive: false, verified: true }
        : fallback(fallbackSymbol);
    } else {
      result = fallback(fallbackSymbol);
    }
  } catch {
    result = fallback(fallbackSymbol);
  }

  _cache.set(key, result);
  return result;
}
