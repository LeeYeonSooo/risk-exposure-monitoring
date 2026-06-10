/**
 * 검증된 브릿지 권한 스냅샷 — 토큰 컨트랙트에서 직접 읽은 mint 권한/한도를 bridge_authorities 에 적재.
 *
 * Usage: npm run snapshot:bridgeauth -- USDe USDC wstETH   (기본: 상위 추적 토큰)
 * Env: DATABASE_URL, ALCHEMY_API_KEY, BASE_URL(기본 http://localhost:3000 — 주소 resolve용)
 */
import process from "node:process";

import { EVM_CHAIN_KEYS } from "@/config/chains";
import { readBridgeAuthority } from "@/lib/bridge-authority";
import { closePool, query } from "@/db/client";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PROBE_CHAINS = EVM_CHAIN_KEYS; // 공용 레지스트리(18체인) — 디텍터 간 리스트 단일화
const MAX_TOKENS = Number(process.env.BRIDGEAUTH_MAX ?? 10);

async function symbols(): Promise<string[]> {
  const argv = process.argv.slice(2).filter((s) => !s.startsWith("-"));
  if (argv.length) return argv;
  try {
    const d = (await fetch(`${BASE}/api/tokens`).then((r) => r.json())) as { tokens?: string[] };
    return [...new Set((d.tokens ?? []).map((t) => t.split("@")[0]))].slice(0, MAX_TOKENS);
  } catch { return ["USDe", "USDC", "wstETH"]; }
}

async function main() {
  const syms = await symbols();
  const snapshotTs = new Date().toISOString();
  let rows = 0, verifiedTokens = 0;
  console.log(`[bridgeauth] ${syms.length}개 토큰 온체인 권한 조회 @ ${snapshotTs}`);

  for (const sym of syms) {
    let addrByChain: Record<string, string> = {};
    try {
      const d = (await fetch(`${BASE}/api/breadth/${encodeURIComponent(sym)}`).then((r) => r.json())) as { tokenAddrByChain?: Record<string, string> };
      addrByChain = d.tokenAddrByChain ?? {};
    } catch { /* skip token */ }
    const chains = Object.keys(addrByChain).filter((c) => PROBE_CHAINS.includes(c));
    let found = 0;
    for (const chain of chains) {
      const r = await readBridgeAuthority(addrByChain[chain], chain).catch(() => null);
      if (!r || !r.bridges.length) continue;
      for (const b of r.bridges) {
        await query(
          `INSERT INTO bridge_authorities (token, chain, bridge_addr, auth_type, mint_limit, mint_limit_raw, current_limit_raw, note, snapshot_ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (token, chain, bridge_addr, auth_type) DO UPDATE SET
             mint_limit=EXCLUDED.mint_limit, mint_limit_raw=EXCLUDED.mint_limit_raw,
             current_limit_raw=EXCLUDED.current_limit_raw, note=EXCLUDED.note, snapshot_ts=EXCLUDED.snapshot_ts`,
          [sym, chain, b.address, b.type, b.mintLimit, b.mintLimitRaw, b.currentLimitRaw, b.note, snapshotTs],
        );
        rows++; found++;
      }
    }
    if (found) { verifiedTokens++; console.log(`[bridgeauth] ${sym}: ${found}건 (${chains.length}체인 조회)`); }
  }
  console.log(`[bridgeauth] 완료 — 토큰 ${verifiedTokens}/${syms.length} 검증, ${rows}건 적재.`);
  await closePool();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
