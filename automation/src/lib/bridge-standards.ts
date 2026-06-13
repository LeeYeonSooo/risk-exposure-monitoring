import { type Abi, type Address, type PublicClient, createPublicClient, getAddress, http, keccak256, toHex } from "viem";

import { evmRpcUrl } from "@/config/chains";

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
// 전 항목 온체인 검증(2026-06-10): usdc.symbol()=="USDC" + messenger getCode 존재. unichain 은
// messenger 주소 미검증이라 제외(확인 시 추가).
const CCTP_USDC: Record<number, { usdc: string; messenger: string }> = {
  1: { usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", messenger: "0xbd3fa81b58ba92a82136038b25adec7066af3155" },
  8453: { usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", messenger: "0x1682ae6375c4e4a97e4b583bc394c861a46d8962" },
  42161: { usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", messenger: "0x19330d10d9cc8751218eaf51e8885d058642e08a" },
  10: { usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", messenger: "0x2b4069517957735be00cee0fadae88a26365528f" },
  137: { usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", messenger: "0x9daf8c91aefae50b9c0e69629d3f6ca40ca3b3fe" },
  43114: { usdc: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", messenger: "0x6b25532e1060ce10cc3b0a99e5683b91bfde6982" },
};

// CCIP chain selector(Chainlink) → 체인명 — 공식 레지스트리(smartcontractkit/chain-selectors)에서
// 추출, 공용 EVM_CHAINS 18체인 + LINK 등 멀티체인 토큰이 실제로 연결하는 추가 메인넷.
// (selectors.yml / selectors_solana.yml / selectors_aptos.yml 의 공식 selector 만, 추측 없음.)
// 모르는 selector 는 "selector:N" 으로 표기. ⚠️ 구 gnosis(46520056007378…)→공식값(46520017068774…) 교정.
const CCIP_SELECTOR_CHAIN: Record<string, string> = {
  "5009297550715157269": "ethereum",
  "15971525489660198786": "base",
  "4949039107694359620": "arbitrum",
  "3734403246176062136": "optimism",
  "4051577828743386545": "polygon",
  "11344663589394136015": "bsc",
  "6433500567565415381": "avalanche",
  "465200170687744372": "gnosis",
  "13204309965629103672": "scroll",
  "4627098889531055414": "linea",
  "1556008542357238666": "mantle",
  "8805746078405598895": "metis",
  "1923510103922296319": "unichain",
  "2049429975587534727": "worldchain",
  "1562403441176082196": "zksync",
  "1673871237479749969": "sonic",
  "1346049177634351622": "celo",
  "12505351618335765396": "soneium",
  // ── 추가 메인넷(공식 레지스트리 확인값, EVM) ──
  "7264351850409363825": "mode",       // ethereum-mainnet-mode-1
  "6916147374840168594": "ronin",      // ronin-mainnet
  "6422105447186081193": "astar",      // polkadot-mainnet-astar
  "5142893604156789321": "wemix",      // wemix-mainnet
  "17673274061779414707": "xdc",       // xdc-mainnet
  "9335212494177455608": "plasma",     // plasma-mainnet
  "3849287863852499584": "bob",        // bitcoin-mainnet-bob-1
  "7937294810946806131": "bitlayer",   // bitcoin-mainnet-bitlayer-1
  "18164309074156128038": "morph",     // morph-mainnet
  "18240105181246962294": "creditcoin",// creditcoin-mainnet
  "16978377838628290997": "stable",    // stable-mainnet
  "1523760397290643893": "jovay",      // jovay-mainnet
  "4059281736450291836": "adi",        // adi-mainnet
  "4426351306075016396": "0g",         // 0g-mainnet
  "4829375610284793157": "ab",         // ab-mainnet
  "5936861837188149645": "tac",        // tac-mainnet
  "6093540873831549674": "megaeth",    // megaeth-mainnet
  "6180753054346818345": "robinhood",  // robinhood-mainnet
  "6325494908023253251": "edge",       // edge-mainnet
  "7281642695469137430": "tempo",      // tempo-mainnet
  "7801139999541420232": "pharos",     // pharos-mainnet
  // ── 비-EVM(원격 주소는 evmAddrFromBytes 가 null 처리, 체인명만 표기) ──
  "124615329519749607": "solana",      // solana-mainnet
  "4741433654826277614": "aptos",      // aptos-mainnet
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

// ── 래핑(lock&mint) 변형 토큰 도출 ──────────────────────────────────────────
// lock&mint 브릿지는 L1 에서 원본을 잠그고 L2 에 **다른 토큰**(USDC.e 등)을 민팅한다.
// native 토큰(전 체인 동일)만 보면 이 경로를 놓치므로, 정규 L1 토큰 → 각 L2 의 "표준 브릿지
// 래핑본" 주소를 온체인으로 도출(범용·하드코딩 없음). 도출된 주소를 readBridgeAuthority 로 스캔하면
// probeL2Canonical(l1Address())/probeOptimism(l1Token()) 이 "L1 원본"을 확인해준다.
const ARB_L1_GATEWAY_ROUTER = "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef"; // Arbitrum L1 GatewayRouter (on ethereum)
const CALC_L2_ABI: Abi = [{ type: "function", name: "calculateL2TokenAddress", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }];

export interface BridgedVariant { address: string; chain: string; sourceChain: string; via: string; }

// ── Superchain(OP-stack) 표준 브릿지 래핑본 도출 ──────────────────────────────
// OP-stack 체인은 Arbitrum 처럼 L1 주소로 L2 주소를 결정론적 계산하기 어렵다(OptimismMintableERC20Factory
// CREATE2 salt 가 L1토큰·이름·심볼 조합이라 재현이 까다로움). 대신 Superchain 공식 토큰리스트
// (static.optimism.io)에서 후보를 얻고, **온체인 검증**으로만 채택한다.
//   링크 키 = extensions.opTokenId — 같은 opTokenId 를 가진 L1(chainId 1) ↔ base(8453) 항목이 짝.
//   (L1 USDC 처럼 한 L1 주소가 opTokenId "USDC"(native)·"BridgedUSDC"(래핑본) 둘에 걸리면 후보 둘 다 시도 →
//    온체인 검증이 래핑본만 통과시킨다. native 는 l1Token() 없어 revert → 자동 탈락.)
const SUPERCHAIN_TOKENLIST_URL = "https://static.optimism.io/optimism.tokenlist.json";
const SUPERCHAIN_CHAIN_ID: Record<string, number> = { base: 8453, optimism: 10 };

interface TokenListEntry { chainId: number; address: string; extensions?: { opTokenId?: string } }
let _tokenlistCache: Promise<TokenListEntry[]> | null = null;
async function loadSuperchainTokenlist(): Promise<TokenListEntry[]> {
  // 1회 캐시(실패 시 빈 배열로 캐시해 재시도 폭주 방지).
  if (!_tokenlistCache) {
    _tokenlistCache = (async () => {
      try {
        const j = (await (await fetch(SUPERCHAIN_TOKENLIST_URL)).json()) as { tokens?: TokenListEntry[] };
        return j.tokens ?? [];
      } catch { return []; }
    })();
  }
  return _tokenlistCache;
}

/** L1 토큰(chainId 1)과 같은 opTokenId 를 가진 targetChainId 항목 주소 후보(소문자, 중복 제거). */
async function superchainCandidates(l1Token: Address, targetChainId: number): Promise<string[]> {
  const toks = await loadSuperchainTokenlist();
  const l1 = l1Token.toLowerCase();
  const ids = new Set<string>();
  for (const t of toks) if (t.chainId === 1 && t.address?.toLowerCase() === l1 && t.extensions?.opTokenId) ids.add(t.extensions.opTokenId);
  if (!ids.size) return [];
  const out = new Set<string>();
  for (const t of toks) if (t.chainId === targetChainId && t.extensions?.opTokenId && ids.has(t.extensions.opTokenId) && t.address) out.add(t.address.toLowerCase());
  return [...out];
}

// 디텍터 공용 RPC(Alchemy 우선) 로 만든 체인별 클라이언트 — Superchain 후보 온체인 검증용. 1회 캐시.
const _chainClients = new Map<string, PublicClient | null>();
function chainClientFor(chain: string): PublicClient | null {
  if (_chainClients.has(chain)) return _chainClients.get(chain)!;
  const url = evmRpcUrl(chain);
  const c = url ? (createPublicClient({ transport: http(url, { retryCount: 2, retryDelay: 500, timeout: 25_000 }) }) as PublicClient) : null;
  _chainClients.set(chain, c);
  return c;
}

/**
 * OptimismMintableERC20 후보가 진짜 l1Token 의 래핑본인지 온체인 검증.
 * l1Token()/remoteToken()/REMOTE_TOKEN() 중 하나가 L1 원본과 일치하면 채택(전부 revert/불일치 = 버림 — 추측 금지).
 */
async function verifyOpMintable(l2Client: PublicClient, candidate: Address, l1Token: Address): Promise<boolean> {
  const l1 = l1Token.toLowerCase();
  const got = await readAddrTry(l2Client, candidate, ["l1Token", "remoteToken", "REMOTE_TOKEN"]);
  return got === l1;
}

/**
 * 정규 L1 토큰의 targetChain 표준-브릿지 래핑본 주소 도출. l1Client = 이더리움 PublicClient.
 *   · arbitrum: L1 GatewayRouter.calculateL2TokenAddress(l1Token) → USDC.e 등 (범용: 어떤 L1 토큰이든).
 *   · base/optimism(OP-stack): Superchain 토큰리스트 후보 → 온체인 l1Token()/remoteToken() 검증 통과한 것만
 *     (예: USDC → USDbC 0xd9aA…). native 발행 토큰(검증 실패)은 래핑본이 아니므로 자동 제외.
 */
export async function deriveBridgedVariant(l1Client: PublicClient, l1Token: Address, targetChain: string): Promise<BridgedVariant | null> {
  if (targetChain === "arbitrum") {
    try {
      const r = String(await l1Client.readContract({ address: getAddress(ARB_L1_GATEWAY_ROUTER), abi: CALC_L2_ABI, functionName: "calculateL2TokenAddress", args: [l1Token] }));
      if (!isZero(r)) return { address: getAddress(r).toLowerCase(), chain: "arbitrum", sourceChain: "ethereum", via: "Arbitrum Gateway" };
    } catch { /* 게이트웨이 미응답 */ }
    return null;
  }
  const opChainId = SUPERCHAIN_CHAIN_ID[targetChain];
  if (opChainId) {
    const l2Client = chainClientFor(targetChain);
    if (!l2Client) return null;
    const cands = await superchainCandidates(l1Token, opChainId).catch(() => [] as string[]);
    for (const cand of cands) {
      let addr: Address;
      try { addr = getAddress(cand); } catch { continue; }
      if (await verifyOpMintable(l2Client, addr, l1Token).catch(() => false)) {
        return { address: addr.toLowerCase(), chain: targetChain, sourceChain: "ethereum", via: "OP Standard Bridge" };
      }
    }
  }
  return null;
}
