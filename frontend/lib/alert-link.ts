/**
 * 알림 → 흐름맵 딥링크: 그 알림과 관련된 토큰들 + 해당 체인만 선택된 /flow URL 을 만든다.
 *  · 토큰: 알림의 token + detail 에 든 상대 토큰(loanAsset / loan_symbol / collateral*)
 *  · 체인: protocol_node_id 의 @chain → 그 체인 / detail.chain / 그 외엔 ethereum
 *    (홈 chainOf 와 같은 규칙 — 알림 테이블에 chain 컬럼이 없어 노드 id 접미사가 근거)
 */
export interface AlertLike {
  token: string;
  protocol_node_id?: string | null;
  detail?: Record<string, unknown> | null;
}

const SYM_RE = /^[A-Za-z0-9.\-+_]{2,24}$/;
const isUsable = (s: string | null | undefined): s is string => {
  const v = (s ?? "").trim();
  return v !== "" && v.toUpperCase() !== "UNKNOWN" && SYM_RE.test(v);
};

/** 체인 추정 — 모르면 null(흐름맵에서 chains 파라미터 생략). 'ethereum' 강제 디폴트는 멀티체인 토큰을 오핀. */
export function alertChain(a: AlertLike): string | null {
  const p = a.protocol_node_id ?? "";
  if (p.includes("@")) {
    const c = p.split("@")[1]?.toLowerCase();
    if (c) return c;
  }
  const dc = (a.detail as { chain?: unknown } | null | undefined)?.chain;
  if (typeof dc === "string" && dc) return dc.toLowerCase();
  return null;
}

export function alertFlowHref(a: AlertLike): string {
  const tokens: string[] = [];
  if (isUsable(a.token)) tokens.push(a.token); // token=UNKNOWN 이면 제외(빈 흐름맵 방지)
  const d = (a.detail ?? {}) as Record<string, unknown>;
  for (const k of ["loanAsset", "loan_symbol", "collateralAsset", "collateral_symbol"]) {
    const v = d[k];
    if (typeof v === "string" && isUsable(v) && !tokens.some((t) => t.toUpperCase() === v.toUpperCase())) tokens.push(v);
  }
  const chain = alertChain(a);
  const parts: string[] = [];
  if (tokens.length) parts.push(`tokens=${encodeURIComponent(tokens.join(","))}`);
  if (chain) parts.push(`chains=${encodeURIComponent(chain)}`);
  return `/flow${parts.length ? `?${parts.join("&")}` : ""}`;
}

// ─────────────────────────────────────────────────────────────
// 알림 → 관계맵 노드 위험색 매핑 (결정론적 순수 함수, 예측모델 아님)
//   엔진이 이미 판정해 DB 에 적재한 알림(dossier.alerts)을 관계맵 노드 id 에 결정적으로 얹는다.
//   매핑 근거는 데이터만: 알림의 protocol_node_id 슬러그 + 심각도. 추측·휴리스틱 없음.
// ─────────────────────────────────────────────────────────────

export type AlertRisk = "danger" | "caution";

export interface RiskAlertLike {
  severity: string;                 // critical | warning | info
  kind?: string | null;
  token?: string | null;            // 알림 대상 토큰 = 그 마켓의 담보 심볼(예: sUSDe). 담보 변별 조인키의 담보축.
  protocol_node_id?: string | null; // protocol:morpho_blue | protocol:aave_v3 | protocol:dl:sky-lending | protocol:drift@solana
  detail?: Record<string, unknown> | null; // loanAsset/lltv/collateral … — 마켓 단위 조인키 (엔진 적재분)
}

// 관계맵 노드 메타(위험색 매핑에 필요한 부분만). page.tsx 가 노드 metadata 에서 넘김.
//   _market = lego-overlay 가 만든 마켓 식별({...meta}) — collateral/loan 심볼 + collateralAddress/loanAddress(주소쌍 유일키) + lltv.
export interface RiskNodeLike {
  id: string;
  metadata?: { venue?: unknown; brandSlug?: unknown; _market?: unknown };
}

// critical→danger(빨강), warning→caution(노랑). info 는 색 없음(breadth 미검증 메모라 노드 위험 아님).
function sevToRisk(severity: string): AlertRisk | null {
  const s = severity.toLowerCase();
  if (s === "critical") return "danger";
  if (s === "warning") return "caution";
  return null;
}

// protocol_node_id → 비교용 canon 슬러그. `protocol:` / `dl:` 접두·`@chain` 접미 제거 후 `_`→`-`.
//   morpho_blue→morpho-blue, aave_v3→aave-v3, dl:sky-lending→sky-lending, drift@solana→drift.
function protoSlugOf(protocolNodeId: string | null | undefined): string | null {
  if (!protocolNodeId) return null;
  const base = protocolNodeId
    .replace(/^protocol:/, "")
    .replace(/^dl:/, "")
    .split("@")[0]
    .replace(/_/g, "-")
    .toLowerCase()
    .trim();
  if (!base) return null;
  return base === "sparklend" ? "spark" : base === "morphoblue" ? "morpho-blue" : base;
}

// 관계맵 노드 id/메타 → 그 노드의 프로토콜 canon 슬러그(있으면). 알림 슬러그와 대조용.
//   concentric 프로토콜 노드(c:{chain}:protocol:slug / c:{chain}:dl:proj@chain),
//   lego 마켓(legomkt:{proto}:..@chain), lego 합성 수용처/출처(lego-acc/-src:{chain}:{slug}),
//   metadata.venue/brandSlug 폴백.
function nodeProtoSlug(node: { id: string; metadata?: { venue?: unknown; brandSlug?: unknown } }): string | null {
  const id = node.id;
  let raw: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^c:[^:]+:protocol:([^@:]+)/.exec(id))) raw = m[1];
  else if ((m = /^c:[^:]+:dl:([^@:]+)/.exec(id))) raw = m[1];
  else if ((m = /^legomkt:([^:]+):/.exec(id))) raw = m[1];
  else if ((m = /^lego-(?:acc|src):[^:]+:(.+)$/.exec(id))) raw = m[1];
  if (!raw) {
    const v = (node.metadata?.brandSlug ?? node.metadata?.venue) as unknown;
    if (typeof v === "string" && v) raw = v;
  }
  return protoSlugOf(raw ? `protocol:${raw}` : null);
}

// ── 마켓 단위 조인키 ──────────────────────────────────────────
//   알림 detail(loanAsset+lltv)과 lego 마켓 노드 meta._market(loan+lltv)을 결정론적으로 조인한다.
//   같은 프로토콜이라도 알림이 가리킨 그 마켓(대출자산+LLTV 일치)만 위험색 — 비매칭 마켓은 안전색 유지.
//   추측 없음: detail·노드 양측에 실재하는 값만 정규화해 문자열 동치 비교.

/** 대출자산 심볼 정규화 — 대문자·공백제거(USDt0/usdt 대소문자·별칭 흡수는 정확일치 우선, 위험은 보수적). */
function normLoan(sym: unknown): string | null {
  if (typeof sym !== "string") return null;
  const s = sym.trim().toUpperCase();
  return s ? s : null;
}

/** LLTV 정규화 — 소수(0.915)·퍼센트(91.5)·wei("915000000000000000") 어느 표기든 소수 3자리 키("0.915"). */
function normLltv(v: unknown): string | null {
  let n: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) n = v;
  else if (typeof v === "string" && v.trim()) { const p = Number(v); if (Number.isFinite(p)) n = p; }
  if (n == null || n <= 0) return null;
  if (n >= 1e15) n = n / 1e18;   // wei 표기
  else if (n > 1.5) n = n / 100; // 퍼센트 표기(91.5 → 0.915)
  if (n <= 0 || n > 1) return null;
  return n.toFixed(3);
}

/** EVM 주소 정규화(소문자 0x40hex) — 주소쌍 유일키용. 아니면 null. */
function normAddr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? s : null;
}

/**
 * 알림 detail → 마켓 조인키들(가능한 것 전부). 강→약 순으로 시도:
 *   1) "a:{collAddr}|{loanAddr}" — 담보+대출 주소쌍(노드 id 와 동일한 유일키). 알림이 주소를 실으면 충돌 0.
 *   2) "{COLLATERAL}|{LOAN}|lltv3" — 담보 심볼(=알림 token)+대출 심볼+LLTV. 같은 loan|lltv 라도 담보가 다르면 갈린다
 *      (USDC|0.915 가 USDe·PT-USDe·sUSDe 6마켓 동시점등하던 충돌 제거 — 회장 작업2).
 * loanAsset/lltv 가 없으면(utilization 류) 빈 배열 → 슬러그 폴백으로 넘어간다.
 */
function alertMarketKeys(a: RiskAlertLike): string[] {
  const detail = a.detail ?? null;
  const keys: string[] = [];
  if (detail) {
    const collAddr = normAddr(detail.collateralAddress ?? detail.collateralAsset);
    const loanAddr = normAddr(detail.loanAddress ?? detail.loanAsset);
    if (collAddr && loanAddr) keys.push(`a:${collAddr}|${loanAddr}`);
    const loan = normLoan(detail.loanAsset ?? detail.loan_symbol ?? detail.loan);
    // maxLtv(utilization 류)는 마켓 LLTV 가 아니므로 조인키로 쓰지 않는다 — lltv 키만.
    const lltv = normLltv(detail.lltv);
    // 담보 = detail.collateral 우선, 없으면 알림 token(엔진은 담보 토큰 단위로 알림을 적재).
    const coll = normLoan(detail.collateral ?? detail.collateral_symbol ?? a.token);
    // 담보 정보 있으면 3중키("{COLL}|{LOAN}|lltv" — 동일 loan|lltv 다담보 충돌 제거), 없으면 2중키("{LOAN}|lltv").
    //   담보 미상 알림이 키를 못 만들면 슬러그 폴백으로 떨어져 비매칭 마켓까지 점등되므로 loan+lltv 로라도 조인.
    if (loan && lltv) keys.push(coll ? `${coll}|${loan}|${lltv}` : `${loan}|${lltv}`);
  }
  return keys;
}

/**
 * lego 마켓 노드 _market(meta) → 마켓 조인키들(가능한 것 전부). alertMarketKeys 와 같은 키공간.
 *   주소쌍("a:..") + 담보심볼 3중키("{COLL}|{LOAN}|lltv3"). 둘 다 만들어 알림 키 집합과 교집합으로 매칭.
 */
function nodeMarketKeys(node: RiskNodeLike): string[] {
  const m = node.metadata?._market as Record<string, unknown> | undefined;
  if (!m) return [];
  const keys: string[] = [];
  const collAddr = normAddr(m.collateralAddress);
  const loanAddr = normAddr(m.loanAddress);
  if (collAddr && loanAddr) keys.push(`a:${collAddr}|${loanAddr}`);
  const loan = normLoan(m.loan);
  const lltv = normLltv(m.lltv);
  const coll = normLoan(m.collateral);
  // alertMarketKeys 와 동일 규칙: 담보 있으면 3중키, 없으면 2중키("{LOAN}|lltv"). 키공간 일치로 교집합 매칭.
  if (loan && lltv) keys.push(coll ? `${coll}|${loan}|${lltv}` : `${loan}|${lltv}`);
  return keys;
}

/**
 * dossier.alerts → Map<nodeId, "danger"|"caution">. 한 노드에 여러 알림이면 danger 우선.
 *   1) 마켓 스코프(우선): 알림 detail(loanAsset+lltv)이 lego 마켓 노드 _market(loan+lltv)에 같은 프로토콜 안에서
 *      결정론적으로 조인되면 그 마켓 노드 + 그 마켓의 큐레이터 볼트 노드(id=`{mktId}:v{k}`)만 위험색.
 *      동일 프로토콜의 비매칭 마켓은 안전색 유지(의사결정 가치 복원 — 5/6 1순위 블로커).
 *   2) 슬러그 폴백: loanAsset/lltv 가 없어 마켓-식별 불가한 알림(utilization 류)에 한해 프로토콜 슬러그로
 *      그 프로토콜 노드 + 같은 슬러그 마켓 노드 전체에 위험색(기존 동작 보존 — 마켓을 못 집으면 프로토콜 단위).
 * 비결정 요소 없음: 같은 입력 → 같은 출력.
 */
export function mapAlertsToNodeRisk(
  alerts: RiskAlertLike[] | null | undefined,
  nodes: RiskNodeLike[],
): Map<string, AlertRisk> {
  const out = new Map<string, AlertRisk>();
  if (!alerts?.length) return out;

  // 마켓-식별 알림: (프로토콜슬러그 → (마켓키 → 최고심각도)). 비마켓 알림: 프로토콜슬러그 → 최고심각도(폴백).
  const byMarket = new Map<string, Map<string, AlertRisk>>();
  const bySlugFallback = new Map<string, AlertRisk>();
  for (const a of alerts) {
    const risk = sevToRisk(a.severity);
    if (!risk) continue;
    const slug = protoSlugOf(a.protocol_node_id);
    if (!slug) continue;
    const mktKeys = alertMarketKeys(a);
    if (mktKeys.length) {
      let m = byMarket.get(slug);
      if (!m) { m = new Map(); byMarket.set(slug, m); }
      for (const mktKey of mktKeys) {
        const prev = m.get(mktKey);
        if (prev !== "danger") m.set(mktKey, risk === "danger" ? "danger" : prev ?? risk);
      }
    } else {
      // 마켓-식별 불가 알림 → 프로토콜 슬러그 폴백
      const prev = bySlugFallback.get(slug);
      if (prev !== "danger") bySlugFallback.set(slug, risk === "danger" ? "danger" : prev ?? risk);
    }
  }
  if (!byMarket.size && !bySlugFallback.size) return out;

  const bump = (id: string, risk: AlertRisk) => {
    const prev = out.get(id);
    if (prev === "danger") return;
    out.set(id, risk === "danger" ? "danger" : prev ?? risk);
  };

  // 큐레이터 볼트 노드(id=`{mktId}:v{k}`)는 부모 마켓 위험을 따른다 — 마켓 id → 위험 매핑을 먼저 만든다.
  const marketRisk = new Map<string, AlertRisk>(); // 마켓 노드 id → 위험
  for (const n of nodes) {
    const slug = nodeProtoSlug(n);
    if (!slug) continue;
    const mktKeys = nodeMarketKeys(n);
    if (mktKeys.length) {
      // 이 노드는 마켓-식별 가능 노드. 같은 프로토콜의 마켓-식별 알림과 정확 조인(키 교집합)만 위험색.
      const perMkt = byMarket.get(slug);
      let r: AlertRisk | null = null;
      if (perMkt) for (const k of mktKeys) { const hit = perMkt.get(k); if (hit === "danger") { r = "danger"; break; } if (hit && !r) r = hit; }
      if (r) { bump(n.id, r); marketRisk.set(n.id, r); }
      // 마켓-식별 가능 노드는 슬러그 폴백을 적용하지 않는다(특정 마켓이 안 잡혔으면 안전 유지 — 변별력 보존).
      continue;
    }
    // 마켓키가 없는 노드(프로토콜 허브·풀형 마켓·loan/lltv 미상 마켓): 슬러그 폴백만.
    const fb = bySlugFallback.get(slug);
    if (fb) bump(n.id, fb);
  }

  // 큐레이터 볼트 노드: 부모 마켓이 위험이면 같이 위험(자금추적상 그 마켓에 공급한 볼트가 노출됨).
  if (marketRisk.size) {
    for (const n of nodes) {
      const m = /^(.+):v\d+$/.exec(n.id);
      if (!m) continue;
      const r = marketRisk.get(m[1]);
      if (r) bump(n.id, r);
    }
  }
  return out;
}
