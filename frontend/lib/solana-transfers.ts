import type { FlowTx } from "./flow-types";

/**
 * 솔라나 라이브 전송 피드 — 표준 JSON-RPC 만으로 (인덱서 없음, EVM 경로와 같은 무상태 패턴).
 * 사용자의 Alchemy 키가 solana-mainnet 을 그대로 지원함을 확인하고 그 RPC 를 쓴다.
 *
 * 원리: getSignaturesForAddress(민트) = "민트 계정을 참조한" 트랜잭션 목록.
 *  잡히는 것: transferChecked(팬텀 등 현대 지갑의 전송)·mintTo/burn·Jupiter
 *  sharedAccountsRoute/exactOutRoute(스왑 주류, 양쪽 민트 포함)·같은 tx 의 ATA 생성 동반 전송.
 *  구조적으로 안 보이는 것: 레거시 plain transfer, 기존 ATA 간 Raydium v4 직접 스왑
 *  (민트 미참조) — UI 배지에 그대로 공지한다. 부분 피드를 전체인 척하지 않는다.
 *
 * 분류: 트랜잭션이 거친 프로그램 ID 로 카운터파티를 정한다 — 프로그램 ID 는 온체인
 * 암호학적 정체성이므로 추측이 아니다. 모든 ID 는 공식 깃헙/문서에서 검증됨 (2026-06-10).
 * 금액: meta.pre/postTokenBalances 의 raw amount 기반 owner 별 delta (공식 권장 방식;
 * 계정 생성=pre 0, 계정 폐쇄=post 0, 실패 tx 제외).
 */

// ── 공식 검증된 프로그램 ID → 라벨 (출처: 각 프로토콜 공식 repo/docs) ──
const PROGRAMS: { id: string; label: string; kind: "swap" | "lend" | "stake" }[] = [
  // DEX (swap)
  { id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", label: "raydium", kind: "swap" },      // Raydium AMM v4
  { id: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", label: "raydium", kind: "swap" },      // Raydium CLMM
  { id: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", label: "raydium", kind: "swap" },      // Raydium CPMM
  { id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", label: "orca-dex", kind: "swap" },      // Orca Whirlpool (라벨 = DeFiLlama 노드 슬러그)
  { id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", label: "meteora", kind: "swap" },       // Meteora DLMM
  { id: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", label: "meteora", kind: "swap" },      // Meteora Dynamic AMM
  { id: "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", label: "lifinity", kind: "swap" },     // Lifinity v2
  { id: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", label: "phoenix", kind: "swap" },       // Phoenix
  { id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", label: "pumpswap", kind: "swap" },      // pump.fun AMM
  { id: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", label: "drift", kind: "swap" },         // Drift v2
  // Lending
  { id: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", label: "kamino-lend", kind: "lend" },   // Kamino Lend
  { id: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", label: "marginfi", kind: "lend" },      // marginfi v2
  { id: "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo", label: "solend", kind: "lend" },        // Solend(Save)
  // Staking
  { id: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", label: "marinade", kind: "stake" },     // Marinade
  { id: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy", label: "stake-pool", kind: "stake" },   // SPL Stake Pool (JitoSOL 등)
  { id: "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY", label: "sanctum", kind: "stake" },      // Sanctum SPL fork
  { id: "SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn", label: "sanctum", kind: "stake" },      // Sanctum SPL multi fork
  { id: "stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq", label: "sanctum", kind: "stake" },      // Sanctum Router
];
// 애그리게이터는 실제 체결 AMM(내부 CPI)이 우선이고, 그것마저 미등록일 때만 라벨로 쓴다
const AGGREGATORS: { id: string; label: string }[] = [
  { id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", label: "jupiter" }, // Jupiter v6
];
const PROGRAM_BY_ID = new Map(PROGRAMS.map((p) => [p.id, p] as const));
const AGG_BY_ID = new Map(AGGREGATORS.map((p) => [p.id, p.label] as const));

const SIG_LIMIT = 50;       // 폴당 서명 조회 상한
const TX_FETCH_CAP = 30;    // 폴당 신규 getTransaction 상한 (CU 예산 — 결과는 영구 캐시)
const BATCH = 20;

interface SigInfo { signature: string; blockTime?: number | null; err?: unknown }
interface TokenBal { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
interface Instr { programId?: string; parsed?: { type?: string; info?: { mint?: string } } }
interface ParsedTx {
  blockTime?: number;
  meta?: { err?: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[]; innerInstructions?: { instructions: Instr[] }[] | null };
  transaction?: { message?: { instructions?: Instr[]; accountKeys?: { pubkey?: string; signer?: boolean }[] } };
}

async function rpc(url: string, body: unknown): Promise<unknown> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// 서명 → 파싱 결과 캐시 (서명은 불변) — 30초 폴마다 같은 tx 를 다시 받지 않는다
const _txCache = new Map<string, FlowTx | null>(); // null = 이 민트 기준 표시할 것 없음(실패/0이동)
function pruneCache() { if (_txCache.size > 8000) _txCache.clear(); }

function classify(tx: ParsedTx, mint: string): { label: string | null; kind: FlowTx["kind"] } {
  const progs = new Set<string>();
  for (const i of tx.transaction?.message?.instructions ?? []) if (i.programId) progs.add(i.programId);
  for (const inner of tx.meta?.innerInstructions ?? []) for (const i of inner.instructions ?? []) if (i.programId) progs.add(i.programId);
  // 1) 등록된 DEX/렌딩/스테이킹 프로그램 (내부 CPI 포함 — Jupiter 경유 시 실제 체결 AMM 이 잡힘)
  for (const p of progs) { const hit = PROGRAM_BY_ID.get(p); if (hit) return { label: hit.label, kind: hit.kind === "swap" ? "swap" : "deposit" }; }
  // 2) 애그리게이터만 보이면 그 라벨 (체결 AMM 미등록 케이스)
  for (const p of progs) { const agg = AGG_BY_ID.get(p); if (agg) return { label: agg, kind: "swap" }; }
  // 3) 민트/소각 (jsonParsed 가 토큰 프로그램 명령을 해석해 줌)
  const allInstr: Instr[] = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...((tx.meta?.innerInstructions ?? []) as { instructions: Instr[] }[]).flatMap((x) => x.instructions ?? []),
  ];
  for (const i of allInstr) {
    const t = i.parsed?.type ?? "";
    if ((t === "mintTo" || t === "mintToChecked") && i.parsed?.info?.mint === mint) return { label: null, kind: "mint" };
    if ((t === "burn" || t === "burnChecked") && i.parsed?.info?.mint === mint) return { label: null, kind: "burn" };
  }
  // 4) 그 외 = 지갑간/미등록 컨트랙트 전송 — 라벨 추측 없이 전송으로 표시
  return { label: null, kind: "transfer" };
}

function toFlowTx(sig: string, tx: ParsedTx, token: string, mint: string, price: number): FlowTx | null {
  if (!tx?.meta || tx.meta.err != null) return null;
  const pre = (tx.meta.preTokenBalances ?? []).filter((b) => b.mint === mint);
  const post = (tx.meta.postTokenBalances ?? []).filter((b) => b.mint === mint);
  if (!pre.length && !post.length) return null;
  const decimals = (post[0] ?? pre[0]).uiTokenAmount.decimals;
  // owner 별 delta — raw amount 문자열 기반 (uiAmount 부동소수 손실 회피), 생성=pre 0 / 폐쇄=post 0
  const byOwner = new Map<string, bigint>();
  const acc = (b: TokenBal, sign: 1n | -1n) => {
    const o = b.owner ?? `idx:${b.accountIndex}`;
    byOwner.set(o, (byOwner.get(o) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };
  for (const b of pre) acc(b, -1n);
  for (const b of post) acc(b, 1n);
  let movedRaw = 0n;
  for (const d of byOwner.values()) if (d > 0n) movedRaw += d;
  const moved = Number(movedRaw) / Math.pow(10, decimals);
  const { label, kind } = classify(tx, mint);
  if (moved <= 0 && kind !== "burn") return null; // 잔액 순이동 없는 민트 참조(승인 등)는 제외
  // 방향: 수수료 지불자(사용자 지갑)의 이 토큰 delta 부호 — 음수 = 토큰이 장소로 들어감(in)
  const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
  const fpDelta = feePayer != null ? byOwner.get(feePayer) : undefined;
  let direction: "in" | "out" = fpDelta != null ? (fpDelta < 0n ? "in" : "out") : kind === "burn" ? "out" : "in";
  if (kind === "mint") direction = "in";
  if (kind === "burn") { direction = "out"; }
  const burnAmt = kind === "burn" ? Number(-[...byOwner.values()].reduce((s, d) => (d < 0n ? s + d : s), 0n)) / Math.pow(10, decimals) : 0;
  const k: FlowTx["kind"] = kind === "deposit" ? (direction === "in" ? "deposit" : "withdraw") : kind;
  return {
    hash: sig, chain: "solana", token, from: "", to: "",
    valueUsd: (kind === "burn" ? burnAmt : moved) * price,
    ts: tx.blockTime ?? 0, direction, kind: k,
    counterparty: label, counterpartyAddr: null, marketHint: null, reasons: [],
  };
}

/** 한 민트의 [loTs, hiTs] 윈도우 전송을 FlowTx 로 반환. price = USD/토큰 (coins.llama.fi solana:<mint>) */
export async function solanaTransfers(rpcUrl: string, token: string, mint: string, loTs: number, hiTs: number, price: number): Promise<FlowTx[]> {
  // 핫한 민트는 최신 50건이 전부 1분 지연보다 새것일 수 있다 → before 커서로 윈도우까지 페이지백 (최대 3페이지)
  const sigs: SigInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < 3; page++) {
    const sigRes = (await rpc(rpcUrl, {
      jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
      params: [mint, { limit: SIG_LIMIT, commitment: "confirmed", ...(before ? { before } : {}) }],
    })) as { result?: SigInfo[] } | null;
    const batchSigs = sigRes?.result ?? [];
    if (!batchSigs.length) break;
    for (const s of batchSigs) {
      if (s.err == null && typeof s.blockTime === "number" && s.blockTime >= loTs && s.blockTime <= hiTs) sigs.push(s);
    }
    const oldest = batchSigs[batchSigs.length - 1];
    if (typeof oldest.blockTime === "number" && oldest.blockTime < loTs) break; // 윈도우 시작 통과
    before = oldest.signature;
  }
  if (!sigs.length) return [];

  const out: FlowTx[] = [];
  const need: string[] = [];
  for (const s of sigs) {
    if (_txCache.has(s.signature)) { const c = _txCache.get(s.signature); if (c) out.push(c); }
    else if (need.length < TX_FETCH_CAP) need.push(s.signature);
  }
  for (let i = 0; i < need.length; i += BATCH) {
    const chunk = need.slice(i, i + BATCH);
    const batch = chunk.map((sig, j) => ({
      jsonrpc: "2.0", id: j, method: "getTransaction",
      params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
    }));
    const res = (await rpc(rpcUrl, batch)) as { id: number; result?: ParsedTx }[] | null;
    if (!Array.isArray(res)) continue;
    for (const r of res) {
      const sig = chunk[r.id];
      const ftx = r.result ? toFlowTx(sig, r.result, token, mint, price) : null;
      _txCache.set(sig, ftx);
      if (ftx) out.push(ftx);
    }
  }
  pruneCache();
  return out.sort((a, b) => b.ts - a.ts);
}
