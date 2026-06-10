/**
 * 조회 가능한 토큰의 체인별 컨트랙트 주소를 마크다운으로 덤프.
 *   - DB 정밀(nodes: ethereum/base/arbitrum, 온체인 검증)
 *   - breadth 라이브(tokenAddrByChain: 전 체인, DeFiLlama 최고TVL 단일자산 풀에서 해석)
 * → 합쳐서 TOKEN-ADDRESSES.md (레포 루트) 에 저장.
 *
 * Usage: npm run dump:addresses
 * Env: DATABASE_URL, BASE_URL(기본 http://localhost:3000)
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { closePool, query } from "@/db/client";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "..", "TOKEN-ADDRESSES.md"); // 레포 루트
const CONC = 6;

async function main() {
  // 1) DB 정밀 주소
  const dbR = await query<{ sym: string; chain: string; addr: string }>(
    `SELECT split_part(replace(node_id,'token:',''),'@',1) AS sym, chain, lower(address) AS addr
     FROM nodes WHERE type IN ('Token','TokenProtocol') AND address ~* '^0x[0-9a-f]{40}$' AND address !~ '^0x0+$'`,
  );
  const map = new Map<string, Map<string, string>>();
  const dbChains = new Set<string>();
  for (const r of dbR.rows) {
    if (!map.has(r.sym)) map.set(r.sym, new Map());
    map.get(r.sym)!.set(r.chain, r.addr);
    dbChains.add(`${r.sym}|${r.chain}`);
  }
  const syms = [...map.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // 2) breadth 라이브 enrich (전 체인) — 병렬
  let i = 0, enriched = 0;
  async function worker() {
    while (i < syms.length) {
      const s = syms[i++];
      try {
        const d = (await fetch(`${BASE}/api/breadth/${encodeURIComponent(s)}`).then((r) => r.json())) as { tokenAddrByChain?: Record<string, string> };
        for (const [ch, a] of Object.entries(d.tokenAddrByChain ?? {})) {
          if (/^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0+$/.test(a)) { map.get(s)!.set(ch, a.toLowerCase()); enriched++; }
        }
      } catch { /* skip */ }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  // 3) MD 작성
  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  let totalRows = 0;
  const lines: string[] = [
    "# 조회 가능한 토큰 — 체인별 컨트랙트 주소",
    "",
    `생성: ${now} · 토큰 ${syms.length}개`,
    "",
    "출처: **DB 정밀**(ethereum/base/arbitrum, 스냅샷 온체인 검증) + **breadth 라이브**(전 체인, DeFiLlama 최고-TVL 단일자산 풀에서 해석). breadth 는 요청 시 재해석되며 베스트-에포트라 일부 체인은 비어있을 수 있음.",
    "",
    "| Token | Chain | Address |",
    "|---|---|---|",
  ];
  for (const s of syms) {
    const chains = [...map.get(s)!.keys()].sort();
    for (const ch of chains) {
      lines.push(`| ${s} | ${ch} | \`${map.get(s)!.get(ch)}\` |`);
      totalRows++;
    }
  }
  lines.push("", `합계: ${totalRows} (토큰×체인) 주소 · DB ${dbChains.size}건 + breadth enrich ${enriched}건(중복 포함).`, "");
  writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log(`[dump] TOKEN-ADDRESSES.md 작성 — 토큰 ${syms.length}, 주소 ${totalRows}건 → ${OUT}`);
  await closePool();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
