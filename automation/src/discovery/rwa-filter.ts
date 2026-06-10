/**
 * RWA / 비추적 자산 필터 — 사용자 규칙:
 *   - 부동산/주택담보 류 RWA 제외
 *   - 금·은 등 commodity(원자재) RWA 제외      ← 추가됨
 *   - USDC 같은 stablecoin-class RWA 는 통과 (오히려 추적 대상)
 *
 * 1차 방어선은 "담보 순위" 자체 — 실제 담보 USD 가 작으면 자동 탈락.
 * 이 필터는 담보가 커도 추적 대상이 아닌 real-estate / commodity 를
 * 명시적으로 배제하기 위한 보조 장치.
 *
 * 확장: 새 케이스 발견 시 패턴 또는 주소 denylist 에 추가.
 * 추후 에이전트가 토큰 메타데이터(발행자·카테고리) 기반 자동 분류 예정.
 */

// 부동산/모기지 RWA 심볼 패턴
const REAL_ESTATE_SYMBOL_PATTERNS: RegExp[] = [
  /realt/i,        // RealT (REALTOKEN-...) 실물 부동산 분할 소유
  /reinhart/i,
  /propy/i,        // Propy 부동산
  /tangible/i,     // Tangible real estate
  /housing/i,
  /mortgage/i,
  /real[-_]?estate/i,
];

// 금·은 등 commodity(원자재) RWA — "금같은 자산 제외" (사용자 지시)
const COMMODITY_SYMBOL_PATTERNS: RegExp[] = [
  /\bxaut?\b/i,    // XAU / XAUt (Tether Gold)
  /\bpaxg\b/i,     // PAX Gold
  /\bxag\b/i,      // 은 (silver)
  /\bkau\b/i, /\bkag\b/i,  // Kinesis gold/silver
  /gold/i,
  /silver/i,
  /\bwti\b/i, /\boil\b/i,  // 원유
];

// 주소 기반 명시적 제외 (정확 매칭, 소문자)
const EXCLUDED_ADDRESS_DENYLIST = new Set<string>([
  "0x68749665ff8d2d112fa859aa293f07a622782f38", // XAUt (Tether Gold)
  "0x45804880de22913dafe09f4980848ece6ecbaf78", // PAXG (Pax Gold)
]);

// stablecoin RWA allowlist — commodity/real-estate 패턴에 우연히 걸려도 통과
const STABLECOIN_ALLOWLIST_PATTERNS: RegExp[] = [
  /usd/i,          // USDC, USDT, PYUSD, sUSDe, syrupUSDC, sUSDS, ...
  /dai/i,
  /eur/i,          // EURC, EURCV
  /gbp/i,
];

/**
 * 추적 대상에서 제외할 자산이면 true.
 * (real-estate RWA + commodity RWA. stablecoin 은 항상 통과)
 */
export function isExcludedRwa(symbol: string, address: string): boolean {
  const addr = address.toLowerCase();
  if (EXCLUDED_ADDRESS_DENYLIST.has(addr)) return true;

  const sym = symbol ?? "";
  // stablecoin allowlist 우선
  if (STABLECOIN_ALLOWLIST_PATTERNS.some((re) => re.test(sym))) return false;

  if (REAL_ESTATE_SYMBOL_PATTERNS.some((re) => re.test(sym))) return true;
  if (COMMODITY_SYMBOL_PATTERNS.some((re) => re.test(sym))) return true;
  return false;
}

/** @deprecated isExcludedRwa 사용 — 하위호환 alias */
export const isRealEstateRwa = isExcludedRwa;
