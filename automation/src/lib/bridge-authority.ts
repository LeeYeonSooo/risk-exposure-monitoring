import { type Address, createPublicClient, getAddress, http, keccak256, type PublicClient, toHex } from "viem";

import { chainIdOf, evmRpcUrl } from "@/config/chains";
import { detectBridgeStandards, resolveCcipTopology, type ExtraAuthType } from "./bridge-standards";
import { discoverBridgesByMintEvents } from "./bridge-mint-events";
import { archiveClientFor, hasArchiveRpc, publicClientFor, scanLogsRecent } from "./public-rpc";

/**
 * 온체인 브릿지 mint 권한 리더 — "추정" 브릿지를 "검증된 브릿지 + 한도"로.
 *
 * 큐레이터의 핵심 질문: "이 담보(토큰)는 어떤 브릿지에 mint 권한을 줬고, 각 한도가 얼마인가?"
 *   → 그 권한이 약하거나 한도가 크면 = 무담보 민팅으로 디페그될 "약한 크로스체인 고리".
 *
 * 우선순위(가장 확정적 → 약한 신호):
 *   1) xERC20  : BridgeLimitsSet 이벤트로 브릿지 enumerate + mintingMaxLimitOf/CurrentLimitOf = 정확한 mint 한도.
 *   2) MINTER_ROLE (AccessControlEnumerable): mint 권한 보유 주소 목록(한도는 보통 무제한).
 *   3) OFT peers (LayerZero): 신뢰하는 원격 OFT — burn&mint 메시 경로.
 *   4) CCIP TokenAdminRegistry.getPool: 그 체인 CCIP 풀(burn&mint 시 mint 권한).
 */

// RPC 는 공용 레지스트리(config/chains.ts EVM_CHAINS, 18체인) — Alchemy(키) 우선, 공개 RPC 폴백.
const _clients = new Map<string, PublicClient>();
function clientFor(chain: string): PublicClient | null {
  const url = evmRpcUrl(chain);
  if (!url) return null;
  if (_clients.has(chain)) return _clients.get(chain)!;
  const c = createPublicClient({ transport: http(url, { retryCount: 2, retryDelay: 500, timeout: 25_000 }) }) as PublicClient;
  _clients.set(chain, c);
  return c;
}

const MINTER_ROLE = keccak256(toHex("MINTER_ROLE")); // 0x9f2d…
const ZERO32 = /^0x0+$/;

const XERC20_ABI = [
  { name: "mintingMaxLimitOf", type: "function", stateMutability: "view", inputs: [{ name: "b", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "mintingCurrentLimitOf", type: "function", stateMutability: "view", inputs: [{ name: "b", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const BRIDGE_LIMITS_SET_TOPIC0 = keccak256(toHex("BridgeLimitsSet(uint256,uint256,address)")); // _bridge 는 유일 indexed = topic1
const ACE_ABI = [
  { name: "getRoleMemberCount", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { name: "getRoleMember", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "address" }] },
] as const;
const DECIMALS_ABI = [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
const OFT_ABI = [
  { name: "peers", type: "function", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "bytes32" }] },
  { name: "endpoint", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
// CCIP TokenAdminRegistry (체인별, best-effort)
const CCIP_REGISTRY: Record<string, Address> = {
  ethereum: "0xb22764f98dD05c789929716D677382Df22C05Cb6",
  base: "0x6f6C373d09C07425BaAE72317863d7F6bb731e37",
  arbitrum: "0x39AE1032cF4B334a1Ed41cd24eb5C0454031f0c0",
  optimism: "0x657c42abE4CD8aa731Aec322f871B5b90cf6274F",
  polygon: "0x00F027eA6D9fd0d4664756F62832b3D4F90faC0E",
};
const CCIP_REG_ABI = [{ name: "getPool", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }] as const;

// LayerZero v2 EID → 체인
const LZ_EIDS: Record<number, string> = {
  30101: "ethereum", 30102: "bsc", 30106: "avalanche", 30109: "polygon", 30110: "arbitrum",
  30111: "optimism", 30145: "gnosis", 30181: "mantle", 30183: "linea", 30184: "base", 30214: "scroll",
};

// 체인명 → chainId 는 공용 레지스트리(chainIdOf) 사용 — 추가 표준 프로브가 Arbitrum/zkSync 구분 등에 씀.

export type AuthType = "xerc20" | "minter_role" | "oft_peer" | "ccip_pool" | "ccip_remote" | ExtraAuthType | "mint_event";
export interface BridgeAuthority {
  address: string;
  type: AuthType;
  mintLimit: number | null;     // 사람이 읽는 토큰 단위(없으면 null=무제한/미상)
  mintLimitRaw: string | null;
  currentLimitRaw: string | null;
  note: string;
}
export interface BridgeAuthorityResult {
  tokenAddr: string;
  chain: string;
  sources: AuthType[];
  decimals: number;
  bridges: BridgeAuthority[];
}

const fmtUnits = (raw: bigint, decimals: number): number => {
  const d = Math.max(0, decimals - 6);
  return Number(raw / 10n ** BigInt(d)) / 1e6;
};

export async function readBridgeAuthority(tokenAddr: string, chain: string): Promise<BridgeAuthorityResult | null> {
  const client = clientFor(chain);
  if (!client) return null;
  let token: Address;
  try { token = getAddress(tokenAddr); } catch { return null; }

  let decimals = 18;
  try { decimals = Number(await client.readContract({ address: token, abi: DECIMALS_ABI, functionName: "decimals" })); } catch { /* keep 18 */ }

  const bridges: BridgeAuthority[] = [];
  const sources = new Set<AuthType>();
  const pushUniq = (b: BridgeAuthority) => { if (!bridges.some((x) => x.address === b.address && x.type === b.type)) bridges.push(b); };

  // 1) xERC20 — BridgeLimitsSet 로 브릿지 enumerate.
  //    로그는 publicnode 로(Alchemy 무료티어는 getLogs 10블록 제한 → 사실상 불가). bounded 최근 스캔.
  //    ARCHIVE_RPC_URL(D#12) 있으면 archive 클라이언트로 한 콜 full-history(deep).
  try {
    const pub = archiveClientFor(chain) ?? publicClientFor(chain);
    const logs = pub ? await scanLogsRecent(pub, token, [BRIDGE_LIMITS_SET_TOPIC0], 5, hasArchiveRpc()) : [];
    const seen = new Set<string>();
    for (const lg of logs) { const t1 = lg.topics?.[1]; if (!t1) continue; const b = ("0x" + t1.slice(-40)).toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(b)) seen.add(b); }
    for (const b of seen) {
      try {
        const max = (await client.readContract({ address: token, abi: XERC20_ABI, functionName: "mintingMaxLimitOf", args: [getAddress(b)] })) as bigint;
        const cur = (await client.readContract({ address: token, abi: XERC20_ABI, functionName: "mintingCurrentLimitOf", args: [getAddress(b)] })) as bigint;
        if (max > 0n) {
          pushUniq({ address: b, type: "xerc20", mintLimit: fmtUnits(max, decimals), mintLimitRaw: max.toString(), currentLimitRaw: cur.toString(), note: "xERC20 mint 한도" });
          sources.add("xerc20");
        }
      } catch { /* skip */ }
    }
  } catch { /* getLogs 실패(범위/미지원) — 다음 신호로 */ }

  // 2) MINTER_ROLE (xERC20 못 찾았을 때만 — 보통 둘 중 하나)
  if (!bridges.length) {
    try {
      const cnt = Number((await client.readContract({ address: token, abi: ACE_ABI, functionName: "getRoleMemberCount", args: [MINTER_ROLE] })) as bigint);
      for (let i = 0; i < Math.min(cnt, 25); i++) {
        try {
          const m = (await client.readContract({ address: token, abi: ACE_ABI, functionName: "getRoleMember", args: [MINTER_ROLE, BigInt(i)] })) as string;
          pushUniq({ address: m.toLowerCase(), type: "minter_role", mintLimit: null, mintLimitRaw: null, currentLimitRaw: null, note: "MINTER_ROLE (한도 무제한 가능)" });
          sources.add("minter_role");
        } catch { /* skip */ }
      }
    } catch { /* not AccessControlEnumerable */ }
  }

  // 3) OFT peers — endpoint() 있으면 LZ OFT → 신뢰 peer enumerate
  try {
    await client.readContract({ address: token, abi: OFT_ABI, functionName: "endpoint" }); // reverts if not OFT
    for (const [eidStr, cname] of Object.entries(LZ_EIDS)) {
      try {
        const p = (await client.readContract({ address: token, abi: OFT_ABI, functionName: "peers", args: [Number(eidStr)] })) as string;
        if (p && !ZERO32.test(p)) {
          pushUniq({ address: "0x" + p.slice(-40), type: "oft_peer", mintLimit: null, mintLimitRaw: null, currentLimitRaw: null, note: `LZ OFT peer → ${cname}` });
          sources.add("oft_peer");
        }
      } catch { /* skip eid */ }
    }
  } catch { /* not OFT */ }

  // 4) CCIP TokenAdminRegistry.getPool — best-effort
  const reg = CCIP_REGISTRY[chain];
  if (reg) {
    try {
      const pool = (await client.readContract({ address: reg, abi: CCIP_REG_ABI, functionName: "getPool", args: [token] })) as string;
      if (pool && !ZERO32.test(pool)) {
        // Method B — CCIP 원격 토폴로지: 연결 체인 + 각 체인의 원격 풀/토큰 주소.
        const topo = await resolveCcipTopology(client, getAddress(pool)).catch(() => [] as Awaited<ReturnType<typeof resolveCcipTopology>>);
        const chains = topo.map((r) => r.chain);
        const rtxt = chains.length ? ` · 연결 ${chains.length}체인: ${chains.slice(0, 6).join(", ")}` : "";
        pushUniq({ address: pool.toLowerCase(), type: "ccip_pool", mintLimit: null, mintLimitRaw: null, currentLimitRaw: null, note: "Chainlink CCIP 토큰풀" + rtxt });
        sources.add("ccip_pool");
        // 원격 풀 주소 1급화 — 토폴로지(어느 체인의 어느 컨트랙트에 연결됐나)를 authority 로.
        for (const r of topo) {
          if (!r.remotePool) continue;
          const tnote = r.remoteToken ? ` (원격토큰 ${r.remoteToken.slice(0, 10)}…)` : "";
          pushUniq({ address: r.remotePool, type: "ccip_remote", mintLimit: null, mintLimitRaw: null, currentLimitRaw: null, note: `CCIP 원격 풀 @${r.chain}${tnote}` });
          sources.add("ccip_remote");
        }
      }
    } catch { /* registry/pool 없음 */ }
  }

  // 5) 한도 enrich — getLogs 막힌 환경에서도 eth_call 로 xERC20 한도 확보:
  //    이미 발견된 브릿지(minter/ccip)에 mintingMaxLimitOf 직접 조회 → 토큰이 xERC20 면 한도가 채워짐.
  for (const b of bridges) {
    if (b.mintLimit != null || b.type === "oft_peer") continue;
    try {
      const max = (await client.readContract({ address: token, abi: XERC20_ABI, functionName: "mintingMaxLimitOf", args: [getAddress(b.address)] })) as bigint;
      if (max > 0n) {
        const cur = (await client.readContract({ address: token, abi: XERC20_ABI, functionName: "mintingCurrentLimitOf", args: [getAddress(b.address)] }).catch(() => 0n)) as bigint;
        b.mintLimit = fmtUnits(max, decimals);
        b.mintLimitRaw = max.toString();
        b.currentLimitRaw = cur.toString();
        b.note += " · xERC20 한도 확인됨";
        sources.add("xerc20");
      }
    } catch { /* not xERC20 */ }
  }

  // 6) 추가 브릿지 표준 (Method C) — Hyperlane/OP/Arbitrum·zkSync/Axelar/CCTP/Polygon PoS/Wormhole NTT/xERC20 lockbox.
  const chainId = chainIdOf(chain);
  if (chainId) {
    const extra = await detectBridgeStandards(client, token, chainId).catch(() => [] as Awaited<ReturnType<typeof detectBridgeStandards>>);
    for (const e of extra) {
      pushUniq({ address: e.address, type: e.type, mintLimit: null, mintLimitRaw: null, currentLimitRaw: null, note: e.note });
      sources.add(e.type);
    }
  }

  // 7) fallback (Method E) — view 함수로 아무 브릿지도 못 찾았을 때만 mint 이벤트로 추정.
  //    cost(getLogs+getTx) 있어 bridges 0건일 때만. 상위 2개(1위가 가장 유력)를 mint_event(추정)로.
  if (bridges.length === 0) {
    const cands = await discoverBridgesByMintEvents(token, chain).catch(() => []);
    for (const c of cands.slice(0, 2)) {
      pushUniq({ address: c.address, type: "mint_event", mintLimit: null, mintLimitRaw: null, currentLimitRaw: null, note: `mint 이벤트 추정 브릿지 (mint ${c.mintTxCount}건)` });
      sources.add("mint_event");
    }
  }

  return { tokenAddr: token.toLowerCase(), chain, sources: [...sources], decimals, bridges };
}
