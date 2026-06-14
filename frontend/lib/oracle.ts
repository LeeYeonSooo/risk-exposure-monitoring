// 오라클 표시 분류 (프론트). automation 어댑터가 모든 자산의 oracle type 을 "MARKET" 으로 하드코딩하는
// 한계를 보정한다: LST/LRT(rsETH·weETH·wstETH 등)는 2차 시장가가 아니라 기초 ETH 대비 **교환비(exchange-rate/NAV)**
// 로 가격됨(Aave CAPO 등) → 시장 디페그가 오라클에 안 잡힘. automation classifyAsset 의 lst 클래스를 미러.

const _LST = ["STETH", "WSTETH", "RETH", "WEETH", "RSETH", "EZETH", "CBETH", "OSETH", "SFRXETH", "ETHX",
  "PUFETH", "RSWETH", "OETH", "METH", "SWETH", "ANKRETH", "WBETH", "EETH", "UNIETH", "LSETH", "AGETH"];

/** LST/LRT = 교환비(NAV) 기반 오라클을 쓰는 ETH 계열 자산. (automation classifyAsset lst 미러) */
export function isRateBasedAsset(symbol: string | null | undefined): boolean {
  const s = (symbol ?? "").toUpperCase();
  if (s === "ETH" || s === "WETH") return false;                  // bare ETH = major
  if (s.startsWith("PT-") || s.startsWith("PT ") || s.includes("-PT-")) return false;
  if (_LST.some((t) => s.includes(t))) return true;
  return s.endsWith("ETH");                                       // *ETH 접미 LST (WETH/ETH 는 위에서 제외)
}

export type OracleClass = "시장가" | "환율(LST)" | "풀 현물가" | "하드코딩·고정";

export const ORACLE_COLORS: Record<string, string> = {
  "시장가": "#34d399", "환율(LST)": "#60a5fa", "풀 현물가": "#fbbf24", "하드코딩·고정": "#f87171",
};

/** 오라클을 위험 의미 단위 클래스로. symbol 을 주면 LST/LRT 의 MARKET 을 교환비(NAV)로 보정. */
export function oracleClassOf(type?: string | null, provider?: string | null, symbol?: string | null): OracleClass {
  const k = `${type ?? ""} ${provider ?? ""}`;
  if (/nav|free|fixed|hard/i.test(k)) return "하드코딩·고정";
  if ((type ?? "") === "NONE" || /pool spot|현물/i.test(k)) return "풀 현물가";
  if ((type ?? "") === "EXCHANGE_RATE") return "환율(LST)";
  if ((type ?? "") === "MARKET" && isRateBasedAsset(symbol)) return "환율(LST)"; // LST/LRT = CAPO/rate, 2차 시장가 아님
  return "시장가";
}

/** 클래스별 "디페그 민감" 표기 + 한 줄 해석 (위험 의미). */
export function oracleNote(cls: OracleClass): { sensitive: string; note: string; danger: boolean } {
  switch (cls) {
    case "하드코딩·고정":
      return { sensitive: "아니오 (고정가)", note: "하드코딩/고정 오라클 — 디페그가 온체인 가격에 안 잡혀 청산이 지연·불가 → bad debt 조용히 누적.", danger: true };
    case "환율(LST)":
      return { sensitive: "아니오 (교환비 추종)", note: "교환비(NAV) 기반 — 슬래싱·디백킹은 반영하나 2차 시장 디페그는 미반영 → 시장 급락 시 청산이 늦을 수 있음.", danger: false };
    case "풀 현물가":
      return { sensitive: "예 (풀 현물가)", note: "풀 현물가 — 별도 오라클 없음. 얕은 풀이면 가격 조작 위험.", danger: false };
    default:
      return { sensitive: "예 (시장가 추종)", note: "시장가 기반 — 디페그 시 청산이 정상 발동.", danger: false };
  }
}
