/**
 * flow-layout — sizing + DETERMINISTIC static layout for the 흐름맵 (물리엔진 없음, 드래그 보존).
 *
 * **느슨한 동심원** (사용자 확정) — 완벽한 원이 아니라, 배치와 구조가 어우러진 유기적 링:
 *   · 안쪽 링 = 토큰 (파생 가족 stETH·wstETH… 는 나란히)
 *   · 중간 링 = 프로토콜 — 연결된 토큰들의 가중 평균 각도 방향 (관계가 가까우면 각도도 가깝게)
 *   · 바깥 링 = 마켓/풀 — 자기 프로토콜 각도 근처, 홀짝 반지름 스태거로 숨통
 *   · 최외곽 = 볼트 · LP/파생 토큰 — 자기 발행처(마켓/프로토콜) 각도 근처
 *   · 토큰 링 안쪽 = 🌉 브릿지 통로
 * 링 내 순서는 "원하는 각도"를 보존한 균등 슬롯(겹침 구조적 차단) + 해시 지터로 살짝 흐트러짐.
 * 멀티체인: 체인별 가로 밴드에 링 하나씩.
 */
import type { FlowGraph, FlowNode } from "./flow-types";

const BASE_R: Record<FlowNode["kind"], number> = { token: 27, protocol: 18, market: 10, vault: 9, external: 10, bridge: 12 };

export function radiusOf(n: FlowNode): number {
  const base = BASE_R[n.kind] ?? 12;
  const t = n.tvlUsd > 0 ? Math.log10(n.tvlUsd + 1) : 0; // ~0..11
  if (n.kind === "token" && n.derived) return 14 + Math.min(12, t * 1.1); // 파생/LP 토큰은 기초보다 작게 (사용자 확정)
  return base + Math.min(base * 1.15, t * 1.7);
}

const TAU = Math.PI * 2;
/** 결정적 해시 — 폴백 각도·유기적 지터용 (id 가 같으면 항상 같은 값) */
function hashOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}
const hashAngle = (id: string) => ((hashOf(id) % 3600) / 3600) * TAU - Math.PI;

/** 원하는 각도 순서를 보존하며 링에 균등 배치 (앵커 = 평균 변위 최소화). 반환은 정렬 순서 포함. */
function ringSlots(ids: string[], desired: Map<string, number>): { id: string; ang: number; idx: number }[] {
  if (!ids.length) return [];
  const sorted = [...ids].sort((a, b) => ((desired.get(a) ?? 0) - (desired.get(b) ?? 0)) || a.localeCompare(b));
  const n = sorted.length;
  let sx = 0, sy = 0;
  sorted.forEach((id, i) => { const d = (desired.get(id) ?? 0) - (i / n) * TAU; sx += Math.cos(d); sy += Math.sin(d); });
  const anchor = sx || sy ? Math.atan2(sy, sx) : -Math.PI / 2;
  return sorted.map((id, i) => ({ id, ang: anchor + (i / n) * TAU, idx: i }));
}

export function computeStaticLayout(graph: FlowGraph, chainsOrder: string[], width: number, height: number): Map<string, { x: number; y: number }> {
  const chains = [...new Set([...chainsOrder, ...graph.nodes.map((n) => n.chain)])].filter(Boolean);
  const multi = chains.length > 1;
  const bandX = (chain: string) => (multi ? ((Math.max(0, chains.indexOf(chain)) + 0.5) / chains.length) * width : width / 2);
  const out = new Map<string, { x: number; y: number }>();

  // ── 인접 정보 ──
  const holdsOfProto = new Map<string, { token: string; w: number }[]>();
  const parentOf = new Map<string, string>();        // market→proto, vault→(market|proto), 🌉→token
  const deriveParentSat = new Map<string, string>(); // LP/파생 token → 발행처(market|proto)
  const deriveBaseOf = new Map<string, string>();    // 파생 token → 기초 token (가족 묶음)
  const kindById = new Map(graph.nodes.map((n) => [n.id, n.kind] as const));
  for (const e of graph.edges) {
    if (e.kind === "holds") {
      const a = holdsOfProto.get(e.target);
      const w = Math.max(1, Math.log10(Math.max(e.tvlUsd, e.volUsd ?? 0) + 10));
      if (a) a.push({ token: e.source, w }); else holdsOfProto.set(e.target, [{ token: e.source, w }]);
    } else if (e.kind === "market" || e.kind === "vault") parentOf.set(e.target, e.source);
    else if (e.kind === "bridge" && e.target.startsWith("bridge:")) parentOf.set(e.target, e.source);
    else if (e.kind === "derive") {
      if (kindById.get(e.source) === "token" && kindById.get(e.target) === "token") deriveBaseOf.set(e.target, e.source);
      else if (kindById.get(e.target) === "token") deriveParentSat.set(e.target, e.source);
    }
  }

  for (const chain of chains) {
    const mine = graph.nodes.filter((n) => n.chain === chain);
    if (!mine.length) continue;
    const cx = bandX(chain), cy = height / 2;
    const unit = multi ? Math.min(width / chains.length, height) : Math.min(width, height);
    const s = multi ? 0.62 : 1;
    const R_TOK = unit * 0.26 * s;
    const R_BRIDGE = R_TOK * 0.55;
    const R_PROTO = R_TOK + unit * 0.17 * s;
    const R_MKT = R_PROTO + unit * 0.12 * s;
    const R_SAT = R_MKT + unit * 0.09 * s;
    const jit = (id: string, amp: number) => ((hashOf(id) % 100) / 100 - 0.5) * amp; // 유기적 흐트러짐
    const angleOf = new Map<string, number>();
    const place = (id: string, ang: number, r: number) => { angleOf.set(id, ang); out.set(id, { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r }); };

    // 1) 토큰 링 — 파생 가족 인접, 가족은 TVL 내림차순
    const satIds = new Set([...deriveParentSat.keys()]);
    const ringTokens = mine.filter((n) => n.kind === "token" && !satIds.has(n.id));
    const rootOf = (id: string): string => { let cur = id; for (let i = 0; i < 6 && deriveBaseOf.has(cur); i++) cur = deriveBaseOf.get(cur)!; return cur; };
    const families = new Map<string, FlowNode[]>();
    for (const n of ringTokens) { const r = rootOf(n.id); const a = families.get(r); if (a) a.push(n); else families.set(r, [n]); }
    const ordered = [...families.values()].map((members) => ({
      members: members.sort((a, b) => (a.id === rootOf(a.id) ? -1 : b.id === rootOf(b.id) ? 1 : b.tvlUsd - a.tvlUsd)),
      weight: Math.max(...members.map((m) => m.tvlUsd)),
    })).sort((a, b) => b.weight - a.weight).flatMap((f) => f.members);
    ordered.forEach((n, i) => {
      const ang = -Math.PI / 2 + (i / Math.max(1, ordered.length)) * TAU;
      place(n.id, ang, ordered.length === 1 ? 0 : R_TOK + jit(n.id, 26));
    });

    // 2) 프로토콜 링 — 연결 토큰 가중 평균 각도 근처
    const protos = mine.filter((n) => n.kind === "protocol");
    const desiredP = new Map<string, number>();
    for (const p of protos) {
      let sx = 0, sy = 0;
      for (const h of holdsOfProto.get(p.id) ?? []) {
        const ang = angleOf.get(h.token);
        if (ang == null) continue;
        sx += Math.cos(ang) * h.w; sy += Math.sin(ang) * h.w;
      }
      desiredP.set(p.id, sx || sy ? Math.atan2(sy, sx) : hashAngle(p.id));
    }
    for (const { id, ang, idx } of ringSlots(protos.map((n) => n.id), desiredP)) {
      place(id, ang, R_PROTO + (idx % 2 ? 16 : -16) + jit(id, 18)); // 홀짝 스태거 — 기계적 원 깨기
    }

    // 3) 마켓 링 — 자기 프로토콜 각도 근처, 홀짝 반지름 스태거(과밀 숨통)
    const markets = mine.filter((n) => n.kind === "market");
    const desiredM = new Map<string, number>();
    for (const m of markets) desiredM.set(m.id, angleOf.get(parentOf.get(m.id) ?? "") ?? hashAngle(m.id));
    for (const { id, ang, idx } of ringSlots(markets.map((n) => n.id), desiredM)) {
      place(id, ang, R_MKT + (idx % 2 ? 30 : -30) + jit(id, 20));
    }

    // 4) 최외곽 — 볼트 + LP/파생 위성: 발행처(마켓/프로토콜) 각도 근처
    const sats = mine.filter((n) => n.kind === "vault" || (n.kind === "token" && satIds.has(n.id)));
    const desiredS = new Map<string, number>();
    for (const v of sats) {
      const pid = (v.kind === "vault" ? parentOf.get(v.id) : deriveParentSat.get(v.id)) ?? "";
      desiredS.set(v.id, angleOf.get(pid) ?? hashAngle(v.id));
    }
    for (const { id, ang, idx } of ringSlots(sats.map((n) => n.id), desiredS)) {
      place(id, ang, R_SAT + (idx % 2 ? 22 : -22) + jit(id, 16));
    }

    // 5) 🌉 브릿지 통로 — 부착 토큰 각도의 안쪽 / 6) 폴백
    const bridges = mine.filter((n) => n.kind === "bridge");
    const desiredB = new Map<string, number>();
    for (const b of bridges) desiredB.set(b.id, angleOf.get(parentOf.get(b.id) ?? "") ?? hashAngle(b.id));
    for (const { id, ang } of ringSlots(bridges.map((n) => n.id), desiredB)) place(id, ang, R_BRIDGE);
    for (const n of mine) if (!out.has(n.id)) place(n.id, hashAngle(n.id), R_MKT * 0.8);
  }
  return out;
}
