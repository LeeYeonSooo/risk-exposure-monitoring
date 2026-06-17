/**
 * 온체인 분류 프리미티브 — kuromi feeder/proxy.py + crawl.classify() 의 TS 포팅 (RPC 전용).
 *
 * 책임:
 *  - EOA/컨트랙트 구분 (eth_getCode) — EOA 는 그래프에서 제외 (§9)
 *  - 프록시 해석 (EIP-1967 슬롯 · 비콘 · EIP-1167 미니멀) — 라벨은 구현체 기준, 보유는 프록시 주소 기준
 *  - 셀렉터 프로브: asset()/UNDERLYING_ASSET_ADDRESS()/stETH()/eETH() → 파생토큰의 기초자산
 *  - symbol() 일괄 읽기 (Multicall3 배칭)
 * 모두 (chain,addr) 캐시 — 배포 코드는 불변.
 */
import { toFunctionSelector, type Address, type PublicClient } from "viem";

import { rpcFor } from "@/lib/rpc";
import { CHAIN_IDS } from "./types";

const ERC20_SYMBOL_ABI = [{ name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;

function client(chain: string): PublicClient {
  return rpcFor(CHAIN_IDS[chain] ?? 1);
}

// ── EOA / 컨트랙트 ──
const _code = new Map<string, boolean>();
export async function isContract(chain: string, addr: string): Promise<boolean> {
  const key = `${chain}|${addr.toLowerCase()}`;
  const hit = _code.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const code = await client(chain).getCode({ address: addr as Address });
    ok = !!code && code !== "0x";
  } catch { /* RPC 실패 = 모름 → false (확정 못하면 안 잇는다) */ }
  _code.set(key, ok);
  return ok;
}

// ── symbol() 일괄 ──
export async function symbolsOf(chain: string, addrs: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (!uniq.length) return out;
  try {
    const res = await client(chain).multicall({
      contracts: uniq.map((a) => ({ address: a as Address, abi: ERC20_SYMBOL_ABI, functionName: "symbol" as const })),
      allowFailure: true,
      batchSize: 4096,
    });
    uniq.forEach((a, i) => {
      const r = res[i];
      out.set(a, r.status === "success" ? String(r.result) : null);
    });
  } catch {
    for (const a of uniq) out.set(a, null);
  }
  return out;
}

// ── 주소 워드 디코드 — 상위 12바이트가 0 이어야 주소로 인정 (가짜 주소 차단) ──
const ZERO40 = "0x0000000000000000000000000000000000000000";
export function decodeAddressWord(hex: string | null | undefined, wordIdx = 0): string | null {
  if (!hex) return null;
  const start = 2 + wordIdx * 64;
  if (hex.length < start + 64) return null;
  if (hex.slice(start, start + 24) !== "0".repeat(24)) return null;
  const a = "0x" + hex.slice(start + 24, start + 64).toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) && a !== ZERO40 ? a : null;
}

async function ethCall(chain: string, to: string, data: `0x${string}`): Promise<string | null> {
  try {
    const r = await client(chain).call({ to: to as Address, data });
    return r.data ?? null;
  } catch { return null; }
}

// ── 프록시 해석 (kuromi proxy.py 포팅) ──
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
const SEL_IMPLEMENTATION = toFunctionSelector("function implementation()");

const _proxy = new Map<string, { kind: string; implementation: string } | null>();
/** 프록시면 {kind, implementation}, 아니면 null. 주소는 그대로 보유자 — 구현체는 라벨 힌트로만. */
export async function resolveProxy(chain: string, addr: string): Promise<{ kind: string; implementation: string } | null> {
  const key = `${chain}|${addr.toLowerCase()}`;
  const hit = _proxy.get(key);
  if (hit !== undefined) return hit;
  let out: { kind: string; implementation: string } | null = null;
  try {
    const c = client(chain);
    const w = await c.getStorageAt({ address: addr as Address, slot: EIP1967_IMPL_SLOT });
    const impl = decodeAddressWord(w);
    if (impl) out = { kind: "erc1967", implementation: impl };
    if (!out) {
      const bw = await c.getStorageAt({ address: addr as Address, slot: EIP1967_BEACON_SLOT });
      const beacon = decodeAddressWord(bw);
      if (beacon) {
        const iw = await ethCall(chain, beacon, SEL_IMPLEMENTATION);
        const bImpl = decodeAddressWord(iw);
        if (bImpl) out = { kind: "beacon", implementation: bImpl };
      }
    }
    if (!out) {
      // EIP-1167 미니멀 프록시: 363d3d373d3d3d363d73 <impl 20바이트> 5af43d82803e903d91602b57fd5bf3
      const code = (await c.getCode({ address: addr as Address })) ?? "0x";
      const h = code.toLowerCase();
      const i = h.indexOf("363d3d373d3d3d363d73");
      if (i >= 0 && h.length >= i + 20 + 40) {
        const impl1167 = "0x" + h.slice(i + 20, i + 60);
        if (/^0x[0-9a-f]{40}$/.test(impl1167) && impl1167 !== ZERO40) out = { kind: "minimal", implementation: impl1167 };
      }
    }
  } catch { /* RPC 실패 → 프록시 아님 취급 */ }
  _proxy.set(key, out);
  return out;
}

// ── 기초자산 프로브 — 파생토큰 → 기초자산 (검증된 게터만, 추측 금지) ──
const SEL_ASSET = toFunctionSelector("function asset()");                                // ERC-4626
const SEL_UNDERLYING_AAVE = toFunctionSelector("function UNDERLYING_ASSET_ADDRESS()");   // aToken
const SEL_STETH = toFunctionSelector("function stETH()");                                // wstETH류
const SEL_EETH = toFunctionSelector("function eETH()");                                  // weETH류
const _under = new Map<string, string | null>();
export async function probeUnderlying(chain: string, addr: string): Promise<string | null> {
  const key = `${chain}|${addr.toLowerCase()}`;
  const hit = _under.get(key);
  if (hit !== undefined) return hit;
  let out: string | null = null;
  for (const sel of [SEL_ASSET, SEL_UNDERLYING_AAVE, SEL_STETH, SEL_EETH]) {
    out = decodeAddressWord(await ethCall(chain, addr, sel));
    if (out) break;
  }
  _under.set(key, out);
  return out;
}

export { ethCall };
