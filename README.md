# Exposure Intelligence

> **렌딩 큐레이터가 실제로 화이트리스팅한 토큰의 멀티체인 익스포저를 정확히 매핑하고, 그 위에서 ~28종 DeFi 리스크를 결정론적으로 탐지·알림하는 시스템.**
> 시뮬레이터가 아니라 *정확한 매핑 + 검증된 알림*이 핵심.

> [!NOTE]
> Upside Academy 4기 팀 프로젝트. 학습·연구 목적의 리스크 모니터링 프로토타

---

## 요약

DeFi 렌딩 시장에서 가장 큰 손실은 "어떤 토큰이 어디에 얼마나 깔려 있는지"를 아무도 정확히 모른 채 디페그,무담보 민팅,오라클 동결이 조용히 누적되다 터질 때 발생한다. **Exposure Intelligence**는 이 사각지대를 두 단계로 메운다.

1. **정확한 매핑** — Aave / Compound / Morpho / Spark / Fluid 등 렌딩·CDP 프로토콜이 *실제로* 담보로 채택한 토큰을, 온체인 read(viem + Multicall3)와 Morpho GraphQL · DeFiLlama로 토큰 → 프로토콜 → 마켓/풀 → 큐레이터까지 이분 그래프(bipartite graph)로 매핑한다.
2. **검증된 알림** — 그 매핑 위에서 디페그·무담보 공급·무한 민팅·가치 유출·하드코딩 오라클 전환 등 ~28종 리스크를 **결정론적 룰 엔진**(LLM 아님)으로 탐지하고, 모든 임계값은 35개 라벨된 과거 실제 사건으로 백테스트해 보정한다.

| 누구를 위한 것인가 | 무엇을 주는가 |
|---|---|
| 리스크 분석가 / 큐레이터 | 토큰별 익스포저 그래프 + Tier 0 위험 판결 + bad-debt at-risk 곡선 |
| 프로토콜 거버넌스 | 담보 채택·오라클 변경·무담보 민팅 실시간 경보 (Discord / Telegram / webhook) |
| 보안·리서치 | 라벨된 35개 익스플로잇 사건 라이브러리 + 결정론적 회귀 하니스 |

---

## 핵심 기능

- **익스포저 매핑** — 토큰 → 프로토콜 → 마켓/풀 → 큐레이터 순으로 잇는 의존성 그래프. 9개 프로토콜 어댑터(aave-v2 / aave-v3 / aave-v3-family / compound-v3 / spark / fluid / morpho-blue / generic-balance)로 정규화
- **결정론적 탐지기 및 알림** — 디페그(자산클래스별 band + 부호 인식)·무담보 공급(Detector A)·무담보 민팅(Detector B)·가치 드리프트·하드코딩 오라클 전환·IRM/마켓 변경·의심 담보 채택·bad debt·고래 unwind·유동성 급감·큐레이터 디리스킹 등.
- **브릿지 mint 권한 토폴로지** — xERC20 · MINTER_ROLE · LayerZero OFT peers · CCIP · Wormhole NTT · Circle CCTP 등 다중 표준을 온체인 순차 프로빙으로 검증하고, **신뢰도를 1급으로 노출**(verified=실선 / estimated=점선 / 추정 mint_event는 "검증"에서 배제).
- **결정론적 백테스트 하니스** — 라벨된 35개 실제 사건을 production 알림 함수에 그대로 replay해 recall/FP를 측정. 임계값 변경 시 회귀를 자동으로 잡는 안전망(CI 게이트로 사용 가능, exit code 연동).
- **동심원 리스크 그래프** — React Flow 기반 체인별 동심원 레이아웃 + Tier 0 위험 판결(위험/주의/안전) + 담보 −p% 하락 시 underwater debt를 계산하는 bad-debt at-risk 곡선.
- **운영/알림** — severity별 쿨다운 dedup(critical 1h / warning 12h / info 24h), Discord·Telegram·webhook 채널(미설정 시 no-op), launchd 상시 구동, cloudflared / Vercel+Neon 배포 경로.



---

## 기술 스택

| 레이어 | 기술 | 비고 |
|---|---|---|
| **수집·탐지 (Tier 1)** | Node 22 · TypeScript 5.7 · tsx 4.19 (ESM, 빌드 스텝 없음) | 의존성이 얇은 스크립트 파이프라인 |
| 온체인 read | viem 2.21 · **Multicall3** (`0xcA11…CA11`) | 토큰당 1콜 배칭, `allowFailure`로 per-call 실패 흡수 |
| 오프체인 소스 | Morpho GraphQL · DeFiLlama · (선택) DeBank | breadth/TVL·큐레이터 커버리지 |
| 자동화 | Playwright 1.60 · dotenv · pg 8.13 | 스크레이프·DB 적재 |
| **저장소** | Postgres 16 + **TimescaleDB** (`timescale/timescaledb:latest-pg16`) | Docker, 포트 5433, hypertable 4개 |
| **프론트 ** | Next.js 15.1 App Router · React 19 | API 라우트가 pg 직독 |
| 시각화 | **@xyflow/react 12.4 (React Flow)** · d3-force · framer-motion | 동심원/트리/de-overlap 레이아웃 자체 구현 |
| 스타일·테스트 | Tailwind v4 · **Vitest 4.1** | 중심성(PageRank) 등 단위 테스트 |
| 부수 모듈 | bridge-detect (Python, 비-EVM 8체인) | 팀원 분리 모듈 |

---

## 탐지 능력 / 커버리지

모든 임계값은 단일 파일 `automation/src/config/alert-thresholds.ts`에 외부화되어 있고, `classifyAsset(symbol)`이 자산 클래스(major / stable / stable_soft / pendle_pt / lst / rwa / altcoin)로 분기한다 — detector 코드는 불변, config만 튜닝.

| 탐지기 | kind (대표) | 심각도 | 핵심 근거 / 로직 |
|---|---|---|---|
| **디페그** | `depeg` | info → critical | 자산클래스별 band(stable 0.5% · stable_soft 5% · pendle_pt 8% · lst/rwa 2%) + **부호 인식**(peg 위=프리미엄은 WARN 상한, 아래만 catastrophic) |
| **무담보 공급** (Detector A) | `unbacked_supply` | high → critical | 크로스체인 불변식 `Σremote ≤ backing + slack`. 무담보 방향만 알림 → 정상 인플라이트는 FP 0 |
| **무담보 민팅** (Detector B) | `unmatched_mint` | high | 크로스체인 mint↔burn 금액 + 30분 창 매칭, 미정합 mint = 의심. 검증된 bridge_authorities를 allowlist 동적 시드로 재사용 |
| **가치 드리프트** | `value_drift` | info → critical | NAV×supply 총가치 24h peak 대비 낙폭(10/25/40%) + **$10M 절대 게이트**. 순수함수(백테스트 가능) |
| **하드코딩 오라클 전환** | `oracle_hardcoded_switch` | critical | 라이브 피드 → ORACLE_FREE 전환 = 가격 동결 → 청산 미발화 → bad debt. 단 **RWA는 정상 설계라 warning 다운그레이드** |
| 오라클 변경/정지/staleness | `oracle_changed` · `oracle_paused_suspect` · `oracle_stale` | warning → critical | 온체인 introspect + heartbeat 측정 기반 재보정 |
| 공급 스파이크 / 단일 민트 | `supply_spike` · `supply_single_mint` | flag → critical | provenance 우선, 리베이스(|Δ|≤50%) 억제 |
| 담보 채택 / 신규 마켓 | `collateral_adoption` · `new_market` | minor → critical | 저신뢰 + long-tail 담보는 critical 승격 |
| bad debt | `bad_debt_threshold` | actionable($1M) → high($50M) | underwater debt 누적 |
| IRM / 유동성 / 고래 | `irm_changed` · `liquidity_drop_*` · `whale_unwind` · `curator_derisk` · `utilization_jump` | 각 임계 | 컨트랙트·유동성 변화 |

> **신뢰도 정직성** — 추정(estimated)은 검증(verified)과 명시적으로 구분하고, 출발 체인을 증명하지 못하는 입자는 엣지에 태우지 않는다(출처 날조 방지). 약한 추정 휴리스틱(예: 재담보 루프 ouroboros)은 검증 후 정직하게 제거됐다.


---

## 빠른 실행

> 상세 실행/운영 가이드는 [RUN.md](RUN.md), 전체 설계·데이터 모델·결정 로그는 [MANUAL.md](MANUAL.md) 참조.

**데모만 (RPC 0, 가장 흔함)** — DB + 프론트만 띄우면 마지막 스냅샷으로 완전 동작:

```bash
# ① DB (TimescaleDB)
cd automation && docker compose up -d            # wbtc-db, :5433

# ② 프론트엔드
cd ../frontend && npm install
npm run build && PORT=3000 npm run start          # → http://localhost:3000
```

**DB가 비어 있을 때 (최초 1회 데이터 적재 + 검증)**:

```bash
cd automation && npm install
npm run init-db          # 마이그레이션 (테이블 생성)
npm run snapshot:all     # 첫 스냅샷 (RPC 1회 → DB 적재)
npm run backtest         # 탐지기 회귀 검증 → 🟢 GREEN
```

**라이브 모니터링 (선택, 데이터 계속 갱신 = RPC 쏘는 유일한 곳)**:

```bash
cd automation && npm run cron    # 스냅샷 루프 주기 실행 (기본 OFF)
```

| 프로세스 | 명령 | 포트 | 필수 ENV |
|---|---|---|---|
| DB | `docker compose up -d` (automation/) | 5433 | (compose 내장) |
| 프론트 | `PORT=3000 npm run start` (frontend/) | 3000 | `DATABASE_URL` |
| cron | `npm run cron` (automation/) | — | `DATABASE_URL` · `ALCHEMY_API_KEY`(권장) |

