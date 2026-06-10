import { NextResponse } from "next/server";

import { topTokensByTvl } from "@/lib/flow-core";

/** GET /api/token-universe — top live tokens by TVL (DeFiLlama), for the search picker. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tokens = await topTokensByTvl(150);
    const total = tokens.reduce((s, t) => s + t.tvlUsd, 0) || 1;
    return NextResponse.json({ tokens: tokens.map((t) => ({ ...t, pct: t.tvlUsd / total })), total });
  } catch (e) {
    return NextResponse.json({ tokens: [], error: (e as Error).message }, { status: 200 });
  }
}
