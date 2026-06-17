/**
 * 엣지 타입별 색상 — 그래프 엣지 + 범례가 공유.
 * 라이트 배경(#f6f8fb/흰)에서 또렷한 팔레트 (Tailwind 600 계열, 진한 채도).
 */
// 엣지를 4개 의미 그룹 색으로 통합(종류 최소화) — 담보·예치/스테이킹·발행·유동성.
//   개별 타입 구분(mono vs 격리 등)은 엣지 클릭/hover 라벨(EDGE_TYPE_LABELS)에만 남기고, 색은 그룹으로 묶어 인지 부하↓.
// 빨강은 위험(danger) 전용으로 비워둔다 — 담보는 중립 파랑. (사용자: 빨강이 "큰일난 것 같다")
const G_COLLATERAL = "#2563eb"; // blue-600 — 담보 (담보로 들어가는 모든 관계)
const G_SUPPLY = "#0d9488";     // teal-600 — 예치/스테이킹/보상재원 (공급 쪽)
const G_ISSUE = "#7c3aed";      // violet-600 — 발행/구성 (토큰→파생·LP)
const G_LIQUIDITY = "#d97706";  // amber-600 — 유동성/백킹 (DEX LP·래퍼)
const G_BACKING = "#0891b2";    // cyan-600 — 기반·배킹(상류): 토큰이 무엇으로 구성되는가(언더라잉→기반→리스테이킹 venue)
export const EDGE_TYPE_COLORS: Record<string, string> = {
  // ── 담보 그룹 ──
  collateral: G_COLLATERAL,
  collateral_isolated: G_COLLATERAL,
  cdp_collateral: G_COLLATERAL,
  collateral_at: G_COLLATERAL,
  // ── 예치/스테이킹 그룹 ──
  deposit_supply: G_SUPPLY,
  staked_in: G_SUPPLY,
  curator_funding: G_SUPPLY,
  // ── 발행/구성 그룹 ──
  issues: G_ISSUE,
  lp_of: G_ISSUE,
  // ── 기반·배킹(상류) — 언더라잉/리스테이킹 체인 ──
  backed_by: G_BACKING,
  // ── 유동성/백킹 그룹 ──
  lp_pair: G_LIQUIDITY,
  mint_backing: G_LIQUIDITY,
  loan_asset: "#ea580c", // orange-600 — 대출(차입) 자산 (드묾, 유지)
  // ── 브릿지(브릿지맵 전용, 그룹 통합 안 함 — 메커니즘 구분이 핵심) ──
  bridge: "#9333ea",
  bridge_in: "#d97706",
  bridge_out: "#059669",
  bridge_lockmint: "#2563eb", // 락&민트(캐노니컬)
  bridge_burnmint: "#dc2626", // 번&민트(네이티브 — 약한 고리)
  bridge_liquidity: "#0d9488", // 유동성 풀(스왑)
};

// 관계맵 범례용 4그룹 (color + 대표 라벨). 브릿지맵은 메커니즘 3종 별도.
export const EDGE_GROUPS: { label: string; color: string }[] = [
  { label: "담보", color: G_COLLATERAL },
  { label: "예치·스테이킹", color: G_SUPPLY },
  { label: "발행·구성", color: G_ISSUE },
  { label: "유동성·백킹", color: G_LIQUIDITY },
  { label: "기반·배킹(상류)", color: G_BACKING },
];

export const EDGE_TYPE_DEFAULT_COLOR = "#475569"; // slate-600 — 미분류

// 구조상 가능(온체인 미검증) 엣지 색 — 검은 선. "이 관계가 구조적으로 가능하다"는 골격만 표시하고,
//   온체인 검증된 관계(실제 자금 흐름 또는 관계 evidence)는 위 EDGE_TYPE_COLORS(범례색)로 칠한다.
//   → 점선 없이 "범례색 = 온체인 검증 / 검은 선 = 구조상 가능"의 2분류로 정직하게 구분(사용자 2026-06-17).
export const STRUCTURAL_EDGE_COLOR = "#111827"; // gray-900 — 검은 선(라이트 배경에서 또렷)

// (b) 관계는 검증됐는데 금액만 미측정(데이터 소스 한계 — 예: Fluid 스마트담보, Euler RPC 실패).
//   "구조상 가능(미관측, 회색)"과 다르다 — 관계 자체는 evidence 로 확인됨. 그래서 별도 색 + "구조상 가능" 토글에 안 묶임.
//   측정된 0(실제 미사용)은 (b) 아니라 (a) 회색이다.
export const VERIFIED_UNMEASURED_COLOR = "#6d7bbf"; // 페리윙클/인디고 — 관측색(파랑담보)·회색 둘 다와 구분

export const EDGE_TYPE_LABELS: Record<string, string> = {
  collateral: "담보 (mono-pool)",
  collateral_isolated: "담보 (격리마켓)",
  cdp_collateral: "CDP 담보",
  loan_asset: "대출 자산",
  deposit_supply: "예치/공급",
  lp_pair: "DEX LP",
  mint_backing: "래퍼 백킹",
  bridge: "OFT 메시 (동일주소)",
  bridge_in: "잠김 → 브릿지 (소스)",
  bridge_out: "브릿지 → 민팅 (도착)",
  bridge_lockmint: "락 & 민트 (캐노니컬)",
  bridge_burnmint: "번 & 민트 (네이티브 — 약한 고리)",
  bridge_liquidity: "유동성 풀 (스왑)",
  issues: "파생토큰 발행",
  lp_of: "LP 구성",
  collateral_at: "담보로 쓰임",
  staked_in: "스테이킹 수용",
  curator_funding: "보상 재원 (마켓 이자 → 볼트)",
  backed_by: "기반 구성 (언더라잉 → 기반 → 리스테이킹)",
};

export function edgeColor(edgeType: string | undefined | null): string {
  if (!edgeType) return EDGE_TYPE_DEFAULT_COLOR;
  return EDGE_TYPE_COLORS[edgeType] ?? EDGE_TYPE_DEFAULT_COLOR;
}
