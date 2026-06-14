import type { Address } from "viem";

import { rpc } from "@/lib/rpc";
import { getContractName } from "@/lib/etherscan";
import { probeUnderlying, resolveProxy } from "@/lego/onchain";
import { lookupProtocol, type ProtocolRegistryEntry } from "@/registry/protocol-registry";

/**
 * 주소 분류 (B10 자동 라벨링 — kuromi classify/proxy 포팅을 protocol-registry 위에 얹음):
 *   1. 레지스트리 정확 매치 → ProtocolRegistryEntry (확정)
 *   2. 미지 컨트랙트 → 프록시 해석(EIP-1967/비콘/1167) + 셀렉터 프로브 + 기초자산 프로브 + Etherscan
 *      이름 → "어디 프로토콜의 무슨 역할"을 추정 라벨로 제안 (사람이 review 로 승인 → 레지스트리 반영)
 *   3. EOA → whale_eoa (그래프 제외)
 * 모르면 거짓 확정 대신 unknown(정직).
 */

export type Classification =
  | { kind: "protocol"; entry: ProtocolRegistryEntry }
  | { kind: "candidate"; family: string; reason: string; label: string | null; underlying: string | null; proxyImpl: string | null; isContract: true }
  | { kind: "whale_eoa"; isContract: false }
  | { kind: "unknown"; isContract: boolean; label: string | null; proxyImpl: string | null };

// Function selector → family hint (인자 없이/0 인자로 불러도 revert 안 하면 매치)
const SELECTOR_HINTS: Array<{ selector: string; family: string; reason: string }> = [
  { selector: "0x35ea6a75", family: "aave_v3", reason: "getReserveData(address) — Aave V3(포크) 풀" },
  { selector: "0x261a323e", family: "morpho_blue", reason: "idToMarketParams(bytes32) — Morpho Blue" },
  { selector: "0xb74f55a0", family: "morpho_blue", reason: "market(bytes32) — Morpho Blue" },
  { selector: "0x38d52e0f", family: "erc4626_vault", reason: "asset() — ERC-4626 볼트" },
  { selector: "0x01e1d114", family: "erc4626_vault", reason: "totalAssets() — ERC-4626 볼트" },
  { selector: "0xc9c65396", family: "compound_v3", reason: "getAssetInfo(uint8) — Compound V3 Comet" },
];

// 비어있지 않은(0x 초과) 응답을 요구 — revert 만 안 하면 매치하던 약한 휴리스틱의 오탐(빈 응답·7702 EOA) 차단.
async function selectorReadable(address: Address, selector: string): Promise<boolean> {
  try {
    const r = await rpc().call({ to: address, data: `${selector}${"00".repeat(32)}` as `0x${string}` });
    return !!r.data && r.data.length > 2;
  } catch {
    return false;
  }
}

// 일반 프록시 이름(껍데기) — 이런 이름이면 구현체 이름을 라벨로 선호
const GENERIC_PROXY_NAME = /proxy|upgradeable|erc1967|beacon/i;

export async function classify(address: Address): Promise<Classification> {
  // 1) 레지스트리 정확 매치 (확정)
  const entry = lookupProtocol(address);
  if (entry) return { kind: "protocol", entry };

  // 2) 컨트랙트 여부 (EOA 는 그래프 제외)
  let isContract = false;
  try {
    const code = await rpc().getBytecode({ address });
    isContract = !!code && code !== "0x";
  } catch { /* swallow */ }
  if (!isContract) return { kind: "whale_eoa", isContract: false };

  // 3) 프록시 해석 + Etherscan 이름 → 사람이 읽는 라벨 (껍데기면 구현체 이름 선호)
  const px = await resolveProxy("ethereum", address);
  let label: string | null = (await getContractName(address, 1)) || null;
  if ((!label || GENERIC_PROXY_NAME.test(label)) && px) {
    const implName = (await getContractName(px.implementation, 1)) || null;
    if (implName) label = implName;
  }
  const proxyImpl = px?.implementation ?? null;

  // 4) 기초자산 프로브 (asset()/UNDERLYING_ASSET_ADDRESS()/stETH()/eETH()) → 래퍼/aToken + 원토큰
  const underlying = await probeUnderlying("ethereum", address);

  // 5) 셀렉터 휴리스틱 → family 추정
  for (const h of SELECTOR_HINTS) {
    if (await selectorReadable(address, h.selector)) {
      return { kind: "candidate", family: h.family, reason: h.reason, label, underlying, proxyImpl, isContract: true };
    }
  }
  // 6) 기초자산이 잡히면(래퍼/4626/aToken) candidate 로 (셀렉터 미스여도)
  if (underlying) {
    return { kind: "candidate", family: "wrapper_or_atoken", reason: "asset()/underlying() 응답 — 래퍼·4626·aToken 류", label, underlying, proxyImpl, isContract: true };
  }
  return { kind: "unknown", isContract: true, label, proxyImpl };
}

/** 분류 → 한 줄 제안 라벨 (unknown_addresses.heuristic_hint 용). "어디 프로토콜의 무슨 역할" 지향. */
export function suggestLabel(c: Classification): string {
  switch (c.kind) {
    case "protocol": return `${c.entry.protocolNodeId} · ${c.entry.role}`;
    case "candidate": return `~${c.family}${c.label ? ` · ${c.label}` : ""}${c.underlying ? ` (underlying ${c.underlying.slice(0, 8)}…)` : ""}`;
    case "whale_eoa": return "EOA(지갑) — 그래프 제외";
    case "unknown": return c.label ? `미확인 · ${c.label}` : "미확인 컨트랙트";
  }
}
