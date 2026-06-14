/**
 * 브릿지 메커니즘 분류 — 큐레이터가 "약한 브릿지"를 한눈에 보게.
 *
 * 3종 메커니즘(리스크 성격이 다름):
 *  - lock_mint  (락&민트, canonical): 소스에 담보 락 → dest 에 민팅. L1 담보가 백킹. 보통 가장 감사됨.
 *  - burn_mint  (번&민트, 네이티브/OFT/CCTP): 소스 소각 → dest 민팅. 메시지층(LZ/CCIP/Wormhole) 신뢰 가정.
 *                그 층이 침해되면 무담보 무한 민팅 → 디페그. = 보통 "가장 약한 고리".
 *  - liquidity  (유동성 풀, Stargate/Across/Hop): 민팅 없이 양쪽 풀로 스왑. 솔벤시 위험 낮음, 유동성/슬리피지 위험.
 */

export type BridgeMechanism = "lock_mint" | "burn_mint" | "liquidity";

export interface BridgeClass {
  mechanism: BridgeMechanism;
  protocol: string; // 풀네임 (LayerZero, Chainlink CCIP, Wormhole, Canonical …)
  tag: string;      // 짧은 칩 라벨 (LZ, CCIP, canonical, Wormhole …)
  weak: boolean;    // 알려진 취약/사고 이력(무담보 민팅 고위험)
}

// 이름(소문자, 부분일치) → 분류. 메시지층 보안이 번&민트 안전성을 좌우.
const RULES: { re: RegExp; cls: Omit<BridgeClass, never> }[] = [
  { re: /layerzero|^lz$|\boft\b/, cls: { mechanism: "burn_mint", protocol: "LayerZero", tag: "LZ", weak: false } },
  { re: /stargate/, cls: { mechanism: "liquidity", protocol: "Stargate (LZ)", tag: "Stargate", weak: false } },
  { re: /ccip|chainlink/, cls: { mechanism: "burn_mint", protocol: "Chainlink CCIP", tag: "CCIP", weak: false } },
  { re: /cctp|circle/, cls: { mechanism: "burn_mint", protocol: "Circle CCTP", tag: "CCTP", weak: false } },
  { re: /wormhole|portal/, cls: { mechanism: "lock_mint", protocol: "Wormhole", tag: "Wormhole", weak: false } },
  { re: /axelar/, cls: { mechanism: "lock_mint", protocol: "Axelar", tag: "Axelar", weak: false } },
  { re: /across/, cls: { mechanism: "liquidity", protocol: "Across", tag: "Across", weak: false } },
  { re: /\bhop\b/, cls: { mechanism: "liquidity", protocol: "Hop", tag: "Hop", weak: false } },
  { re: /synapse/, cls: { mechanism: "liquidity", protocol: "Synapse", tag: "Synapse", weak: false } },
  { re: /connext/, cls: { mechanism: "liquidity", protocol: "Connext", tag: "Connext", weak: false } },
  { re: /celer|cbridge/, cls: { mechanism: "liquidity", protocol: "Celer cBridge", tag: "Celer", weak: false } },
  { re: /multichain|anyswap/, cls: { mechanism: "burn_mint", protocol: "Multichain", tag: "Multichain", weak: true } }, // 사고 이력
  { re: /polygon/, cls: { mechanism: "lock_mint", protocol: "Polygon PoS", tag: "PoS", weak: false } },
  { re: /gnosis|omnibridge|\bamb\b/, cls: { mechanism: "lock_mint", protocol: "Gnosis (AMB)", tag: "AMB", weak: false } },
  { re: /\bbsc\b|binance/, cls: { mechanism: "lock_mint", protocol: "BNB Bridge", tag: "BNB", weak: false } },
];

/**
 * 브릿지 이름/유형 → 메커니즘 분류.
 *   opts.oft        → 동일주소 OFT 메시 (burn&mint, LayerZero)
 *   opts.canonical  → 추정 캐노니컬(L2 네이티브) = lock&mint
 */
export function classifyBridge(name: string, opts?: { canonical?: boolean; oft?: boolean }): BridgeClass {
  if (opts?.oft) return { mechanism: "burn_mint", protocol: "LayerZero OFT", tag: "LZ OFT", weak: false };
  const n = (name || "").toLowerCase();
  for (const r of RULES) if (r.re.test(n)) return { ...r.cls };
  if (opts?.canonical) return { mechanism: "lock_mint", protocol: "Canonical", tag: "canonical", weak: false };
  // 미상 → 캐노니컬(락&민트) 가정 (가장 보수적). 표시만 그대로.
  return { mechanism: "lock_mint", protocol: name || "bridge", tag: name || "bridge", weak: false };
}

export const MECH_LABEL: Record<BridgeMechanism, string> = {
  lock_mint: "락 & 민트 (담보 백킹)",
  burn_mint: "번 & 민트 (네이티브 민팅)",
  liquidity: "유동성 풀 (스왑)",
};

// 메커니즘별 한줄 리스크 노트 (큐레이터용)
export function mechNote(c: BridgeClass): string {
  if (c.mechanism === "burn_mint")
    return `메시지층(${c.protocol}) 신뢰 가정 — 침해 시 무담보 무한 민팅 → 디페그.${c.weak ? " ⚠️ 사고 이력 있는 브릿지." : ""}`;
  if (c.mechanism === "liquidity")
    return `양쪽 풀로 스왑(민팅 X). 솔벤시 위험 낮음, 유동성 고갈·슬리피지 위험.`;
  return `소스에 담보 락 → dest 민팅. L1 담보가 백킹(보통 가장 감사됨). 브릿지 침해 시 무담보 위험.`;
}
