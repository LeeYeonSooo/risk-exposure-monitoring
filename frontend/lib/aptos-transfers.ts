import type { FlowTx } from "./flow-types";
import { APTOS_VENUES } from "./nonevm-venues";

/**
 * 앱토스 라이브 전송 피드 — 공식 Indexer GraphQL (keyless, api.mainnet.aptoslabs.com).
 * fungible_asset_activities: asset_type 별 Withdraw/Deposit 이벤트 + 시각 + 트랜잭션의
 * 최상위 엔트리 함수(entry_function_id_str). 카운터파티 = 엔트리 함수의 모듈 계정 주소가
 * 검증 레지스트리에 있을 때만 라벨 (모듈 주소는 온체인 실행 컨텍스트 — 추측이 아님).
 * 0x1(프레임워크) 직접 전송 = 지갑간 "전송". 미등재 모듈 = 라벨 없는 "전송".
 */

const GQL = "https://api.mainnet.aptoslabs.com/v1/graphql";
// 익명 호출은 IP 당 속도제한(429)이 낮다 — APTOS_API_KEY(aptoslabs.com 무료 발급) 설정 시 헤더로 사용
const APTOS_KEY = process.env.APTOS_API_KEY;

const normAddr = (a: string) => {
  try { return "0x" + BigInt(a).toString(16); } catch { return a.toLowerCase(); }
};
const VENUE_BY_ADDR = new Map(APTOS_VENUES.map((v) => [normAddr(v.address), { label: v.label, kind: v.kind }] as const));

interface Activity {
  amount: number | string;
  type: string; // e.g. 0x1::fungible_asset::Deposit / Withdraw / ...::Mint / ...::Burn
  entry_function_id_str: string | null;
  transaction_timestamp: string; // UTC, no Z
  transaction_version: number;
  owner_address: string;
}

export async function aptosTransfers(token: string, assetType: string, loTs: number, hiTs: number, price: number, decimals: number): Promise<FlowTx[]> {
  const iso = (t: number) => new Date(t * 1000).toISOString().replace("Z", "");
  const query = `{
    fungible_asset_activities(
      where: { asset_type: { _eq: ${JSON.stringify(assetType)} }, is_gas_fee: { _eq: false }, is_transaction_success: { _eq: true },
               transaction_timestamp: { _gte: ${JSON.stringify(iso(loTs))}, _lte: ${JSON.stringify(iso(hiTs))} } }
      order_by: { transaction_version: desc }, limit: 200
    ) { amount type entry_function_id_str transaction_timestamp transaction_version owner_address }
  }`;
  let rows: Activity[] = [];
  try {
    const r = await fetch(GQL, {
      method: "POST", cache: "no-store", body: JSON.stringify({ query }),
      headers: { "Content-Type": "application/json", ...(APTOS_KEY ? { Authorization: `Bearer ${APTOS_KEY}` } : {}) },
    });
    if (!r.ok) return [];
    rows = ((await r.json()) as { data?: { fungible_asset_activities?: Activity[] } }).data?.fungible_asset_activities ?? [];
  } catch { return []; }

  // 트랜잭션(version) 단위로 Withdraw/Deposit 을 합쳐 한 건의 흐름으로
  const byVer = new Map<number, Activity[]>();
  for (const a of rows) { const arr = byVer.get(a.transaction_version); if (arr) arr.push(a); else byVer.set(a.transaction_version, [a]); }

  const out: FlowTx[] = [];
  for (const [ver, acts] of byVer) {
    const ts = Math.floor(new Date(acts[0].transaction_timestamp + "Z").getTime() / 1000);
    if (ts < loTs || ts > hiTs) continue;
    const amount = Math.max(...acts.map((a) => Number(a.amount) || 0)) / Math.pow(10, decimals);
    if (!(amount > 0)) continue;
    const typeOf = (a: Activity) => a.type.split("::").pop() ?? "";
    const hasMint = acts.some((a) => typeOf(a).startsWith("Mint"));
    const hasBurn = acts.some((a) => typeOf(a).startsWith("Burn"));
    const hasWithdraw = acts.some((a) => typeOf(a).startsWith("Withdraw"));
    const entry = acts.find((a) => a.entry_function_id_str)?.entry_function_id_str ?? "";
    const moduleAddr = entry.includes("::") ? normAddr(entry.split("::")[0]) : "";
    const venue = moduleAddr ? VENUE_BY_ADDR.get(moduleAddr) : undefined;

    let kind: FlowTx["kind"] = "transfer";
    let counterparty: string | null = null;
    let direction: "in" | "out" = hasWithdraw ? "in" : "out";
    if (hasMint && !hasWithdraw) { kind = "mint"; direction = "in"; }
    else if (hasBurn) { kind = "burn"; direction = "out"; }
    else if (venue) { counterparty = venue.label; kind = venue.kind === "swap" ? "swap" : direction === "in" ? "deposit" : "withdraw"; }
    out.push({ hash: String(ver), chain: "aptos", token, from: "", to: "", valueUsd: amount * price, ts, direction, kind, counterparty, counterpartyAddr: null, marketHint: null, reasons: [] });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
