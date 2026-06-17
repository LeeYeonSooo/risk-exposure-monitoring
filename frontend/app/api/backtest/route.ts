import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NextResponse } from "next/server";

/**
 * Fork 백테스트 결과 서빙 — automation/backtest/results.json (npm run backtest 가 생성).
 * 알림 패널의 "백테스트" 토글이 이걸 읽어 각 과거 사건을 fork 한 시점의 발화 알림을 보여준다.
 *
 * 결과는 라이브 RPC 재생이라 무겁다(브라우저 클릭마다 재실행 X) → 사전 생성된 스냅샷 결과를 제공.
 * 갱신: automation 에서 `npm run backtest`.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  // frontend cwd 기준 ../automation/backtest/results.json
  const candidates = [
    resolve(process.cwd(), "..", "automation", "backtest", "results.json"),
    resolve(process.cwd(), "automation", "backtest", "results.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const json = JSON.parse(raw);
      return NextResponse.json(json);
    } catch { /* 다음 후보 */ }
  }
  return NextResponse.json(
    { generatedAt: null, results: [], error: "results.json 없음 — automation 에서 `npm run backtest` 실행 필요" },
    { status: 200 },
  );
}
