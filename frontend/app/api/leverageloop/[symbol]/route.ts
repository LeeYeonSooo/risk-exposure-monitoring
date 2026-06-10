import { NextResponse } from "next/server";

/**
 * GET /api/leverageloop/[symbol]
 *
 * **레버리지 루핑** — 사기 사건이 아니라 LST/LRT·스테이블의 정상 레버리지 루프를
 * Morpho 포지션으로 결정론적으로 탐지(트랜잭션 추적 불필요).
 *   루퍼 = 같은 주소가 토큰을 담보로 넣고(collateral>0) + 상관자산을 차입(borrow>0).
 *   루프: 주소 →[토큰 담보]→ Morpho 마켓 →[loan 차입]→ 주소 →(스왑)→ 토큰 재담보.
 *
 * 온체인 라이브 — 임의 LST/LRT/스테이블에 일반화. (Aave e-mode 루프는 후속.)
 */
export const dynamic = "force-dynamic";

const MORPHO_GQL = "https://blue-api.morpho.org/graphql";

// LST/LRT · 스테이블 주소 (메인넷). 레버리지 루핑이 흔한 담보 토큰.
const ADDR: Record<string, string> = {
  wsteth: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", steth: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
  weeth: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", rseth: "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
  ezeth: "0xbf5495efe5db9ce00f80364c8b423567e58d2110", pufeth: "0xd9a442856c234a39a81a089c06451ebaa4306a72",
  cbeth: "0xbe9895146f7af43049ca1c1ae358b0541ea49704", reth: "0xae78736cd615f374d3085123a210448e74fc6393",
  meth: "0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa", sweth: "0xf951e335afb289353dc249e82926178eac7ded78",
  ethx: "0xa35b1b31ce002fbf2058d22f30f95d405200a15b", sfrxeth: "0xac3e018457b222d93114458476f3e3416abbe38f",
  susde: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", usde: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
  sdai: "0x83f20f44975d03b1b09e64809b757c47f942beea", usds: "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
  susds: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", wbtc: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  cbbtc: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", usd0: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5",
};

async function gql<T>(query: string): Promise<T | null> {
  try {
    const r = await fetch(MORPHO_GQL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json())?.data ?? null;
  } catch { return null; }
}

interface MItem { marketId: string; lltv: string; loanAsset: { symbol: string }; collateralAsset: { symbol: string }; state: { borrowAssetsUsd: number | null; collateralAssetsUsd: number | null; utilization: number | null } }
interface PItem { user: { address: string }; healthFactor: number | null; state: { collateralUsd: number | null; borrowAssetsUsd: number | null } }

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await ctx.params;
  const sym = decodeURIComponent(symbol);
  const addr = ADDR[sym.toLowerCase()];
  if (!addr) return NextResponse.json({ available: false, reason: `${sym} 는 레버리지 루핑 대상(LST/LRT·스테이블)이 아닙니다`, known: Object.keys(ADDR) });

  // 1) 이 토큰이 담보인 Morpho 마켓(차입 큰 순) — 레버리지 루프 시장.
  const md = await gql<{ markets: { items: MItem[] } }>(
    `{ markets(first:6, orderBy:BorrowAssetsUsd, orderDirection:Desc, where:{collateralAssetAddress_in:["${addr}"], chainId_in:[1]}){ items{ marketId lltv loanAsset{symbol} collateralAsset{symbol} state{ borrowAssetsUsd collateralAssetsUsd utilization } } } }`,
  );
  const markets = (md?.markets?.items ?? []).filter((m) => (m.state.borrowAssetsUsd ?? 0) > 0);
  if (!markets.length) return NextResponse.json({ available: false, reason: `${sym} 담보로 차입된 Morpho 마켓이 없습니다 (레버리지 루프 없음)`, known: Object.keys(ADDR) });

  const topMarkets = markets.slice(0, 4);

  // 2) 각 마켓의 상위 포지션 → 루퍼(담보+차입 동시).
  const looperMap = new Map<string, { addr: string; collatUsd: number; borrowUsd: number; hf: number | null; markets: Set<string>; loans: Set<string> }>();
  const marketOut = [] as { id: string; label: string; loan: string; lltv: number; util: number | null; borrowUsd: number; collatUsd: number; loopers: number }[];

  await Promise.all(topMarkets.map(async (m) => {
    const pd = await gql<{ marketPositions: { items: PItem[] } }>(
      `{ marketPositions(first:14, orderBy:Collateral, orderDirection:Desc, where:{marketUniqueKey_in:["${m.marketId}"], chainId_in:[1]}){ items{ user{address} healthFactor state{ collateralUsd borrowAssetsUsd } } } }`,
    );
    const items = pd?.marketPositions?.items ?? [];
    let mLoopers = 0;
    for (const p of items) {
      const c = p.state.collateralUsd ?? 0, b = p.state.borrowAssetsUsd ?? 0;
      if (c <= 0 || b <= 0) continue; // 루퍼만(담보+차입)
      mLoopers++;
      const a = p.user.address.toLowerCase();
      const e = looperMap.get(a) ?? { addr: p.user.address, collatUsd: 0, borrowUsd: 0, hf: p.healthFactor, markets: new Set(), loans: new Set() };
      e.collatUsd += c; e.borrowUsd += b; e.markets.add(m.marketId); e.loans.add(m.loanAsset.symbol);
      if (p.healthFactor != null && (e.hf == null || p.healthFactor < e.hf)) e.hf = p.healthFactor;
      looperMap.set(a, e);
    }
    marketOut.push({
      id: m.marketId, label: `${m.collateralAsset.symbol}/${m.loanAsset.symbol}`, loan: m.loanAsset.symbol,
      lltv: Number(m.lltv) / 1e18, util: m.state.utilization, borrowUsd: m.state.borrowAssetsUsd ?? 0, collatUsd: m.state.collateralAssetsUsd ?? 0, loopers: mLoopers,
    });
  }));

  const loopers = [...looperMap.values()]
    .map((l) => ({ addr: l.addr, collatUsd: l.collatUsd, borrowUsd: l.borrowUsd, hf: l.hf, ltv: l.collatUsd > 0 ? l.borrowUsd / l.collatUsd : 0, loans: [...l.loans], marketIds: [...l.markets] }))
    .sort((a, b) => b.collatUsd - a.collatUsd)
    .slice(0, 24);

  const totalCollat = loopers.reduce((s, l) => s + l.collatUsd, 0);
  const totalBorrow = loopers.reduce((s, l) => s + l.borrowUsd, 0);
  const maxLltv = Math.max(...marketOut.map((m) => m.lltv));

  return NextResponse.json({
    available: true, symbol: sym, source: "Morpho positions (live)",
    markets: marketOut.sort((a, b) => b.borrowUsd - a.borrowUsd),
    loopers, looperCount: loopers.length, totalCollatUsd: totalCollat, totalBorrowUsd: totalBorrow,
    maxLltv, loanAssets: [...new Set(marketOut.map((m) => m.loan))],
  });
}
