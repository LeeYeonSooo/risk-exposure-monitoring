# 흐름맵 v2 — 실시간 상황판 (Flow Situation Board) 스펙

> 2026-06-10. 흐름맵 탭 전면 교체. 기존 보유 보드(FlowBoard)는 폐기, 레버리지 루프 뷰는 서브로 유지.

## 1. 한 줄 정의

**시장 전체(멀티토큰)의 토큰↔프로토콜 자금 흐름 중, 평소(baseline) 대비 비정상인 흐름만
발화시켜 보여주는 동심원 상황판.** 평시엔 구조 지도(흐림), 사건 시엔 어디가 불붙었는지
한눈에 보이는 상황판이 된다.

설계 원칙 (이번 세션 평가에서 확정):
1. **이상치만 렌더** — 원시 흐름의 99.99%는 정상. 흐름 자체를 그리는 건 Arkham/Bitquery 레드오션.
   가치는 "평소와 다른 곳"을 surface하는 데서만 나온다.
2. **집계 추론 금지, tx 단위 이벤트 페어링** — "wstETH 유입 + WETH 유출 = 담보→차입"을
   집계로 추정하면 생태학적 오류. 같은 tx 안의 `Supply(wstETH)`+`Borrow(WETH)` 이벤트
   페어만 "레버 액션"으로 인정한다 (이 세션에서 실제 tx 디코딩으로 검증한 방법).
3. **상태(노드) + 흐름(엣지) 동시 인코딩** — rsETH 사건의 신호는 "인출 흐름 급증(엣지)" →
   "가동률 100%(노드 상태)"의 시간차. 엣지만으론 스토리가 반쪽.
4. **고정 동심원 배치** — 토큰은 안쪽 링, 프로토콜은 바깥 링, 위치 불변 → 공간 기억이 생겨
   "어디가 달라졌는지"가 즉시 보인다 (force-directed 금지).

## 2. 페르소나와 핵심 질문

투자자/운용사(예: Hyperithm)와 리스크 큐레이터. 답하려는 질문:
- "지금 이 순간, 시장 어디에서 평소와 다른 자금 이동이 벌어지고 있나?"
- "그 이동이 담보→차입(레버 증설)인가, 인출 러시(뱅크런)인가, 디레버리징(언와인드)인가?"
- "내가 보는 토큰(페이지 토큰)이 그 사건에 엮여 있나?"

## 3. 화면 설계

```
┌────────────────────────────────────────────────┬──────────────────┐
│        (SVG 보드)                              │  우측 레일        │
│            바깥 링 = 프로토콜                   │  ⚠ 이상 흐름 N건  │
│        Aave V3   Aave Prime   Spark   Morpho   │   · WETH←Aave    │
│            ↑발화 시 링 펄스(상태)               │     인출 $48M     │
│        안쪽 링 = 토큰 (16개 고정)               │     baseline×12   │
│     WETH wstETH weETH rsETH … USDC USDT sUSDe  │  ↻ 레버 경로 Top  │
│                                                │   · wstETH↦Aave  │
│   엣지: 토큰↔프로토콜 방향별 곡선 한 쌍          │     ↦WETH $2.1M  │
│   평시=흐린 회색(구조), 이상치=색+대시 애니       │  메타(윈도우·갱신) │
└────────────────────────────────────────────────┴──────────────────┘
```

### 시각 인코딩

| 요소 | 인코딩 |
|---|---|
| 토큰 노드 (안쪽 링) | 아이콘+심볼. 페이지 토큰 = 강조 링. 이상 유출 연루 시 빨간 링 |
| 프로토콜 노드 (바깥 링) | 아이콘+이름. 상태 링: 정상 회색 / 주의(z≥2) 호박 / 위험(z≥3.5) 빨강 + 회전 대시(`cs-flow-dash`) |
| 유입 엣지 (토큰→프로토콜) | supply 파랑 `#2563eb` / repay 청록 `#0d9488` |
| 유출 엣지 (프로토콜→토큰) | withdraw 빨강 `#dc2626` / borrow 주황 `#ea580c` |
| 평시 엣지 | `#cbd5e1` 가는 선 (구조 레이어 — 빈 화면 방지) |
| 이상치 엣지 | 액션 색 + 두께=sqrt(USD) + 대시 애니메이션(`fb-dash-f/r`) |
| 레버 페어 | 보라 `#9333ea` 2-세그먼트 경로: 담보토큰 → 프로토콜 → 차입토큰 (한 붓) |
| 굵기 | sqrt(최근 15분 USD), 캡 적용 |

- **엣지 표시 필터**: (a) 해당 토큰 윈도우 거래량 점유율 ≥ 1% (`SHARE_MIN`, 조정 가능) 또는 (b) 이상치 판정. 둘 다 아니면 숨김 — 사용자가 제안한 1% 컷.
- **평시 상태**: 이상치 0건이면 "정상 — 이상 흐름 없음" 배지 + 구조 레이어만. 빈 화면 문제 없음.
- 호버: 엣지/노드 → 수치 툴팁(15분 USD, baseline 중앙값, ×배수, z). 우측 레일 행 호버 ↔ 보드 강조 동기화.
- **격리 = 호버(임시) + 클릭 고정(pin)**: 노드/엣지/레버 클릭 → 다시 클릭하거나 배경을 클릭할
  때까지 격리 유지(화살표 선택이 쉬움). 레일 행 클릭도 동일하게 pin.
- **격리에 구조선은 안 띄움**: 격리 시 보이는 건 발화(systemic·whale 상위)·레버 페어뿐 —
  회색 구조선은 격리해도 흐림 유지(요청 반영). 평시 구조선 0.12 로 더 흐리게.
- **보드 과밀 방지**: whale 은 보드에 상위 5개만 색칠(WHALE_BOARD_MAX), 나머지는 레일 목록에만.
- 토큰 링 간격: 반지름 184 + 홀짝 ±13 스태거(59노드), 라벨은 중심 방향 방사형.

## 4. 데이터 파이프라인

### 4.1 소스 (v1)

| 소스 | 방법 | 커버 |
|---|---|---|
| Aave V3 Core Pool | `eth_getLogs` — **publicnode** (키 불필요, 1800블록 1콜 1.3s. Alchemy free 는 10블록 제한이라 탈락, mevblocker 폴백) | 메인넷 전 reserve의 Supply/Withdraw/Borrow/Repay |
| Aave V3 Prime(Lido)·EtherFi 인스턴스, Spark | 동일 ABI, 주소만 추가 (4개 모두 코드/로그 프로브 통과 — EtherFi 는 조용함) | LST 레버의 본진 |
| Morpho Blue | GraphQL `transactions` (assetsUsd 가 이미 USD. 1000건×최대 8페이지, 잘림 시 meta.errors 에 표기. 체인 로그 직결은 2단계) | wstETH/WETH 97% 마켓 등 |
| Compound V3 | Comet 3개(cUSDCv3/cWETHv3/cUSDTv3) `eth_getLogs`. base Supply/Withdraw + SupplyCollateral/WithdrawCollateral 토픽을 **selector→로그 역산으로 확정**. base 인출은 차입과 혼재(방향만 정확) — borrow 분리·lever 페어 제외(정직) | wstETH/cbBTC 담보 루프 |
| Fluid | Liquidity 싱글톤 1주소(공식문서+Etherscan 라벨 확정). 단일 이벤트 `LogOperate` 가 **부호로 4액션**(supply±/borrow±) — 실로그 256건으로 의미 검증. ⚠ actor=상위 프로토콜 컨트랙트 → 주체 수 과소집계(systemic 게이트 보수적) | USDC/USDT 대형 차입·상환 |
| Euler v2 | 볼트 841개 — **목록**은 코드베이스 기존 Goldsky 서브그래프(6h 캐시), **흐름은 온체인**(서브그래프 이벤트 인덱싱 7.7일 지연 실측 → 흐름엔 사용 금지). 4토픽은 하네스로 활동볼트 2개 프로브해 실증. getLogs 주소배열 841개는 mevblocker 만 허용(publicnode 403, 실측) | PYUSD·AUSD·BOLD 마켓 |
| Uniswap V3 (DEX) | 풀을 **팩토리에서 유도**(레지스트리 토큰 × WETH/USDC/USDT/WBTC × 수수료 4단계, 배치 eth_call ~900콜·6h 캐시 — 주소 추측 0). 팩토리는 getPool→token0/token1/fee 정합으로 구성적 자기검증. Swap 토픽 하네스 실증. amount **>0 = 풀로 유입(매도)** | 디페그 덤핑·대형 스왑 흐름 |
| Uniswap V4 (DEX) | PoolManager 싱글톤(이 세션 실거래 receipt 관측 주소). poolId 맵 = Initialize 에 **레지스트리 주소 topic2/3 필터** → 전이력 1콜·2,622풀·4.3s(실측). ⚠ Swap 부호가 **V3와 반대**(>0 = 풀에서 유출=매수) — Transfer 로그 대조 3/3 실증. 네이티브 ETH=address(0)→"ETH". 600블록당 ~8.5k 스왑이라 3청크 수집 | 최대 볼륨 DEX ($167M/6h 실측) |
| Curve (DEX) | 풀 목록·coins(주소/decimals)는 **공식 API 5개 레지스트리**(TVL≥$300K, 6h 캐시). TokenExchange 두 변형(legacy/ng + crypto) 토픽을 활동 풀 하네스 프로브로 실증 — 레이아웃 동일(data=[sold_id, tokens_sold, bought_id, tokens_bought]). TokenExchangeUnderlying(메타풀)은 v1 미지원(정직 제외) | 디페그 본진 — ETH/stETH $67M 풀 등 |
| Balancer (DEX) | Vault 싱글톤 — Swap 토픽에 **tokenIn/tokenOut 이 직접**(idx2/3, 풀맵 불필요). 주소는 이벤트 믹스+볼륨으로 구성적 검증 | 메인넷 활동 미미($20K/6h 실측 — 그대로 표시) |

**DEX 공통 규칙**: sender/recipient/buyer = 라우터·애그리게이터 → 실주체 식별 불가 →
**systemic 판정 제외**(레일에 "라우터 경유 — 주체식별불가" 명시), 볼륨 z 이상(z≥3.5, 실 baseline)
∧ ≥$2M 만 whale(정보)로. DEX sell/buy 는 레버 페어링에서도 제외.
| 가격 | `coins.llama.fi/prices/current` 배치 1콜, 5분 캐시. 네이티브 ETH(Fluid)는 WETH 가격 준용(1:1 wrap) | Aave·Compound·Fluid·Euler·UniV3 USD 환산 |

**프로토콜 추가 하네스** — `scripts/probe_protocol.py`: 주소만 주면 getLogs→distinct topic0→
openchain 시그니처 DB 벌크 조회→shape(indexed/words)→(--selectors) 함수↔이벤트 교차증거→TS 매핑
후보 출력. Aave 정답지 재현으로 자기검증(8/8), Fluid·Euler 를 이걸로 추가(각 ~15분). 의미 판단
("이 Withdraw 가 인출인가 차입인가")은 사람 몫 — 하네스는 증거만.

**노드 커버리지(고정 링)** — 활동 유무와 무관하게 *지원하는 전체*를 항상 렌더:
- 안쪽 링 = 추적 토큰 **59종** = 기존 29 + 네이티브 ETH + 관계맵 우주(DeFiLlama top TVL)에서
  주소 해석→**온체인 symbol()/decimals() 배치 검증 통과 29종**(생성 스크립트 출력 그대로 — 손 타이핑 금지).
  idle 은 작은 점, 활동분은 크게+방사형 스태거 라벨.
- 바깥 링 = 흐름 디코딩 **12 프로토콜** = 렌딩 8(Aave Core/Prime/EtherFi · Spark · Morpho ·
  Compound V3 · Fluid · Euler) + DEX 4(Uniswap V3/V4 · Curve · Balancer).
- **흐름 커버리지 < TVL 커버리지**(정직성): 관계맵의 DEX/스테이킹/CDP(Uniswap·Lido·Maker 등)는
  렌딩 액션 의미가 달라 이 보드의 4액션 모델 밖 — Maker CDP(비표준 LogNote)·Curve LlamaLend 가
  다음 후보(하네스로 ~15분/패밀리).

단일 싱글톤 컨트랙트에 전 자산 이벤트가 모이므로(풀 하나 = 모든 reserve) getLogs 몇 번으로
시장 전체가 커버된다 — 토큰별 Transfer 스캔 불필요. **이벤트 토픽 상수는 메모리가 아니라
온체인 실증으로 고정한다** (알려진 함수 selector로 들어온 tx의 receipt에서 역산 — §7 검증).

### 4.2 이벤트 → 의미 (Aave V3)

| 이벤트 | 방향 | 의미 | 페어링 키 |
|---|---|---|---|
| `Supply(reserve, user, onBehalfOf, amount, ref)` | 토큰→프로토콜 | 예치/담보 추가 | onBehalfOf(topic2) |
| `Withdraw(reserve, user, to, amount)` | 프로토콜→토큰 | 인출 (러시 시그널) | user(topic2) |
| `Borrow(reserve, user, onBehalfOf, amount, mode, rate, ref)` | 프로토콜→토큰 | 차입 (레버 증설) | onBehalfOf(topic2) |
| `Repay(reserve, user, repayer, amount, aTokens)` | 토큰→프로토콜 | 상환 (디레버) | user(topic2) |

### 4.3 tx 페어링 (레버/언와인드 탐지)

같은 `txHash` & 같은 풀 & 같은 주체(topic2) 안에서:
- `Supply(A)` + `Borrow(B)` → **레버 페어** A↦프로토콜↦B (원자적 담보+차입 — 추정 아님, 사실)
- `Repay(B)` + `Withdraw(A)` → **언와인드 페어** (디레버리징)

**기준(확정, UI 에 그대로 표기)** — 레버 = 같은 tx·같은 주체(onBehalf/user)·같은 프로토콜에서
[담보 예치 + *다른* 토큰 차입], 차입 ≥ **$100K**. 언와인드 = 같은 tx·같은 주체의 [상환 + *다른*
토큰 담보 회수], 상환 ≥ $100K. **원자적(한 tx) 페어만 — 추정 없음.** 멀티 tx에 걸친 루프는
포지션 기반인 레버리지 루프 탭 담당. DEX sell/buy 는 페어링에서 제외.
윈도우 합산으로 (담보, 프로토콜, 차입) 튜플별 건수·총액 집계 → Top N 표시.

### 4.4 버킷·베이스라인·이상치 판정 (v2 — 검증으로 재설계)

> **왜 재설계했나(실측 근거):** v1(6h baseline z-score) 은 실데이터에서 4건을 "이상치"로 띄웠는데
> 트랜잭션을 까보니 전부 오탐이었다 — RLUSD 인출 $2M=routine 1건(건강한 $42M 마켓의 4.7%),
> WBTC 인출 $8M=한 주소(0x25D2…)가 99%, USDC repay $4M=같은 주소(디레버=오히려 derisking).
> z-score 단독은 (a) zero-baseline 엣지에 단발 큰 tx, (b) 단일 고래, (c) 정상 고볼륨을 못 거른다.

**v2 분류 게이트** — 흐름을 3종으로:
- **systemic(이상치, 빨강)** = 통계적 비정상(z≥3.5, 실 baseline) **∧ 다수 주체(≥4)**
  **∧ 최대주체 USD 점유 ≤60% ∧ ≥$500K**. run·패닉·coordinated 공격만.
  *USD 가중* 조건은 2차 검증에서 추가 — 머릿수만 세면 고래 1명($53M, 0x3398…)+먼지 3명(≤4 WETH)이
  "다수 주체"로 통과하는 오탐을 실거래로 확인했기 때문. 점유>60% 면 whale 로 강등.
- **whale(대형 단일, 호박)** = 소수 주체(≤3) ∧ (≥$2M ∨ 풀 유동성의 ≥15% 드레인). 포지션 청산·
  리밸런싱 등 — 보여주되 *경보 아님*. (Kelp 식 단일 공격은 여기 잡히고 풀% 로 위중도 표시.)
- **normal** = 나머지(다수 주체 정상 churn 포함 — USDC Morpho $10M/9주체 같은 건 여기).

주체 수·tx 수는 **최근 평가창 안의 이벤트만** 카운트. materiality(풀 대비 %)는 Morpho 는 마켓
state(supply/collateral)로 산출, **Aave/Spark/Compound 는 풀 규모 미조회 → 다수주체+z 로만 게이트**(2단계).

```
WINDOW_BLOCKS = 1800   (≈6시간, 12s/블록)
BUCKET_BLOCKS = 25     (≈5분)  → 72버킷
엣지키 = 토큰 | 프로토콜 | 액션(supply/withdraw/borrow/repay)

시리즈  V[i] = 버킷별 USD 합
평가량  R    = 최근 3개 완결 버킷 합 (≈15분)
히스토리 H   = 롤링 3-버킷 합 전체(stride 1), 최근 3버킷 제외
robust z    = (R − median(H)) / (1.4826·MAD(H) + ε)

이상치 ⇔ R ≥ MIN_USD ∧ ( z ≥ Z_TH ∨ (MAD≈0 ∧ R ≥ 4·max(H)) )
        MIN_USD 기본 $300k (소액 노이즈 컷), Z_TH 기본 3.5 (UI에서 2.5/3.5/5 선택)
```

- median+MAD(평균+σ 아님): 6시간 윈도우에 스파이크 1개만 있어도 평균·σ가 오염되는 것 방지.
- MAD≈0(희소/버스트 엣지 — Morpho 마켓 공급처럼 평소 조용하다 한 번에 오는 흐름)일 땐
  "직전 최대 버스트의 4배" 룰. 이때 z 도 `z = Z_TH·R/(4·max(H))` 로 연속화해
  **클라이언트의 z≥임계 재평가(임계 셀렉터 2.5/3.5/5)가 서버 판정과 정확히 일치**한다.
- 한 토큰·프로토콜에서 in/out 이 동시에 비슷한 규모로 발화 = 볼트 리밸런싱(내부 재배치)
  패턴 → 레일에 `재배치?` 태그 (MetaMorpho reallocation 오탐 완화).
- 레버 페어링: 같은 tx 에 담보 2종+차입 1건이면 차입 1건당 **최대 공급 1개만** 페어
  (cross-product 중복 방지 — sUSDe/USDe 동시 담보 사례에서 실측 후 수정).
- 노드 상태 z: 프로토콜별 유출(withdraw+borrow) 합산 시리즈에 동일 수식. 토큰 노드도 동일.
- **정직한 한계**: 6시간 인메모리 baseline은 일중 계절성(아시아/미국 장)을 모른다. 진짜
  baseline(7일, 시간대별)은 TimescaleDB 적재가 필요 — 2단계. v1은 "직전 6시간 대비 급변"
  탐지기다. 문서·UI에 윈도우를 명시한다.

### 4.5 갱신·캐시

- 라우트 인메모리 캐시 TTL 60s (여러 클라이언트가 폴링해도 RPC 1회/분).
- 클라이언트 60s 폴링(탭 비가시 시 중단) + 수동 새로고침.

## 5. API 계약

`GET /api/flowmap` → (focus 파라미터 없음 — 보드는 시장 전체, 강조는 클라이언트가)

```jsonc
{
  "meta": { "latestBlock": 25285081, "windowBlocks": 1800, "bucketBlocks": 25,
            "fetchedAt": 1760000000, "protocols": ["Aave V3", "Aave Prime", "Spark", "Morpho"],
            "minUsd": 300000, "zTh": 3.5 },
  "tokens": [ { "sym": "WETH", "addr": "0x…", "inUsd": 1.2e6, "outUsd": 4.8e7, "anomalous": true } ],
  "protocols": [ { "name": "Aave V3", "inUsd": …, "outUsd": …, "outZ": 6.2, "state": "danger" } ],
  "edges": [ { "token": "WETH", "proto": "Aave V3", "action": "withdraw", "dir": "out",
               "recentUsd": 4.8e7, "baseUsd": 3.9e6, "z": 9.1, "ratio": 12.3,
               "share": 0.34, "anomalous": true } ],
  "levers": [ { "collat": "wstETH", "proto": "Aave V3", "debt": "WETH",
                "usd": 2.1e6, "count": 3 } ],
  "unwinds": [ /* levers 와 동형 */ ]
}
```

이상치 목록은 클라이언트에서 `edges.filter(anomalous)` 정렬로 파생 (중복 전송 안 함).

## 6. 파일 구조

```
frontend/lib/flowmap.ts                  토큰 레지스트리(주소·decimals)·이벤트 토픽 상수·
                                         버킷/베이스라인 수식·타입 (서버/클라 공용 타입)
frontend/app/api/flowmap/route.ts        getLogs 수집→디코드→페어링→이상치 판정 (60s 캐시)
frontend/components/flowmap/FlowMapBoard.tsx   동심원 보드 + systemic/whale 레일 + hover 격리
```
(demo-fixture.ts 는 폐기 — 가짜 시연 안 함. 과거 시연은 `?ts=` 실데이터 리플레이.)

- 페이지: 흐름맵 서브 = **실시간 상황판(기본) / 레버리지 루프**. 보유 보드는 화면에서 제거
  (FlowBoard.tsx·flow-board.ts 파일은 미연결 상태로 남아 있음 — 완전 삭제는 확인 후).
- API 키 불필요 — publicnode/mevblocker/Morpho/DeFiLlama 모두 무키. (Alchemy 키는 이
  기능엔 안 씀: free tier eth_getLogs 10블록 제한.)

## 7. 검증 계획

1. **토픽 실증**: 최근 블록에서 `to=Pool` & input selector가 `supply/withdraw/borrow/repay`인
   tx를 찾아 그 receipt의 풀 이벤트 topic0를 역산 → 상수로 고정 (메모리 의존 금지).
2. 단순 supply tx(이 세션에서 확보한 `0x61a66130…`)의 amount 디코드가 calldata와 일치하는지.
3. 페어링: 한 tx에 Supply+Borrow가 실제로 같이 찍히는 것 확인(이 세션 `0x53e7ff66…`에서 관측 — Withdraw+Borrow).
4. UI: tsc + dev 서버 + 콘솔/스크린샷.

## 8. 시연 — 가짜 픽스처 폐기, 실데이터 과거 리플레이

**가짜 데모는 제거했다**(의미 없음). 대신 `GET /api/flowmap?ts=<unix>` 로 **그 시각 기준 6h 윈도우를
실제 온체인 데이터로 리플레이**한다. 블록을 ts 에서 역산해 head 앵커로 잡고 *같은 파이프라인*을
돌리므로, 과거 어느 시점이든 진짜 흐름·진짜 분류가 나온다. 보드에 `과거 리플레이 — 블록 N` 배지.
- 검증: `?ts=(now-7200)` → 블록 25285170(현재 −590, ≈2h) 앵커, 동일 분류 동작 확인.
- 특정 인시던트(예: Kelp rsETH)를 재현하려면 그 사건의 **실제 블록/타임스탬프**가 필요하다.
  `data/kelp_dao.json` 은 뉴스 기반 *구조 그래프*라 온체인 좌표(주소·tx·블록)가 없음 → 좌표 확보 시
  `?ts=` 로 바로 재현 가능. (그 전엔 가짜로 시연하지 않는다.)

## 9. 2단계 (이번 범위 아님)

- TimescaleDB 적재 → 7일 시간대별 baseline (계절성), 알림 엔진과 연결(흐름 이상치 → 토스트).
- Morpho Blue 온체인 로그 직결(SupplyCollateral/Borrow 페어링), Euler·Compound 추가.
- 가동률 상태 레이어(프로토콜·마켓별 utilization 폴링 → 노드 상태에 합성).
- 구조 레이어를 윈도우 거래량 점유율 대신 TVL 분포(관계맵과 동일 기준)로 교체 옵션.
