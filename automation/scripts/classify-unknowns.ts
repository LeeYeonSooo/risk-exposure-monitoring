/**
 * 미지주소 자동 분류 (B10) — unknown_addresses 큐를 읽어 classify() 로 "어디 프로토콜의 무슨 역할"을
 * 추정 라벨로 적재(heuristic_hint·notes). 사람이 `npm run review` 로 확인 → 확정분은 protocol-registry 반영.
 * protocol-registry(수동) 위에 kuromi 프록시(EIP-1967/1167)·셀렉터 프로브·Etherscan 자동분류를 얹은 제안 파이프.
 *
 *   npm run classify:unknowns                # 미검토 전부
 *   npm run classify:unknowns -- 0x<addr>    # 단일 주소 테스트(큐 무관)
 */
import process from "node:process";
import type { Address } from "viem";

import { closePool, query } from "@/db/client";
import { classify, suggestLabel } from "@/snapshot/classify";

async function main() {
  const arg = process.argv.slice(2).filter((a) => a !== "--")[0];
  if (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) { // 단일 주소 테스트(큐 무관)
    const c = await classify(arg as Address);
    console.log(`${arg} → ${suggestLabel(c)}`);
    console.log(JSON.stringify(c, null, 2));
    await closePool();
    return;
  }

  const rows = (await query<{ address: string }>(
    `SELECT address FROM unknown_addresses WHERE NOT reviewed ORDER BY discovered_at DESC LIMIT 200`,
  )).rows;
  console.log(`[classify] 미검토 미지주소 ${rows.length}개 분류`);
  let labeled = 0, eoa = 0, unknown = 0;
  for (const { address } of rows) {
    try {
      const c = await classify(address as Address);
      const hint = suggestLabel(c);
      const note = c.kind === "candidate" ? `${c.reason}${c.proxyImpl ? ` · impl ${c.proxyImpl}` : ""}`
        : c.kind === "unknown" && c.proxyImpl ? `proxy impl ${c.proxyImpl}` : null;
      await query(`UPDATE unknown_addresses SET heuristic_hint = $2, notes = COALESCE($3, notes) WHERE address = $1`, [address, hint, note]);
      if (c.kind === "candidate" || c.kind === "protocol") labeled++;
      else if (c.kind === "whale_eoa") eoa++; else unknown++;
      console.log(`  ${address} → ${hint}`);
    } catch (e) {
      console.warn(`  ${address} 분류 실패:`, (e as Error).message);
    }
  }
  console.log(`[classify] 완료 — 후보/확정 ${labeled} · EOA ${eoa} · 미확인 ${unknown}`);
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
