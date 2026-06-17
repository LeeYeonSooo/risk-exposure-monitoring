import { gatedJsonRpc } from "./rpc-gate";

/**
 * Fluid DEX 컨트랙트 주소 집합 — DexFactory 온체인 열거(키리스).
 *
 * 주의: Fluid dex 컨트랙트로는 토큰이 전혀 안 흐른다(모든 유동성이 공유 Liquidity 싱글톤
 * 0x52aa...497 에 있음). 따라서 전송매칭(addKnown)으로는 절대 색칠 안 된다. 대신 DEX 스왑은
 * Liquidity 싱글톤의 LogOperate 를 emit하고 그 topic1(user)=dex 주소다 → lending-events 의 Fluid
 * 수집기에서 topic1 ∈ 이 집합이면 'fluid-dex', 아니면 'fluid-lending' 으로 분기한다(지금은 전부
 * fluid-lending 으로 잘못 섞임). 이 모듈은 그 분기용 dex 주소 집합만 제공한다.
 * (2026-06-13 검증: DexFactory eth 48개·arb 21개, 스왑 tx 의 LogOperate user=dex주소 확인.)
 */
const FACTORY = "0x91716c4eda1fb55e84bf8b4c7085f84285c19085"; // eth·arbitrum·base 동일주소
const RPC: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
};
const SEL_TOTAL = "0x93656c17";  // totalDexes() -> uint256
const SEL_GET = "0x12e366aa";    // getDexAddress(uint256) -> address
const ZERO = "0x0000000000000000000000000000000000000000";
const padUint = (n: number) => n.toString(16).padStart(64, "0");
const _cache = new Map<string, Set<string>>();

export async function fluidDexSet(chain: string): Promise<Set<string>> {
  const rpc = RPC[chain];
  if (!rpc) return new Set();
  const hit = _cache.get(chain);
  if (hit) return hit;
  const set = new Set<string>();
  try {
    const cntHex = await gatedJsonRpc<string>(rpc, "eth_call", [{ to: FACTORY, data: SEL_TOTAL }, "latest"]);
    if (cntHex == null) return set; // 실패(or factory 없는 체인) — 캐시 안 함(재시도)
    const n = parseInt(cntHex, 16);
    if (!Number.isFinite(n) || n <= 0 || n > 500) return set;
    let conclusive = true;
    await Promise.all(Array.from({ length: n }, (_, i) => i + 1).map(async (id) => {
      const hex = await gatedJsonRpc<string>(rpc, "eth_call", [{ to: FACTORY, data: SEL_GET + padUint(id) }, "latest"]);
      if (hex == null) { conclusive = false; return; }
      const a = "0x" + hex.slice(-40).toLowerCase();
      if (a !== ZERO) set.add(a);
    }));
    if (conclusive && set.size) _cache.set(chain, set); // 결론적일 때만 캐시
  } catch { /* false negative only — fluid-lending 폴백 */ }
  return set;
}
