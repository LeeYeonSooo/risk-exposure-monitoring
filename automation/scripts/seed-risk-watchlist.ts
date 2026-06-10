/**
 * P0-1 — 위험 토큰 watchlist 재조준 (BACKLOG P0-1).
 *
 * 평가서가 지목한 "실제 위험" 토큰들을 watchlist 에 **pin**(active=true, reason=manual → discovery 가 안 내림).
 * 각 주소는 **온체인 symbol() 로 검증** 후에만 pin — 잘못된/오타 주소는 자동 탈락(가짜 토큰 추적 방지).
 * (이미 watchlist 에 있는 RWA/PT 는 건드리지 않음. 중복은 ON CONFLICT 로 idempotent.)
 *
 * Usage: npm run seed:risk   [-- --dry]
 */
import process from "node:process";

import { type Abi, createPublicClient, getAddress, http, type PublicClient } from "viem";

import { env } from "@/config/chains";
import { closePool } from "@/db/client";
import { pinWatchlist } from "@/db/upsert";

const DRY = process.argv.includes("--dry");

// 큐레이트 위험군(Ethereum mainnet). symbol 은 기대값(검증용) — 실제 pin 은 온체인 symbol() 우선.
// xUSD(Stream)·USDf(Falcon)·mF-ONE 등 주소 불확실/이미 추적중인 건 제외(아래 NOTE).
const RISK_TOKENS: { sym: string; addr: string; note: string }[] = [
  { sym: "USD0++", addr: "0x35D8949372D46B7a3D5A56006AE77B215fc69bC0", note: "Usual 채권형 — 디페그 실측 9% (catastrophic 보정 근거)" },
  { sym: "crvUSD", addr: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", note: "Curve CDP 스테이블 — 소프트페그" },
  { sym: "sUSDe", addr: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", note: "Ethena staked USDe — LST류 yield" },
  { sym: "USDe", addr: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", note: "Ethena 합성 달러 — 펀딩/디페그 리스크" },
  { sym: "ENA", addr: "0x57e114B691Db790C35207b2e685D4A43181e6061", note: "Ethena 거버넌스 — 변동성" },
  { sym: "mkUSD", addr: "0x4591DBfF62656E7859Afe5e45f6f47D3669fBB28", note: "Prisma CDP 스테이블 — exploit 이력(2024-03)" },
  { sym: "USR", addr: "0x66a1E37c9b0eAddca17d3662D6c05F4DECf3e110", note: "Resolv — compromised-mint 백테스트 사건" },
  { sym: "syrupUSDC", addr: "0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b", note: "Maple yield-bearing — Morpho 담보" },
  { sym: "alUSD", addr: "0xBC6DA0FE9aD5f3b0d58160288917AA56653660E9", note: "Alchemix self-repaying — Dolomite 담보 채택 류" },
  { sym: "deUSD", addr: "0x15700B564Ca08D9439C58cA5053166E8317aa138", note: "Elixir 합성 달러 — redemption-run 백테스트 사건" },
];

const SYMBOL_ABI: Abi = [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }];
const DECIMALS_ABI: Abi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }];

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function mainnetClient(): PublicClient {
  const url = env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : "https://ethereum-rpc.publicnode.com";
  return createPublicClient({ transport: http(url, { retryCount: 2, retryDelay: 500, timeout: 20_000 }) }) as PublicClient;
}

async function main() {
  if (!env.DATABASE_URL) { console.error("[seed:risk] DATABASE_URL 필요"); process.exit(1); }
  const client = mainnetClient();
  let pinned = 0, skipped = 0;
  console.log(`[seed:risk] ${RISK_TOKENS.length}개 위험 토큰 온체인 검증 후 pin${DRY ? " (DRY)" : ""}\n`);

  for (const t of RISK_TOKENS) {
    let onchainSym: string | null = null;
    try {
      const addr = getAddress(t.addr);
      onchainSym = String(await client.readContract({ address: addr, abi: SYMBOL_ABI, functionName: "symbol" }));
      await client.readContract({ address: addr, abi: DECIMALS_ABI, functionName: "decimals" }); // ERC20 sanity
    } catch (e) {
      console.log(`  ✗ SKIP ${t.sym} ${t.addr} — symbol() 실패(ERC20 아님/주소 오류): ${(e as Error).message.slice(0, 60)}`);
      skipped++; continue;
    }
    // 기대 심볼과 대략 일치하나(오타 주소 방지). 한쪽이 다른쪽 포함이면 OK.
    const a = norm(onchainSym), b = norm(t.sym);
    if (!(a.includes(b) || b.includes(a))) {
      console.log(`  ✗ SKIP ${t.sym} ${t.addr} — 온체인 심볼 "${onchainSym}" 가 기대 "${t.sym}" 와 불일치(주소 의심)`);
      skipped++; continue;
    }
    // 인식 가능한 기대 심볼로 pin(calibration 문서와 일치) — 온체인값은 검증/투명성용으로 로그.
    const onchainTag = norm(onchainSym) === norm(t.sym) ? "" : ` (onchain: ${onchainSym})`;
    if (DRY) {
      console.log(`  ✓ (dry) PIN ${t.sym.padEnd(12)} ${t.addr}${onchainTag}  — ${t.note}`);
    } else {
      await pinWatchlist(t.addr, t.sym);
      console.log(`  ✓ PIN ${t.sym.padEnd(12)} ${t.addr}${onchainTag}  — ${t.note}`);
    }
    pinned++;
  }

  console.log(`\n[seed:risk] 완료: pin ${pinned} · skip ${skipped}${DRY ? " (DRY — 실제 적재 안 함)" : ""}`);
  console.log("다음: npm run snapshot:bridgeauth → npm run snapshot:backing (lock&mint lockbox 적재 → Detector A 자동 활성)");
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
