/**
 * 종착(terminal) 전역 백필 — 이미 DB 에 적재된 모든 lego_nodes 에 종착 표식을 다시 계산해 얹는다.
 *
 * 왜 필요한가(감사관 [추궁-전역전파]·[고정4]): snapshot-lego ⑦ 종착 로직은 "재스냅한 토큰"에만 적재된다.
 * snapshot:all 은 금지(레이트리밋·정책)라, ⑦ 도입 전 적재된 ~80개 구 스냅샷 토큰의 sink 후보
 * (YT·예치영수증·렌딩마켓·확정 스테이킹 풀)는 종착 표기가 없어 트리에서 '끝'과 '단절'이 구분되지 않았다.
 *
 * 이 스크립트는 네트워크 호출 0 — 순수하게 DB 의 node.role/kind/meta.kind + 엣지(out·staked_in 들어옴)만으로
 * types.computeTerminalMark(=⑦ 와 동일 규칙)을 전 노드에 재적용한다. 추측 데이터 없음, snapshot:all 아님.
 * 새 스냅샷이 그 토큰을 갱신하면 ⑦ 가 같은 결과를 다시 써넣으므로 멱등(idempotent)·정합.
 *
 * Usage:
 *   npm run lego:terminal            # 전역 백필
 *   npm run lego:terminal -- --dry   # 변경 건수만 출력(쓰지 않음)
 */
import process from "node:process";

import { closePool, query } from "@/db/client";
import { computeTerminalMark, type LegoNode, type TerminalKind } from "@/lego/types";

interface NodeRow {
  id: string;
  kind: LegoNode["kind"];
  role: LegoNode["role"];
  protocol: string | null;
  parent_token: string | null;
  meta: Record<string, unknown>;
}

/** token:sUSDe / token:sUSDe@base → "sUSDe" (종착 이유 문구의 기초자산 이름용). */
function viewedSymbolOf(parentToken: string | null): string {
  return (parentToken ?? "").replace(/^token:/i, "").split("@")[0];
}

async function main() {
  const dry = process.argv.includes("--dry");

  // 예치방향 out엣지가 있는 노드 집합(issues/lp_of/collateral_at/staked_in 모두 예치방향).
  const outRows = await query<{ src: string }>(`SELECT DISTINCT src FROM lego_edges`);
  const outSrc = new Set(outRows.rows.map((r) => r.src));
  // 들어오는 staked_in 이 있는 노드(=스테이킹 수용처로 온체인 확정된 풀).
  const inRows = await query<{ dst: string }>(`SELECT DISTINCT dst FROM lego_edges WHERE relation = 'staked_in'`);
  const inStakedIn = new Set(inRows.rows.map((r) => r.dst));

  const nodes = (await query<NodeRow>(
    `SELECT id, kind, role, protocol, parent_token, meta FROM lego_nodes`,
  )).rows;

  let added = 0, cleared = 0, unchanged = 0;
  const byKind: Record<string, number> = {};
  for (const n of nodes) {
    const mark = computeTerminalMark(
      { kind: n.kind, role: n.role, protocol: n.protocol, meta: n.meta ?? {} },
      outSrc.has(n.id),
      inStakedIn.has(n.id),
      viewedSymbolOf(n.parent_token),
    );
    const had = (n.meta as { terminal?: boolean } | undefined)?.terminal === true;

    if (mark) {
      // 이미 같은 종착이면 스킵(멱등). 종착 종류/이유가 바뀌었으면 갱신.
      const prevKind = (n.meta as { terminalKind?: TerminalKind } | undefined)?.terminalKind;
      const prevReason = (n.meta as { terminalReason?: string } | undefined)?.terminalReason;
      if (had && prevKind === mark.terminalKind && prevReason === mark.terminalReason) { unchanged++; continue; }
      byKind[mark.terminalKind] = (byKind[mark.terminalKind] ?? 0) + 1;
      added++;
      if (!dry) {
        const meta = { ...(n.meta ?? {}), ...mark };
        await query(`UPDATE lego_nodes SET meta = $2, updated_at = now() WHERE id = $1`, [n.id, JSON.stringify(meta)]);
      }
    } else if (had) {
      // 더 이상 종착이 아닌데 옛 표식이 남아있음(예: out엣지가 새로 생긴 풀) → 종착 메타 제거.
      cleared++;
      if (!dry) {
        const meta = { ...(n.meta ?? {}) } as Record<string, unknown>;
        delete meta.terminal; delete meta.terminalKind; delete meta.terminalReason; delete meta.rewardSource;
        await query(`UPDATE lego_nodes SET meta = $2, updated_at = now() WHERE id = $1`, [n.id, JSON.stringify(meta)]);
      }
    } else {
      unchanged++;
    }
  }

  const kindStr = Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(" · ") || "없음";
  console.log(`[terminal-backfill]${dry ? " (dry-run)" : ""} 노드 ${nodes.length} 중 종착 적재/갱신 ${added} (${kindStr}) · 표식제거 ${cleared} · 변화없음 ${unchanged}`);
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
