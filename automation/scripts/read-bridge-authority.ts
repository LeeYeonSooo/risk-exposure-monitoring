/**
 * 온체인 브릿지 권한 리더 테스트 — npm run read:bridgeauth -- USDe [ethereum]
 * 심볼 → breadth 로 체인별 주소 resolve → readBridgeAuthority 로 mint 권한/한도 출력.
 */
import process from "node:process";

import { readBridgeAuthority } from "@/lib/bridge-authority";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PROBE_CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc"];

async function main() {
  const sym = process.argv[2] ?? "USDe";
  const onlyChain = process.argv[3];
  const d = (await fetch(`${BASE}/api/breadth/${encodeURIComponent(sym)}`).then((r) => r.json()).catch(() => ({}))) as { tokenAddrByChain?: Record<string, string> };
  const addrByChain = d.tokenAddrByChain ?? {};
  const chains = onlyChain ? [onlyChain] : Object.keys(addrByChain).filter((c) => PROBE_CHAINS.includes(c));
  if (!chains.length) { console.log(`[bridgeauth] ${sym}: 주소 없음(breadth)`); return; }

  for (const chain of chains) {
    const addr = addrByChain[chain];
    if (!addr) continue;
    console.log(`\n=== ${sym} @ ${chain} (${addr}) ===`);
    const r = await readBridgeAuthority(addr, chain).catch((e) => { console.warn("  err:", (e as Error).message); return null; });
    if (!r) { console.log("  (RPC 미지원 체인 또는 읽기 실패)"); continue; }
    console.log(`  sources: ${r.sources.join(", ") || "none"} · decimals ${r.decimals} · bridges ${r.bridges.length}`);
    for (const b of r.bridges.slice(0, 18)) {
      console.log(`   - [${b.type}] ${b.address}${b.mintLimit != null ? ` · mint한도 ${b.mintLimit.toLocaleString()}` : ""} · ${b.note}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
