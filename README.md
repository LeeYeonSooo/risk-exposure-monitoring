# Exposure Intelligence

> **렌딩 큐레이터가 실제로 화이트리스팅한 토큰의 멀티체인 익스포저를 정확히 매핑하고, 그 위에서 ~28종 DeFi 리스크를 결정론적으로 탐지·알림하는 시스템.**
> 시뮬레이터가 아니라 *정확한 매핑 + 검증된 알림*이 핵심.

`Node 22 · TypeScript 5.7` · `viem 2 · Multicall3` · `Postgres 16 + TimescaleDB` · `Next.js 15 · React 19 · React Flow` · **Backtest 🟢 GREEN (recall 100% / FP 0%)** · `EVM 3-chain (Ethereum · Base · Arbitrum)`

> [!NOTE]
> Upside Academy 4기 팀 프로젝트. 학습·연구 목적의 리스크 모니터링 프로토타입입니다(투자 자문 아님).

---

## ① 한눈에

DeFi 렌딩 시장에서 가장 큰 손실은 "어떤 토큰이 어디에 얼마나 깔려 있는지"를 아무도 정확히 모른 채 디페그·무담보 민팅·오라클 동결이 조용히 누적되다 터질 때 발생한다. **Exposure Intelligence**는 이 사각지대를 두 단계로 메운다.

1. **정확한 매핑** — Aave / Compound / Morpho / Spark / Fluid 등 렌딩·CDP 프로토콜이 *실제로* 담보로 채택한 토큰을, 온체인 read(viem + Multicall3)와 Morpho GraphQL · DeFiLlama로 토큰 → 프로토콜 → 마켓/풀 → 큐레이터까지 이분 그래프(bipartite graph)로 매핑한다.
2. **검증된 알림** — 그 매핑 위에서 디페그·무담보 공급·무한 민팅·가치 유출·하드코딩 오라클 전환 등 ~28종 리스크를 **결정론적 룰 엔진**(LLM 아님)으로 탐지하고, 모든 임계값은 35개 라벨된 과거 실제 사건으로 백테스트해 보정한다.

| 누구를 위한 것인가 | 무엇을 주는가 |
|---|---|
| 리스크 분석가 / 큐레이터 | 토큰별 익스포저 그래프 + Tier 0 위험 판결 + bad-debt at-risk 곡선 |
| 프로토콜 거버넌스 | 담보 채택·오라클 변경·무담보 민팅 실시간 경보 (Discord / Telegram / webhook) |
| 보안·리서치 | 라벨된 35개 익스플로잇 사건 라이브러리 + 결정론적 회귀 하니스 |

**핵심 설계 원칙: zero-cost 기본**(무료 RPC·API + 로컬 Postgres, 유료·채널·배포는 전부 opt-in)이며, **읽기(프론트)와 쓰기(cron)가 완전히 분리**되어 cron을 켜지 않아도 마지막 스냅샷으로 화면이 온전히 동작한다 — 발표·데모 친화적.

---

## ② 핵심 기능

- **익스포저 매핑** — 토큰 → 프로토콜 → 마켓/풀 → 큐레이터를 잇는 bipartite 그래프. 9개 프로토콜 어댑터(aave-v2 / aave-v3 / aave-v3-family / compound-v3 / spark / fluid / morpho-blue / generic-balance)로 정규화.
- **~28종 결정론적 탐지기** — 디페그(자산클래스별 band + 부호 인식)·무담보 공급(Detector A)·무담보 민팅(Detector B)·가치 드리프트·하드코딩 오라클 전환·IRM/마켓 변경·의심 담보 채택·bad debt·고래 unwind·유동성 급감·큐레이터 디리스킹 등.
- **브릿지 mint 권한 토폴로지** — xERC20 · MINTER_ROLE · LayerZero OFT peers · CCIP · Wormhole NTT · Circle CCTP 등 다중 표준을 온체인 순차 프로빙으로 검증하고, **신뢰도를 1급으로 노출**(verified=실선 / estimated=점선 / 추정 mint_event는 "검증"에서 배제).
- **결정론적 백테스트 하니스** — 라벨된 35개 실제 사건을 production 알림 함수에 그대로 replay해 recall/FP를 측정. 임계값 변경 시 회귀를 자동으로 잡는 안전망(CI 게이트로 사용 가능, exit code 연동).
- **동심원 리스크 그래프** — React Flow 기반 체인별 동심원 레이아웃 + Tier 0 위험 판결(위험/주의/안전) + 담보 −p% 하락 시 underwater debt를 계산하는 bad-debt at-risk 곡선.
- **운영·알림** — severity별 쿨다운 dedup(critical 1h / warning 12h / info 24h), Discord·Telegram·webhook 채널(미설정 시 no-op), launchd 상시 구동, cloudflared / Vercel+Neon 배포 경로.

---

## ③ 아키텍처

DB를 단일 진실 원천(single source of truth)으로 삼아 **쓰기(automation cron) ↔ 읽기(Next.js 프론트)를 완전히 디커플링**한 3-tier 구조. 별도 백엔드/API 서버가 없고, 프론트가 Postgres를 직독한다.

```
┌─ TIER 1 ── automation/  (Node 22 + tsx, TypeScript 5.7, ESM) ───────────────────┐
│   viem + Multicall3 (Alchemy 우선 → publicnode 무료 폴백)                          │
│   Morpho GraphQL · DeFiLlama        getLogs 는 항상 publicnode 전용               │
│   cron(scripts/cron.ts) → 다수 스냅샷 루프 (스태거 스케줄, 기본 OFF)               │
│   결정론적 룰 엔진 (snapshot/diff.ts · Detector A/B) · 9개 프로토콜 어댑터          │
└──────────────────────────────────────────┬───────────────────────────────────────┘
                                            │  pg INSERT / UPSERT
┌─ TIER 2 ── Postgres 16 + TimescaleDB  (docker wbtc-db, :5433) ───────────────────┐
│   nodes / edges (bipartite, token→protocol)   alerts (severity·kind·source)       │
│   supply_samples · chain_supply_samples (hypertable, 가치 시계열)                  │
│   bridge_authorities · mint_burn_ledger · vault_allocations · watchlist …          │
└──────────────────────────────────────────┬───────────────────────────────────────┘
                                            │  pg SELECT  (프론트 /api/* 직독, 백엔드 무경유)
┌─ TIER 3 ── frontend/  (Next.js 15 App Router + React 19 + React Flow) ───────────┐
│   API 라우트 22개 (전부 pg 직독)   동심원 그래프 · Tier0 판결 · at-risk 곡선        │
│   페이지: / · /token/[symbol] · /multi · /explore                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **읽기/쓰기 분리** — cron(쓰기)을 켜지 않아도 마지막 스냅샷으로 프론트(읽기)가 완전 동작. 데모는 DB + 프론트만 있으면 끝.
- **RPC 정책** — 일반 read는 Alchemy 우선 → publicnode 폴백(키 없이도 동작, 비용 0). `getLogs`(이벤트 스캔)는 Alchemy 무료티어 10블록 제한을 피해 항상 publicnode 전용. 깊은 과거는 선택적 유료 `ARCHIVE_RPC_URL`.
- **알고리즘 swap** — 모든 알림은 `insertAlert({…, source})` 계약(builtin-v1 / backing-v1 / mintburn-v1 / valuedrift-v1 / baddebt-v1)을 따라, detector 알고리즘 교체를 스키마 변경 없이 추적·교체할 수 있다.

---

## ④ 기술 스택

| 레이어 | 기술 | 비고 |
|---|---|---|
| **수집·탐지 (Tier 1)** | Node 22 · TypeScript 5.7 · tsx 4.19 (ESM, 빌드 스텝 없음) | 의존성이 얇은 스크립트 파이프라인 |
| 온체인 read | viem 2.21 · **Multicall3** (`0xcA11…CA11`) | 토큰당 1콜 배칭, `allowFailure`로 per-call 실패 흡수 |
| 오프체인 소스 | Morpho GraphQL · DeFiLlama · (선택) DeBank | breadth/TVL·큐레이터 커버리지 |
| 자동화 | Playwright 1.60 · dotenv · pg 8.13 | 스크레이프·DB 적재 |
| **저장소 (Tier 2)** | Postgres 16 + **TimescaleDB** (`timescale/timescaledb:latest-pg16`) | Docker, 포트 5433, hypertable 4개 |
| **프론트 (Tier 3)** | Next.js 15.1 App Router · React 19 | API 라우트가 pg 직독 |
| 시각화 | **@xyflow/react 12.4 (React Flow)** · d3-force · framer-motion | 동심원/트리/de-overlap 레이아웃 자체 구현 |
| 스타일·테스트 | Tailwind v4 · **Vitest 4.1** | 중심성(PageRank) 등 단위 테스트 |
| 부수 모듈 | bridge-detect (Python, 비-EVM 8체인) | 팀원 분리 모듈 |

---

## ⑤ 탐지 능력 / 커버리지

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

## ⑥ 검증·성과

**결정론적 백테스트 하니스가 이 프로젝트의 핵심 검증 자산이다.** 라벨된 과거 실제 사건을 production 알림 함수(`depegSeverity` · `reconcile` · `evaluateBacking` 등)에 그대로 replay해 precision/recall을 측정한다 — ML이 아닌 룰베이스 시스템을 "데이터로 검증 가능"하게 만든 설계.

`cd automation && npm run backtest` 실행 결과 (재현 확인):

```
═══ 백테스트 스코어보드 (DEPEG·LARGE_SINGLE_MINT·TOTAL_SUPPLY_SPIKE·UNMATCHED_MINT·UNBACKED_SUPPLY) ═══
사건 35개 · case 81개 (구동채점 67 / 미구동 14 · 부분커버 4)
  ✓ PASS 67  ·  ✗ MISS(FN) 0  ·  ✗ FORBIDDEN(FP) 0
  recall 100.0%  ·  FP rate 0.0%  ·  결과: 🟢 GREEN
```

| 지표 | 값 |
|---|---|
| 라벨된 사건 | **35개** (2020 AMPL ~ 2026 USR, depeg·무담보·오라클 조작·bad debt + 컨트롤군) |
| 채점 case | 81개 (구동채점 67 / 미구동 14 / 부분커버 4) |
| **recall (FN 0)** | **100.0%** |
| **FP rate (FORBIDDEN 0)** | **0.0%** |
| 명시적 control/baseline 디렉터리 | 7개 (AMPL 리베이스 · GHO 소프트페그 · crvUSD · USDC organic growth · USDe CEX wick · RWA above-peg 등 FP-trap) |

- **measured-data 앵커링** — 임계값은 손으로 단언하지 않고 온체인 실측에 맞춘다. 예: 디페그 catastrophic을 0.10 → **0.085**로 재보정(USD0++ 실측 on-chain trough 9.02%에 맞춤, 8.5~10% 구간에 다른 사건·컨트롤 없음).
- **고난도 시나리오** — dedup/쿨다운 재생, persistence-escalation(단일 폴 HIGH → 2폴 corroborated CRITICAL), FP-trap(in-flight bridging skew는 침묵)까지 비자명 케이스를 커버.
- **정직한 부분 커버리지** — 스냅샷 입력이 없는 신호(ORACLE_FREEZE·UTIL·WHALE·BAD_DEBT 등)는 recall 계산에서 정직하게 제외한다. recall 100%는 "구동 가능한 67 case 한정"임을 코드·문서가 일관되게 명시 — 이 정직성이 오히려 신뢰도를 높인다.
- 라벨 입력의 약 86%가 온체인 measured 값(소스 주소·블록 명시), 나머지 asserted는 분리 표기.

---

## ⑦ 빠른 실행

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

---

## ⑧ 화면 / 데모

`presentation/` 디렉터리에 발표 자료와 캡처가 포함되어 있다.

- **발표 슬라이드** — [`presentation/Exposure-Intelligence.pdf`](presentation/Exposure-Intelligence.pdf) / `.pptx` (Playwright 스크린샷 자동화 빌드 파이프라인 `build-deck.cjs` 포함)
- **메인 화면** — `presentation/assets/landing.png` : 좌측 토큰 리스트 + 우측 실시간 알림 피드(디페그·신규 마켓·유동성 급감 등 severity별)
- **토큰 동심원 그래프** — `presentation/assets/token-usde.png`, `rseth-chains.png` : 체인별 동심원에 토큰 → 프로토콜 → 큐레이터, 신뢰도별 엣지 스타일

---

## ⑨ 팀 · 기여

**Upside Academy 4기 팀 프로젝트** (총 35커밋, 8 원격 브랜치로 기능별 협업).

| 작성자 (git) | 커밋 | 담당 영역 (커밋·브랜치 근거) |
|---|---|---|
| `upa4-lia` + `UpsideAkali` *(동일인 추정)* | **12 + 9 = 21** | 전체 스택 토대 · 동심원 관계맵 · 머니레고 오버레이 · 브릿지 권한 탐지(DVN/attester) · 흐름맵 35어댑터 이식 · 설계 문서(MANUAL)·발표자료 |
| `songmyounghun` | 7 | diff.ts 분해 리팩터 · 백테스트 사건 확장 · 스캐너/디텍터 하드닝 · FP 감사 |
| `link` | 6 | EOA flow 그래프 · 지갑 포트폴리오 · Morpho/Compound 상세 패널 |
| `promael` | 1 | Across 브릿지 추가 |

> [!IMPORTANT]
> 작성자 `upa4-lia(lia@upside.center)`와 `UpsideAkali(akali@upside.center)`는 동일 도메인·교차 날짜·동일 작업 영역, 그리고 일부 커밋의 author/committer 교차 등 정황상 **동일인(이연수, akali)으로 강하게 추정**되며 합산 시 팀 최다 기여자다. 다만 git 히스토리가 스쿼시되어 있어 파일 단위 작성자 매핑에는 한계가 있다 — **세부 역할 귀속은 작성자 본인 확인이 필요**하다.

비-EVM 브릿지 탐지 모듈(`automation/bridge-detect/`, Python 8체인)은 팀원 활성 작업으로, 결정 로그에서 일관되게 미수정·보존(G가드) 처리됐다.

---

## ⑩ 보안 · 면책

- 본 프로젝트는 **학습·연구 목적의 프로토타입**이며, 투자 자문·금융 자문이 아니다. 탐지 결과는 참고용이다.
- **zero-cost 기본** — 기본값은 로컬·비용 0. 유료 RPC(archive)·알림 채널·공개 배포는 운영자가 자기 크리덴셜로 직접 opt-in한다(자동화가 토큰을 대신 채우지 않는다).
- 민감정보 주의 — `ALCHEMY_API_KEY` · `DISCORD_WEBHOOK_URL` · `TELEGRAM_BOT_TOKEN` · `DEBANK_ACCESS_KEY` 등은 `.env`(git 미추적)로만 주입하고 커밋하지 않는다.
- 알림 발송 실패는 삼켜 메인 파이프라인을 비차단하며, 미설정 채널은 no-op로 동작한다.
- 구 Python "contagion simulator"(`attic/`)는 라이브 무참조 죽은 코드로, 프로젝트가 시뮬레이터에서 "정확한 매핑 + 검증 알림"으로 피벗한 흔적이다.
