/* Exposure Intelligence — 발표 덱 생성기 (pptxgenjs). 다크 리스크-대시보드 테마.
   실행: NODE_PATH=$(npm root -g) node presentation/build-deck.cjs */
const path = require("path");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const FA = require("react-icons/fa");

const ASSETS = path.join(__dirname, "assets");
const OUT = path.join(__dirname, "Exposure-Intelligence.pptx");

// ── 팔레트 (딥 네이비 지배 + 시안 액센트 + 시맨틱 리스크 컬러) ──
const C = {
  bg: "0B1020", bg2: "0E1426", card: "151D33", card2: "1B2540", border: "27324F",
  text: "F1F5F9", muted: "97A6C2", faint: "5E6E90",
  accent: "38BDF8", accent2: "22D3EE", purple: "A78BFA",
  danger: "FB4D6A", warn: "F5A524", ok: "29D08A",
};
const F = { title: "Trebuchet MS", body: "Calibri", mono: "Consolas" };
const W = 13.333, H = 7.5;
const shadow = () => ({ type: "outer", color: "000000", blur: 10, offset: 3, angle: 90, opacity: 0.35 });

const pres = new pptxgen();
pres.defineLayout({ name: "W", width: W, height: H });
pres.layout = "W";
pres.author = "Exposure Intelligence";
pres.title = "Exposure Intelligence";

// ── 아이콘 → base64 PNG ──
async function icon(name, color, size = 256) {
  const Comp = FA[name];
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color, size: String(size) }));
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}
const ICONS = {};
async function loadIcons() {
  const need = {
    sitemap: ["FaSitemap", C.accent], eyeslash: ["FaEyeSlash", C.warn], clock: ["FaBolt", C.danger],
    server: ["FaServer", C.accent], db: ["FaDatabase", C.accent2], desktop: ["FaDesktop", C.purple],
    net: ["FaNetworkWired", C.accent], layers: ["FaLayerGroup", C.accent2], stream: ["FaStream", C.purple],
    coins: ["FaCoins", C.accent], chart: ["FaChartLine", C.danger], contract: ["FaFileContract", C.warn], water: ["FaWater", C.accent2],
    check: ["FaCheckCircle", C.ok], eye: ["FaEye", C.accent], history: ["FaHistory", C.accent2],
    scale: ["FaBalanceScale", C.purple], plug: ["FaPlug", C.warn], search: ["FaSearch", C.accent],
    list: ["FaListOl", C.accent2], warn: ["FaExclamationTriangle", C.warn], fwd: ["FaForward", C.ok],
    shield: ["FaShieldAlt", C.accent], double: ["FaCheckDouble", C.ok],
  };
  for (const [k, [n, col]] of Object.entries(need)) ICONS[k] = await icon(n, col);
}

// ── 헬퍼 ──
function bg(s, color = C.bg) { s.background = { color }; }
function header(s, label, titleText, titleColor = C.text) {
  s.addText(label, { x: 0.6, y: 0.42, w: 12, h: 0.3, fontFace: F.mono, fontSize: 12, color: C.accent, charSpacing: 3, bold: true });
  s.addText(titleText, { x: 0.6, y: 0.74, w: 12.1, h: 0.85, fontFace: F.title, fontSize: 27, bold: true, color: titleColor });
}
function card(s, x, y, w, h, fill = C.card, line = C.border) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.09, fill: { color: fill }, line: { color: line, width: 1 }, shadow: shadow() });
}
function dot(s, x, y, color, d = 0.13) { s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color } }); }
function iconChip(s, x, y, color, key, d = 0.62) {
  s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: C.card2 }, line: { color, width: 1.25 } });
  s.addImage({ data: ICONS[key], x: x + d * 0.26, y: y + d * 0.26, w: d * 0.48, h: d * 0.48 });
}
function rings(s, cx, cy) {
  [3.3, 2.55, 1.8, 1.05].forEach((r, i) => s.addShape(pres.shapes.OVAL, {
    x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: C.bg, transparency: 100 },
    line: { color: i % 2 ? "1E2E52" : "223763", width: 1.25 },
  }));
  const nd = [[cx, cy - 3.3, C.accent], [cx + 2.55, cy, C.purple], [cx - 1.8, cy + 0.2, C.accent2], [cx + 1.1, cy + 1.05, C.warn], [cx - 1.0, cy - 1.55, C.accent], [cx + 1.7, cy - 1.9, C.purple], [cx - 2.4, cy + 1.7, C.danger]];
  nd.forEach(([x, y, c]) => dot(s, x - 0.07, y - 0.07, c, 0.16));
  dot(s, cx - 0.13, cy - 0.13, C.ok, 0.26);
}
function pill(s, x, y, w, txt, color) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h: 0.46, rectRadius: 0.23, fill: { color: C.card2 }, line: { color, width: 1.25 } });
  dot(s, x + 0.22, y + 0.165, color, 0.14);
  s.addText(txt, { x: x + 0.46, y, w: w - 0.5, h: 0.46, fontFace: F.mono, fontSize: 12.5, bold: true, color: C.text, valign: "middle" });
}

function build() {
  // ───────── 1. TITLE ─────────
  let s = pres.addSlide(); bg(s);
  rings(s, 10.7, 3.5);
  s.addText("CHAIN SPIRAL", { x: 0.6, y: 0.55, w: 6, h: 0.3, fontFace: F.mono, fontSize: 12, color: C.accent, charSpacing: 4, bold: true });
  s.addText([
    { text: "Exposure", options: { color: C.accent } },
    { text: " Intelligence", options: { color: C.text } },
  ], { x: 0.55, y: 2.35, w: 10, h: 1.1, fontFace: F.title, fontSize: 54, bold: true });
  s.addText("큐레이터 토큰 익스포저 매핑  +  결정론적 리스크 알림 엔진", { x: 0.6, y: 3.5, w: 9.5, h: 0.5, fontFace: F.body, fontSize: 20, color: C.muted });
  s.addText("“큐레이터가 토큰을 화이트리스트하기 전, 그 토큰의 모든 온체인 익스포저를 한 화면에서 실사한다.”",
    { x: 0.6, y: 4.15, w: 9.2, h: 0.5, fontFace: F.body, fontSize: 13.5, italic: true, color: C.faint });
  pill(s, 0.6, 5.15, 1.85, "tsc 0", C.ok);
  pill(s, 2.6, 5.15, 3.0, "backtest GREEN", C.ok);
  pill(s, 5.75, 5.15, 2.2, "build OK", C.ok);
  s.addText([
    { text: "Upside Academy · 두나무 × Theori", options: { breakLine: true } },
    { text: "멘토: Hyperithm VP  ·  2026-06-08", options: {} },
  ], { x: 0.6, y: 6.55, w: 9, h: 0.6, fontFace: F.mono, fontSize: 12, color: C.faint, lineSpacingMultiple: 1.2 });

  // ───────── 2. PROBLEM ─────────
  s = pres.addSlide(); bg(s);
  header(s, "문제 / PROBLEM", "큐레이터는 받기 전, 그 토큰을 다 볼 수 없다");
  const probs = [
    ["sitemap", "흩어진 익스포저", "한 토큰이 수십 개 프로토콜·체인·마켓·볼트에 담보/공급/LP로 분산"],
    ["eyeslash", "안 보이는 실사 포인트", "어디 박혔는지, 청산 바닥(LLTV)이 어딘지, 빠질 수 있는 유동성이 얼만지 한눈에 안 보임"],
    ["clock", "분 단위로 터지는 사고", "청산은 분 단위인데 실사는 수동·산발적 — 사후에야 안다"],
  ];
  probs.forEach((p, i) => {
    const y = 1.85 + i * 1.18;
    card(s, 0.6, y, 6.7, 1.02);
    iconChip(s, 0.85, y + 0.2, [C.accent, C.warn, C.danger][i], p[0]);
    s.addText(p[1], { x: 1.65, y: y + 0.13, w: 5.5, h: 0.34, fontFace: F.title, fontSize: 15, bold: true, color: C.text });
    s.addText(p[2], { x: 1.65, y: y + 0.46, w: 5.45, h: 0.5, fontFace: F.body, fontSize: 11.5, color: C.muted });
  });
  // 오른쪽: 실제 집중도 예시 (USDe)
  card(s, 7.6, 1.85, 5.13, 3.53, C.card);
  s.addText("실제 예 · USDe 익스포저 집중도", { x: 7.85, y: 2.05, w: 4.7, h: 0.35, fontFace: F.mono, fontSize: 12, bold: true, color: C.accent });
  s.addText([{ text: "HHI ", options: { fontSize: 20, color: C.muted } }, { text: "0.76", options: { fontSize: 40, color: C.danger, bold: true } }, { text: "  → 위험", options: { fontSize: 16, color: C.danger, bold: true } }],
    { x: 7.85, y: 2.4, w: 4.7, h: 0.8, fontFace: F.mono, valign: "middle" });
  const conc = [["Aave V3", 86, C.accent], ["Convex Finance", 12, C.purple], ["Fluid", 1, C.accent2]];
  conc.forEach((c, i) => {
    const y = 3.45 + i * 0.6;
    s.addText(c[0], { x: 7.85, y, w: 2.2, h: 0.32, fontFace: F.body, fontSize: 12, color: C.text, valign: "middle" });
    s.addShape(pres.shapes.RECTANGLE, { x: 9.8, y: y + 0.05, w: 2.55, h: 0.22, fill: { color: C.bg2 } });
    s.addShape(pres.shapes.RECTANGLE, { x: 9.8, y: y + 0.05, w: Math.max(0.06, 2.55 * c[1] / 100), h: 0.22, fill: { color: c[2] } });
    s.addText(c[1] + "%", { x: 12.0, y, w: 0.75, h: 0.32, fontFace: F.mono, fontSize: 11, color: C.muted, valign: "middle" });
  });
  s.addText("상위 1개 프로토콜이 86% — 단일 실패점.  이런 토큰이 watchlist에 62종.", { x: 0.6, y: 5.6, w: 12.1, h: 0.4, fontFace: F.body, fontSize: 12.5, italic: true, color: C.faint });

  // ───────── 3. SOLUTION ─────────
  s = pres.addSlide(); bg(s);
  header(s, "해법 / APPROACH", "시뮬레이터가 아니다 — 정확한 매핑 + 검증된 알림");
  const tiers = [
    ["1", C.danger, "위험한 놈인가?", ["총공급 · 24h 변화율", "디페그 여부", "집중도 (HHI / 상위 보유 %)", "토큰별 알림 히스토리 누적"]],
    ["2", C.warn, "어디 박혔나?", ["역할분포 (담보/공급/LP)", "빠질 수 있는 vs 잠긴 유동성", "오라클 분류 (시장가/NAV/하드코딩)", "LTV · LLTV 분포"]],
    ["3", C.accent, "심층 실사", ["마켓 단위 LTV · top borrowers", "크로스체인 분포 (브릿지)", "큐레이터별 risk profile", "최근 대형 입출금"]],
  ];
  tiers.forEach((t, i) => {
    const x = 0.6 + i * 4.11;
    card(s, x, 1.9, 3.85, 4.4);
    s.addShape(pres.shapes.OVAL, { x: x + 0.3, y: 2.2, w: 0.62, h: 0.62, fill: { color: C.card2 }, line: { color: t[1], width: 1.5 } });
    s.addText(t[0], { x: x + 0.3, y: 2.2, w: 0.62, h: 0.62, fontFace: F.title, fontSize: 26, bold: true, color: t[1], align: "center", valign: "middle" });
    s.addText("TIER " + t[0], { x: x + 1.05, y: 2.24, w: 2.6, h: 0.3, fontFace: F.mono, fontSize: 12, bold: true, color: t[1], charSpacing: 2 });
    s.addText(t[2], { x: x + 1.05, y: 2.5, w: 2.7, h: 0.4, fontFace: F.title, fontSize: 16, bold: true, color: C.text });
    s.addText(t[3].map((b, j) => ({ text: b, options: { bullet: { code: "2022", indent: 14 }, breakLine: true, color: C.muted, paraSpaceAfter: 8 } })),
      { x: x + 0.32, y: 3.25, w: 3.3, h: 2.9, fontFace: F.body, fontSize: 12.5 });
  });
  s.addText("= 큐레이터의 실사 순서  =  빌드 우선순위.  디페그 전염은 같은 데이터 위의 선택적 렌즈.", { x: 0.6, y: 6.5, w: 12.1, h: 0.4, fontFace: F.body, fontSize: 12.5, italic: true, color: C.faint });

  // ───────── 4. ARCHITECTURE ─────────
  s = pres.addSlide(); bg(s);
  header(s, "아키텍처 / ARCHITECTURE", "3-Tier · Zero-cost · DB가 source of truth");
  const arch = [
    ["server", "TIER 1 · automation", "Node 22 + tsx (TypeScript)", ["viem + Multicall3", "Morpho GraphQL · DeFiLlama", "9개 cron 루프 (기본 OFF)"], C.accent],
    ["db", "TIER 2 · Postgres", "TimescaleDB · :5433", ["nodes / edges 그래프", "시계열 hypertable (공급)", "alerts · bridge_authorities"], C.accent2],
    ["desktop", "TIER 3 · frontend", "Next.js 15 + React Flow", ["/api/* 가 pg 직독 (백엔드 X)", "동심원 익스포저 그래프", "Tier 0 판결 · at-risk 곡선"], C.purple],
  ];
  arch.forEach((a, i) => {
    const x = 0.6 + i * 4.33;
    card(s, x, 2.05, 3.85, 3.55);
    iconChip(s, x + 0.3, 2.32, a[4], a[0], 0.66);
    s.addText(a[1], { x: x + 1.1, y: 2.35, w: 2.6, h: 0.34, fontFace: F.title, fontSize: 14.5, bold: true, color: a[4] });
    s.addText(a[2], { x: x + 1.1, y: 2.68, w: 2.65, h: 0.3, fontFace: F.mono, fontSize: 10.5, color: C.muted });
    s.addText(a[3].map((b) => ({ text: b, options: { bullet: { code: "2022", indent: 12 }, breakLine: true, color: C.muted, paraSpaceAfter: 7 } })),
      { x: x + 0.32, y: 3.35, w: 3.35, h: 2.1, fontFace: F.body, fontSize: 12 });
  });
  // 화살표
  [4.45, 8.78].forEach((x, i) => {
    s.addShape(pres.shapes.LINE, { x, y: 3.75, w: 0.45, h: 0, line: { color: C.faint, width: 1.5, endArrowType: "triangle" } });
    s.addText(i ? "pg SELECT" : "pg INSERT", { x: x - 0.1, y: 3.85, w: 0.7, h: 0.25, fontFace: F.mono, fontSize: 8, color: C.faint, align: "center" });
  });
  s.addText("무료 RPC (Alchemy → publicnode) + 무료 API + 로컬 Postgres.  유료(holder/archive)·알림채널·공개배포는 전부 opt-in.",
    { x: 0.6, y: 5.95, w: 12.1, h: 0.5, fontFace: F.body, fontSize: 12.5, italic: true, color: C.faint });

  // ───────── 5. DATA ─────────
  s = pres.addSlide(); bg(s);
  header(s, "데이터 / COVERAGE", "멀티체인 · 정밀+breadth 2레이어 · 신뢰도 1급 노출");
  const stats = [["62", "active watchlist 토큰", C.accent], ["43+", "체인 (정밀 3 + breadth)", C.accent2], ["8", "프로토콜 어댑터", C.purple], ["237", "누적 알림", C.warn]];
  stats.forEach((st, i) => {
    const x = 0.6 + i * 3.07;
    card(s, x, 1.9, 2.82, 1.75);
    s.addText(st[0], { x: x + 0.2, y: 2.05, w: 2.45, h: 0.85, fontFace: F.mono, fontSize: 44, bold: true, color: st[2], align: "left" });
    s.addText(st[1], { x: x + 0.22, y: 2.95, w: 2.5, h: 0.55, fontFace: F.body, fontSize: 12, color: C.muted });
  });
  card(s, 0.6, 3.95, 6.0, 2.65);
  s.addText("3-레이어 데이터 소스", { x: 0.85, y: 4.15, w: 5.5, h: 0.35, fontFace: F.title, fontSize: 15, bold: true, color: C.text });
  [["정밀 (DB)", "온체인 검증 — viem/Multicall3 어댑터", C.accent], ["breadth (라이브)", "DeFiLlama 전 체인 풀 (검증 보완)", C.accent2], ["라이브 Morpho", "GraphQL — 마켓별 LLTV·큐레이터 볼트", C.purple]].forEach((r, i) => {
    const y = 4.6 + i * 0.62;
    dot(s, 0.9, y + 0.06, r[2], 0.16);
    s.addText(r[0], { x: 1.2, y, w: 2.0, h: 0.32, fontFace: F.mono, fontSize: 12, bold: true, color: C.text, valign: "middle" });
    s.addText(r[1], { x: 3.1, y, w: 3.4, h: 0.32, fontFace: F.body, fontSize: 11, color: C.muted, valign: "middle" });
  });
  card(s, 6.85, 3.95, 5.88, 2.65);
  s.addText("신뢰도를 UI에 1급 노출", { x: 7.1, y: 4.15, w: 5.4, h: 0.35, fontFace: F.title, fontSize: 15, bold: true, color: C.text });
  [["verified", "온체인 검증", "실선 ———", C.ok], ["estimated", "DeFiLlama breadth", "점선 - - -", C.warn], ["opaque", "DD 불가 (이름없는 볼트)", "점점선 · · ·", C.faint]].forEach((r, i) => {
    const y = 4.6 + i * 0.62;
    s.addText(r[2], { x: 7.1, y, w: 1.5, h: 0.32, fontFace: F.mono, fontSize: 12, bold: true, color: r[3], valign: "middle" });
    s.addText(r[0], { x: 8.7, y, w: 1.6, h: 0.32, fontFace: F.mono, fontSize: 12, bold: true, color: C.text, valign: "middle" });
    s.addText(r[1], { x: 10.2, y, w: 2.4, h: 0.32, fontFace: F.body, fontSize: 10.5, color: C.muted, valign: "middle" });
  });

  // ───────── 6. ENGINE ─────────
  s = pres.addSlide(); bg(s);
  header(s, "엔진 / DETECTION", "결정론적 리스크 탐지 — 28종 알림 · 자산클래스별 임계");
  const cats = [
    ["coins", "민팅 / 공급", "Detector A(무담보 backing) · B(무담보민팅) · supply spike · 가치드리프트(NAV×supply)", C.accent],
    ["chart", "디페깅", "depeg(부호 인식) · bad debt 임계", C.danger],
    ["contract", "컨트랙트", "오라클/IRM/마켓 변경 · 하드코딩 오라클 전환 · 신규마켓/담보채택", C.warn],
    ["water", "유동성", "utilization · liquidity drop · whale unwind · curator derisk · wallet drop", C.accent2],
  ];
  cats.forEach((c, i) => {
    const y = 1.9 + i * 1.07;
    card(s, 0.6, y, 6.5, 0.92);
    iconChip(s, 0.82, y + 0.16, c[3], c[0], 0.6);
    s.addText(c[1], { x: 1.6, y: y + 0.12, w: 5.2, h: 0.32, fontFace: F.title, fontSize: 14, bold: true, color: c[3] });
    s.addText(c[2], { x: 1.6, y: y + 0.44, w: 5.35, h: 0.42, fontFace: F.body, fontSize: 10.5, color: C.muted });
  });
  // 실데이터 차트
  card(s, 7.4, 1.9, 5.33, 3.55);
  s.addText("라이브 발화 분포 (237건)", { x: 7.65, y: 2.05, w: 4.9, h: 0.35, fontFace: F.title, fontSize: 14, bold: true, color: C.text });
  s.addChart(pres.charts.BAR, [{
    name: "alerts",
    labels: ["liquidity_drop", "unverified_large", "high_util", "collateral_adopt", "util_jump", "supply_spike"],
    values: [78, 31, 30, 24, 19, 17],
  }], {
    x: 7.5, y: 2.45, w: 5.1, h: 2.9, barDir: "bar",
    chartColors: [C.accent], chartArea: { fill: { color: C.card } }, plotArea: { fill: { color: C.card } },
    catAxisLabelColor: C.muted, valAxisLabelColor: C.faint, catAxisLabelFontFace: F.mono, catAxisLabelFontSize: 8.5,
    valAxisLabelFontSize: 8, valGridLine: { color: "20304F", size: 0.5 }, catGridLine: { style: "none" },
    showValue: true, dataLabelColor: C.text, dataLabelFontFace: F.mono, dataLabelFontSize: 9, dataLabelPosition: "outEnd",
    showLegend: false, showTitle: false, valAxisHidden: true, barGapWidthPct: 40,
  });
  s.addText("7 자산클래스 (major/stable/stable_soft/pendle_pt/lst/rwa/altcoin) — 클래스별 디페그 band·오라클 heartbeat.  모든 임계값은 config 한 곳, 백테스트로 보정.",
    { x: 0.6, y: 6.25, w: 12.1, h: 0.7, fontFace: F.body, fontSize: 12, italic: true, color: C.faint });

  // ───────── 7. BACKTEST (trust) ─────────
  s = pres.addSlide(); bg(s, C.bg2);
  s.addText("검증 / BACKTEST", { x: 0.6, y: 0.42, w: 12, h: 0.3, fontFace: F.mono, fontSize: 12, color: C.ok, charSpacing: 3, bold: true });
  s.addText("라벨된 과거 사건을 production 알림 함수에 결정론 replay", { x: 0.6, y: 0.74, w: 12.1, h: 0.7, fontFace: F.title, fontSize: 27, bold: true, color: C.text });
  // GREEN 배지
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 1.95, w: 3.3, h: 1.9, rectRadius: 0.12, fill: { color: "0C2A20" }, line: { color: C.ok, width: 1.5 }, shadow: shadow() });
  dot(s, 1.0, 2.45, C.ok, 0.4);
  s.addText("GREEN", { x: 1.5, y: 2.3, w: 2.3, h: 0.7, fontFace: F.title, fontSize: 34, bold: true, color: C.ok, valign: "middle" });
  s.addText("회귀 통과", { x: 0.85, y: 3.15, w: 2.8, h: 0.5, fontFace: F.body, fontSize: 13, color: C.muted });
  const bts = [["100%", "recall (FN 0)", C.ok], ["0%", "FP rate (FORBIDDEN 0)", C.ok], ["67", "구동 case PASS", C.accent]];
  bts.forEach((b, i) => {
    const x = 4.2 + i * 2.92;
    card(s, x, 1.95, 2.72, 1.9, C.card);
    s.addText(b[0], { x: x + 0.2, y: 2.15, w: 2.35, h: 0.95, fontFace: F.mono, fontSize: 40, bold: true, color: b[2] });
    s.addText(b[1], { x: x + 0.22, y: 3.12, w: 2.4, h: 0.55, fontFace: F.body, fontSize: 12, color: C.muted });
  });
  card(s, 0.6, 4.25, 12.13, 2.3);
  s.addText("35 사건 / 81 case  ·  구동채점 67  ·  미구동 14 · 부분커버 4 (입력 없는 신호는 정직하게 채점 제외)", { x: 0.85, y: 4.45, w: 11.6, h: 0.4, fontFace: F.mono, fontSize: 12.5, bold: true, color: C.text });
  s.addText("구동 신호", { x: 0.85, y: 4.95, w: 3, h: 0.3, fontFace: F.body, fontSize: 11, color: C.faint });
  ["DEPEG", "LARGE_SINGLE_MINT", "TOTAL_SUPPLY_SPIKE", "UNMATCHED_MINT", "UNBACKED_SUPPLY"].forEach((sig, i) => {
    const x = 0.85 + (i % 5) * 2.36;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 5.3, w: 2.2, h: 0.42, rectRadius: 0.21, fill: { color: C.card2 }, line: { color: C.border, width: 1 } });
    s.addText(sig, { x, y: 5.3, w: 2.2, h: 0.42, fontFace: F.mono, fontSize: 9.5, color: C.accent, align: "center", valign: "middle" });
  });
  s.addText("LLM 아님 — 결정론. 임계값을 바꾸면 여기서 회귀가 잡힌다.", { x: 0.85, y: 5.95, w: 11.5, h: 0.4, fontFace: F.body, fontSize: 12.5, italic: true, color: C.muted });

  // ───────── 8. SCREENSHOT (token) ─────────
  s = pres.addSlide(); bg(s);
  header(s, "제품 / IN ACTION", "/token/USDe — 하나의 토큰으로 끝내는 실사");
  s.addShape(pres.shapes.RECTANGLE, { x: 0.97, y: 1.68, w: 11.4, h: 5.18, fill: { color: "070A12" }, line: { color: C.border, width: 1 }, shadow: shadow() });
  s.addImage({ path: path.join(ASSETS, "token-usde.png"), x: 1.02, y: 1.73, w: 11.3, h: 5.08 });
  s.addText([
    { text: "①  Tier 0 판결 (위험/주의/안전)", options: { color: C.danger, breakLine: false } },
    { text: "      ②  체인별 동심원 익스포저 맵", options: { color: C.accent, breakLine: false } },
    { text: "      ③  실시간 알림 dossier (DB 실데이터)", options: { color: C.accent2 } },
  ], { x: 0.97, y: 6.92, w: 11.5, h: 0.4, fontFace: F.mono, fontSize: 11.5, bold: true, align: "center" });

  // ───────── 9. DIFFERENTIATORS ─────────
  s = pres.addSlide(); bg(s);
  header(s, "차별점 / EDGE", "정직성과 누적이 만드는 해자");
  const diffs = [
    ["eye", "정직성을 1급으로", "verified/estimated/opaque 신뢰도를 UI에 노출. 모르는 건 모른다고 표시.", C.accent],
    ["history", "알림 히스토리 누적", "토큰별 위험史가 우리 DB에 쌓임 — 외부 검색 없이, 거의 공짜인 차별점.", C.accent2],
    ["scale", "RWA 디스카운트 구분", "mF-ONE류 의도적 NAV 디스카운트는 정상으로. 비-RWA 고정 오라클은 여전히 위험.", C.purple],
    ["plug", "2개 외부 알고리즘 seam", "위험알림·자금추적을 계약(source/스키마) 뒤에 꽂아 provider만 교체 — UI 무변경.", C.warn],
  ];
  diffs.forEach((d, i) => {
    const x = 0.6 + (i % 2) * 6.16, y = 1.95 + Math.floor(i / 2) * 2.3;
    card(s, x, y, 5.95, 2.05);
    iconChip(s, x + 0.32, y + 0.32, d[3], d[0], 0.72);
    s.addText(d[1], { x: x + 1.3, y: y + 0.35, w: 4.4, h: 0.45, fontFace: F.title, fontSize: 16.5, bold: true, color: C.text });
    s.addText(d[2], { x: x + 1.3, y: y + 0.92, w: 4.45, h: 0.95, fontFace: F.body, fontSize: 12.5, color: C.muted });
  });

  // ───────── 10. DEMO FLOW ─────────
  s = pres.addSlide(); bg(s);
  header(s, "데모 / 5분", "데모 시나리오");
  s.addShape(pres.shapes.RECTANGLE, { x: 0.57, y: 1.83, w: 6.04, h: 4.46, fill: { color: "070A12" }, line: { color: C.border, width: 1 }, shadow: shadow() });
  s.addImage({ path: path.join(ASSETS, "landing.png"), x: 0.6, y: 1.86, sizing: { type: "cover", w: 5.98, h: 4.4 } });
  const steps = [
    ["랜딩 개요", "토큰 익스포저 랭킹($26B USDC…) + 실시간 알림 피드"],
    ["검색 → /token/USDe", "Tier 0 판결 위험 (HHI 0.76 · critical 2)"],
    ["동심원 그래프", "체인별 익스포저 (Aave 86%/Convex/Fluid) · 마켓·큐레이터 토글"],
    ["알림 dossier", "실데이터 — new market(LLTV 91.5%)·liquidity drop·담보채택"],
    ["/multi 비교", "여러 토큰이 공유하는 프로토콜 = 상관위험"],
  ];
  steps.forEach((st, i) => {
    const y = 1.95 + i * 0.92;
    s.addShape(pres.shapes.OVAL, { x: 6.95, y: y + 0.05, w: 0.5, h: 0.5, fill: { color: C.card2 }, line: { color: C.accent, width: 1.5 } });
    s.addText(String(i + 1), { x: 6.95, y: y + 0.05, w: 0.5, h: 0.5, fontFace: F.title, fontSize: 18, bold: true, color: C.accent, align: "center", valign: "middle" });
    s.addText(st[0], { x: 7.65, y: y - 0.02, w: 5.1, h: 0.35, fontFace: F.title, fontSize: 14.5, bold: true, color: C.text });
    s.addText(st[1], { x: 7.65, y: y + 0.32, w: 5.15, h: 0.5, fontFace: F.body, fontSize: 11, color: C.muted });
  });

  // ───────── 11. LIMITS ─────────
  s = pres.addSlide(); bg(s);
  header(s, "한계 / HONESTY", "지금 안 하는 것, 그리고 다음");
  card(s, 0.6, 1.95, 6.0, 4.3);
  iconChip(s, 0.85, 2.2, C.warn, "warn", 0.6);
  s.addText("한계 (현재)", { x: 1.62, y: 2.28, w: 4.5, h: 0.4, fontFace: F.title, fontSize: 17, bold: true, color: C.warn });
  s.addText([
    "Detector A 라이브 활성은 lock&mint(xERC20 lockbox) 토큰 필요 — 현 위험토큰 9종은 burn&mint/CDP → Detector B+디페그+가치드리프트가 커버",
    "가치드리프트·mintburn·backing은 백테스트 검증됨, 라이브 발화 0 (트리거 조건 미충족) — 정직 표기",
    "그래프-스테이트 타임라인 스크럽 deferred (공급/알림 시계열은 있음, 그래프 영속화 선행)",
  ].map((b) => ({ text: b, options: { bullet: { code: "2022", indent: 14 }, breakLine: true, color: C.muted, paraSpaceAfter: 12 } })),
    { x: 0.85, y: 2.95, w: 5.5, h: 3.1, fontFace: F.body, fontSize: 12 });
  card(s, 6.75, 1.95, 5.98, 4.3);
  iconChip(s, 7.0, 2.2, C.ok, "fwd", 0.6);
  s.addText("다음 (후속)", { x: 7.77, y: 2.28, w: 4.5, h: 0.4, fontFace: F.title, fontSize: 17, bold: true, color: C.ok });
  s.addText([
    "2개 외부 알고리즘(위험알림·자금추적) 통합 — seam은 이미 구축, provider만 교체",
    "IRM 곡선(target utilization) 보완 (낮은 가치)",
    "실전 알림 채널 (Discord/Telegram) opt-in 전환",
  ].map((b) => ({ text: b, options: { bullet: { code: "2022", indent: 14 }, breakLine: true, color: C.muted, paraSpaceAfter: 12 } })),
    { x: 7.0, y: 2.95, w: 5.5, h: 2.3, fontFace: F.body, fontSize: 12 });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 7.0, y: 5.45, w: 5.5, h: 0.62, rectRadius: 0.1, fill: { color: "2A1622" }, line: { color: C.danger, width: 1 } });
  s.addText([{ text: "WON'T  ", options: { color: C.danger, bold: true } }, { text: "정량적 전염 시뮬레이션 — attic/ 격리 (스코프 밖)", options: { color: C.muted } }],
    { x: 7.2, y: 5.45, w: 5.2, h: 0.62, fontFace: F.body, fontSize: 11.5, valign: "middle" });

  // ───────── 12. CLOSING ─────────
  s = pres.addSlide(); bg(s);
  rings(s, 1.7, 3.7);
  s.addText("검증된 상태로 마무리", { x: 5.4, y: 2.1, w: 7.5, h: 0.9, fontFace: F.title, fontSize: 40, bold: true, color: C.text });
  s.addText("정확한 멀티체인 익스포저 매핑 위에,\n결정론적이고 백테스트로 검증된 리스크 알림.", { x: 5.4, y: 3.15, w: 7.5, h: 0.9, fontFace: F.body, fontSize: 16, color: C.muted, lineSpacingMultiple: 1.2 });
  pill(s, 5.4, 4.35, 2.0, "tsc 0", C.ok);
  pill(s, 7.55, 4.35, 4.6, "backtest GREEN · recall 100% / FP 0%", C.ok);
  pill(s, 5.4, 4.95, 2.4, "prod build OK", C.ok);
  s.addText("Exposure Intelligence  ·  Chain Spiral", { x: 5.4, y: 6.6, w: 7.5, h: 0.35, fontFace: F.mono, fontSize: 12, color: C.faint });

  return pres.writeFile({ fileName: OUT });
}

loadIcons().then(build).then(() => console.log("WROTE", OUT)).catch((e) => { console.error(e); process.exit(1); });
