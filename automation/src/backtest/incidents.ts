/**
 * 백테스트 사건 레지스트리 — fork 백테스트가 재생할 과거 해킹/디페그 사건.
 *
 * 설계(2026-06 재작성): 종전 하니스는 손으로 캡처한 snapshot JSON 픽스처를 replay 했다. 신규 하니스는
 *   **실제 사건 블록으로 fork(아카이브 히스토리컬 읽기)** 해서, 그 시점 온체인 상태(공급·가격·…)를
 *   프로덕션 데이터 캡처 그대로 읽고 프로덕션 디텍터를 그대로 돌린다. 픽스처 불필요 — 라이브 재현.
 *
 * ⚠️ 사건은 **최근(2024~2026)** 만. 너무 옛날 사건은 당시 토큰/프로토콜 주소·동작이 지금과 달라 현재 모니터링
 *   로직 검증에 부적합(사용자 제약 2026-06). 그래서 2021 PAID·2023 SVB 등은 제외.
 *
 * 각 사건은 **poll 타임스탬프 시퀀스**로 정의(블록은 reader 가 ts→block 으로 해석). 보통 baseline(사건 전,
 *   peg 정상·공급 정상) + event(트러프/사건 시점)로 구성 — baseline 이 priceBaseline/공급 baseline 을 깔고
 *   event poll 에서 위험 신호가 발화해야 한다. baseline poll 은 동시에 "정상상태 미발화" FP 체크가 된다.
 */

export type Severity = "info" | "warning" | "critical";
export type PollRole = "baseline" | "event" | "mid" | "recovery" | "snapshot";

export interface Poll {
  /** ISO8601 UTC — reader 가 이 시각의 체인 블록을 해석해 그 시점 상태를 읽는다. */
  at: string;
  role: PollRole;
}

/** 5분 간격 스냅샷 윈도 — 프로덕션 cron(5분)과 동일 주기로 사건 핵심 구간을 촘촘히 fork. */
export interface SnapshotWindow {
  from: string;   // ISO8601 UTC
  to: string;     // ISO8601 UTC
  stepMin?: number; // 기본 5분
}

export interface ExpectSignal {
  kind: string;            // 디텍터 발화 kind (depeg · supply_single_mint · supply_spike · value_drift · supply_conservation)
  minSeverity: Severity;   // 이 이상으로 떠야 "기대대로". 더 낮게 떠도 '발화는 함'(CALIB)으로 detected 인정.
}

export interface Incident {
  id: string;              // backtest/events/<id> 와 일치(있으면)
  name: string;
  chain: "ethereum" | "base" | "arbitrum";
  /** 헤더 표시용 체인(framing). 토큰 read 는 chain 으로 하되, 사건 framing 이 다른 체인이면 헤더만 displayChain 으로.
   *  예: rsETH 는 arb rep(arbitrum)을 읽어 대량 민트를 잡지만, 사건의 본질은 **메인넷 escrow 드레인**이라 헤더는 ethereum. */
  displayChain?: "ethereum" | "base" | "arbitrum";
  token: { address: `0x${string}`; symbol: string };
  category: "depeg" | "supply_mint" | "value_outflow" | "unbacked_xchain" | "control";
  /** 5분 간격 스냅샷 윈도(사건 핵심 구간). window 가 있으면 5분 폴 자동생성(권장). */
  window?: SnapshotWindow;
  /** value_drift(자금유출) 사건용 — 사건 한참 전 정상상태 1점(peak 기준선). window 폴 앞에 prepend. */
  baselineAt?: string;
  /** window 없을 때만 사용하는 명시 폴(레거시/특수). window 우선. */
  polls?: Poll[];
  expect: ExpectSignal[];      // control 은 빈 배열. 하나라도 발화하면 detected.
  mustNotFire?: string[];      // control: 이 kind 들이 어느 poll 에서도 warning+ 로 뜨면 실패
  note: string;
  /** 교차체인 무담보 발행(supply_conservation) 입력 — escrow(홈 lockbox 에 잠긴 canonical=backing) vs Σremote 불변식.
   *  매 poll 마다 escrow balanceOf(canonical)@홈블록 + 각 remote totalSupply@그체인블록 을 읽어 evaluateBacking 구동. */
  conservation?: {
    canonical: `0x${string}`;
    decimals: number;
    escrow: `0x${string}`;     // 홈(ethereum) lockbox/OFT adapter — 잠긴 canonical = 정당 backing
    remotes: { chain: "ethereum" | "base" | "arbitrum"; token: `0x${string}` }[]; // 아카이브 읽기 가능 체인만
    tolBps?: number;
    /** 무담보 발행/escrow 드레인 tx — 알림을 이 원인 tx 로 바로가기(블록 대신). 무담보 규모 = baseline escrow − 현재 escrow(드레인). */
    attackTx?: `0x${string}`;
    /** 드레인 체인(attackTx 가 실행된 체인) — 미지정 시 ethereum(홈). */
    attackChain?: "ethereum" | "base" | "arbitrum";
  };
  /** 연관 시장(contagion) — 사건 토큰 외에 전파된 위험. 사건 시점 Aave 마켓 가동률을 읽어 연관 토큰 알림 발화 →
   *  "관련 없어 보이는 토큰의 의존성"을 시각화. 예: rsETH 무담보→bad debt 우려→WETH/USDC/USDT 인출러시 util 100%. */
  relatedMarkets?: {
    protocol: string;            // "aave_v3"
    pool: `0x${string}`;         // Aave V3 Pool (ethereum)
    tokens: { symbol: string; address: `0x${string}` }[];
  }[];
  /** 연관 토큰(contagion) — 사건 토큰의 부실이 **다른 토큰으로 전파**되는 의존성. 매 poll 마다 그 토큰의 가격/공급을
   *  fork 읽어 프로덕션 depeg 디텍터를 그대로 돌린다 → "관련 없어 보이는 토큰"이 동반 디페그하는 걸 타임라인에 보여준다.
   *  예: Stream xUSD 무담보 폭로 → Elixir 가 deUSD 준비금 65%($68M)를 Stream 에 xUSD 담보로 대출 → deUSD 동반 붕괴. */
  relatedTokens?: {
    symbol: string;
    address: `0x${string}`;
    chain: "ethereum" | "base" | "arbitrum";
    cause: string;               // 의존성(왜 전파됐나) — 알림 메시지에 명시
  }[];
  /** V4 가격 풀 — Uni V3/V2 풀이 없고 coins.llama 도 (죽은 토큰이라) pruning 한 토큰(예: Stream xUSD)의 **온체인 시장가**를
   *  Uniswap V4(싱글톤) StateView 로 직접 산출. 붕괴가가 온체인서 readable. poolId·quote(USDC 등)·quote decimals. */
  priceV4Pool?: { poolId: `0x${string}`; quote: `0x${string}`; quoteDecimals: number; quoteUsd?: number };
}

// 최근 사건(2024~2026) 9개 — 전부 실사건(웹+온체인 검증, 2026-06). 디페그 5(USD0++·FDUSD·sUSD·xUSD·USR) ·
//   자금유출/공급붕괴 3(mkUSD·reUSD·deUSD) · 교차체인 무단발행 1(rsETH). 정상 대조군(USDC-organic·crvUSD)은 삭제됨.
export const INCIDENTS: Incident[] = [
  // ───────────── DEPEG ─────────────
  {
    id: "2024-03-28-mkUSD-prisma-exploit-depeg",
    name: "mkUSD — Prisma 익스플로잇 · 공급/TVL 붕괴 (2024-03)",
    chain: "ethereum",
    token: { address: "0x4591DBfF62656E7859Afe5e45f6f47D3669fBB28", symbol: "mkUSD" },
    category: "value_outflow",
    baselineAt: "2024-03-20T00:00:00Z", // 정상 peak(기준선)
    window: { from: "2024-03-28T04:00:00Z", to: "2024-03-28T12:00:00Z" }, // 5분 간격 · 익스플로잇 리뎀션 급락 구간
    // ⚠️ 웹검증(2026-06): 2024-03-28 Prisma 익스플로잇은 mkUSD 가격을 ~$0.99(−1%)만 떨궜다(디페그 아님). 진짜 피해는
    //   TVL −40%·대량 리뎀션 = **공급 붕괴**(value_drift). 가격은 페그 근처 유지라 depeg 미발화가 정상.
    expect: [{ kind: "value_drift", minSeverity: "warning" }],
    note: "Prisma 익스플로잇(~$11.6M) → mkUSD 대량 리뎀션·TVL −40%(공급 붕괴). 가격은 ~$0.99 유지 → value_drift 로 포착(디페그 아님).",
  },
  {
    id: "2025-01-10-USD0PP-depeg",
    name: "USD0++ — 거버넌스 유발 본드 디페그 (2025-01)",
    chain: "ethereum",
    token: { address: "0x35D8949372D46B7a3D5A56006AE77B215fc69bC0", symbol: "USD0++" },
    category: "depeg",
    window: { from: "2025-01-10T11:00:00Z", to: "2025-01-10T16:00:00Z" }, // 5분 간격 · 디페그 onset~트러프
    expect: [{ kind: "depeg", minSeverity: "warning" }],
    note: "USD0++ floor 재설정으로 ~8–11% 디페그.",
  },
  {
    id: "2025-04-02-FDUSD-confidence-depeg",
    name: "FDUSD — 신뢰 디페그 (2025-04)",
    chain: "ethereum",
    token: { address: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", symbol: "FDUSD" },
    category: "depeg",
    window: { from: "2025-04-02T13:00:00Z", to: "2025-04-02T18:00:00Z" }, // 5분 간격 · 인트라데이 트러프(~16:00 $0.945) 포함
    expect: [{ kind: "depeg", minSeverity: "warning" }],
    note: "FDUSD 발행사 지급능력 루머(Justin Sun)로 인트라데이 디페그. 실제 CEX 트러프 ~$0.87(−13%)이나 coins.llama 블렌디드 가격은 ~$0.945(−5.5%)까지만 — 표시는 보수적(피드 한계, 부풀리지 않음).",
  },
  {
    id: "2025-04-18-sUSD-incentive-depeg",
    name: "sUSD — Synthetix 인센티브 디페그 (2025-04)",
    chain: "ethereum",
    token: { address: "0x57Ab1ec28D129707052df4dF418D58a2D46d5f51", symbol: "sUSD" },
    category: "depeg",
    window: { from: "2025-04-18T09:00:00Z", to: "2025-04-18T14:00:00Z" }, // 5분 간격 · 깊은 디페그 구간
    expect: [{ kind: "depeg", minSeverity: "warning" }],
    // 웹검증(2026-06): SIP-420(C-ratio 750→200%)로 peg 방어 인센티브 소멸 → 04-18 실측 ~$0.66대(−32%, 사상 최대·최장 디페그). 익스플로잇 아닌 설계 결함.
    note: "Synthetix SIP-420(담보비율 인하)로 peg 방어 붕괴 → sUSD 04-18 ~$0.66(−32%) 디페그. 해킹 아닌 메커니즘 설계 결함.",
  },
  {
    id: "2025-06-26-Resupply-reUSD-erc4626-oracle",
    name: "Resupply reUSD — ERC4626 오라클 익스플로잇 (2025-06)",
    chain: "ethereum",
    token: { address: "0x57aB1E0003F623289CD798B1824Be09a793e4Bec", symbol: "reUSD" },
    category: "depeg",
    baselineAt: "2025-06-24T00:00:00Z", // 정상 peak(기준선)
    window: { from: "2025-06-26T05:00:00Z", to: "2025-06-26T13:00:00Z" }, // 5분 간격 · 익스플로잇 후 리뎀션 급락
    // 오라클 익스플로잇 후 대량 redeem(공급 −32%) → value_drift, 또는 디페그.
    expect: [{ kind: "depeg", minSeverity: "warning" }, { kind: "value_drift", minSeverity: "warning" }],
    note: "Resupply reUSD ERC4626 오라클 조작 익스플로잇 → 디페그 + 대량 리뎀션(공급 붕괴).",
  },

  // ───────────── VALUE OUTFLOW / UNBACKED ─────────────
  {
    id: "2025-11-04-xUSD-unbacked",
    name: "Stream xUSD — 무담보 폭로 + 디페그 → deUSD 전염 (2025-11)",
    chain: "ethereum",
    token: { address: "0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94", symbol: "xUSD" },
    category: "value_outflow",
    // ⚠️ 다일(多日) contagion 사건 — 윈도를 4일로 잡아 xUSD 점진 디페그(11-03~04)와 **deUSD 동반 붕괴(11-06~07)** 를
    //   한 타임라인에 담는다. 5분이면 1000+ poll → 30분 간격(≤230). 점진 심화는 일 단위 하강으로 충분히 보임.
    //   웹검증(2026-06): 외부 펀드매니저 ~$93M 손실 → 11-03 ~18:00 인출지연·디페그 시작 → 11-04 ~$0.43→~$0.26 → 11-08 ~$0.10.
    baselineAt: "2025-11-03T12:00:00Z", // 정상(xUSD≈$1, deUSD≈$1)
    window: { from: "2025-11-03T18:00:00Z", to: "2025-11-07T12:00:00Z", stepMin: 30 },
    expect: [{ kind: "depeg", minSeverity: "warning" }],
    note: "Stream Finance 무담보(~$93M off-chain 손실) 폭로 → xUSD 점진 디페그($1→~$0.10, −90%). Elixir 가 deUSD 준비금 65%($68M)를 Stream 에 xUSD 담보로 대출 → 2~3일 뒤 deUSD 동반 붕괴(~$0.03).",
    // contagion — xUSD 부실이 **다른 스테이블 deUSD 로 전파**(순환 의존: deUSD backing 의 65% 가 Stream 대출, 담보가 xUSD).
    //   xUSD 붕괴 → 그 담보·대출이 휴지 → deUSD 가 며칠 뒤 ~$0.03 으로 동반 붕괴. "관련 없어 보이는 스테이블의 의존성".
    relatedTokens: [
      { symbol: "deUSD", address: "0x15700B564Ca08D9439C58cA5053166E8317aa138", chain: "ethereum",
        cause: "Elixir deUSD 준비금 65%($68M)를 Stream 에 xUSD 담보로 대출 → 동반 부실" },
    ],
    // xUSD 온체인 가격 — Uni V3/V2 풀 없음 + coins.llama 가 죽은 토큰 pruning → Uniswap V4 USDC/xUSD 10% 풀(StateView)에서
    //   직접 산출. 이 풀은 11-04~07 유동성 보유: 실측 $0.32(11-04)→$0.18(11-05)→$0.10(11-07) 붕괴가 온체인서 readable.
    priceV4Pool: { poolId: "0x0b5f7d1d0e10846429e3981aa99a04126931d90eb86858dd316a262f3125ae8a", quote: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", quoteDecimals: 6, quoteUsd: 1 },
  },
  {
    id: "2025-11-07-deUSD-redemption-run",
    name: "Elixir deUSD — 리뎀션 런 + 공급 붕괴 (2025-11)",
    chain: "ethereum",
    token: { address: "0x15700B564Ca08D9439C58cA5053166E8317aa138", symbol: "deUSD" },
    category: "value_outflow",
    baselineAt: "2025-10-25T00:00:00Z", // 정상 peak(기준선, 풀 공급)
    window: { from: "2025-11-06T06:00:00Z", to: "2025-11-06T16:00:00Z" }, // 5분 간격 · 리뎀션 런 공급붕괴 구간
    expect: [{ kind: "value_drift", minSeverity: "warning" }],
    note: "Stream 손실 노출로 deUSD 대량 리뎀션 런 — 공급 units 붕괴(가격 마크다운 아닌 실유출). 표시 −38%는 런 초기 신호; 최종은 ~80% 상환·가격 ~$0.03(−98%, 사후) — Elixir 가 deUSD 준비금 65%($68M)를 Stream 에 노출.",
  },

  // ───────────── 민트 권한 탈취 ─────────────
  {
    id: "2026-03-22-USR-compromised-mint-depeg",
    name: "Resolv USR — 가격 붕괴/디페그 (2026-03)",
    chain: "ethereum",
    token: { address: "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110", symbol: "USR" },
    category: "depeg",
    window: { from: "2026-03-22T04:00:00Z", to: "2026-03-22T12:00:00Z" }, // 5분 간격 · 가격 붕괴 구간
    // ⚠️ 리뷰(2026-06): 이 블록 구간엔 USR totalSupply 가 오히려 감소(182→172M) — 무단 mint 가 온체인에 안 보임 →
    //   '민트 권한 탈취' 신호(supply_single_mint)는 약속하지 않는다. 관측 가능한 건 가격 붕괴(depeg). 정직하게 depeg-only.
    expect: [{ kind: "depeg", minSeverity: "warning" }],
    note: "Resolv USR 민트 권한 탈취 → 무담보 발행 + 가격 붕괴.",
  },

  // ───────────── CROSS-CHAIN UNBACKED (flagship) ─────────────
  {
    id: "2026-04-20-rsETH-kelp-unbacked-mint",
    name: "Kelp DAO rsETH Bridge 해킹 (2026-04)",
    chain: "arbitrum",      // 토큰 read = arb rep(무단 민트가 일어난 곳)
    displayChain: "ethereum", // 헤더 framing = 메인넷(escrow 드레인이 본질·최대 피해)
    // 무단 민트는 메인넷이 아니라 **브릿지(LayerZero OFT)가 Arbitrum rsETH 에 찍었다** — 메인넷 totalSupply 는
    //   불변이고 arb rep 공급이 04-18 29.6K → 04-19 65.8K (+122%) 로 폭증(온체인 확인). 그 rep 을 fork 읽기.
    token: { address: "0x4186BFC76E2E237523CBC30FD220FE055156b41F", symbol: "rsETH" },
    category: "unbacked_xchain",
    // 5분 간격 · 사건 전체 arc: escrow 드레인(메인넷 12:00 116.7K→0=최대 피해) + arb 무단민트(16~20시 +122%) +
    //   전파(Aave WETH 100%@20시·USDT 99%@익일02시·USDC 98%@익일05시). baseline=정상 over-backed.
    baselineAt: "2026-04-18T11:00:00Z",
    window: { from: "2026-04-18T13:00:00Z", to: "2026-04-19T06:00:00Z" },
    expect: [
      { kind: "supply_conservation", minSeverity: "warning" }, // 무담보 발행(escrow vs Σremote 무결성 붕괴)
      { kind: "supply_single_mint", minSeverity: "warning" },  // arb rep 공급 급증
    ],
    // 웹검증(2026-06): 단일 1-of-1 LZ DVN 탈취 → 위조 패킷(Unichain 출처 사칭)이 **메인넷 OFTAdapter에서 canonical
    //   rsETH 116,500개를 release**(escrow 116,723→223, tx 0x1ae232da…). 즉 본질은 **메인넷 escrow 드레인**(원격 mint 아님).
    //   공격자는 이후 일부를 Arbitrum 으로 브릿지해 추가 Aave 차입(arb rep 공급 +)·Aave WETH→USDC/USDT 100% 가동률 유발.
    note: "1-of-1 LZ DVN 탈취 → 메인넷 OFTAdapter escrow 드레인 116,500 rsETH(~$292M) release. 무담보 발행(escrow 붕괴)+arb 브릿지 대량유입+Aave 전파 포착.",
    conservation: {
      canonical: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7",
      decimals: 18,
      escrow: "0x85d456B2DfF1fd8245387C0BfB64Dfb700e98Ef3", // LZ OFT adapter(자동발견 검증). 잠긴 canonical = backing
      remotes: [
        { chain: "arbitrum", token: "0x4186BFC76E2E237523CBC30FD220FE055156b41F" },
        { chain: "base", token: "0x1Bc71130A0e39942a7658878169764Bbd8A45993" },
      ],
      // 무단 발행 tx — escrow 에서 116,500 rsETH 를 release 한 위조 lzReceive(Ethereum blk 24,908,285). 알림이 이 tx 로 바로가기.
      attackTx: "0x1ae232da212c45f35c1525f851e4c41d529bf18af862d9ce9fd40bf709db4222",
      attackChain: "ethereum",
    },
    // contagion — rsETH 무담보→Aave bad debt 우려→공급자 인출러시. WETH·USDC·USDT 가동률 급등(실측 04-19 전부 100%).
    //   관련 없어 보이는 스테이블(USDC/USDT)까지 전파된 의존성을 보여준다.
    relatedMarkets: [{
      protocol: "aave_v3",
      pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      tokens: [
        { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
        { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
        { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
      ],
    }],
  },
];
