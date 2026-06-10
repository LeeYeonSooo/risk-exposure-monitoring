/**
 * 지갑 밸류 급감 — 브릿지 in-flight FP 가드 (BACKLOG P2-7, 전문가 §3.2).
 *
 * 함정: 추적 지갑이 Optimistic 롤업으로 **L2→L1 인출**(7일 챌린지) 하면, 그 기간 동안 자금이
 * 브릿지 에스크로/메신저에 묶여 포트폴리오 총액이 "비어 보임" → `wallet_value_drop` 오탐(FP).
 * 가드: 급감 직전 윈도우의 **아웃고잉 전송 목적지가 known 브릿지**면 "in-flight/settling"로 보고
 *      알림을 info 로 다운그레이드(페이지 억제, 기록은 유지).
 *
 * known 브릿지 = ① 온체인 검증된 `bridge_authorities`(토큰별 풀/lockbox/OFT/CCIP) ② canonical 브릿지
 * (OP-stack 예약주소·ArbSys 등 — 결정론적/문서화된 안전 주소). 잘못된 주소 위험은 다운그레이드(삭제 아님)로 제한.
 */
import { getOutgoingTransfers } from "@/lib/alchemy";

// canonical 브릿지/메신저 컨트랙트 (소문자). 체인별. 확실한(결정론적/널리 문서화된) 것만.
export const KNOWN_BRIDGES: Record<string, Set<string>> = {
  // OP-stack 예약주소(Optimism·Base 등 — 결정론적, 100% 안전): L2StandardBridge·L2ToL1MessagePasser·L2CrossDomainMessenger
  optimism: new Set(["0x4200000000000000000000000000000000000010", "0x4200000000000000000000000000000000000016", "0x4200000000000000000000000000000000000007"]),
  base: new Set(["0x4200000000000000000000000000000000000010", "0x4200000000000000000000000000000000000016", "0x4200000000000000000000000000000000000007"]),
  // Arbitrum L2→L1: ArbSys(예약주소)
  arbitrum: new Set(["0x0000000000000000000000000000000000000064"]),
  // Ethereum L1 gateways (canonical, 문서화):
  ethereum: new Set([
    "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", // Optimism L1StandardBridge
    "0x3154cf16ccdb4c6d922629664174b904d80f2c35", // Base L1StandardBridge
    "0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a", // Arbitrum L1 Gateway Router
    "0xa3a7b6f88361f48403514059f1f16c8e78d60eec", // Arbitrum L1 ERC20 Gateway
    "0xa0c68c638235ee32657e8f720a23cec1bfc77c77", // Polygon PoS Bridge
    "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf", // Polygon PoS ERC20 predicate
    "0x32400084c286cf3e17e7b677ea9583e60a000324", // zkSync Era Diamond
  ]),
  polygon: new Set([]),
};

const CHAINS = ["ethereum", "optimism", "base", "arbitrum", "polygon"];

export interface BridgeOutflowHit { chain: string; to: string; asset: string; value: number; }

/** DB `bridge_authorities` 의 검증 주소 — 추가 known-브릿지(체인 무관, 컨트랙트 주소 매칭). */
export async function loadVerifiedBridgeAddrs(query: (sql: string) => Promise<{ rows: { addr: string }[] }>): Promise<Set<string>> {
  try {
    const r = await query(`SELECT DISTINCT lower(bridge_addr) AS addr FROM bridge_authorities WHERE bridge_addr IS NOT NULL`);
    return new Set(r.rows.map((x) => x.addr).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * 급감 윈도우(sinceUnixSec 이후) 동안 지갑이 known 브릿지로 보낸 아웃고잉 전송이 있나.
 * 주요 체인을 순회(급감은 드물어 bounded). 첫 히트 반환, 없으면 null. ALCHEMY_API_KEY 없으면 null(가드 미작동).
 */
export async function detectBridgeOutflow(wallet: string, sinceUnixSec: number, verified: Set<string>): Promise<BridgeOutflowHit | null> {
  for (const chain of CHAINS) {
    const transfers = await getOutgoingTransfers(wallet, chain, sinceUnixSec).catch(() => []);
    for (const t of transfers) {
      if (!t.to) continue;
      if (KNOWN_BRIDGES[chain]?.has(t.to) || verified.has(t.to)) {
        return { chain, to: t.to, asset: t.asset, value: t.value };
      }
    }
  }
  return null;
}
