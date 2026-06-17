/**
 * 검증된 브릿지 권한 스냅샷 — 토큰 컨트랙트에서 직접 읽은 mint 권한/한도를 bridge_authorities 에 적재.
 *
 * Usage: npm run snapshot:bridgeauth -- USDe USDC wstETH   (기본: 상위 추적 토큰)
 * Env: DATABASE_URL, ALCHEMY_API_KEY, BASE_URL(기본 http://localhost:3000 — 주소 resolve용)
 */
import process from "node:process";

import { EVM_CHAIN_KEYS } from "@/config/chains";
import { readBridgeAuthority, readWrappedVariantAuthority, type BridgeAuthorityResult } from "@/lib/bridge-authority";
import { closePool, query } from "@/db/client";
import { upsertTokenVariant } from "@/db/upsert";

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
  let rows = 0, verifiedTokens = 0, ccipVariants = 0;
  console.log(`[bridgeauth] ${syms.length}개 토큰 온체인 권한 조회 @ ${snapshotTs}`);

  for (const sym of syms) {
    let addrByChain: Record<string, string> = {};
    try {
      const d = (await fetch(`${BASE}/api/breadth/${encodeURIComponent(sym)}`).then((r) => r.json())) as { tokenAddrByChain?: Record<string, string> };
      addrByChain = d.tokenAddrByChain ?? {};
    } catch { /* skip token */ }
    const chains = Object.keys(addrByChain).filter((c) => PROBE_CHAINS.includes(c));
    let found = 0;
    const store = async (chain: string, b: { address: string; type: string; mintLimit: number | null; mintLimitRaw: string | null; currentLimitRaw: string | null; note: string }) => {
      await query(
        `INSERT INTO bridge_authorities (token, chain, bridge_addr, auth_type, mint_limit, mint_limit_raw, current_limit_raw, note, snapshot_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (token, chain, bridge_addr, auth_type) DO UPDATE SET
           mint_limit=EXCLUDED.mint_limit, mint_limit_raw=EXCLUDED.mint_limit_raw,
           current_limit_raw=EXCLUDED.current_limit_raw, note=EXCLUDED.note, snapshot_ts=EXCLUDED.snapshot_ts`,
        [sym, chain, b.address, b.type, b.mintLimit, b.mintLimitRaw, b.currentLimitRaw, b.note, snapshotTs],
      );
      rows++; found++;
    };
    // CCIP 원격 토큰 1급화 — getRemoteToken 으로 디코드된 원격 체인의 토큰 주소를 token_variants 로.
    //   chain=원격 체인(변형이 사는 곳), source_chain=조회 체인(풀을 읽은 곳), via='CCIP'.
    //   keepBridged: 이미 bridged_wrapped(lock&mint 확정)로 박힌 PK 는 강등 금지.
    const storeCcipRemotes = async (r: BridgeAuthorityResult) => {
      for (const rm of r.ccipRemotes ?? []) {
        if (!rm.remoteToken) continue; // 비-EVM/미조회 토큰은 skip
        await upsertTokenVariant({
          token: sym, chain: rm.chain, address: rm.remoteToken,
          sourceChain: r.chain, via: "CCIP", kind: "ccip_remote",
          note: `CCIP 원격 토큰 (풀 @${r.chain}${rm.remotePool ? ` 원격풀 ${rm.remotePool.slice(0, 10)}…` : ""})`,
          snapshotTs, keepBridged: true,
        }).catch((e) => console.warn(`[bridgeauth] ccip_remote upsert 실패 (${sym} ${r.chain}→${rm.chain}):`, (e as Error).message));
        ccipVariants++;
      }
    };
    // ① native(정규) 주소 — 전 체인 동일 토큰(burn&mint) 경로
    for (const chain of chains) {
      const r = await readBridgeAuthority(addrByChain[chain], chain).catch(() => null);
      if (!r) continue;
      await storeCcipRemotes(r); // 브릿지 0건이어도 CCIP 토폴로지는 적재
      if (!r.bridges.length) continue;
      for (const b of r.bridges) await store(chain, b);
    }
    // ② 래핑(lock&mint) 변형 — 정규 토큰만 보면 놓치는 USDC.e 등 (L1 GatewayRouter 로 변형 도출 → 스캔).
    //    note 에 래핑본 주소 + 출발 체인(L1)을 박아 프론트가 체인쌍(eth↔L2)에 브릿지를 매핑한다.
    const l1Addr = addrByChain.ethereum;
    if (l1Addr) {
      for (const chain of chains) {
        if (chain === "ethereum") continue;
        const w = await readWrappedVariantAuthority(l1Addr, chain).catch(() => null);
        if (!w) continue;
        // 래핑본 1급화 — note 텍스트 외에 token_variants 정식 테이블에도 보존 (후속 파이프라인 조회용).
        await upsertTokenVariant({
          token: sym, chain, address: w.variant.address,
          sourceChain: w.variant.sourceChain, via: w.variant.via,
          kind: "bridged_wrapped",
          note: `브릿지 ${w.result.bridges.length}건 확인`, snapshotTs,
        }).catch((e) => console.warn(`[bridgeauth] token_variants upsert 실패 (${sym}@${chain}):`, (e as Error).message));
        await storeCcipRemotes(w.result); // 래핑본 풀에 CCIP 토폴로지가 있으면 원격 토큰도 1급화
        for (const b of w.result.bridges) {
          await store(chain, { ...b, note: `${b.note} · 래핑본 ${w.variant.address.slice(0, 10)}…(${w.variant.via}) ← ${w.variant.sourceChain}` });
        }
        console.log(`[bridgeauth] ${sym} @ ${chain}: 래핑본 ${w.variant.address} (${w.result.bridges.length} 브릿지)`);
      }
    }
    if (found) { verifiedTokens++; console.log(`[bridgeauth] ${sym}: ${found}건 (${chains.length}체인 조회)`); }
  }
  console.log(`[bridgeauth] 완료 — 토큰 ${verifiedTokens}/${syms.length} 검증, ${rows}건 적재, CCIP 원격 토큰 ${ccipVariants}건.`);
  await closePool();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
