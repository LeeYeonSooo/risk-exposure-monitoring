/**
 * 서버 사이드 온체인 읽기 — 프론트 API 라우트 공용. viem 클라이언트 대신 raw eth_call + gateFor 게이트
 * (lending-pools.ts 의 검증된 패턴을 공유 모듈로 추출). 3-state: string=결과 · null=리버트(결론) · undefined=전송실패.
 *   Alchemy(키 있을 때) 우선 → publicnode 폴백. 이더리움/베이스/아비트럼만.
 */
import { toFunctionSelector } from "viem";

import { gateFor } from "@/lib/rpc-gate";

const PUBLICNODE: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
};
const _AK = process.env.ALCHEMY_API_KEY;
const _NET: Record<string, string> = { ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet" };
const RPC: Record<string, string> = { ...PUBLICNODE };
const _FALLBACK: Record<string, string> = {}; // primary(Alchemy) → publicnode 폴백
if (_AK) for (const [c, net] of Object.entries(_NET)) {
  const a = `https://${net}.g.alchemy.com/v2/${_AK}`;
  _FALLBACK[a] = PUBLICNODE[c];
  RPC[c] = a;
}

export const supportedChain = (chain: string): boolean => !!RPC[chain];

async function ethCallOne(rpc: string, to: string, data: string): Promise<string | null | undefined> {
  return gateFor(rpc)(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(rpc, {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        });
        if (!r.ok) { if (attempt === 0) { await new Promise((s) => setTimeout(s, 300)); continue; } return undefined; }
        const j = (await r.json()) as { result?: string; error?: { message?: string } };
        if (j.error) {
          const m = (j.error.message ?? "").toLowerCase();
          if (m.includes("revert") || m.includes("execution")) return null;
          if (attempt === 0) { await new Promise((s) => setTimeout(s, 300)); continue; }
          return undefined;
        }
        return j.result ?? null;
      } catch { if (attempt === 0) { await new Promise((s) => setTimeout(s, 300)); continue; } return undefined; }
    }
    return undefined;
  });
}

/** chain 단위 eth_call. string=결과 · null=리버트(결론) · undefined=전송실패. Alchemy 실패 시 publicnode 1회 폴백. */
export async function ethCall(chain: string, to: string, data: string): Promise<string | null | undefined> {
  const rpc = RPC[chain];
  if (!rpc) return undefined;
  const r = await ethCallOne(rpc, to, data);
  if (r !== undefined) return r;
  const fb = _FALLBACK[rpc];
  return fb ? await ethCallOne(fb, to, data) : undefined;
}

// ── 인코딩 헬퍼 (셀렉터는 런타임 계산 — 손으로 박지 않음) ──
export const selectorOf = (sig: string): string => toFunctionSelector(sig);
export const padWord = (h: string): string => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const uintWord = (n: number | bigint): string => n.toString(16).padStart(64, "0");

// ── 디코더 ──
const ZERO40 = "0x0000000000000000000000000000000000000000";
const PAD24 = "0".repeat(24);

/** 단일 주소 워드 디코드(상위 12바이트 0 검증 — 가짜 주소 차단). */
export function decodeAddressWord(hex: string, wordIdx = 0): string | null {
  const start = 2 + wordIdx * 64;
  if (hex.length < start + 64) return null;
  if (hex.slice(start, start + 24) !== PAD24) return null;
  const a = "0x" + hex.slice(start + 24, start + 64).toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) && a !== ZERO40 ? a : null;
}

/** uint 워드 → number (작은 값 전용 — count/threshold 등). */
export function decodeUint(hex: string, wordIdx = 0): number {
  const start = 2 + wordIdx * 64;
  if (hex.length < start + 64) return 0;
  try { return Number(BigInt("0x" + hex.slice(start, start + 64))); } catch { return 0; }
}

/** ERC20 symbol() — 동적 string 또는 레거시 bytes32 둘 다 처리. */
export function decodeString(hex: string | null | undefined): string | null {
  if (!hex || hex === "0x") return null;
  const b = hex.startsWith("0x") ? hex.slice(2) : hex;
  // 동적 string: offset(0x20) + len + data
  if (b.length >= 128) {
    const off = parseInt(b.slice(0, 64), 16);
    if (off === 32) {
      const len = parseInt(b.slice(64, 128), 16);
      if (len > 0 && len <= 256 && b.length >= 128 + len * 2) {
        try {
          const s = Buffer.from(b.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0+$/g, "").trim();
          if (s) return s;
        } catch { /* fall through */ }
      }
    }
  }
  // 레거시 bytes32 (고정 32바이트, 트레일링 0 트림)
  if (b.length === 64) {
    try {
      const s = Buffer.from(b, "hex").toString("utf8").replace(/\0+$/g, "").trim();
      if (s && /[\x20-\x7e]/.test(s)) return s;
    } catch { /* */ }
  }
  return null;
}
