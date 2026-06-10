/**
 * 비-Morpho 외부 큐레이터/펀드 자동 발견.
 *
 * 왜: 현재 큐레이터 발견은 Morpho MetaMorpho(+Euler)에 한정. DeBank 추적은 venue-무관이지만
 *   "누가 큐레이터인가"의 주소 소스가 필요했다. 추적 토큰의 **탑홀더**(Dune erc20 Transfer 넷팅으로
 *   현재 잔액 산출) 중 CEX·프로토콜 인프라·번 주소를 거른 대형 보유자(펀드/볼트/DAO/전략/고래)를
 *   tracked_wallets 로 시드 → 이후 snapshot-wallets(DeBank/온체인)가 전 venue 추적 → 자금 이탈 알림.
 *   Dune labels.owner_addresses 로 엔티티명·EOA 여부, cex.addresses 로 CEX 식별.
 *
 * Usage: npm run discover:wallets -- wstETH USDe   (기본: wstETH USDe WBTC)
 * Env: DATABASE_URL, DUNE_API_KEY(automation/.env 또는 export)
 */
import process from "node:process";

import { closePool, query } from "@/db/client";
import { runDuneSql } from "@/lib/dune";
import { lookupProtocol } from "@/registry/protocol-registry";

const HOLDER_LIMIT = Number(process.env.DISCOVER_LIMIT ?? 80);
const SEED_CAP = Number(process.env.DISCOVER_SEED_CAP ?? 30);
const ZERO = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
// 탑홀더는 대부분 인프라(브릿지·AMM·렌딩·리시트토큰·팩토리) — 라벨로 거른다.
// 큐레이터/펀드/트레저리(특히 Safe 멀티시그)·미라벨 고래는 남김.
const INFRA_RE = /bridge|gateway|join|factory|\bamm\b|\bpool\b|\bpair\b|router|atoken|ctoken|comet|crvusd|gauge|staking|distributor|vesting|teleport|wrapped|reserve|escrow|locker|0x\s*protocol|aave|compound|maker|spark|morpho|euler|fluid|uniswap|balancer|curve|pendle|lido\s*:?\s*(?:steth|wsteth|deposit|withdraw)/i;

interface HolderRow {
  address: string; raw: number;
  account_owner: string | null; contract_name: string | null; eoa: string | null; cex_name: string | null;
}

async function ethTokenAddrs(symbols: string[]): Promise<{ sym: string; addr: string }[]> {
  const out: { sym: string; addr: string }[] = [];
  for (const sym of symbols) {
    const r = await query<{ addr: string }>(
      `SELECT lower(address) AS addr FROM nodes
       WHERE chain='ethereum' AND address ~* '^0x[0-9a-f]{40}$'
         AND (lower(label)=lower($1) OR node_id ILIKE 'token:'||$1||'%' OR node_id ILIKE 'token:'||$1||'@%')
       ORDER BY (node_id ILIKE 'token:'||$1) DESC LIMIT 1`,
      [sym],
    );
    if (r.rows[0]) out.push({ sym, addr: r.rows[0].addr });
    else console.warn(`[discover] ${sym}: 이더리움 토큰 주소 못 찾음(DB nodes) — skip`);
  }
  return out;
}

// erc20 Transfer 넷팅으로 현재 잔액 → 탑홀더. 라벨(owner)·CEX 조인. (잔액 raw, 랭킹용)
function buildSql(addr: string): string {
  const hex = addr.replace(/^0x/, "");
  return `
    WITH flows AS (
      SELECT "to" AS addr, CAST(value AS double) AS v FROM erc20_ethereum.evt_Transfer WHERE contract_address = from_hex('${hex}')
      UNION ALL
      SELECT "from" AS addr, -CAST(value AS double) AS v FROM erc20_ethereum.evt_Transfer WHERE contract_address = from_hex('${hex}')
    ),
    bal AS ( SELECT addr, sum(v) AS raw FROM flows GROUP BY addr HAVING sum(v) > 0 )
    SELECT '0x' || to_hex(b.addr) AS address, b.raw,
           max(o.account_owner) AS account_owner, max(o.contract_name) AS contract_name,
           max(o.eoa) AS eoa, max(c.cex_name) AS cex_name
    FROM bal b
    LEFT JOIN labels.owner_addresses o ON o.address = b.addr AND o.blockchain = 'ethereum'
    LEFT JOIN cex.addresses c          ON c.address = b.addr AND c.blockchain = 'ethereum'
    GROUP BY b.addr, b.raw
    ORDER BY b.raw DESC
    LIMIT ${HOLDER_LIMIT}
  `;
}

async function main() {
  const args = process.argv.slice(2).filter((s) => !s.startsWith("-"));
  const symbols = args.length ? args : ["wstETH", "USDe", "WBTC"];
  const tokens = await ethTokenAddrs(symbols);
  if (!tokens.length) { console.log("[discover] 토큰 주소 없음 — 중단"); await closePool(); return; }

  let seeded = 0, skipCex = 0, skipInfra = 0, skipBurn = 0, scanned = 0;
  const seen = new Set<string>();
  const named: string[] = [];

  for (const t of tokens) {
    if (seeded >= SEED_CAP) break;
    console.log(`[discover] ${t.sym} 탑홀더 조회 (Dune erc20 Transfer 넷팅)…`);
    let rows: HolderRow[] = [];
    try {
      rows = await runDuneSql<HolderRow>(buildSql(t.addr), `holders ${t.sym}`);
    } catch (e) {
      console.error(`[discover] ${t.sym} Dune 실패: ${(e as Error).message}`);
      continue;
    }
    scanned += rows.length;
    for (const r of rows) {
      if (seeded >= SEED_CAP) break;
      const addr = (r.address || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr) || seen.has(addr)) continue;
      seen.add(addr);
      if (ZERO.has(addr)) { skipBurn++; continue; }
      if (r.cex_name) { skipCex++; continue; }                              // CEX 핫월렛 제외
      if (lookupProtocol(addr as `0x${string}`)) { skipInfra++; continue; } // 알려진 프로토콜 인프라/리시트 토큰 제외
      const nameStr = `${r.account_owner ?? ""} ${r.contract_name ?? ""}`.trim();
      if (nameStr && INFRA_RE.test(nameStr)) { skipInfra++; continue; }     // 라벨이 인프라(브릿지·AMM·렌딩…)면 제외

      const label = r.account_owner || r.contract_name || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
      const isEoa = r.eoa === "true" || r.eoa === "t";
      const kind = isEoa ? "whale" : "fund"; // 컨트랙트=펀드/볼트/트레저리, EOA=고래
      await query(
        `INSERT INTO tracked_wallets (wallet, label, kind, source_token, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (wallet) DO UPDATE SET
           source_token = COALESCE(tracked_wallets.source_token, EXCLUDED.source_token),
           label = COALESCE(tracked_wallets.label, EXCLUDED.label), active = true`,
        [addr, label, kind, t.sym],
      );
      seeded++;
      if (r.account_owner || r.contract_name) named.push(`${label} (${t.sym})`);
    }
  }

  console.log(`[discover] 후보 ${scanned} → 시드 ${seeded} · 제외: CEX ${skipCex} / 인프라 ${skipInfra} / 번 ${skipBurn}`);
  if (named.length) console.log(`[discover] 발견된 라벨드 엔티티(비-Morpho 큐레이터/펀드/트레저리 후보):\n  - ${[...new Set(named)].slice(0, 25).join("\n  - ")}`);
  console.log(`다음: npm run snapshot:wallets (등록 지갑 DeBank/온체인 추적 → 자금 이탈 알림)`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
