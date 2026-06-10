/**
 * Detector A 러너 — Σremote ≤ backing 무담보 공급 점검 (alarm-totalsupply 포팅).
 *
 * watch 소스: ① BACKING_WATCHES(수동 설정)  ② bridge_authorities 의 xERC20 lockbox(자동 — 브릿지 스냅샷이 적재).
 * 무담보 감지 시 alerts(kind=unbacked_supply, source=backing-v1) 적재. 무한민팅/Kelp rsETH류 신호.
 *
 * Usage: npm run snapshot:backing
 * Env: DATABASE_URL(필수), ALCHEMY_API_KEY(옵션, 없으면 공개 RPC).
 */
import process from "node:process";

import { type Abi, type Address, createPublicClient, getAddress, http, type PublicClient } from "viem";

import { RECOMMENDED_THRESHOLDS } from "@/config/alert-thresholds";
import { env } from "@/config/chains";
import { closePool, query } from "@/db/client";
import { insertAlert } from "@/db/upsert";
import { BACKING_WATCHES, evaluateBacking, readBacking, readTotalSupply, type BackingWatch } from "@/snapshot/supply-backing";

const ALCHEMY = env.ALCHEMY_API_KEY;
const RPC: Record<string, string> = {
  ethereum: ALCHEMY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY}` : "https://ethereum-rpc.publicnode.com",
  base: ALCHEMY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY}` : "https://base-rpc.publicnode.com",
  arbitrum: ALCHEMY ? `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY}` : "https://arbitrum-one-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
  avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
};

const _clients = new Map<string, PublicClient>();
function clientFor(chain: string): PublicClient | null {
  const url = RPC[chain];
  if (!url) return null;
  if (_clients.has(chain)) return _clients.get(chain)!;
  const c = createPublicClient({ transport: http(url, { retryCount: 2, retryDelay: 500, timeout: 25_000 }) }) as PublicClient;
  _clients.set(chain, c);
  return c;
}

// xERC20 lockbox 의 canonical token getter (lockbox 면 ERC20() 가 백킹 토큰을 준다).
const ERC20_GETTER_ABI: Abi = [{ type: "function", name: "ERC20", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const DECIMALS_ABI: Abi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }];

/** canonical 토큰 decimals — 실패 시 18(대부분 wrapped/LRT). 비교는 raw 라 표시용이지만 정확히. */
async function readDecimals(client: PublicClient, token: string): Promise<number> {
  try { return Number(await client.readContract({ address: getAddress(token), abi: DECIMALS_ABI, functionName: "decimals" })); }
  catch { return 18; }
}

async function blockTs(client: PublicClient): Promise<number> {
  try { return Number((await client.getBlock()).timestamp); } catch { return 0; }
}

/** bridge_authorities 의 xERC20 lockbox → 자동 watch (backing = canonical.balanceOf(lockbox), circulating=all). */
async function autoWatches(): Promise<BackingWatch[]> {
  const lockboxes = (await query(
    `SELECT token, chain, bridge_addr FROM bridge_authorities WHERE auth_type = 'xerc20_lockbox'`,
  )).rows as { token: string; chain: string; bridge_addr: string }[];
  if (!lockboxes.length) return [];

  const nodes = (await query(
    `SELECT label, chain, address FROM nodes WHERE type = 'Token' AND address IS NOT NULL`,
  )).rows as { label: string; chain: string; address: string }[];
  const addrByKey = new Map<string, string>();
  const chainsByTok = new Map<string, Set<string>>();
  for (const n of nodes) {
    const sym = n.label.toUpperCase();
    addrByKey.set(`${sym}|${n.chain}`, n.address);
    if (!chainsByTok.has(sym)) chainsByTok.set(sym, new Set());
    chainsByTok.get(sym)!.add(n.chain);
  }

  const out: BackingWatch[] = [];
  for (const lb of lockboxes) {
    const sym = lb.token.toUpperCase();
    const home = clientFor(lb.chain);
    if (!home) continue;
    let canonical: string;
    try { canonical = String(await home.readContract({ address: getAddress(lb.bridge_addr), abi: ERC20_GETTER_ABI, functionName: "ERC20" })); }
    catch { continue; } // ERC20() 없음 = 표준 lockbox 아님 → 자동 backing 불가, skip
    if (!canonical || /^0x0+$/.test(canonical)) continue;
    const chains = [...(chainsByTok.get(sym) ?? [])];
    const remotes = chains.map((c) => ({ chain: c, token: addrByKey.get(`${sym}|${c}`)! })).filter((x) => x.token);
    if (!remotes.length) continue;
    const decimals = await readDecimals(home, canonical); // 하드코딩 18 대신 실제 decimals (표시 정확도)
    out.push({ symbol: sym, decimals, homeChain: lb.chain, lockReads: [{ contract: canonical, method: "balanceOf", holder: lb.bridge_addr }], remotes, circulating: "all", tolBps: RECOMMENDED_THRESHOLDS.unbacked.toleranceBps });
  }
  return out;
}

async function processWatch(w: BackingWatch): Promise<void> {
  const home = clientFor(w.homeChain);
  if (!home) { console.log(`[backing] ${w.symbol}: 홈 ${w.homeChain} RPC 없음 — skip`); return; }

  const backing = await readBacking(home, w.lockReads);
  if (backing === null) { console.log(`[backing] ${w.symbol}: backing 읽기 실패 — DD 불가, skip`); return; }

  // 순환 공급: all = 홈+원격 모두 / remotes = 원격만(홈은 lockbox).
  const supplyChains = w.circulating === "all" ? w.remotes : w.remotes.filter((r) => r.chain !== w.homeChain);
  const breakdown: Record<string, string> = {};
  let remoteSum = 0n;
  let latestRemoteTs = 0;
  for (const r of supplyChains) {
    const c = clientFor(r.chain);
    if (!c) { console.log(`[backing] ${w.symbol}: ${r.chain} RPC 없음 — watch skip`); return; }
    const s = await readTotalSupply(c, r.token);
    if (s === null) { console.log(`[backing] ${w.symbol}: ${r.chain} totalSupply 실패 — watch skip`); return; }
    remoteSum += s;
    breakdown[r.chain] = s.toString();
    latestRemoteTs = Math.max(latestRemoteTs, await blockTs(c));
  }
  const homeTs = await blockTs(home);
  const staleHome = homeTs > 0 && latestRemoteTs > 0 && homeTs < latestRemoteTs;

  const finding = evaluateBacking({ symbol: w.symbol, homeChain: w.homeChain, decimals: w.decimals, circulating: w.circulating, tolBps: w.tolBps, backing, remoteSum, staleHome, breakdown });
  if (!finding) { console.log(`[backing] ${w.symbol}: balanced/over-backed ✓`); return; }

  console.log(`[backing] 🚨 ${w.symbol}: ${finding.message}`);
  await insertAlert({
    // stale=WATCH(info) · backing 대비 ≥criticalBps(100) 초과=critical · 그 외 warning (risk_rules D09 보정)
    severity: finding.staleHome ? "info" : finding.overageBps >= RECOMMENDED_THRESHOLDS.unbacked.criticalBps ? "critical" : "warning",
    kind: "unbacked_supply",
    token: w.symbol,
    message: finding.message,
    detail: { remoteSum: finding.remoteSum.toString(), backing: finding.backing.toString(), deficit: finding.deficit.toString(), overageBps: finding.overageBps, staleHome: finding.staleHome, breakdown: finding.breakdown },
    source: "backing-v1",
  });
}

async function main() {
  if (!env.DATABASE_URL) { console.error("[backing] DATABASE_URL 필요"); process.exit(1); }
  const auto = await autoWatches().catch((e) => { console.warn("[backing] auto watch 실패:", (e as Error).message); return [] as BackingWatch[]; });
  const watches = [...BACKING_WATCHES, ...auto];
  console.log(`[backing] watch ${watches.length}개 (config ${BACKING_WATCHES.length} + auto-xERC20 ${auto.length})`);
  if (!watches.length) console.log("[backing] (감시 대상 없음 — BACKING_WATCHES 추가하거나, 브릿지 스냅샷이 xERC20 lockbox 를 적재하면 자동 활성)");
  for (const w of watches) await processWatch(w).catch((e) => console.error(`[backing] ${w.symbol} 오류:`, (e as Error).message));
  console.log("[backing] 완료");
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
