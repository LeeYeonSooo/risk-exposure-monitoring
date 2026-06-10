import { type Address, createPublicClient, getAddress, http, type PublicClient } from "viem";

/**
 * 방법 E — mint 이벤트 추적 (get_token_bridge_address `events.py` 의 TS 포팅).
 *
 * 토큰이 view 함수로 브릿지를 안 알려줘도, 실제 발행(Transfer from 0x0)을 *일으킨* 컨트랙트(tx.to)를
 * 빈도순 집계하면 브릿지가 드러난다. view-probe(Method C)가 전부 실패했을 때의 **fallback**.
 *   - 페이지네이션: getLogs 범위 제한에 맞춰 창을 줄여가며 과거로 여러 청크 훑음.
 *   - 노이즈 필터: DEX 정산/애그리게이터(스왑 중 발행에 끼어듦) 제외.
 *
 * RPC: **publicnode(공개)** 를 쓴다 — Alchemy 는 viem 의 eth_getLogs 요청을 거부("JSON invalid")해서
 *      로그 스캔이 안 됨(getBlockNumber 등은 정상). publicnode 는 getLogs/getTransaction 모두 정상.
 *      cost(여러 getLogs + getTx) 있으므로 view-probe 가 0건일 때만 호출할 것.
 */

const RPC: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
  gnosis: "https://gnosis-rpc.publicnode.com",
  linea: "https://linea-rpc.publicnode.com",
  scroll: "https://scroll-rpc.publicnode.com",
  mantle: "https://mantle-rpc.publicnode.com",
  avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
};
const _clients = new Map<string, PublicClient>();
function clientFor(chain: string): PublicClient | null {
  const url = RPC[chain];
  if (!url) return null;
  if (_clients.has(chain)) return _clients.get(chain)!;
  const c = createPublicClient({ transport: http(url, { retryCount: 2, retryDelay: 500, timeout: 30_000 }) }) as PublicClient;
  _clients.set(chain, c);
  return c;
}

// keccak256("Transfer(address,address,uint256)") — ERC20 Transfer topic0
const TRANSFER_TOPIC0: `0x${string}` = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC: `0x${string}` = "0x0000000000000000000000000000000000000000000000000000000000000000"; // indexed from == 0x0 (mint)
const WINDOWS = [200_000n, 50_000n, 10_000n, 2_000n]; // getLogs 청크 크기(한도 초과 시 축소)
const MAX_CHUNKS = 12;       // 과거로 훑는 청크 수
const TARGET_TXS = 30;       // 이만큼 mint tx 모으면 조기 종료
const MAX_TX_LOOKUPS = 40;   // tx 조회 상한

// 브릿지가 아닌 흔한 인프라(스왑 정산/애그리게이터) — 발행에 끼어들어 노이즈. 제외.
const NOISE = new Set([
  "0x9008d19f58aabd9ed0d60971565aa8510560ab41", // CoW GPv2Settlement
  "0x1111111254eeb25477b68fb85ed929f73a960582", // 1inch AggregationRouter V5
  "0x111111125421ca6dc452d289314280a0f8842a65", // 1inch AggregationRouter V6
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff", // 0x Exchange Proxy
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", // Uniswap Universal Router
  "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", // KyberSwap Meta Aggregator
  "0xe592427a0aece92de3edee1f18e0157c05861564", // Uniswap V3 SwapRouter
]);

export interface MintBridgeCandidate { address: string; mintTxCount: number; }

interface RpcLog { transactionHash: `0x${string}` | null }
const hexBlock = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;

/** raw eth_getLogs (mint = Transfer topic0 + from==0x0). 실패 시 throw(상위에서 흡수). */
async function getMintLogs(client: PublicClient, token: Address, from: bigint, to: bigint): Promise<RpcLog[]> {
  return (await client.request({
    method: "eth_getLogs",
    params: [{ address: token, topics: [TRANSFER_TOPIC0, ZERO_TOPIC], fromBlock: hexBlock(from), toBlock: hexBlock(to) }],
  })) as RpcLog[];
}

/** RPC 가 허용하는 가장 큰 getLogs 창을 찾고 그 결과를 함께 반환. */
async function maxWindow(client: PublicClient, token: Address, latest: bigint): Promise<{ win: bigint; logs: RpcLog[] } | null> {
  for (const win of WINDOWS) {
    const from = latest > win ? latest - win : 0n;
    try {
      const logs = await getMintLogs(client, token, from, latest);
      return { win, logs };
    } catch { /* 범위 초과 → 더 작은 창 */ }
  }
  return null;
}

/**
 * mint 이벤트로 브릿지 후보(발행 빈도순)를 찾는다. 없으면 빈 배열.
 * @param token 토큰 주소  @param chain 체인명(publicnode RPC 해석용)
 */
export async function discoverBridgesByMintEvents(token: Address, chain: string): Promise<MintBridgeCandidate[]> {
  const client = clientFor(chain);
  if (!client) return [];

  let latest: bigint;
  try { latest = await client.getBlockNumber(); } catch { return []; }

  const first = await maxWindow(client, token, latest);
  if (!first) return [];
  const { win } = first;
  const logs: RpcLog[] = [...first.logs];
  const seenTx = new Set<string>(logs.map((l) => l.transactionHash).filter((h): h is `0x${string}` => !!h));

  // 페이지네이션 — 과거로 청크 단위 훑으며 mint 로그 누적(충분히 모이면 조기 종료).
  let end = latest - win - 1n;
  let chunks = 1;
  while (seenTx.size < TARGET_TXS && chunks < MAX_CHUNKS && end > 0n) {
    const from = end > win ? end - win : 0n;
    try {
      const chunk = await getMintLogs(client, token, from, end);
      logs.push(...chunk);
      for (const l of chunk) if (l.transactionHash) seenTx.add(l.transactionHash);
    } catch { /* 청크 실패 skip */ }
    chunks++;
    end = from - 1n;
  }
  if (!logs.length) return [];

  // mint 트랜잭션의 대상 컨트랙트(tx.to)를 빈도순 집계.
  const counts = new Map<string, number>();
  const looked = new Set<string>();
  for (const l of logs) {
    const h = l.transactionHash;
    if (!h || looked.has(h)) continue;
    looked.add(h);
    if (looked.size > MAX_TX_LOOKUPS) break;
    let to: string | null = null;
    try { to = (await client.getTransaction({ hash: h })).to; } catch { continue; }
    if (!to) continue;
    const a = to.toLowerCase();
    if (a === token.toLowerCase() || NOISE.has(a)) continue; // 자기자신/노이즈 제외
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  if (!counts.size) return [];

  // 빈도순 정렬 + 컨트랙트만(EOA 발행 제외). 상위 5.
  const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const out: MintBridgeCandidate[] = [];
  for (const [addr, n] of ranked) {
    if (out.length >= 5) break;
    try {
      const code = await client.getBytecode({ address: getAddress(addr) });
      if (code && code !== "0x") out.push({ address: addr, mintTxCount: n });
    } catch { /* skip */ }
  }
  return out;
}
