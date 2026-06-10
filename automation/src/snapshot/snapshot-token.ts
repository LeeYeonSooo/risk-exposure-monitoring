import { type Address, formatUnits } from "viem";

import { ADAPTERS_BY_FAMILY } from "@/adapters";
import type { AdapterContext } from "@/adapters/types";
import { KNOWN_TOKENS } from "@/config/tokens";
import { batch } from "@/lib/multicall";
import { rpc } from "@/lib/rpc";
import { postDiscord } from "@/lib/discord-alert";
import {
  type EdgeAttrs,
  type EdgeRole,
  type EdgeSnapshot,
  makeClassification,
  NO_ORACLE,
  type ProtocolNodeSnapshot,
  type TokenNodeSnapshot,
  type TokenSnapshotResult,
} from "@/types/edge-schema";

import { getTokenPriceUsd } from "@/lib/prices";

import { fetchAllBridgeBalances } from "./bridges";
import { fetchBreadthExposure } from "./breadth-defillama";
import { classify } from "./classify";
import { type Holder, topHolders } from "./holders";

const ERC20_ABI = [
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalSupply", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

// D04b — Chainlink Feed Registry(메인넷): 토큰/USD 정식 피드의 latestRoundData(updatedAt 포함)로 freeze/staleness 판정.
//   Aave getSourceOfAsset 소스는 latestAnswer(가격)만 주고 timestamp 가 없어 staleness 불가 → 정식 레지스트리 사용.
const CHAINLINK_FEED_REGISTRY: Address = "0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf";
const USD_DENOM: Address = "0x0000000000000000000000000000000000000348";
const ETH_DENOM: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // ETH/WETH → ETH 키
const FEED_REGISTRY_ABI = [
  { inputs: [{ name: "base", type: "address" }, { name: "quote", type: "address" }], name: "latestRoundData",
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
    stateMutability: "view", type: "function" },
] as const;

/**
 * Main entry — snapshot one token end-to-end.
 *
 * Flow:
 *   1. Token metadata (symbol, decimals, totalSupply)
 *   2. Top holders enumeration
 *   3. Classify each holder via Protocol Registry + heuristics
 *   4. For each *unique* family found among holders, dispatch its adapter
 *   5. Build edges (bipartite)
 *   6. Surface unknown contracts to Discord queue
 *
 * Returns a complete TokenSnapshotResult ready for DB upsert.
 */
export async function snapshotToken(
  rawToken: Address,
  opts: { tokenPriceUsd?: number; topN?: number } = {},
): Promise<TokenSnapshotResult> {
  // 주소 정규화 — viem 은 mixed-case 인데 EIP-55 체크섬이 틀리면 throw 함.
  // watchlist/seed 주소 체크섬이 하나라도 틀리면 해당 토큰 스냅샷이 통째로
  // 깨지므로(symbol=UNKNOWN, edges 0), 진입점에서 소문자로 정규화해 차단.
  const token = rawToken.toLowerCase() as Address;
  const ctx0 = await fetchTokenMeta(token);
  // 가격: 인자 우선 → DeFiLlama 무료 API → 실패 시 1 (USD 정확도 핵심).
  const tokenPriceUsd =
    opts.tokenPriceUsd ?? (await getTokenPriceUsd(token).catch(() => null)) ?? 1;
  const topN = opts.topN ?? 200;
  const blockNumber = Number(await rpc().getBlockNumber());

  const tokenNode: TokenNodeSnapshot = {
    nodeId: `token:${ctx0.symbol}`,
    type: "Token",
    label: ctx0.symbol,
    address: token,
    metadata: {
      symbol: ctx0.symbol,
      decimals: ctx0.decimals,
      totalSupply: ctx0.totalSupply,
      holders: null,
      marketCapUsd: ctx0.totalSupply * tokenPriceUsd,
      paused: false, // TODO: fetch from contract if function exists
      bridges: { ethereum: [] },
      topHolders: [],
    },
  };

  // D04b: 정식 Chainlink USD 피드 staleness 입력 (FeedRegistry, 메인넷). 미등록 토큰이면 null → diff 가 skip.
  tokenNode.metadata.oracleFeed = await readChainlinkUsdFeed(token, ctx0.symbol);

  const unknownAddresses: TokenSnapshotResult["unknownAddresses"] = [];
  const bridges: TokenNodeSnapshot["metadata"]["bridges"]["ethereum"] = [];

  // 2) Top holders — BEST-EFFORT only.
  //    핵심 그래프(edges)는 holder 목록에 의존하지 않음 — 등록된 adapter 를
  //    토큰마다 직접 실행해 protocol 포지션을 조회함 (토큰 agnostic, Multicall3).
  //    holder 목록은 (a) 고래 unwind 추적, (b) 미지 컨트랙트 발굴 에만 쓰이며,
  //    무료 소스가 없으면(현재 Alchemy 는 top-holders RPC 미지원) 조용히 skip.
  let holders: Holder[] = [];
  try {
    holders = await topHolders(token, topN);
  } catch (e) {
    console.warn(`[snapshot] holder enumeration unavailable (best-effort skip): ${(e as Error).message}`);
  }

  // record top 20 for whale-unwind diff alert (있을 때만)
  tokenNode.metadata.topHolders = holders.slice(0, 20).map((h) => ({
    address: h.address,
    rawBalance: h.rawBalance.toString(),
    amount: Number(formatUnits(h.rawBalance, ctx0.decimals)),
  }));

  // holder 가 있으면 미지 컨트랙트 발굴 (Discord 큐) — 없으면 skip
  if (holders.length > 0) {
    const classifications = await Promise.all(
      holders.map(async (h) => ({
        holder: h,
        classification: await classify(h.address as Address),
      })),
    );
    for (const { holder, classification } of classifications) {
      if (classification.kind === "candidate") {
        unknownAddresses.push({
          address: holder.address,
          balance: holder.rawBalance,
          hint: `candidate ${classification.family}: ${classification.reason}`,
        });
      } else if (classification.kind === "unknown" && classification.isContract) {
        unknownAddresses.push({ address: holder.address, balance: holder.rawBalance, hint: null });
      }
    }
  }

  // 3) Run ALL registered adapters (protocol마다 1개, 토큰 agnostic).
  //    각 adapter 는 해당 프로토콜에 토큰 포지션이 없으면 null 반환 → skip.
  const protocols: ProtocolNodeSnapshot[] = [];
  const edges: EdgeSnapshot[] = [];

  const ctx: AdapterContext = {
    tokenPriceUsd,
    tokenTotalSupply: ctx0.totalSupply,
    tokenSymbol: ctx0.symbol,
    snapshotTs: new Date().toISOString(),
    blockNumber,
  };

  const adapterEntries = Object.entries(ADAPTERS_BY_FAMILY);
  const adapterResults = await Promise.all(
    adapterEntries.map(async ([family, adapter]) => {
      try {
        const attrs = await adapter.fetchEdge(token, ctx);
        return { family, adapter, attrs };
      } catch (e) {
        console.error(`[snapshot] adapter ${family} failed:`, (e as Error).message);
        return { family, adapter, attrs: null };
      }
    }),
  );

  for (const { adapter, attrs } of adapterResults) {
    if (!attrs) continue;
    const desc = adapter.describeNode();
    const amountToken = attrs.core.amountToken;
    if (!(amountToken > 0)) continue; // 포지션 없음

    protocols.push({
      ...desc,
      metadata: {
        ...desc.metadata,
        tokensHeld: amountToken,
        tokensHeldUsd: amountToken * tokenPriceUsd,
      },
    });

    edges.push({
      edgeId: `${tokenNode.nodeId}__${desc.nodeId}`,
      source: tokenNode.nodeId,
      target: desc.nodeId,
      type: attrs.classification.primary_role,
      weight: amountToken,
      attrs,
    });
  }

  // 5b) BREADTH tier — 기준 기반(DeFiLlama TVL 임계 + 카테고리) 근방 프로토콜.
  //     precise adapter 가 커버 안 하는 Silo/Euler/Dolomite/Convex/… 를 coarse edge 로.
  const coveredNodeIds = new Set(protocols.map((p) => p.nodeId));
  try {
    const breadth = await fetchBreadthExposure(ctx0.symbol, coveredNodeIds);
    for (const b of breadth) {
      const amountUsd = b.tvlUsd;
      const amountToken = tokenPriceUsd > 0 ? amountUsd / tokenPriceUsd : 0;
      const role: EdgeRole = {
        edge_type: b.edgeType,
        amount_token: amountToken,
        amount_usd: amountUsd,
        pct_of_supply: ctx0.totalSupply > 0 ? amountToken / ctx0.totalSupply : null,
        pct_of_protocol_tvl: null,
      };
      const attrs: EdgeAttrs = {
        classification: makeClassification(role, b.venueType, b.protocolClass),
        edgeType: b.edgeType,
        venueType: b.venueType,
        protocolClass: b.protocolClass,
        core: {
          amountToken,
          amountUsd,
          pctOfSupply: role.pct_of_supply ?? null,
          pctOfProtocolTvl: null,
        },
        oracle: NO_ORACLE,
        lendingRisk: null,
        dex: null,
        wrapper: null,
        topMarkets: null,
        topPools: null,
        meta: {
          snapshotBlock: blockNumber,
          snapshotTs: ctx.snapshotTs,
          verifiableOnchain: false,
          confidence: "MEDIUM",
          dataSource: `defillama-yields (${b.category}${b.multiAssetApprox ? ", multi-asset TVL 상한추정" : ""})`,
        },
      };
      protocols.push({
        nodeId: b.nodeId,
        type: "DefiProtocol",
        label: b.label,
        address: "",
        metadata: {
          family: `dl:${b.project}`,
          architecture: b.category,
          coreContract: null,
          tokensHeld: amountToken,
          tokensHeldUsd: amountUsd,
          governance: null,
        },
      });
      edges.push({
        edgeId: `${tokenNode.nodeId}__${b.nodeId}`,
        source: tokenNode.nodeId,
        target: b.nodeId,
        type: b.edgeType,
        weight: amountToken,
        attrs,
      });
    }
    if (breadth.length > 0) {
      console.log(`[snapshot] breadth(+DeFiLlama): ${breadth.length} extra protocols (${breadth.slice(0, 5).map((b) => b.project).join(", ")}${breadth.length > 5 ? ", …" : ""})`);
    }
  } catch (e) {
    console.warn("[snapshot] breadth tier failed (skip):", (e as Error).message);
  }

  // 6) Bridges — augment holder-derived list with direct Multicall3 balanceOf
  //    on the full bridge registry. This catches bridges that fell outside
  //    the topN holder window, and gives canonical balance at the same block.
  try {
    const registryBridges = await fetchAllBridgeBalances(token, ctx0.decimals);
    const seen = new Set(bridges.map((b) => b.bridge));
    for (const rb of registryBridges) {
      if (seen.has(rb.bridge)) {
        // overwrite with Multicall3-canonical balance
        const existing = bridges.find((b) => b.bridge === rb.bridge);
        if (existing) existing.lockedAmount = rb.amountToken;
      } else {
        bridges.push({
          bridge: rb.bridge,
          lockedAmount: rb.amountToken,
          destChains: [],
        });
      }
    }
  } catch (e) {
    console.warn("[snapshot] bridge multicall batch failed:", (e as Error).message);
  }
  tokenNode.metadata.bridges.ethereum = bridges.sort(
    (a, b) => b.lockedAmount - a.lockedAmount,
  );

  // 7) Surface unknown contracts to Discord
  const significantUnknowns = unknownAddresses.filter((u) => {
    const amount = Number(formatUnits(u.balance, ctx0.decimals));
    return amount * tokenPriceUsd > 1_000_000; // > $1M holdings
  });
  if (significantUnknowns.length > 0) {
    await postDiscord({
      title: `🆕 ${significantUnknowns.length} unknown contracts holding ${ctx0.symbol}`,
      body: "Add to protocol-registry.ts after manual review.",
      fields: significantUnknowns.slice(0, 5).map((u) => ({
        k: u.address,
        v: `${Number(formatUnits(u.balance, ctx0.decimals)).toFixed(2)} ${ctx0.symbol}${u.hint ? `\n${u.hint}` : ""}`,
      })),
    }).catch((e: unknown) => console.warn("Discord post failed:", e));
  }

  return {
    token: tokenNode,
    protocols,
    edges,
    unknownAddresses,
    snapshotTs: ctx.snapshotTs,
    blockNumber,
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * symbol() 견고화 — multicall(aggregate) 이 null 을 주거나(일부 RWA 가 aggregate 에서 revert)
 * symbol 이 bytes32(구형 토큰) 일 때, 단일 직접콜 + bytes32 디코드로 한 번 더 시도.
 * UNKNOWN 라벨이 만들어지는 주원인(전이적 multicall 실패) 차단.
 */
async function resolveSymbolFallback(token: Address): Promise<string | null> {
  const client = rpc();
  try {
    const s = (await client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" })) as string;
    if (s && typeof s === "string" && s.trim()) return s.trim();
  } catch { /* try bytes32 */ }
  try {
    const raw = await client.call({ to: token, data: "0x95d89b41" }); // symbol()
    const hex = (raw.data ?? "0x").slice(2);
    if (hex.length >= 64) {
      const str = Buffer.from(hex.slice(0, 64), "hex").toString("utf8").replace(/ +$/g, "").trim();
      if (str && /^[\x20-\x7e]+$/.test(str)) return str;
    }
  } catch { /* give up */ }
  return null;
}

async function fetchTokenMeta(token: Address): Promise<{
  symbol: string;
  decimals: number;
  totalSupply: number;
}> {
  const [sym, dec, ts] = (await batch([
    { address: token, abi: ERC20_ABI, functionName: "symbol" },
    { address: token, abi: ERC20_ABI, functionName: "decimals" },
    { address: token, abi: ERC20_ABI, functionName: "totalSupply" },
  ])) as [string | null, number | null, bigint | null];

  const known = KNOWN_TOKENS[token.toLowerCase()];
  const decimals = dec ?? known?.decimals ?? 18;
  // 견고화: multicall symbol 실패 시 단일콜/bytes32 폴백 → KNOWN_TOKENS → 최후 UNKNOWN.
  const symbol = sym ?? known?.symbol ?? (await resolveSymbolFallback(token)) ?? "UNKNOWN";
  return {
    symbol,
    decimals,
    totalSupply: Number(formatUnits(ts ?? BigInt(0), decimals)),
  };
}

/** D04b: 토큰의 정식 Chainlink USD 피드(FeedRegistry) latestRoundData. 미등록(LST/exotic)/비-메인넷이면 null. */
async function readChainlinkUsdFeed(
  token: Address,
  symbol: string,
): Promise<{ updatedAt: number; answer: number; roundStale: boolean } | null> {
  const s = (symbol ?? "").toUpperCase();
  const base: Address = s === "WETH" || s === "ETH" ? ETH_DENOM : token;
  try {
    const r = (await rpc().readContract({
      address: CHAINLINK_FEED_REGISTRY, abi: FEED_REGISTRY_ABI, functionName: "latestRoundData", args: [base, USD_DENOM],
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    return { updatedAt: Number(r[3]), answer: Number(r[1]), roundStale: r[4] < r[0] };
  } catch {
    return null; // FeedRegistry 미등록 토큰 — staleness 검사 안 함(오탐 방지)
  }
}
