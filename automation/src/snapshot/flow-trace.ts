/**
 * 트랜잭션 플로우 그래프 — kuromi feeder/flow_trace.py 포팅 (Dune 단일 SQL 버전).
 *
 * kuromi 원본: alchemy_getAssetTransfers BFS(depth 2)로 "코어 행위자 + 행위자간 멀티자산 흐름"을
 * 수집하고, 병적 자기조달 고리(차입으로 받은 가치가 자기 고리로 복귀)를 DFS 로 탐지했다.
 * 이 포팅은 BFS 를 Dune SQL 한 방(쿼리 ID 고정, 파라미터 = 토큰주소·윈도우·행위자수)으로 대체하고,
 * 후처리(라벨링·사이클·역할·스푸핑)는 여기서 결정적 코드로 수행한다 — kuromi 원칙
 * "온체인 읽기·카운팅·검증은 결정적 코드, LLM 은 가장자리만" 유지.
 *
 * 시맨틱 보존:
 *   - 노드 = 주소(EOA 포함 — 정적 그래프와 달리 EOA 가 1급), 0x0 = mint/burn 센티넬
 *   - 엣지 = (src,dst,asset) 방향 집계 {amount,count,blockRange,sampleTx}
 *   - in_cycle = 닫힌 고리 + 대출(LENDERS)로 주입된 가치가 그 고리에서 재순환할 때만 (순수 스왑 고리 제외)
 *   - suspicious = 심볼 스푸핑(비ASCII 정제로 변형 or 메이저 사칭인데 정식주소 아님)
 *   - role = Morpho/Aave 등 렌더와의 transfer 에 공급/담보·차입/인출 의미 부여
 */

import { KNOWN_TOKENS } from "@/config/tokens";

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// 대출 가치 주입원 — kuromi 는 Morpho 만(+TODO Aave 등). 메인넷 풀 주소로 확장(온체인 정설 주소).
export const LENDERS: Record<string, string> = {
  "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb": "Morpho Blue",
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "Aave V3 Pool",
  "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9": "Aave V2 Pool",
  "0xc13e21b648a5ee794902342038ff3adab66be987": "Spark Pool",
  "0x52aa899454998be5b000ad077a46bbe360f4e497": "Fluid",
};

export interface FlowEdgeRaw {
  src: string; dst: string; asset: string;
  assetSymbol: string | null;
  amount: number; cnt: number;
  minBlock: number | null; maxBlock: number | null;
  sampleTx: string | null;
}

export interface FlowEdgeOut extends FlowEdgeRaw {
  suspicious: boolean;
  role: string | null;       // 공급/담보 · 차입/인출
  inCycle: boolean;
  isMintBurn: boolean;
}

// ── 심볼 스푸핑 (kuromi trusted_sym 포팅) ─────────────────────────
// asset 정체성은 주소(스푸핑 불가)고 심볼은 attacker-controllable. 비ASCII(zero-width/Lisu 등)
// 정제로 글자가 바뀌면, 또는 메이저 심볼인데 정식주소가 아니면 의심 플래그.
const MAJORS = new Set(["USDC", "USDT", "DAI", "WETH", "WBTC", "ETH", "USDS", "FRAX", "CRVUSD", "GHO", "USDE"]);
const CANON_BY_SYMBOL = new Map(Object.entries(KNOWN_TOKENS).map(([addr, v]) => [v.symbol.toUpperCase(), addr]));

export function checkSymbol(assetAddr: string, raw: string | null): { symbol: string; suspicious: boolean } {
  const a = assetAddr.toLowerCase();
  if (!raw) return { symbol: a.slice(0, 8), suspicious: false };
  const clean = [...raw].filter((c) => c.charCodeAt(0) < 128 && c.charCodeAt(0) >= 32).join("").trim();
  const canon = CANON_BY_SYMBOL.get(clean.toUpperCase());
  const suspicious = clean !== raw || (MAJORS.has(clean.toUpperCase()) && canon != null && canon !== a);
  return { symbol: clean || a.slice(0, 8), suspicious };
}

// ── 병적 자기조달 고리 (kuromi find_cycles 포팅) ───────────────────
// injected = LENDERS→X 로 X 가 받은(=차입/인출한) 자산. 닫힌 고리에서 루트의 주입 자산이
// 다시 순환할 때만 병적으로 마킹 — 정상 스왑 라운드트립·일반 보유 순환은 제외.
export function findCycles(
  edges: FlowEdgeRaw[],
  maxLen = 5,
): { cycleNodes: Set<string>; cycleEdges: Set<string> } {
  const edgeKey = (e: FlowEdgeRaw) => `${e.src}|${e.dst}|${e.asset}`;
  const adj = new Map<string, Array<{ to: string; key: string; asset: string }>>();
  for (const e of edges) {
    if (e.src === ZERO_ADDR || e.dst === ZERO_ADDR || e.src === e.dst) continue;
    if (!adj.has(e.src)) adj.set(e.src, []);
    adj.get(e.src)!.push({ to: e.dst, key: edgeKey(e), asset: e.asset });
  }
  // 주입 자산: lender → X
  const injected = new Map<string, Set<string>>();
  for (const e of edges) {
    if (LENDERS[e.src] && e.dst !== ZERO_ADDR) {
      if (!injected.has(e.dst)) injected.set(e.dst, new Set());
      injected.get(e.dst)!.add(e.asset);
    }
  }
  const roots = [...injected.keys()];
  const cycleNodes = new Set<string>();
  const cycleEdges = new Set<string>();

  for (const s of roots) {
    const inj = injected.get(s)!;
    const dfs = (v: string, path: string[], epath: string[], assets: Set<string>) => {
      if (epath.length >= maxLen) return;
      for (const { to, key, asset } of adj.get(v) ?? []) {
        if (to === s && epath.length >= 1) {
          const ringAssets = new Set(assets); ringAssets.add(asset);
          let hit = false;
          for (const t of inj) if (ringAssets.has(t)) { hit = true; break; }
          if (hit) {
            for (const n of path) cycleNodes.add(n);
            cycleNodes.add(s);
            for (const k of epath) cycleEdges.add(k);
            cycleEdges.add(key);
          }
        } else if (to !== s && !path.includes(to)) {
          const na = new Set(assets); na.add(asset);
          dfs(to, [...path, to], [...epath, key], na);
        }
      }
    };
    dfs(s, [s], [], new Set());
  }
  return { cycleNodes, cycleEdges };
}

/** 렌더(대출풀)와의 흐름에 의미 부여 — kuromi: t==MORPHO → 공급/담보, f==MORPHO → 차입/인출. */
export function roleOf(src: string, dst: string): string | null {
  if (LENDERS[dst]) return "공급/담보";
  if (LENDERS[src]) return "차입/인출";
  return null;
}

/** 후처리 일괄 — raw 엣지 → 사이클·역할·스푸핑 마킹 완료 엣지. */
export function enrichEdges(raw: FlowEdgeRaw[]): { edges: FlowEdgeOut[]; cycleNodes: Set<string> } {
  const { cycleNodes, cycleEdges } = findCycles(raw);
  const edges = raw.map((e) => {
    const { symbol, suspicious } = checkSymbol(e.asset, e.assetSymbol);
    return {
      ...e,
      assetSymbol: symbol,
      suspicious,
      role: roleOf(e.src, e.dst),
      inCycle: cycleEdges.has(`${e.src}|${e.dst}|${e.asset}`),
      isMintBurn: e.src === ZERO_ADDR || e.dst === ZERO_ADDR,
    };
  });
  return { edges, cycleNodes };
}
