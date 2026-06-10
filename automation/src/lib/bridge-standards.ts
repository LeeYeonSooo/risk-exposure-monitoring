import { type Abi, type Address, type PublicClient, getAddress, keccak256, toHex } from "viem";

/**
 * 추가 브릿지 표준 온체인 감지 — `get_token_bridge_address`(Python Method C/B)의 TS 포팅.
 *
 * 기존 bridge-authority.ts 가 잡는 것: xERC20(BridgeLimitsSet 한도) · MINTER_ROLE · OFT peer · CCIP pool.
 * 이 모듈이 추가로 잡는 것(전부 view 함수 프로빙, 읽기 전용):
 *   xERC20 lockbox · Hyperlane Warp · OP Standard Bridge · Arbitrum/zkSync canonical ·
 *   Axelar ITS · Circle CCTP · Polygon PoS · Wormhole NTT,  + CCIP 원격 토폴로지(연결 체인).
 *
 * 원칙(원본과 동일): 표준 함수로 노출 안 되면 "틀린 답" 대신 조용히 skip(감지 없음).
 */

export type ExtraAuthType =
  | "xerc20_lockbox" | "hyperlane" | "op_bridge" | "l2_canonical"
  | "axelar_its" | "cctp" | "polygon_pos" | "wormhole_ntt";

export interface DetectedBridge { address: string; type: ExtraAuthType; note: string; }

const ZERO = /^0x0*$/;
const isZero = (h: string): boolean => !h || h === "0x" || ZERO.test(h);

const addrAbi = (fn: string): Abi => [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const bytes32Abi = (fn: string): Abi => [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }];
const ACE_ABI: Abi = [
  { type: "function", name: "getRoleMemberCount", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getRoleMember", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "address" }] },
];
const HYP_DOMAINS_ABI: Abi = [{ type: "function", name: "domains", stateMutability: "view", inputs: [], outputs: [{ type: "uint32[]" }] }];
const NTT_TOKEN_ABI: Abi = [{ type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const NTT_MODE_ABI: Abi = [{ type: "function", name: "getMode", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }];
const POOL_CHAINS_ABI: Abi = [{ type: "function", name: "getSupportedChains", stateMutability: "view", inputs: [], outputs: [{ type: "uint64[]" }] }];

const DEPOSITOR_ROLE = keccak256(toHex("DEPOSITOR_ROLE"));

// CCTP 는 토큰 인터페이스로 감지 불가 → 알려진 USDC 레지스트리(TokenMessenger 공통 진입점).
const CCTP_USDC: Record<number, { usdc: string; messenger: string }> = {
  1: { usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", messenger: "0xbd3fa81b58ba92a82136038b25adec7066af3155" },
};

// CCIP chain selector(Chainlink) → 체인명. 주요 메인넷만(모르면 selector:N 으로 표기).
const CCIP_SELECTOR_CHAIN: Record<string, string> = {
  "5009297550715157269": "ethereum",
  "4949039107694359620": "arbitrum",
  "15971525489660198786": "base",
  "3734403246176062136": "optimism",
  "4051577828743386545": "polygon",
  "6433500567565415381": "avalanche",
  "11344663589394136015": "bsc",
  "465200560073787000": "gnosis",
};

/** 여러 후보 함수명 중 처음으로 0 아닌 주소를 반환(소문자). 전부 revert/0 이면 null. */
async function readAddrTry(client: PublicClient, address: Address, fns: string[]): Promise<string | null> {
  for (const fn of fns) {
    try {
      const r = String(await client.readContract({ address, abi: addrAbi(fn), functionName: fn }));
      if (!isZero(r)) return getAddress(r).toLowerCase();
    } catch { /* try next signature */ }
  }
  return null;
}

async function probeXerc20Lockbox(client: PublicClient, token: Address): Promise<DetectedBridge | null> {
  const lb = await readAddrTry(client, token, ["lockbox"]);
  return lb ? { address: lb, type: "xerc20_lockbox", note: "xERC20 lockbox (lock&mint 백킹)" } : null;
}

async function probeHyperlane(client: PublicClient, token: Address): Promise<DetectedBridge | null> {
  const mb = await readAddrTry(client, token, ["mailbox"]);
  if (!mb) return null;
  let n = 0;
  try { n = ((await client.readContract({ address: token, abi: HYP_DOMAINS_ABI, functionName: "domains" })) as readonly unknown[]).length; } catch { /* */ }
  return { address: mb, type: "hyperlane", note: `Hyperlane Warp · mailbox${n ? ` · ${n} domains` : ""}` };
}

async function probeOptimism(client: PublicClient, token: Address): Promise<DetectedBridge | null> {
  const l1 = await readAddrTry(client, token, ["remoteToken", "l1Token"]);
  if (!l1) return null;
  const br = await readAddrTry(client, token, ["bridge", "BRIDGE", "l2Bridge"]);
  return { address: br ?? l1, type: "op_bridge", note: `OP Standard Bridge · L1 토큰 ${l1.slice(0, 10)}…` };
}

async function probeL2Canonical(client: PublicClient, token: Address, chainId: number): Promise<DetectedBridge | null> {
  const l1 = await readAddrTry(client, token, ["l1Address"]);
  if (!l1) return null;
  const br = await readAddrTry(client, token, ["l2Bridge", "bridge", "BRIDGE"]);
  const std = chainId === 324 ? "zkSync" : chainId === 42161 ? "Arbitrum" : "L2 Canonical";
  return { address: br ?? l1, type: "l2_canonical", note: `${std} Bridge · L1 원본 ${l1.slice(0, 10)}…` };
}

async function probeAxelar(client: PublicClient, token: Address): Promise<DetectedBridge | null> {
  let tokenId: string | null = null;
  try { const r = String(await client.readContract({ address: token, abi: bytes32Abi("interchainTokenId"), functionName: "interchainTokenId" })); if (!isZero(r)) tokenId = r; } catch { /* */ }
  const its = await readAddrTry(client, token, ["interchainTokenService"]);
  if (!tokenId && !its) return null;
  return { address: its ?? token.toLowerCase(), type: "axelar_its", note: `Axelar ITS${tokenId ? ` · tokenId ${tokenId.slice(0, 10)}…` : ""}` };
}

function probeCctp(token: Address, chainId: number): DetectedBridge | null {
  const info = CCTP_USDC[chainId];
  if (!info || token.toLowerCase() !== info.usdc) return null;
  return { address: info.messenger, type: "cctp", note: "Circle CCTP · TokenMessenger(공통 진입점)" };
}

async function probePolygonPos(client: PublicClient, token: Address): Promise<DetectedBridge | null> {
  try {
    const cnt = Number(await client.readContract({ address: token, abi: ACE_ABI, functionName: "getRoleMemberCount", args: [DEPOSITOR_ROLE] }));
    if (!cnt) return null;
    const m = String(await client.readContract({ address: token, abi: ACE_ABI, functionName: "getRoleMember", args: [DEPOSITOR_ROLE, 0n] }));
    if (isZero(m)) return null;
    return { address: getAddress(m).toLowerCase(), type: "polygon_pos", note: "Polygon PoS · DEPOSITOR_ROLE(ChildChainManager)" };
  } catch { return null; }
}

async function probeWormholeNtt(client: PublicClient, token: Address): Promise<DetectedBridge | null> {
  const m = await readAddrTry(client, token, ["minter"]);
  if (!m) return null;
  try {
    const t = String(await client.readContract({ address: getAddress(m), abi: NTT_TOKEN_ABI, functionName: "token" }));
    if (isZero(t) || getAddress(t).toLowerCase() !== token.toLowerCase()) return null;
    await client.readContract({ address: getAddress(m), abi: NTT_MODE_ABI, functionName: "getMode" }); // NttManager 아니면 revert
    return { address: m, type: "wormhole_ntt", note: "Wormhole NTT · NttManager" };
  } catch { return null; }
}

/**
 * 토큰에서 추가 브릿지 표준을 온체인으로 감지. 독립 view 콜이라 병렬 실행, 각 실패는 무시(null).
 */
export async function detectBridgeStandards(client: PublicClient, token: Address, chainId: number): Promise<DetectedBridge[]> {
  const out: DetectedBridge[] = [];
  const cctp = probeCctp(token, chainId);
  if (cctp) out.push(cctp);
  const results = await Promise.all([
    probeXerc20Lockbox(client, token).catch(() => null),
    probeHyperlane(client, token).catch(() => null),
    probeOptimism(client, token).catch(() => null),
    probeL2Canonical(client, token, chainId).catch(() => null),
    probeAxelar(client, token).catch(() => null),
    probePolygonPos(client, token).catch(() => null),
    probeWormholeNtt(client, token).catch(() => null),
  ]);
  for (const r of results) if (r) out.push(r);
  return out;
}

const CCIP_REMOTE_POOLS_ABI: Abi = [{ type: "function", name: "getRemotePools", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [{ type: "bytes[]" }] }];
const CCIP_REMOTE_POOL_ABI: Abi = [{ type: "function", name: "getRemotePool", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [{ type: "bytes" }] }];
const CCIP_REMOTE_TOKEN_ABI: Abi = [{ type: "function", name: "getRemoteToken", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [{ type: "bytes" }] }];

/** CCIP 원격 주소는 bytes(ABI-encoded). EVM 이면 마지막 20바이트가 주소. 비-EVM/빈 값 → null. */
function evmAddrFromBytes(hex: string | null | undefined): string | null {
  if (!hex || hex === "0x") return null;
  const h = hex.replace(/^0x/, "");
  if (h.length < 40) return null;
  const last40 = h.slice(-40);
  if (/^0+$/.test(last40)) return null;
  try { return getAddress("0x" + last40).toLowerCase(); } catch { return null; }
}

export interface CcipRemote { chain: string; selector: string; remotePool: string | null; remoteToken: string | null; }

/**
 * CCIP TokenPool 원격 토폴로지 — 연결 체인 + 각 체인의 **원격 풀/토큰 주소**(Method B 완성).
 * getSupportedChains() selector 별 getRemotePools/getRemotePool(원격 풀) + getRemoteToken(원격 토큰).
 * (이전엔 체인 목록만 — 이제 실제 원격 컨트랙트 주소까지 1급화.)
 */
export async function resolveCcipTopology(client: PublicClient, pool: Address): Promise<CcipRemote[]> {
  let sels: readonly bigint[] = [];
  try { sels = (await client.readContract({ address: pool, abi: POOL_CHAINS_ABI, functionName: "getSupportedChains" })) as readonly bigint[]; }
  catch { return []; }
  const out: CcipRemote[] = [];
  for (const sel of sels ?? []) {
    const chain = CCIP_SELECTOR_CHAIN[sel.toString()] ?? `selector:${sel.toString()}`;
    let remotePool: string | null = null;
    try {
      const arr = (await client.readContract({ address: pool, abi: CCIP_REMOTE_POOLS_ABI, functionName: "getRemotePools", args: [sel] })) as readonly string[];
      remotePool = evmAddrFromBytes(arr?.[0]); // 멀티풀이면 첫 풀
    } catch {
      try {
        const one = (await client.readContract({ address: pool, abi: CCIP_REMOTE_POOL_ABI, functionName: "getRemotePool", args: [sel] })) as string;
        remotePool = evmAddrFromBytes(one); // 구버전 단일 풀
      } catch { /* 원격 풀 미조회 */ }
    }
    let remoteToken: string | null = null;
    try {
      const rt = (await client.readContract({ address: pool, abi: CCIP_REMOTE_TOKEN_ABI, functionName: "getRemoteToken", args: [sel] })) as string;
      remoteToken = evmAddrFromBytes(rt);
    } catch { /* 원격 토큰 미조회 */ }
    out.push({ chain, selector: sel.toString(), remotePool, remoteToken });
  }
  return out;
}

/** (호환) CCIP 연결 원격 체인 목록 — resolveCcipTopology 의 체인명만. */
export async function resolveCcipRemotes(client: PublicClient, pool: Address): Promise<string[]> {
  return (await resolveCcipTopology(client, pool)).map((r) => r.chain);
}
