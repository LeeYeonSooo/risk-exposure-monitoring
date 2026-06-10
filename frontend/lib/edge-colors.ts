/**
 * 엣지 타입별 색상 — 그래프 엣지 + 범례가 공유.
 * 라이트 배경(#f6f8fb/흰)에서 또렷한 팔레트 (Tailwind 600 계열, 진한 채도).
 */
// 진한 채도 — 흰/연한 배경에서 대비 확보 (Tailwind 600 계열)
export const EDGE_TYPE_COLORS: Record<string, string> = {
  collateral: "#2563eb", // blue-600 — mono-pool 담보
  collateral_isolated: "#0284c7", // sky-600 — 격리 마켓 담보 (Morpho)
  cdp_collateral: "#7c3aed", // violet-600 — CDP 담보 (Maker/f(x))
  loan_asset: "#ea580c", // orange-600 — 대출(차입) 자산
  deposit_supply: "#16a34a", // green-600 — 예치/공급
  lp_pair: "#db2777", // pink-600 — DEX LP
  mint_backing: "#9333ea", // purple-600 — 래퍼 백킹
  bridge: "#9333ea", // purple-600 — OFT 메시(동일주소)
  bridge_in: "#d97706", // amber-600 — 이 체인에서 잠김(브릿지로 들어감) [legacy, 방향]
  bridge_out: "#059669", // emerald-600 — 다른 체인으로 민팅(브릿지에서 나옴) [legacy, 방향]
  // 메커니즘별 (방향은 화살표로 표시) — 큐레이터가 약한 브릿지 식별
  bridge_lockmint: "#2563eb", // blue-600 — 락&민트(캐노니컬, 담보 백킹)
  bridge_burnmint: "#dc2626", // red-600 — 번&민트(네이티브 민팅 — 메시지층 침해 시 무담보)
  bridge_liquidity: "#0d9488", // teal-600 — 유동성 풀(스왑, 민팅 X)
};

export const EDGE_TYPE_DEFAULT_COLOR = "#475569"; // slate-600 — 미분류

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
};

export function edgeColor(edgeType: string | undefined | null): string {
  if (!edgeType) return EDGE_TYPE_DEFAULT_COLOR;
  return EDGE_TYPE_COLORS[edgeType] ?? EDGE_TYPE_DEFAULT_COLOR;
}
