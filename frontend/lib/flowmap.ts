/**
 * 흐름맵 v2 — 실시간 상황판 공용 모듈 (docs/flow-situation-board.md)
 *
 * 토큰 레지스트리 · Aave V3 이벤트 토픽(온체인 실증으로 고정) · 버킷/베이스라인 수식 · API 타입.
 * 토픽 상수는 2026-06-10 메인넷에서 selector→receipt 역산으로 검증함 — 절대 추정으로 바꾸지 말 것.
 */

// ── 윈도우/버킷 파라미터 ───────────────────────────────────────────────
export const WINDOW_BLOCKS = 1800; // ≈6h (12s/blk)
export const BUCKET_BLOCKS = 25;   // ≈5min
export const N_BUCKETS = WINDOW_BLOCKS / BUCKET_BLOCKS; // 72
export const RECENT_BUCKETS = 3;   // 평가량 = 최근 3개 완결 버킷(≈15분)
export const MIN_USD = 300_000;    // 흐름 최소 규모(소액 노이즈 컷)
export const Z_TH = 3.5;           // robust z 기본 임계
export const SHARE_MIN = 0.01;     // 구조(평시) 엣지 표시 컷 — 토큰 윈도우 거래량 점유율 1%
// 레버/언와인드 판정 기준 (UI 에도 그대로 표기):
//   레버     = 같은 tx 에서 같은 주체(onBehalf/user)가 같은 프로토콜에 [담보 예치 + 다른 토큰 차입], 차입 ≥$100K
//   언와인드 = 같은 tx 에서 같은 주체가 [차입 상환 + 다른 토큰 담보 회수], 상환 ≥$100K
//   원자적(한 tx) 페어만 — 추정 아님. 다중 tx에 걸친 루프는 레버리지 루프 뷰(포지션 기반)가 담당.
export const LEVER_MIN_USD = 100_000;
// 이상치 분류 게이트 (실거래 검증으로 도출·보정 — 단일 고래·routine tx·먼지 동반 고래 오탐 제거)
export const MIN_ACTORS = 4;       // "systemic(이상치)" = 서로 다른 주소 ≥4 (run/패닉은 다수 주체)
export const TOP_ACTOR_MAX = 0.6;  // systemic 은 최대주체 USD 점유 ≤60% (먼지 3명+고래 1명 = 머릿수 4 오탐 방지)
export const SYSTEMIC_MIN_USD = 500_000; // systemic 최소 규모
export const WHALE_MIN_USD = 2_000_000;  // "대형 단일 이동" = 소수/지배 주체 대형(정보용, 경보 아님)
export const MATERIAL_PCT = 0.15;  // 풀 유동성 대비 이만큼↑ 빠지면 materiality 충족(드레인)
export const WHALE_BOARD_MAX = 5;  // 보드에 색칠하는 whale 상한(나머지는 레일에만) — 화살표 과밀 방지

// ── Aave V3 이벤트 토픽 (메인넷 실증 — supply/withdraw/borrow/repay tx receipt에서 역산) ──
export const AAVE_TOPIC: Record<string, "supply" | "withdraw" | "borrow" | "repay"> = {
  "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": "supply",   // data[user,amount] → amount=word1
  "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7": "withdraw", // data[amount] → word0
  "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0": "borrow",   // data[user,amount,mode,rate] → word1
  "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": "repay",    // data[amount,useATokens] → word0
};
// 이벤트별 amount 의 data word 인덱스 (위 실증과 1:1)
export const AAVE_AMOUNT_WORD: Record<LendAction, number> = { supply: 1, withdraw: 0, borrow: 1, repay: 0 };

export type LendAction = "supply" | "withdraw" | "borrow" | "repay";
export type FlowAction = LendAction | "sell" | "buy"; // sell/buy = DEX 스왑(토큰→풀 매도 / 풀→토큰 매수)
// 방향: 토큰 기준 — in = 토큰이 프로토콜로(예치/상환/매도), out = 프로토콜에서 나옴(인출/차입/매수)
export const ACTION_DIR: Record<FlowAction, "in" | "out"> = { supply: "in", repay: "in", withdraw: "out", borrow: "out", sell: "in", buy: "out" };

// ── Aave-ABI 인스턴스 (메인넷, 코드/로그 프로브 통과분) ─────────────────────
export const AAVE_INSTANCES = [
  { name: "Aave Core", slug: "aave-v3", addr: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2" },
  { name: "Aave Prime", slug: "aave-v3", addr: "0x4e033931ad43597d96d6bcc25c280717730b58b1" },
  { name: "Aave EtherFi", slug: "aave-v3", addr: "0x0aa97c284e98396202b6a04024f5e2c65026f3c0" },
  { name: "Spark", slug: "spark", addr: "0xc13e21b648a5ee794902342038ff3adab66be987" },
] as const;
export const MORPHO_PROTO = { name: "Morpho", slug: "morpho-blue" } as const;
export const COMPOUND_PROTO = { name: "Compound V3", slug: "compound-finance" } as const;

// Compound V3 Comet — 베이스자산별 개별 컨트랙트(온체인 baseToken() 검증). 한 프로토콜로 집계.
export const COMETS = [
  { name: "cUSDCv3", addr: "0xc3d688b66703497daa19211eedff47f25384cdc3", base: "USDC" },
  { name: "cWETHv3", addr: "0xa17581a9e3356d9a858b789d68b4d866e593ae94", base: "WETH" },
  { name: "cUSDTv3", addr: "0x3afdc9bca9213a35503b077a6072f3d0d5ab0840", base: "USDT" },
] as const;
// Compound V3 이벤트 토픽 — 메인넷 selector(supply/withdraw)→로그 역산으로 확정. scope=base 면
// asset=Comet 베이스자산, scope=collat 면 asset=topic[3](indexed). amount=data word0(모두).
export const COMPOUND_TOPIC: Record<string, { action: FlowAction; scope: "base" | "collat" }> = {
  "0xd1cf3d156d5f8f0d50f6c122ed609cec09d35c9b9fb3fff6ea0959134dae424e": { action: "supply", scope: "base" },     // Supply(from,dst,amt)
  "0x9b1bfa7fa9ee420a16e124f794c35ac9f90472acc99140eb2f6447c714cad8eb": { action: "withdraw", scope: "base" },   // Withdraw(src,to,amt) — 베이스 인출/차입 혼재(방향만 정확)
  "0xfa56f7b24f17183d81894d3ac2ee654e3c26388d17a28dbd9549b8114304e1f4": { action: "supply", scope: "collat" },   // SupplyCollateral(from,dst,asset,amt)
  "0xd6d480d5b3068db003533b170d67561494d72e3bf9fa40a266471351ebba9e16": { action: "withdraw", scope: "collat" }, // WithdrawCollateral(src,to,asset,amt)
};

// ── Fluid (Instadapp) — Liquidity 싱글톤. 단일 이벤트 LogOperate 가 부호로 4액션 표현.
//    공식문서+Etherscan 라벨로 주소 확정, 부호 의미는 실로그 256건으로 검증(2026-06-10).
//    supplyAmount>0 예치 / <0 인출, borrowAmount>0 차입 / <0 상환. token=topic2, actor=topic1.
//    ⚠ actor 는 최종 유저가 아니라 상위 프로토콜 컨트랙트(fToken/Vault) — 주체 수 과소집계됨.
export const FLUID_PROTO = { name: "Fluid", slug: "fluid-lending" } as const;
export const FLUID_ADDR = "0x52aa899454998be5b000ad077a46bbe360f4e497";
export const FLUID_LOGOPERATE = "0x4d93b232a24e82b284ced7461bf4deacffe66759d5c24513e6f29e571ad78d15";
export const FLUID_NATIVE_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // Fluid 는 네이티브 ETH 사용

// ── Euler v2 — 볼트별 컨트랙트(841개, 목록은 Goldsky 서브그래프·캐시). 흐름은 온체인.
//    토픽 4종은 활동 볼트 2개를 하네스(scripts/probe_protocol.py)로 프로브해 실증(2026-06-10).
//    ⚠ 서브그래프 이벤트 인덱싱은 ~7.7일 지연 → 볼트 '목록'만 쓰고 흐름엔 절대 안 씀.
export const EULER_PROTO = { name: "Euler", slug: "euler-v2" } as const;
export const EULER_SUBGRAPH = "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn";
export const EULER_TOPIC: Record<string, { action: FlowAction; actorTopic: number }> = {
  "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7": { action: "supply", actorTopic: 2 },   // Deposit(sender,owner idx2, assets=word0, shares)
  "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db": { action: "withdraw", actorTopic: 3 }, // Withdraw(sender,receiver,owner idx3, assets=word0, shares)
  "0xcbc04eca7e9da35cb1393a6135a199ca52e450d5e9251cbd99f7847d33a36750": { action: "borrow", actorTopic: 1 },   // Borrow(account idx1, assets=word0)
  "0x5c16de4f8b59bd9caf0f49a545f25819a895ed223294290b408242e72a594231": { action: "repay", actorTopic: 1 },    // Repay(account idx1, assets=word0)
};

// ── Uniswap V3 — 팩토리에서 풀을 유도(주소 추측 불필요). 팩토리는 getPool(USDC,WETH,500)→
//    token0/token1/fee 정합으로 구성적 자기검증(2026-06-10). Swap 토픽은 하네스로 실증.
//    Swap(sender idx1, recipient idx2, amount0 int256=word0, amount1 int256=word1, …):
//    amountN>0 = tokenN 이 풀로 들어감(매도), <0 = 풀에서 나옴(매수).
//    ⚠ sender/recipient 는 대부분 라우터 — 실주체 식별 불가 → DEX 는 systemic 판정 제외(정보만).
export const UNIV3_PROTO = { name: "Uniswap V3", slug: "uniswap-v3" } as const;
export const UNIV3_FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
export const UNIV3_GETPOOL_SEL = "0x1698ee82"; // getPool(address,address,uint24)
export const UNIV3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const UNIV3_FEE_TIERS = [100, 500, 3000, 10000] as const;

// ── Uniswap V4 — PoolManager 싱글톤(이 세션 실거래 receipt 에서 관측한 주소).
//    Initialize(id idx1, currency0 idx2, currency1 idx3, …) 로 poolId→통화 맵을 만들고
//    (레지스트리 주소를 topic2/3 필터로 걸면 전이력 1콜·2,622풀·4.3s — 실측),
//    Swap(id idx1, sender idx2, amount0 int128=w0, amount1=w1, …) 부호는 **V3와 반대**:
//    amount>0 = 풀에서 유출(매수), <0 = 풀로 유입(매도) — Transfer 로그 대조 3/3 실증(2026-06-10).
//    네이티브 ETH = address(0) → 레지스트리 "ETH" 매핑.
export const UNIV4_PROTO = { name: "Uniswap V4", slug: "uniswap-v4" } as const;
export const UNIV4_ADDR = "0x000000000004444c5dc75cb358380d2e3de08a90";
export const UNIV4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
export const UNIV4_INIT_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// ── Balancer V2 — Vault 싱글톤. Swap(poolId idx1, tokenIn idx2, tokenOut idx3,
//    amountIn=w0, amountOut=w1) — 토큰 정체가 토픽에 직접 들어있어 풀맵 불필요(하네스 실증).
//    주소는 이벤트 믹스(Swap/FlashLoan/PoolBalanceChanged)+볼륨으로 구성적 검증.
export const BALANCER_PROTO = { name: "Balancer", slug: "balancer-v2" } as const;
export const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
export const BALANCER_SWAP_TOPIC = "0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b";

// ── Curve — 풀 목록·coins(주소/decimals)는 공식 API(5개 레지스트리). TokenExchange 는
//    두 변형이 같은 레이아웃(buyer idx1; data [sold_id, tokens_sold, bought_id, tokens_bought]):
//    legacy/stable-ng 와 crypto — 둘 다 활동 풀 하네스 프로브로 토픽 실증(2026-06-10).
//    TokenExchangeUnderlying(메타풀 언더라잉 경유)은 v1 미지원 — 정직하게 제외.
export const CURVE_PROTO = { name: "Curve", slug: "curve-dex" } as const;
export const CURVE_TE_TOPICS = [
  "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140", // TokenExchange(address,int128,uint256,int128,uint256)
  "0xb2e76ae99761dc136e598d4a629bb347eccb9532a5f8bbd72e18467c3c34cc98", // TokenExchange(address,uint256,uint256,uint256,uint256) — crypto
] as const;
export const CURVE_API_REGISTRIES = ["main", "factory-stable-ng", "crypto", "factory-crypto", "factory-tricrypto"] as const;

export const DEX_PROTOS = new Set<string>([UNIV3_PROTO.name, UNIV4_PROTO.name, CURVE_PROTO.name, BALANCER_PROTO.name]);

// ── 멀티체인 레지스트리 — scripts/probe_flowmap_chains.mjs 전수 검증 통과분만 (2026-06-10).
//    검증 항목: RPC 생존·blockSec 실측·Aave getReservesList()+reserve symbol() 디코드·
//    Comet baseToken()·Balancer/Fluid 코드+로그·UniV3 feeAmountTickSpacing(500)==10·
//    주소배열 getLogs 허용·DeFiLlama 가격 슬러그·Morpho chainId 트랜잭션 존재.
//    ⚠ 새 체인/주소는 반드시 프로브를 통과시킨 뒤 추가할 것 — 메모리 출처 금지.
//    알려진 공백(정직성): BSC Venus·Avalanche Benqi(Compound V2 포크 ABI)·Base Aerodrome(Solidly
//    ABI)·비메인넷 Euler/UniV4 — 별도 디코더 필요, MANUAL §18 백로그.
export interface FlowChain {
  key: string; label: string; chainId: number;
  rpcs: string[];               // 0번 = 주(publicnode), 이후 폴백
  llamaSlug: string;            // coins.llama.fi `{slug}:{addr}` (probe 로 확정: avax·xdai 주의)
  aave: { name: string; slug: string; addr: string }[]; // Aave-ABI 인스턴스(Spark 포크 포함)
  comets: string[];             // Compound V3 — baseToken()은 런타임 해석(캐시)
  morpho: boolean;              // blue-api 가 이 chainId 트랜잭션을 줌
  fluid?: string;               // Fluid Liquidity 싱글톤 (동일주소 배포 — 코드+로그 확인분만)
  univ3Factory?: string;        // tick(500)==10 검증 통과분만
  balancerVault?: string;       // Swap 로그 확인분만
  curveSlug?: string;           // api.curve.finance getPools 슬러그
  ethereumOnly?: { univ4: boolean; euler: boolean }; // 메인넷 전용 소스 플래그
}
const AAVE_V3_CANON = "0x794a61358d6845594f94dc1db02a252b5b4814ad"; // arb·op·poly·avax 동일 배포
export const FLOW_CHAINS: FlowChain[] = [
  { key: "ethereum", label: "Ethereum", chainId: 1, rpcs: ["https://ethereum-rpc.publicnode.com", "https://rpc.mevblocker.io"], llamaSlug: "ethereum",
    aave: AAVE_INSTANCES.map((i) => ({ name: i.name, slug: i.slug, addr: i.addr })), comets: COMETS.map((c) => c.addr), morpho: true,
    fluid: FLUID_ADDR, univ3Factory: UNIV3_FACTORY, balancerVault: BALANCER_VAULT, curveSlug: "ethereum", ethereumOnly: { univ4: true, euler: true } },
  { key: "base", label: "Base", chainId: 8453, rpcs: ["https://base-rpc.publicnode.com"], llamaSlug: "base",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5" }],
    comets: ["0xb125e6687d4313864e53df431d5425969c15eb2f", "0x46e6b214b524310239732d51387075e0e70970bf"], morpho: true,
    fluid: FLUID_ADDR, univ3Factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd", balancerVault: BALANCER_VAULT },
  { key: "arbitrum", label: "Arbitrum", chainId: 42161, rpcs: ["https://arbitrum-one-rpc.publicnode.com"], llamaSlug: "arbitrum",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: AAVE_V3_CANON }],
    comets: ["0xa5edbdd9646f8dff606d7448e414884c7d905dca", "0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf", "0x6f7d514bbd4aff3bcd1140b7344b32f063dee486", "0xd98be00b5d27fc98112bde293e487f8d4ca57d07"], morpho: true,
    fluid: FLUID_ADDR, univ3Factory: UNIV3_FACTORY, balancerVault: BALANCER_VAULT, curveSlug: "arbitrum" },
  { key: "optimism", label: "Optimism", chainId: 10, rpcs: ["https://optimism-rpc.publicnode.com"], llamaSlug: "optimism",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: AAVE_V3_CANON }],
    comets: ["0x2e44e174f7d53f0212823acc11c01a11d58c5bcb", "0x995e394b8b2437ac8ce61ee0bc610d617962b214", "0xe36a30d249f7761327fd973001a32010b521b6fd"], morpho: true,
    univ3Factory: UNIV3_FACTORY, balancerVault: BALANCER_VAULT, curveSlug: "optimism" },
  { key: "polygon", label: "Polygon", chainId: 137, rpcs: ["https://polygon-bor-rpc.publicnode.com"], llamaSlug: "polygon",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: AAVE_V3_CANON }],
    comets: ["0xf25212e676d1f7f89cd72ffee66158f541246445", "0xaeb318360f27748acb200ce616e389a6c9409a07"], morpho: true,
    univ3Factory: UNIV3_FACTORY, balancerVault: BALANCER_VAULT, curveSlug: "polygon" },
  { key: "avalanche", label: "Avalanche", chainId: 43114, rpcs: ["https://avalanche-c-chain-rpc.publicnode.com"], llamaSlug: "avax",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: AAVE_V3_CANON }], comets: [], morpho: false,
    univ3Factory: "0x740b1c1de25031c31ff4fc9a62f554a55cdc1bad", balancerVault: BALANCER_VAULT, curveSlug: "avalanche" },
  { key: "bsc", label: "BSC", chainId: 56, rpcs: ["https://bsc-rpc.publicnode.com"], llamaSlug: "bsc",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: "0x6807dc923806fe8fd134338eabca509979a7e0cb" }], comets: [], morpho: false,
    fluid: FLUID_ADDR, univ3Factory: "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7" },
  { key: "gnosis", label: "Gnosis", chainId: 100, rpcs: ["https://gnosis-rpc.publicnode.com"], llamaSlug: "xdai",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: "0xb50201558b00496a145fe76f7424749556e326d8" }, { name: "Spark", slug: "spark", addr: "0x2dae5307c5e3fd1cf5a72cb6f698f915860607e0" }],
    comets: [], morpho: false, balancerVault: BALANCER_VAULT, curveSlug: "xdai" },
  { key: "scroll", label: "Scroll", chainId: 534352, rpcs: ["https://scroll-rpc.publicnode.com"], llamaSlug: "scroll",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: "0x11fcfe756c05ad438e312a7fd934381537d3cffe" }],
    comets: ["0xb2f97c1bd3bf02f5e74d13f02e3e26f93d77ce44"], morpho: false },
  { key: "linea", label: "Linea", chainId: 59144, rpcs: ["https://linea-rpc.publicnode.com"], llamaSlug: "linea",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: "0xc47b8c00b0f69a36fa203ffeac0334874574a8ac" }], comets: [], morpho: false },
  { key: "sonic", label: "Sonic", chainId: 146, rpcs: ["https://sonic-rpc.publicnode.com"], llamaSlug: "sonic",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: "0x5362dbb1e601abf3a4c14c22ffeda64042e5eaa3" }], comets: [], morpho: false,
    fluid: FLUID_ADDR, balancerVault: BALANCER_VAULT },
  { key: "celo", label: "Celo", chainId: 42220, rpcs: ["https://celo-rpc.publicnode.com"], llamaSlug: "celo",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: "0x3e59a31363e2ad014dcbc521c4a0d5757d9f3402" }], comets: [], morpho: false,
    univ3Factory: "0xafe208a311b21f13ef87e33a90049fc17a7acdec" },
  { key: "metis", label: "Metis", chainId: 1088, rpcs: ["https://metis-rpc.publicnode.com"], llamaSlug: "metis",
    aave: [{ name: "Aave V3", slug: "aave-v3", addr: "0x90df02551bb792286e8d4f13e0e357b4bf1d6a57" }], comets: [], morpho: false },
];
export const FLOW_CHAIN_BY_KEY: Record<string, FlowChain> = Object.fromEntries(FLOW_CHAINS.map((c) => [c.key, c]));

// UniV3 쿼트(메이저) 심볼 — 체인별 동적 레지스트리에서 이 심볼들을 찾아 페어 유도에 사용.
// (대문자 비교; USD₮0 은 아비트럼 USDT 리브랜딩 실심볼 — 프로브에서 관측)
export const UNIV3_QUOTE_SYMS = new Set(["WETH", "USDC", "USDC.E", "USDBC", "USDT", "USDT0", "USD₮0", "WBTC", "WBNB", "WAVAX", "WXDAI", "WPOL", "WMATIC", "WS", "BTCB", "CBBTC", "CBETH", "WSTETH"]);

// 동적 토큰 그룹 분류(보드 링 정렬용) — 심볼 휴리스틱. 메인넷은 큐레이션 레지스트리 유지.
export function groupOfSym(sym: string): TokenInfo["group"] {
  const s = sym.toUpperCase();
  if (/(^|W|R|CB|ST|EZ|RS|WE|OS|PUF|FRX)ETH/.test(s) || s === "ETH") return "eth";
  if (/BTC/.test(s)) return "btc";
  if (/USD|DAI|FRAX|GHO|EUR|FDUSD|USDT|USDC/.test(s)) return "stable";
  return "other";
}

// 한 체인(이더리움)에서 흐름을 디코딩하는 전체 프로토콜 — 활동 없어도 링에 항상 렌더(고정 배치).
export const SUPPORTED_PROTOCOLS: { name: string; slug: string }[] = [
  ...AAVE_INSTANCES.map((i) => ({ name: i.name, slug: i.slug })),
  { name: MORPHO_PROTO.name, slug: MORPHO_PROTO.slug },
  { name: COMPOUND_PROTO.name, slug: COMPOUND_PROTO.slug },
  { name: FLUID_PROTO.name, slug: FLUID_PROTO.slug },
  { name: EULER_PROTO.name, slug: EULER_PROTO.slug },
  { name: UNIV3_PROTO.name, slug: UNIV3_PROTO.slug },
  { name: UNIV4_PROTO.name, slug: UNIV4_PROTO.slug },
  { name: CURVE_PROTO.name, slug: CURVE_PROTO.slug },
  { name: BALANCER_PROTO.name, slug: BALANCER_PROTO.slug },
];

// ── 추적 토큰 레지스트리 (메인넷) — 안쪽 링 후보. 미등록 reserve 는 untracked 로 집계만.
//    확장분(2026-06-10)은 관계맵과 같은 우주(DeFiLlama 풀 underlying)에서 주소 해석 후
//    온체인 symbol()/decimals() 배치 검증을 통과한 것만 — scripts 로 재생성 가능. ──
export interface TokenInfo { sym: string; addr: string; decimals: number; group: "eth" | "btc" | "stable" | "other" }
export const TOKENS: TokenInfo[] = [
  { sym: "WETH", addr: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", decimals: 18, group: "eth" },
  { sym: "wstETH", addr: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", decimals: 18, group: "eth" },
  { sym: "weETH", addr: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", decimals: 18, group: "eth" },
  { sym: "rsETH", addr: "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7", decimals: 18, group: "eth" },
  { sym: "ezETH", addr: "0xbf5495efe5db9ce00f80364c8b423567e58d2110", decimals: 18, group: "eth" },
  { sym: "rETH", addr: "0xae78736cd615f374d3085123a210448e74fc6393", decimals: 18, group: "eth" },
  { sym: "cbETH", addr: "0xbe9895146f7af43049ca1c1ae358b0541ea49704", decimals: 18, group: "eth" },
  { sym: "ETHx", addr: "0xa35b1b31ce002fbf2058d22f30f95d405200a15b", decimals: 18, group: "eth" },
  { sym: "osETH", addr: "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38", decimals: 18, group: "eth" },
  { sym: "pufETH", addr: "0xd9a442856c234a39a81a089c06451ebaa4306a72", decimals: 18, group: "eth" },
  { sym: "WBTC", addr: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8, group: "btc" },
  { sym: "cbBTC", addr: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8, group: "btc" },
  { sym: "LBTC", addr: "0x8236a87084f8b84306f72007f36f2618a5634494", decimals: 8, group: "btc" },
  { sym: "eBTC", addr: "0x657e8c867d8b37dcc18fa4caead9c45eb088c642", decimals: 8, group: "btc" },
  { sym: "tBTC", addr: "0x18084fba666a33d37592fa2633fd49a74dd93a88", decimals: 18, group: "btc" },
  { sym: "USDC", addr: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, group: "stable" },
  { sym: "USDT", addr: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, group: "stable" },
  { sym: "DAI", addr: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18, group: "stable" },
  { sym: "USDS", addr: "0xdc035d45d973e3ec169d2276ddab16f1e407384f", decimals: 18, group: "stable" },
  { sym: "USDe", addr: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", decimals: 18, group: "stable" },
  { sym: "sUSDe", addr: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", decimals: 18, group: "stable" },
  { sym: "GHO", addr: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", decimals: 18, group: "stable" },
  { sym: "sDAI", addr: "0x83f20f44975d03b1b09e64809b757c47f942beea", decimals: 18, group: "stable" },
  { sym: "sUSDS", addr: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", decimals: 18, group: "stable" },
  { sym: "PYUSD", addr: "0x6c3ea9036406852006290770bedfcaba0e23a0e8", decimals: 6, group: "stable" },
  { sym: "crvUSD", addr: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", decimals: 18, group: "stable" },
  { sym: "FRAX", addr: "0x853d955acef822db058eb8505911ed77f175b99e", decimals: 18, group: "stable" },
  { sym: "RLUSD", addr: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", decimals: 18, group: "stable" },
  { sym: "USD0", addr: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5", decimals: 18, group: "stable" },
  // ── 확장분: 관계맵 우주(DeFiLlama top TVL) → 주소 해석 → 온체인 symbol()/decimals() 검증 통과 29종.
  //    아래 블록은 생성 스크립트 출력 그대로(손 타이핑 금지 — 주소 오타 사고 방지). ──
  { sym: "ETH", addr: FLUID_NATIVE_ETH, decimals: 18, group: "eth" }, // Fluid 네이티브 — 가격은 WETH 준용(1:1 wrap)
  { sym: "frxETH", addr: "0x5e8422345238f34275888049021821e8e08caa1f", decimals: 18, group: "eth" },
  { sym: "kBTC", addr: "0x73e0c0d45e048d25fc26fa3159b0aa04bfa4db98", decimals: 8, group: "btc" },
  { sym: "USDY", addr: "0x96f6ef951840721adbf46ac996b59e0235cb985c", decimals: 18, group: "stable" },
  { sym: "reUSD", addr: "0x5086bf358635b81d8c47c66d1c8b9e567db70c72", decimals: 18, group: "stable" },
  { sym: "apxUSD", addr: "0x98a878b1cd98131b271883b390f68d2c90674665", decimals: 18, group: "stable" },
  { sym: "frxUSD", addr: "0xcacd6fd266af91b8aed52accc382b4e165586e29", decimals: 18, group: "stable" },
  { sym: "syrupUSDC", addr: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", decimals: 6, group: "stable" },
  { sym: "DOLA", addr: "0x865377367054516e17014ccded1e7d814edc9ce4", decimals: 18, group: "stable" },
  { sym: "apyUSD", addr: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a", decimals: 18, group: "stable" },
  { sym: "USDtb", addr: "0xc139190f447e929f090edeb554d95abb8b18ac1c", decimals: 18, group: "stable" },
  { sym: "AUSD", addr: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6, group: "stable" },
  { sym: "USDG", addr: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6, group: "stable" },
  { sym: "USDat", addr: "0x23238f20b894f29041f48d88ee91131c395aaa71", decimals: 6, group: "stable" },
  { sym: "xUSD", addr: "0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94", decimals: 6, group: "stable" },
  { sym: "USD1", addr: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", decimals: 18, group: "stable" },
  { sym: "BOLD", addr: "0x6440f144b7e50d6a8439336510312d2f54beb01d", decimals: 18, group: "stable" },
  { sym: "USTB", addr: "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e", decimals: 6, group: "other" },
  { sym: "WLFI", addr: "0xda5e1988097297dcdc1f90d4dfe7909e847cbef6", decimals: 18, group: "other" },
  { sym: "OUSG", addr: "0x1b19c19393e2d034d8ff31ff34c81252fcbbee92", decimals: 18, group: "other" },
  { sym: "USCC", addr: "0x14d60e7fdc0d71d8611742720e4c50e7a974020c", decimals: 6, group: "other" },
  { sym: "PRIME", addr: "0x19ebb35279a16207ec4ba82799cc64715065f7f6", decimals: 6, group: "other" },
  { sym: "LINK", addr: "0x514910771af9ca656af840dff83e8264ecf986ca", decimals: 18, group: "other" },
  { sym: "XAUt", addr: "0x68749665ff8d2d112fa859aa293f07a622782f38", decimals: 6, group: "other" },
  { sym: "thBILL", addr: "0x5fa487bca6158c64046b2813623e20755091da0b", decimals: 6, group: "other" },
  { sym: "STAC", addr: "0x51c2d74017390cbbd30550179a16a1c28f7210fc", decimals: 6, group: "other" },
  { sym: "USYC", addr: "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b", decimals: 6, group: "other" },
  { sym: "AAVE", addr: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", decimals: 18, group: "other" },
  { sym: "msY", addr: "0x890a5122aa1da30fec4286de7904ff808f0bd74a", decimals: 18, group: "other" },
  { sym: "PAXG", addr: "0x45804880de22913dafe09f4980848ece6ecbaf78", decimals: 18, group: "other" },
];
export const TOKEN_BY_ADDR: Record<string, TokenInfo> = Object.fromEntries(TOKENS.map((t) => [t.addr, t]));
export const TOKEN_BY_SYM: Record<string, TokenInfo> = Object.fromEntries(TOKENS.map((t) => [t.sym.toLowerCase(), t]));

// ── 베이스라인/이상치 수식 (docs §4.4) ─────────────────────────────────
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface AnomalyStat { recentUsd: number; baseUsd: number; baseMaxUsd: number; z: number; ratio: number; anomalous: boolean }

/**
 * buckets: 길이 N_BUCKETS, [0]=가장 오래됨 … [N-1]=현재(부분) 버킷.
 * 평가량 R = 마지막 부분 버킷 직전의 RECENT_BUCKETS 개 합.
 * 히스토리 = 그 이전 구간의 롤링 RECENT_BUCKETS 합(stride 1) → median+MAD robust z.
 */
export function anomalyStat(buckets: number[], minUsd = MIN_USD, zTh = Z_TH): AnomalyStat {
  const n = buckets.length;
  const recent = buckets.slice(n - 1 - RECENT_BUCKETS, n - 1); // 부분 버킷(n-1) 제외한 최근 3개
  const R = recent.reduce((s, x) => s + x, 0);
  const histEnd = n - 1 - RECENT_BUCKETS;
  const rolls: number[] = [];
  for (let i = 0; i + RECENT_BUCKETS <= histEnd; i++) {
    let s = 0;
    for (let j = 0; j < RECENT_BUCKETS; j++) s += buckets[i + j];
    rolls.push(s);
  }
  const med = median(rolls);
  const mad = median(rolls.map((x) => Math.abs(x - med)));
  const sigma = 1.4826 * mad;
  const maxH = rolls.length ? Math.max(...rolls) : 0;
  // MAD≈0(희소/버스트 엣지)일 땐 "직전 최대 버스트의 4배" 룰. z 도 그 스케일로 연속화해
  // 클라이언트의 z≥임계 재평가가 서버 판정과 일치하게 (z=Z_TH ⇔ R=4·maxH).
  const z = sigma > 1 ? (R - med) / sigma : maxH > 0 ? (Z_TH * R) / (4 * maxH) : R > 0 ? 99 : 0;
  const fired = R >= minUsd && (sigma > 1 ? z >= zTh : R >= 4 * Math.max(maxH, 1));
  const zOut = Math.min(z, 99);
  return { recentUsd: R, baseUsd: med, baseMaxUsd: maxH, z: zOut, ratio: med > 0 ? R / med : R > 0 ? 99 : 0, anomalous: fired };
}

// ── API 응답 타입 ─────────────────────────────────────────────────────
// 흐름 분류: systemic=다수 주체 비정상(진짜 이상치) · whale=단일주체 대형(정보) · normal=구조
export type FlowKind = "systemic" | "whale" | "normal";
export interface FlowEdgeOut {
  token: string; proto: string; action: FlowAction; dir: "in" | "out";
  recentUsd: number; baseUsd: number; baseMaxUsd?: number; z: number; ratio: number;
  share: number;        // 이 토큰 윈도우 총거래량 중 점유율 (구조 레이어 1% 컷)
  windowUsd: number;    // 윈도우 전체 USD (구조 두께)
  actors: number;       // 최근 15분 이 엣지의 서로 다른 주소 수 (systemic 게이트)
  topShare: number;     // 최대주체 USD 점유율 (1=한 명이 전부) — 먼지 동반 고래 식별
  txCount: number;      // 최근 15분 tx 수
  poolUsd: number;      // 이 (토큰,프로토)의 풀 규모 (Morpho 공급, Aave aToken 총공급) — 0=미상
  pctPool: number;      // recentUsd / poolUsd (materiality), poolUsd 0 이면 0
  kind: FlowKind;
  anomalous: boolean;   // = kind==="systemic" (하위호환)
}
export interface FlowTokenOut { sym: string; addr: string; group: TokenInfo["group"]; inUsd: number; outUsd: number; anomalous: boolean }
export interface FlowProtoOut { name: string; slug: string; inUsd: number; outUsd: number; outZ: number; state: "ok" | "warn" | "danger" }
export interface LeverOut { collat: string; proto: string; debt: string; usd: number; count: number }
export interface FlowMapData {
  meta: {
    chain: string; chainId: number; chainLabel: string; // 멀티체인 — 보드 칩/아이콘 CDN 경로
    blockSec: number;     // 실측 블록타임(latest vs latest-10000) — 윈도우/버킷 산출 근거
    latestBlock: number; headTime: number; windowBlocks: number; bucketBlocks: number; recentBuckets: number;
    recentStartSec: number; recentEndSec: number; // 평가창의 실제 시각(블록 기준) — "15분" 거짓 라벨 방지
    fetchedAt: number; protocols: string[]; minUsd: number; minActors: number;
    untrackedUsd: number; // 레지스트리 밖 reserve 거래량(정직성 표기)
    historical?: number;  // 과거 리플레이면 기준 블록(실데이터)
    errors?: string[];
  };
  tokens: FlowTokenOut[];
  protocols: FlowProtoOut[];
  edges: FlowEdgeOut[];  // kind 로 systemic/whale/normal 구분 (클라이언트가 분리)
  levers: LeverOut[];   // 같은 tx: 담보 예치 + 차입 (레버 증설)
  unwinds: LeverOut[];  // 같은 tx: 상환 + 담보 인출 (디레버)
}

// ?summary=1 — 전 체인 이상치 한눈 집계(칩/레일용). 캐시 스냅샷만 — 수집 중이면 collecting.
export interface FlowSummaryChain {
  key: string; label: string; chainId: number;
  status: "ready" | "collecting" | "error";
  fetchedAt: number | null;
  systemic: number; whale: number; levers: number;
  topAnomaly: { token: string; proto: string; action: FlowAction; usd: number; z: number } | null;
  error?: string;
}
export interface FlowSummary { chains: FlowSummaryChain[] }
