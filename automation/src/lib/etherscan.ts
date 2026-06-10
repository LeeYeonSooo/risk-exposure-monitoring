import { env } from "@/config/chains";

const BASE = "https://api.etherscan.io/api";

/**
 * Etherscan API client — top token holders.
 *
 * Note: `tokenholderlist` requires PRO ($199/mo).
 * Free alternative: use Alchemy `alchemy_getTokenHolders` (separate adapter).
 */

interface HoldersResp {
  status: string;
  result: Array<{ TokenHolderAddress: string; TokenHolderQuantity: string }>;
}

export async function topHoldersEtherscan(
  tokenAddress: string,
  limit = 200,
): Promise<Array<{ address: string; quantityRaw: bigint }>> {
  if (!env.ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY not set");
  }
  const url = new URL(BASE);
  url.searchParams.set("module", "token");
  url.searchParams.set("action", "tokenholderlist");
  url.searchParams.set("contractaddress", tokenAddress);
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(limit));
  url.searchParams.set("apikey", env.ETHERSCAN_API_KEY);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Etherscan: HTTP ${res.status}`);
  const data = (await res.json()) as HoldersResp;
  if (data.status !== "1") {
    throw new Error(`Etherscan API: ${(data as unknown as { message?: string }).message ?? "unknown"}`);
  }
  return data.result.map((r) => ({
    address: r.TokenHolderAddress.toLowerCase(),
    quantityRaw: BigInt(r.TokenHolderQuantity),
  }));
}

// ── 컨트랙트 검증 이름 (오라클 provider/type 식별 — kuromi etherscan_name 포팅) ──────────
const V2_BASE = "https://api.etherscan.io/v2/api";
const _nameCache = new Map<string, string>();
let _lastEsCall = 0;

/**
 * Etherscan V2 getsourcecode 로 컨트랙트 검증 이름(ContractName)을 읽는다.
 * 오라클 분류의 핵심 신호(예: "MorphoChainlinkOracleV2"·"FixedPriceOracle"·"…Redstone…").
 * 키 없으면 ""(graceful). 주소별 캐시 + free tier(5req/s) 대비 경량 throttle.
 */
export async function getContractName(address: string, chainId = 1): Promise<string> {
  const k = `${chainId}:${address.toLowerCase()}`;
  const hit = _nameCache.get(k);
  if (hit !== undefined) return hit;
  if (!env.ETHERSCAN_API_KEY) {
    _nameCache.set(k, "");
    return "";
  }
  const wait = 220 - (Date.now() - _lastEsCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastEsCall = Date.now();
  let name = "";
  try {
    const url = new URL(V2_BASE);
    url.searchParams.set("chainid", String(chainId));
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getsourcecode");
    url.searchParams.set("address", address);
    url.searchParams.set("apikey", env.ETHERSCAN_API_KEY);
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as { result?: Array<{ ContractName?: string }> };
      if (Array.isArray(data.result)) name = (data.result[0]?.ContractName ?? "").trim();
    }
  } catch {
    name = "";
  }
  _nameCache.set(k, name);
  return name;
}
