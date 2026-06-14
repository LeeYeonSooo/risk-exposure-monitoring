/**
 * 공용 RPC/GraphQL 동시성 게이트 + 백오프 재시도 — 무료 엔드포인트(publicnode·blue-api·goldsky)가
 * 동시 버스트에 429 로 일부 호출을 떨어뜨려 **그 데이터(프로토콜·볼트)가 통째로 사라지는** 버그를
 * 막는다(2026-06-12 "aave $1.35M/h 가 회색" 의 진범 클래스). URL(호스트)당 동시 N개로 캡하고,
 * 일시적 실패(429/5xx/네트워크/타임아웃)는 재시도, 결론적 실패(실행 리버트 등)는 즉시 포기한다.
 *
 * 게이트는 **호스트 단위로 전역 공유**(모듈 경계를 넘어) — lending-events·lending-pools·curve-pools
 * 등이 같은 publicnode 를 두드려도 합산 동시성이 캡을 넘지 않는다.
 */
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function makeGate(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = () => new Promise<void>((res) => { if (active < max) { active++; res(); } else queue.push(res); });
  const release = () => { active--; if (queue.length && active < max) { active++; queue.shift()!(); } };
  return async <T>(task: () => Promise<T>): Promise<T> => { await acquire(); try { return await task(); } finally { release(); } };
}

const _gates = new Map<string, ReturnType<typeof makeGate>>();
function hostOf(url: string): string { try { return new URL(url).host; } catch { return url; } }
/** 이 URL(호스트)의 동시성 게이트. 기본 동시 3 — 무료 publicnode 한도(16토큰 부하에서 4는
 *  lido 가 간헐 탈락하는 게 실측됨)와 콜드빌드 속도의 절충. */
export function gateFor(url: string, max = 3) {
  const h = hostOf(url);
  let g = _gates.get(h);
  if (!g) {
    // API 키가 붙은 Alchemy 엔드포인트는 무료 publicnode(동시 3)보다 한도가 훨씬 높다. 트랜잭션 피드의
    // getAssetTransfers 페이지네이션 + 랩 검증 eth_call 프로브가 한 호스트에 몰리므로, 3슬롯이면
    // 콜드로드가 100s+ 로 폭증한다(2026-06-13 실측). 키 엔드포인트는 12 로 — 여전히 bounded(무제한
    // fan-out·소켓 폭주 방지)지만 정상 처리량을 회복한다. publicnode 등은 호출부 기본값(3) 유지. */
    const effMax = /\.g\.alchemy\.com$/.test(h) ? Math.max(max, 12) : max;
    g = makeGate(effMax); _gates.set(h, g);
  }
  return g;
}

// 지수 백오프(250·500·1000ms). 신뢰성은 **폴백(2 엔드포인트)**이 담당하므로 1차 재시도는 3회로
// 짧게 끊어 빠르게 폴백으로 넘긴다 — 5회·긴 백오프는 base 가 126s 걸리던 원인(실측)이었다.
const backoff = (i: number) => sleep(250 * 2 ** i);

/** JSON-RPC POST (게이트 + **3회 지수 백오프 재시도**). result(성공) / null(결론적 실패 or 소진) 반환. */
export async function gatedJsonRpc<T>(url: string, method: string, params: unknown[], attempts = 3): Promise<T | null> {
  return gateFor(url)(async () => {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
        if (r.status === 429 || r.status >= 500) { if (i < attempts - 1) { await backoff(i); continue; } return null; }
        if (!r.ok) return null;
        const j = (await r.json()) as { result?: T; error?: { message?: string } };
        if (j.error) {
          const msg = (j.error.message ?? "").toLowerCase();
          if (/rate|limit|exceed|capacity|busy|timeout|too many|try again/.test(msg) && i < attempts - 1) { await backoff(i); continue; }
          return null;
        }
        return j.result ?? null;
      } catch { if (i < attempts - 1) { await backoff(i); continue; } return null; }
    }
    return null;
  });
}

/** GraphQL POST (게이트 + **5회 지수 백오프 재시도**). 파싱된 JSON / null 반환. */
export async function gatedGql<T = unknown>(url: string, query: string, attempts = 5): Promise<T | null> {
  return gateFor(url)(async () => {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) });
        if (r.status === 429 || r.status >= 500) { if (i < attempts - 1) { await backoff(i); continue; } return null; }
        if (!r.ok) return null;
        return (await r.json()) as T;
      } catch { if (i < attempts - 1) { await backoff(i); continue; } return null; }
    }
    return null;
  });
}
