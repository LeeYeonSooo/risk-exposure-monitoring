# 설명서 (MANUAL) — 큐레이터 토큰 익스포저 & 리스크 알림 시스템

> **구현된 모든 것 + 처음부터 재현 + 진행 이력**을 담은 단일 종합 문서(설계·이해·재현·결정로그). 사실 기반(코드와 어긋나면 코드가 정답).
> §2 빠른 시작 = 재현 절차, §3~16 = 상세 레퍼런스, §17 = 진행 이력(결정 로그), §18 = 백로그. (구 BLUEPRINT·ARCHITECTURE·DECISIONS·BACKLOG·threshold-calibration 문서는 이 매뉴얼로 통합됨.)
> 실행·운영(어떤 서버를 띄우나)은 [README.md](README.md).
> 경로는 `risk-exposure-monitoring/` 기준.

## 목차
1. 개요 · 2. 빠른 시작 · 3. 아키텍처 · 4. 데이터 모델 · 5. 자동화 파이프라인 · 6. 탐지기 전체 · 7. 알림 종류 표 · 8. 임계값 레퍼런스 · 9. 브릿지 토폴로지 · 10. 백테스트 · 11. 프론트엔드 · 12. 알림 채널 · 13. 운영 · 14. 스크립트 레퍼런스 · 15. 알고리즘 swap · 16. 한계·후속 · 17. 진행 이력(결정 로그) · 18. 백로그

---

## 1. 개요
**렌딩 큐레이터가 화이트리스팅해 실제로 쓰는 토큰의 멀티체인 익스포저를 매핑하고, 그 위에서 리스크를 결정론적으로 탐지·알림하는 시스템.** 시뮬레이터가 아니라 *정확한 매핑 + 검증된 알림*이 핵심.

탐지하는 리스크: 디페그 · 무담보 공급(Detector A) · 무담보민팅(Detector B) · 공급 스파이크/무한민팅 · **가치 유출(NAV×supply 드리프트)** · 오라클/IRM/마켓 변경 · **하드코딩 오라클 전환** · 신규마켓/**의심 담보채택** · bad debt · 고래 unwind · 유동성 급감 · 큐레이터 디리스킹.

설계 원칙:
1. **Zero-cost 기본** — 무료(Alchemy Multicall3 + Morpho GraphQL + DeFiLlama + publicnode) + 로컬 Postgres. 유료(holder/archive)·채널·공개배포는 전부 opt-in.
2. **DB 가 source of truth** — 프론트가 `/api/*`에서 `pg`로 직독(별도 백엔드 없음).
3. **임계 기반 즉시 모니터링(검토 게이트 없음)** — discovery는 임계(누적 95% 커버리지 · 최소 $1M) 통과 토큰을 `active=true`로 **바로 등록**(자동 모니터링), 임계 미달 시 자동 해제. 수동 `reason='manual'` pin만 discovery가 안 내림. (구버전은 `active=false` 승인 게이트 설계였으나 코드는 즉시 활성 — 본 문서를 코드에 맞춤.)
4. **정밀+breadth 2레이어** — verified(실선)/estimated(점선)/opaque(점점선) 신뢰도 1급 노출.
5. **매직넘버 한 곳** — 모든 임계값은 `src/config/alert-thresholds.ts`.
6. **알고리즘 swap** — 알림은 `insertAlert({…, source})` 계약으로 detector 교체 추적.

규모: 마이그레이션 13 · lib 모듈 17 · snapshot 모듈 10 · 스크립트 25 · 알림 종류 ~28 · 백테스트 사건 35.

---

## 2. 빠른 시작
```bash
# 0) DB (TimescaleDB) — 정의는 automation/docker-compose.yml (wbtc/wbtc_local_pw/wbtc_mapping)
docker compose -f automation/docker-compose.yml up -d   # 컨테이너 wbtc-db, 포트 5433

# 1) automation
cd automation && npm install
cat > .env <<EOF
DATABASE_URL=postgres://wbtc:wbtc_local_pw@localhost:5433/wbtc_mapping
ALCHEMY_API_KEY=<무료 키>        # 없으면 publicnode 폴백
EOF
npm run init-db          # 마이그레이션 적용
npm run snapshot:all     # 첫 스냅샷(active watchlist 토큰)
npm run backtest         # 탐지기 회귀 검증 → GREEN 확인

# 2) frontend
cd ../frontend && npm install
echo "DATABASE_URL=postgres://wbtc:wbtc_local_pw@localhost:5433/wbtc_mapping" > .env.local
npm run build && npm run start   # http://localhost:3000

# 3) (옵션) 연속 모니터링
cd ../automation && npm run cron   # 또는 launchd (§13)
```

---

## 3. 아키텍처 (3-Tier)
```
TIER 1 automation/ (Node 22 + tsx, TypeScript)
  viem + Multicall3 (Alchemy 우선, 없으면 publicnode) · Morpho GraphQL · DeFiLlama — RPC 우선(Dune 폐기, §17 2026-06-12)
  cron(scripts/cron.ts) → 10개 루프(§5 표). getLogs 는 publicnode 전용(Alchemy 무료티어 제한).
        │ pg INSERT/UPSERT
TIER 2 Postgres + TimescaleDB (docker wbtc-db, :5433/wbtc_mapping)
  그래프 nodes/edges(bipartite) · 시계열 hypertable(supply/chain_supply) · alerts · bridge_authorities · mint_burn_ledger …
        │ pg SELECT (프론트 /api/* 직독)
TIER 3 frontend/ (Next.js 15 App Router + React Flow)
  /api/{topology,alerts,dossier,breadth,bridge-authority,…} · 페이지 / · /token/[symbol] · /multi · /explore
  동심원 그래프 + Tier 0 판결 + bad-debt at-risk 곡선
```
- `DATABASE_URL` 은 automation·frontend 동일. 구 Python "contagion simulator" 클러스터는 `attic/`(라이브 무참조, 죽음).
- **RPC 정책**: 일반 read = Alchemy 우선→publicnode. **로그(getLogs) = 항상 publicnode**(`lib/public-rpc.ts`). 깊은 과거 = `ARCHIVE_RPC_URL`(유료, 옵션).

---

## 4. 데이터 모델 (`src/db/migrations/`)
| mig | 테이블 | 컬럼 핵심 | 역할 |
|---|---|---|---|
| 001~002 | `nodes` · `edges` | node_id·type·label·address·chain·metadata / 모든 엣지 token→protocol | bipartite 그래프. 멀티롤은 `classification.roles[]` 중첩(페어당 1엣지) |
| 003,006 | `watchlist` | token_address·symbol·**active**·excluded·reason·discovery_metric_usd | discovery가 임계 통과 토큰을 **active=true로 즉시 등록**(게이트 없음, 미달 시 자동 해제) + admin. **reason='manual'은 discovery가 안 내림** |
| 004,009 | `alerts` | severity·kind·token·protocol_node_id·message·detail(jsonb)·**source** | 알림(§7) |
| 005 | edges 압축/보존 | — | TimescaleDB 정책 |
| 007 | `supply_samples` | snapshot_ts·token_node_id·block_number·**total_supply** | 토큰 공급 시계열(hypertable) |
| 008 | `vault_allocations` | curator·vault_name·chain·collateral·**supply_usd** | 큐레이터/볼트별 담보 배분(depositor 측) |
| 010 | `loop_findings` | kind·collateral_symbol·loan_symbol·looped_usd·lltv·confidence | 루핑 후보(structural-v1) — ouroboros writer 제거로 현재 미적재 |
| 011 | `chain_supply_samples` | snapshot_ts·token_node_id·chain·total_supply·**supply_usd** | 체인별 공급+**가치** 시계열 → 가치-드리프트(§6.6) 입력 |
| 012 | `wallet_tracking` | 추적 지갑 밸류 | 자금 이탈 감시 |
| 013 | `bridge_authorities` | token·chain·**bridge_addr·auth_type**·mint_limit·note | 검증된 브릿지 mint 권한(§9) |
| 014 | `mint_burn_ledger`(+`mint_burn_cursor`) | token·chain·tx_hash·kind(mint/burn)·amount·event_ts | Detector B 원장(§6.4) |
| — | `snapshot_runs` | cron 실행 감사로그 | 매 실행 INSERT |

핵심 불변: **모든 엣지 token→protocol** · discovery는 임계 통과 시 즉시 active=true 스냅샷(승인 게이트 없음) · 무료·배치 우선.

---

## 5. 자동화 파이프라인 (`scripts/cron.ts`)
즉시 1회 + 주기. 기본 **OFF**(비용 안전). 켜기 = `npm run cron` 또는 launchd(§13).

| 루프 | 주기 | 스크립트 | 산출 |
|---|---|---|---|
| `loop`(스냅샷) | 20분 스태거(체인별) | snapshot-chain | nodes/edges + **diff 알림** |
| `discoveryLoop` | 1일 | discover | watchlist(임계 통과 → active=true 즉시 등록) + Discord 요약 |
| `curatorLoop` | 30분 | snapshot-curators | vault_allocations |
| `chainSupplyLoop` | 1시간 | snapshot-chain-supply | chain_supply_samples(가치 시계열) |
| `walletLoop` | 2시간 | snapshot-wallets | wallet_tracking(자금 이탈) |
| `bridgeAuthLoop` | 6시간 | snapshot-bridge-authority | bridge_authorities(§9) |
| `backingLoop`(Detector A) | 1시간 | snapshot-backing | unbacked_supply 알림 |
| `mintburnLoop`(Detector B) | 1시간 | snapshot-mintburn | mint_burn_ledger + unmatched_mint |
| `valueDriftLoop` | 1시간 | snapshot-value-drift | **value_drift 알림(P2-6)** |
| `reflexivityLoop` | 1시간 | snapshot-reflexivity | **사기 루핑 grade**(loop_findings reflexivity-v1) → dossier.loops → 프론트 Tier0·상세그래프 |

---

## 6. 탐지기 전체 레퍼런스
모든 임계값은 `src/config/alert-thresholds.ts:RECOMMENDED_THRESHOLDS`. `classifyAsset(symbol)`이 자산클래스로 분기. **백테스트(§10)로 보정**.

### 6.1 자산 클래스 (`classifyAsset`)
`major`(ETH/WBTC) · `stable`(USDC/USDT/DAI 하드페그, 타이트) · `stable_soft`(GHO/mkUSD/crvUSD/USD0++ 소프트·CDP, 넓음) · `pendle_pt`(만기전 할인 PT) · `lst`(stETH/weETH/…) · `rwa`(USYC/OUSG/…) · `altcoin`(long-tail/미분류).

### 6.2 디페그 (`depegSeverity`, `diff.ts:checkDepeg`) — kind `depeg`
- 입력 `belowPegFraction=(1-price)`: **양수=peg 아래**(catastrophic 가능), **음수=peg 위**(프리미엄/수익누적 → WARN 상한).
- 규칙: `|dev|<band/2`→무알림 · `≥band/2`→info · `≥band`→warning · (아래∧`≥catastrophic 0.085`)→**critical**.
- band(분수): major 0.0075 · stable 0.005 · **stable_soft 0.05** · **pendle_pt 0.08** · lst/rwa 0.02 · altcoin 0.05.

### 6.3 무담보 공급 — Detector A (`snapshot/supply-backing.ts`, `snapshot-backing.ts`) — kind `unbacked_supply` · source `backing-v1`
- 불변식 **Σremote(+home if burn&mint) ≤ backing + slack**. **무담보 방향만** 알림(정상 인플라이트는 over-backed → FP 0).
- backing 자동 watch: `bridge_authorities`의 xERC20 lockbox(ERC20() canonical) + `nodes`의 모든 체인 Σtotal_supply. 멀티체인 집계 내장.
- severity: stale=info · overageBps≥`criticalBps(100)`→critical · 그 외 warning. tolerance 50bps·settlement 30분·2폴 지속.
- 백테스트 검증: Wormhole(2022)·xUSD(2025) 무담보 사건 GREEN. ⚠️ 라이브 활성은 lock&mint(xERC20 lockbox) 토큰 필요.

### 6.4 무담보민팅 — Detector B (`snapshot/mint-burn-recon.ts`, `snapshot-mintburn.ts`) — kind `unmatched_mint` · source `mintburn-v1`
- 크로스체인 **mint↔burn을 금액+시간창(30분)** 매칭. 창 지나도 미정합 mint = 무담보민팅 의심(Kelp rsETH류).
- 입력: publicnode getLogs(Transfer from/to 0x0) + 증분 커서 + 7일 보존.
- FP 컷: ① 구조적 가드(일시 미정합 무시 — 2×window 지속 또는 backing 동반일 때만) ② **allowlist**(정적 + **동적 시드**: `verifiedMintersFor`가 검증된 `bridge_authorities` 주소 제외).
- backing 불일치(Detector A) 동반 시 **critical 승격**.

### 6.5 공급 스파이크 / 단일 민트 (`diff.ts`) — kind `supply_spike`·`supply_single_mint`·`chain_supply_spike` · source `builtin-v1`
- `supply_spike`: curr vs prev %Δ → perSnapshotPct{info 1%·warn 3%·crit 10%}. elastic whitelist(USDC 등 11종) ×2. **리베이스 억제**(`|Δ|≤rebaseSaneMax 50% ∧ 이산 mint 0`).
- `supply_single_mint`: 비-home·무권한 수신자 단일 mint ≥5%(singleTxPctBps) → 크기 무관 critical(provenance 우선). authorized 발행 무시.

### 6.6 가치-드리프트 — 자금 유출 (`snapshot/value-drift.ts`, `snapshot-value-drift.ts`) — kind `value_drift` · source `valuedrift-v1`
- **총가치 = NAV(price)×supply**(전문가 §3.2). 데이터 = `chain_supply_samples.supply_usd`(체인 가치 시계열).
- `computeValueDrift`(순수): 토큰별 Σchain 가치 시계열에서 **최근 24h 윈도우 peak 대비 낙폭**. dropPct 10/25/40% + **minAbsUsd $10M 절대게이트**(소형 노이즈 컷).
- 노이즈/소형/상승 무발화(합성검증 4/4). deUSD 리뎀션런류(40%↓→critical) 포착.

### 6.7 오라클 / IRM / 마켓 변경 (`diff.ts:checkOracleChange`·`checkIrmChange`) — source `builtin-v1`
- `oracle_changed`(주소 변경, critical) · `oracle_paused_suspect`(MARKET→NONE, critical) · `oracle_depeg_flag_flip`(depeg-sensitive 플래그) · **`oracle_hardcoded_switch`(라이브 피드 MARKET/EXCHANGE_RATE → 하드코딩 ORACLE_FREE, **critical** — 가격 동결로 청산 미발화→bad debt 누적, P1-4)**.
- **RWA 의도적 디스카운트 예외(P2-8)**: RWA(국채/펀드형, mF-ONE·OUSG·USTB·USYC 등)는 NAV 대비 보수적 디스카운트 고정이 **정상 설계** → `isIntentionalDiscountOracle`(classifyAsset rwa ∧ NAV/ORACLE_FREE/fixed)면 oracle_hardcoded_switch 를 **critical→warning 다운그레이드**. 비-RWA 의 고정 오라클은 여전히 critical.
- `irm_changed`(IRM 컨트랙트 swap, critical) · `irm_base_rate_jump`(baseRate Δ → info 1%/warn 3%/crit 8%).
- `reserve_frozen` · `high_lltv_market`. (동일패밀리 재담보 ouroboros 신호는 약한 추정 휴리스틱이라 **전면 제거됨**.)

### 6.8 신규마켓 / 담보채택 (`diff.ts:checkNewMarket`·`checkCollateralAdoption`) — source `builtin-v1`
- `new_market`: 신규 마켓(>minMarketSizeUsd $100k). LLTV≥0.945→critical / ≥0.90→warning.
- `collateral_adoption`: MAJOR 렌딩 프로토콜(Aave/Morpho 등 6종) 채택→critical. **minor 렌딩 + long-tail(altcoin) 담보→critical 승격**(쓰레기담보 마켓 의심, UwU/MEV류, P1-5). minor+블루칩→warning.
- `unverified_large_exposure`: 미검증 대형 노출.

### 6.9 유동성 / 고래 / 큐레이터 (`diff.ts`, `scan-curator-derisk.ts`) — source `builtin-v1`
- `utilization_jump`(≥12pp 점프+≥70% 안착) · `high_utilization`(0.93/0.95/0.98) · `liquidity_drop_lending`·`liquidity_drop_dex`(0.10/0.30/0.50) · `whale_unwind`(top20 EOA 30%/50% 또는 $10M/$50M 인출) · `curator_derisk`(큐레이터 배분 축소) · `bad_debt_threshold`(§6.10) · `wallet_value_drop`(추적 지갑 밸류 급락).
  - **브릿지 in-flight FP 가드(P2-7)**: 급감 직전 윈도우(3일)의 아웃고잉 목적지가 **known 브릿지**(canonical OP-stack 예약주소·ArbSys·L1 게이트웨이 + 검증된 `bridge_authorities`)면 Optimistic 7일 인출 등 in-flight/settling 로 보고 **info 다운그레이드**(페이지 억제, 기록 유지). `lib/wallet-bridge-guard.ts` + alchemy `getAssetTransfers`. ALCHEMY 키 없으면 가드 미작동(원래대로 발화).

### 6.10 bad debt — kind `bad_debt_threshold` · source `baddebt-v1`
마켓 deficit ≥`actionableUsd($1M)`→HIGH · ≥`highUsd($50M)`→CRITICAL. 프론트 at-risk(p) 곡선과 연계.

### 6.11 알림 dedup + 채널 (`db/upsert.ts:insertAlert`, `lib/notify.ts`)
- **dedup**: 동일 (kind,token,protocol)이 **severity별 쿨다운** 내면 skip — critical 1h / warning 12h / info 24h(`cooldownBySeverity`).
- **채널 발송**(§12): 적재 후 `dispatchAlert`가 env 설정 채널(Discord/Telegram/webhook)로 warning·critical만. info는 DB만.

### 6.12 Tier 0 판결 (프론트 `page.tsx` + `concentric-layout.ts`)
4신호 합성 → **위험/주의/안전 + 한 줄 사유**: 집중(HHI≥0.4) · 디페그 · 무담보민팅 · **하드코딩 오라클** + critical 알림 수. 복합조건(하드코딩 오라클 ∧ 디페그)·critical·무담보민팅이 "위험" 승격. (재담보 루프 신호는 제거됨.)
**RWA 예외(P2-8)**: 페이지 토큰이 RWA 면 NAV/fixed 오라클을 위험 하드코딩에서 제외 → `rwaDiscount`(오라클 칩 "RWA NAV(정상)"), 판결 위험 미승격.

---

## 7. 알림 종류(kind) 전체 표
| kind | severity 로직 | source | 카테고리(프론트) |
|---|---|---|---|
| `depeg` | band/catastrophic, 부호인식 | builtin-v1 | 디페깅 |
| `unbacked_supply` | overage≥100bps crit | backing-v1 | 민팅/공급 |
| `unmatched_mint` | 구조가드 후 | mintburn-v1 | 민팅/공급 |
| `supply_spike` | 1/3/10% | builtin-v1 | 민팅/공급 |
| `supply_single_mint` | 무권한 5%+ crit | builtin-v1 | 민팅/공급 |
| `chain_supply_spike` | 체인 공급 급증 | builtin-v1 | 민팅/공급 |
| `value_drift` | 24h 25/40% + $10M | valuedrift-v1 | 유동성 |
| `oracle_changed` | critical | builtin-v1 | 컨트랙트 |
| `oracle_hardcoded_switch` | **critical** | builtin-v1 | 컨트랙트 |
| `oracle_paused_suspect` | critical | builtin-v1 | 컨트랙트 |
| `oracle_depeg_flag_flip` | warning | builtin-v1 | 컨트랙트 |
| `irm_changed` | critical | builtin-v1 | 컨트랙트 |
| `irm_base_rate_jump` | 1/3/8% | builtin-v1 | 컨트랙트 |
| `new_market` | LLTV/마켓크기 | builtin-v1 | 컨트랙트 |
| `collateral_adoption` | major/minor+long-tail crit | builtin-v1 | 컨트랙트 |
| `high_lltv_market` · `reserve_frozen` · `unverified_large_exposure` | — | builtin-v1 | 컨트랙트 |
| `utilization_jump`·`high_utilization`·`liquidity_drop_lending`·`liquidity_drop_dex`·`whale_unwind`·`curator_derisk` | 각 임계 | builtin-v1 | 유동성 |
| `bad_debt_threshold` | $1M/$50M | baddebt-v1 | 디페깅 |
| `wallet_value_drop` | 지갑 밸류 급락 | structural-v1 | 유동성 |

---

## 8. 임계값 레퍼런스 (`alert-thresholds.ts` 전체)
```
depeg.bandByClass     major .0075 · stable .005 · stable_soft .05 · pendle_pt .08 · lst .02 · rwa .02 · altcoin .05
depeg.catastrophic    0.085 (USD0++ 실측 9.02% 보정)
totalSupply           perSnapshotPct {info .01 warn .03 crit .10} · singleTxPctBps 500 · largeSingleMintBps 1000
                      rebaseSaneMax .5 · autoMintWhitelist 11종(USDC/USDT/DAI/USDS/PYUSD/USDE/RLUSD/FRAX/GHO/USDP/TUSD)
unbacked              toleranceBps 50 · criticalBps 100 · settlementSeconds 1800 · persistencePolls 2
mintBurn              matchWindowSeconds 1800
valueDrift            dropPct {info .10 warn .25 crit .40} · minAbsUsd 10_000_000 · windowHours 24 · minSamples 3
badDebt               actionableUsd 1_000_000 · highUsd 50_000_000
newMarket             minMarketSizeUsd 100_000 · highLltvWarning .90 · highLltvCritical .945 · fastGrowthUsd 5_000_000
collateralAdoption    materialUsd 10_000_000 · dustUsd 1_000_000 · majorProtocols(aave_v3·compound_v3·spark·maker·morpho_blue·fluid)
oracle                heartbeatByClass(major/stable 1h · lst/rwa/pendle 24h · altcoin 4h) · deviationByClass · stalenessFactor 1.75
                      addressChange critical · depegFlagFlip warning
whaleUnwind           perSnapshotDropPct {.10/.30/.50} · absDropUsd {1M/10M/50M} · trackTopN 20
utilizationLiquidity  utilizationJumpPct {.05/.15/.30} · utilizationAbsolute {.93/.95/.98} · jumpActionable .12 · jumpMinLevel .70
irmChange             addressChange critical · baseRateDelta {.01/.03/.08}
cooldownBySeverity    critical 3600s(1h) · warning 43200s(12h) · info 86400s(24h)
```
재튜닝: 값 변경 → `npm run backtest`로 회귀 확인(detector 코드 아닌 config만).

### 8.1 보정 근거 (왜 이 값인가 — 구 threshold-calibration.md 통합)
이 값들은 `backtest/events/`의 라벨된 35사건으로 **결정론적 백테스트 GREEN까지 튜닝**된 결과(구 `risk_rules_test_agent` 산출물 이식). 핵심 근거:
| 값 | 근거 |
|---|---|
| **디페그 catastrophic 0.085** | USD0++ 실측 on-chain trough 9.02%(deepest 9.07%). asserted 0.10이 사건 *위*에 앉아 못 잡던 것을 measured-data로 0.085 재보정(8.5~10%에 다른 사건·컨트롤 없음). |
| 디페그 band 클래스별 | 정상 트레이딩 노이즈 vs 디페그 분리(band=WARN, catastrophic=CRIT). stable 0.5% 타이트 vs stable_soft 5% 넓음(소프트 할인 정상) · pendle_pt 8%(만기 전 할인). |
| supply spike 1/3/10% + elastic ×2 | 자연 대량 mint/burn 토큰(USDC 등 11종) 페이지 방지. |
| 단일 mint 5%→flag · 10%→crit | provenance 우선(무권한 수신자), flat-MAD z-폭발 차단, rebase 50% 억제. |
| 무담보 critical 100bps | finality skew(50bps tolerance) 무시 + 지속 시 승격. |
| 쿨다운 crit 1h / warn 12h / info 24h | critical 더 responsive(구 26h flat 대체). |

부호 인식 depeg: peg **위**(수익누적/프리미엄)는 WARN 상한(critical 안 됨). oracle heartbeat: stable·major 1h / lst·rwa·pendle 24h / altcoin 4h · staleness ×1.75. util: level co-gate 0.95 + velocity 12pp 점프·≥70% 안착.

---

## 9. 브릿지 토폴로지 탐지 (`lib/bridge-*.ts`)
`readBridgeAuthority(token, chain)`이 온체인 순차 탐지 → `bridge_authorities` 적재. `auth_type` 자유텍스트(마이그레이션 없이 흐름):
1. **xERC20** — `BridgeLimitsSet` 로그(publicnode)로 브릿지 enumerate + `lockbox()` 백킹.
2. **MINTER_ROLE** — AccessControlEnumerable role member.
3. **OFT peers(LayerZero)** — `endpoint()` → eid별 `peers(eid)` → **원격 peer 주소**(0x+slice(-40)) + 체인.
4. **CCIP(Method B/C)** — `TokenAdminRegistry.getPool` → `resolveCcipTopology`: selector별 **`getRemotePools`/`getRemotePool`(원격 풀)** + **`getRemoteToken`(원격 토큰)** 디코드 → `ccip_pool`+`ccip_remote`. (라이브 검증: LINK→28 원격 체인 실주소.)
5. **Method C 8표준** — Hyperlane·OP·Arbitrum/zkSync canonical·Axelar ITS·Circle CCTP·Polygon PoS·Wormhole NTT·xERC20 lockbox.
6. **Method E(fallback)** — view-probe 전부 실패 시 mint 로그(Transfer from 0x0) `tx.to` 최빈값으로 **추정**(`mint_event` 타입 = 프론트 "✓검증" 제외).
- 프론트 `lib/concentric-layout.ts` `AUTH_MAP`/`AUTH_ORDER`가 auth_type → 메커니즘(burn_mint/lock_mint)·프로토콜·태그 분류, 최강 권한이 그 체인 브릿지를 "추정→검증" 승격.
- **이중 용도**: bridge_authorities 검증 주소는 Detector B allowlist 동적 시드로 재사용(§6.4).

---

## 10. 백테스트 하니스 (`scripts/backtest.ts` — `npm run backtest`)
**라벨된 과거 사건을 production 알림 함수에 결정론적 replay**(LLM 아님).
- 사건 라이브러리: `backtest/events/` — 35사건/81case. 각 `<날짜-이름>/`=`EVENT.md`+`label.json`+`snapshots/*.json`.
- `label.json`=detector-agnostic 계약: case마다 `{snapshot, prev?, now, peg_probes|polls[], should_fire[], must_not_fire[]}`.
- 구동 신호: `DEPEG`(부호인식) · `LARGE_SINGLE_MINT`(provenance) · `TOTAL_SUPPLY_SPIKE`(리베이스 억제) · `UNMATCHED_MINT`(Detector B) · `UNBACKED_SUPPLY`(Detector A evaluateBacking).
- dedup 재생: `polls[]`는 DEPEG를 `cooldownBySeverity`로 재생 후 마지막 폴 채점. 공급/backing은 point-in-time.
- 부분 커버리지: 미구동 신호(ORACLE/UTIL/WHALE/BAD_DEBT/SUPPLY_DELTA 등 — 스냅샷 입력 없음)는 정직하게 채점 제외.
- **현재: 구동채점 67 case → recall 100% · FP 0% · 🟢 GREEN.** 임계값 변경 시 여기서 회귀가 잡힘.

---

## 11. 프론트엔드 (`frontend/`)
- **페이지**: `/`(전체) · `/token/[symbol]`(동심원+Tier0 판결+bad-debt at-risk 곡선+알림 패널) · `/multi`(다중) · `/explore`(depgraph).
- **API 라우트**(`app/api/`, pg 직독): `topology` · `alerts` · `dossier`(토큰별 알림/공급24h/loop/curator 합산) · `breadth`(DeFiLlama) · `bridge-authority` · `curators` · `tokens` · `portfolio` · `wallets` · `graph`.
- **동심원 그래프**(`lib/concentric-layout.ts` + React Flow): 체인별 원 — 토큰→프로토콜→마켓/풀→큐레이터. verified=실선 / breadth=점선 / opaque=점점선.
- 토큰 페이지 폼 토글: **동심원 · 리스트** (체인맵 제거됨).
- `components/graph/AlertPanel.tsx`: 알림을 카테고리(민팅/공급·디페깅·컨트랙트·유동성)로 필터.

---

## 12. 알림 채널 (`lib/notify.ts`, `lib/discord-alert.ts`)
- `insertAlert`가 DB 적재 후 `dispatchAlert` 호출 — **env 설정 채널로만** warning·critical 발송(info는 DB만), fire-and-forget.
- 채널: **Discord**(웹훅 `{content}`) · **Telegram**(bot sendMessage) · **범용 webhook**(JSON POST).
- `discord-alert.ts:postDiscord`(embed) — discover watchlist 요약·미지 컨트랙트 큐 등 운영 알림.
- 미설정 시 no-op(zero-cost). cron 기동 로그에 활성 채널 표시.

---

## 13. 운영 (`ops/`, 실행·배포·채널 절차는 [README.md](README.md))
**환경변수**(`automation/.env`):
```
DATABASE_URL=…              (필수)
ALCHEMY_API_KEY=…           (권장 — 없으면 publicnode 폴백)
ETHERSCAN_API_KEY=          (선택, 라벨 보강)
DISCORD_WEBHOOK_URL=        (선택, 알림 채널 — Discord 채널>연동>웹후크)
TELEGRAM_BOT_TOKEN= / TELEGRAM_CHAT_ID=   (선택, 텔레그램)
ALERT_WEBHOOK_URL=          (선택, 자체 수신기)
ARCHIVE_RPC_URL=            (선택, 유료 archive — deep getLogs full-history)
```
**launchd 상시구동**(`ops/*.plist` → `~/Library/LaunchAgents/`, `launchctl load`):
- `com.exposure.frontend.plist` — 단일 링크 유지(무비용, KeepAlive).
- `com.exposure.cron.plist` — 연속 모니터링(OPT-IN, 무료티어 RPC 소모).
**deep history(D#12)**: `ARCHIVE_RPC_URL` 설정 시 `scanLogsRecent(deep=true)` 한 콜 fromBlock:0.
**공개 배포(D#10)**: 로컬(기본) · `cloudflared tunnel`(무료) · Vercel+Neon(계정/연결문자열은 운영자).

---

## 14. 스크립트 레퍼런스 (`npm run <X>`)
| 스크립트 | 역할 |
|---|---|
| `init-db` | 마이그레이션 적용 |
| `snapshot:all` / `:one <addr>` / `:chain` | watchlist 전체 / 단일 토큰 / 체인별 스냅샷 (+diff 알림) |
| `snapshot:chainsupply` | 체인별 공급+가치 시계열(가치-드리프트 입력) |
| `snapshot:bridgeauth` | 온체인 브릿지 권한 검증(§9) |
| `snapshot:backing` | Detector A 무담보 공급(§6.3) |
| `snapshot:mintburn` | Detector B 무담보민팅(§6.4) |
| `snapshot:valuedrift` | 가치-드리프트(§6.6) |
| `snapshot:reflexivity` | 사기 루핑 grade(Morpho 오라클 introspect + 차입자 집중도) → loop_findings(reflexivity-v1) |
| `snapshot:wallets` | 추적 지갑 밸류 |
| `snapshot:curators` | 큐레이터 배분 |
| `discover` / `discover:dry` | 신규 토큰 발굴(임계 통과 → active=true 즉시 등록, 미달 시 자동 해제) |
| `seed:risk` | **위험 토큰 watchlist 핀**(온체인 symbol() 검증, §16) |
| `watchlist -- pin/exclude/unpin <addr>` | watchlist 수동 관리 |
| `backtest` | 탐지기 회귀 검증(§10) |
| `scan:risks` / `scan:derisk` / `review` / `prune` / `validate` | 현재 리스크 스캔 / 디리스킹 / 검토 큐 / 스냅샷 정리 / 정확도 |
| `cron` | 연속 파이프라인(§5) |

---

## 15. 알고리즘 swap 지점 (2개)
- **(A) 리스크 알림 detector** — 모든 알림은 `insertAlert({…, source})`. source(builtin-v1 / backing-v1 / mintburn-v1 / valuedrift-v1 / baddebt-v1 / structural-v1)로 어느 알고리즘이 냈는지 추적. 외부 detector 교체 시 같은 `alerts` 스키마+source만 맞추면 프론트/백테스트가 그대로 동작.
- **(B) 자금 추적** — `wallet_tracking` + `snapshot-wallets.ts`. 동일 테이블 계약으로 교체 가능.

---

## 16. 한계 + 후속 백로그 (상세 §18)
**한계**
- full-history getLogs는 무료 RPC 불가(bounded 스캔) → 깊은 과거는 `ARCHIVE_RPC_URL`(유료).
- Detector A 라이브 **활성됨** — wstETH lock&mint(Lido 공식 L2 브릿지: L1 잠긴 wstETH ≥ Σ L2 공급) `BACKING_WATCHES` 추가(2026-06, arb/op/base over-backed 온체인 검증). 추가로 xERC20 lockbox 토큰은 `autoWatches` 로 자동 watch. 현 위험 토큰(USD0++/crvUSD/sUSDe 등)은 네이티브/CDP/burn&mint라 Detector B+디페그+가치드리프트가 커버.
- 그래프-스테이트 타임라인 스크럽 미구현(공급/알림 시계열은 있음 — 그래프 영속화 선행).
- 시뮬레이션(전염 추정)은 범위 밖(WON'T) — 구 Python은 `attic/`.
- 계정 생성·토큰 입력(Vercel/Neon/Discord 웹훅)은 운영자 단계.

**완료된 백로그**: P0-1(위험 토큰 10종 핀+스냅샷) · P0-2(Detector A 라이브 판정) · P1-4(하드코딩 오라클 전환 critical) · P1-5(저신뢰 담보채택 승격) · P2-6(가치-드리프트).
**후속**: P2-7(지갑 7일 브릿지 in-flight FP 가드) · P2-8(RWA 의도적 디스카운트 라벨) · P1-3(IRM 곡선, 낮은 가치) · P3(타임라인·학습메모리, deferred).

---

## 17. 진행 이력 (결정 로그)

> 비자명한 선택을 한 줄씩 누적. 최신이 위로. (구 DECISIONS.md 통합 — 변경의 "왜".)

### 2026-06-13 (오후) — 관계맵 트리 전환 + 수용처 프로토콜 중요도 + 자금추적 단절 감사
- **관계맵 형태 토글 트리/동심원**(`lib/tree-layout.ts` 신설, `page.tsx` shape state·기본 트리): 토큰(root) 최상단 → 프로토콜 → 마켓/파생 → 수용처 → 큐레이터 볼트를 위→아래 계층으로. BFS 스패닝 트리(얕은 경로=부모), 비트리 엣지는 교차. **토글 버그**: `graphKey`에 shape 없어 staticLayout이 재마운트 안 해 동심원 눌러도 트리 유지 → graphKey에 shape 추가로 수정. **둘은 같은 base(overlayLego+PageRank 노드/엣지)에 position만 다르게** — 노드/엣지 수 동일(검증: sUSDe 트리 75 = 동심원 75).
- **프로토콜 2줄 지그재그**: 형제 >6이면 짝/홀 y 교차(ZIGZAG_DY 138) + 가로 압축 0.62 — 허브 토큰(USDC) 프로토콜이 한 줄로 길어지는 것 방지.
- **트리 직선 엣지**: `GraphCanvas.straightEdges` prop → `initialEdges`에서 cx/cy/rp(곡선 라우팅 중심) 생략 → FloatingEdge가 직선. 트리 계층엔 곡선 불필요(사용자: "lp 등 파생 연결 직선으로").
- **수용처 프로토콜 중요도(PageRank)**: 무명 수용처(Yield Basis·Fluid류)가 유명 프로토콜의 LP/PT/토큰을 받으면 in-degree↑ → PageRank↑ → 크게. `lego-overlay.ensureAcceptorProto`(동심원에 없는 수용처를 프로토콜 1급화) + 베이스 토큰 수용처도 프로토콜 단위 집약 엣지(동심원에 있으면 그 노드로, 없으면 lego-acc). 사용자: "yield basis 같은 애들이 유명 프로토콜 lp 받아주면 중요한 프로토콜이 되도록".
- **자금추적 단절 감사(논리↔검증 에이전트 5라운드 루프)**: "최초 예치→최종 출금 전 경로에서 트리만으로 ▲LP 최종 출구 ▲큐레이터 보상 재원 ▲원금 회수 역경로가 읽히고, 출처불명 수익·행방불명 파생 0" 목표. **결과**: 행방불명 파생 343→1개(전역 종착 표식). 핵심 수정 — `types.ts:computeTerminalMark`(순수함수) + `scripts/backfill-terminal.ts`(전역 멱등 재계산, 네트워크 0)로 모든 파생에 종착 표식(collateral_sink 317·lp_held_sink 206·reward_sink 76·staking_sink 35·yield_sink 24·vault_share_sink 20). YT/receipt/LP 종착은 connected 필터 보존(숨김→표시), RiskNode "끝" 배지. 큐레이터 보상 재원 = market→vault 엣지(`curator_funding`) + meta.rewardSource(678개) + 범례 "보상 재원(마켓 이자→볼트)". 역방향 회수 = EdgeLegend "예치·담보 엣지 가역, 화살표 반대=출금/상환".
- **남은 단절 2건(정직 처리)**: 큐레이터 보상 재원·원금 회수 역방향이 "별도 엣지"가 아니라 meta/범례/종착으로만 읽힘(논리 에이전트 treeOnly=false). 별도 역엣지/보상엣지는 **온체인 새 사실이 아니라 추측**이라(상환=예치의 역연산, 보상=마켓 이자) 만들지 않음 — 프로젝트 핵심 원칙 "추측 데이터 금지" 준수. 잔존 행방불명 1개(USDbC@base 래핑본, base 수용처 미발견)도 추측 종착 단정 대신 connected 미통과로 트리 숨김. 검증: automation·frontend typecheck·build GREEN.

### 2026-06-13 — 검증 후 13개 보완(수용처 확장·래핑본 1급화·PageRank): 멀티에이전트 구현+리뷰게이트
검증(브릿지맵 래핑·관계맵 파생 수용·머니레고 추가형·PageRank·X 피드 조사)에서 도출한 13개 작업을 구현 에이전트 + 리뷰 게이트(보고 불신·직접 재현, OK까지 수정 루프)로 진행. 통합검증: automation/frontend typecheck·`npm run build`·vitest 15/15·관계맵(129노드/139엣지)·브릿지맵(3체인) 라이브 렌더 GREEN. (변경 파일 20개, git 없음 — 백업 `/tmp/rem-backup-1781314786.tgz`.)
- **수용처 레지스트리(`src/lego/acceptors.ts`)**: 인라인 Morpho/Euler 질의를 `AcceptorAdapter{id,chains,accepting}` 플러그인으로 — `ACCEPTOR_ADAPTERS=[morphoBlue, eulerV2, aaveV3, fluid]`. 동작 불변(노드 id·엣지 형식 보존, 리뷰가 전후 DB diff로 확인). Convex `staked_in`은 파생 발견(cvxLP 영수증 발행+레벨2 재귀)과 결합돼 어댑터 인터페이스로 표현 불가 → 인라인 유지(정직한 예외).
- **Aave v3 수용처(`aaveAccepting`)**: Core Pool `getReserveData`+config 비트맵(LTV>0 ∧ ¬frozen)으로 담보 리저브 판정, `legomkt:aave_v3:{collateral}@chain`. 단 현재 **collateral_at 0건** — 2026-06-13 온체인 실상(전 체인 Core에 담보가능 PT 0개, 과거 PT-USDe 상장분 만기 오프보딩). 어댑터 자체는 WETH/wstETH 양성대조로 동작 입증(LTV=0 USDe 정확히 제외). lock&mint 토큰 들어오면 자동 활성하는 Detector A와 동일 패턴.
- **볼트 쉐어(ERC-4626) 1급화**: `metamorphoVaultsFor`(Morpho GraphQL vaults, TVL≥$1M·상위 12 캡) → derivative `role=wrapper`, 토큰→쉐어 `issues`. 검증: USDC 볼트쉐어 27개 적재, 그중 **11개가 재담보(`collateral_at`)로 연결**(steakUSDC·gtUSDC 등이 다른 Morpho/Euler 마켓 담보). 프론트 "볼트" 칩(순수 한글).
- **Euler 멀티체인 + Morpho 페이지네이션**: `morphoAccepting` first:100 → skip 루프(상한 1000). `eulerAccepting` base/arbitrum 서브그래프 엔드포인트 추가(curl 실응답 확인).
- **Fluid 수용처**: 라이브 API로 24개 실마켓 반환 확인하나 **collateral_at 0건** — 레고 모델이 어댑터에 파생 주소만 넘기고 viewed 베이스 토큰은 안 넘기는 구조 경계(거짓 적재 안 함). Gearbox는 역질의 가능 공개 소스 미확인으로 미구현.
- **`token_variants` 테이블(018) + 래핑본 파이프라인**: 브릿지 래핑본을 `bridge_authorities.note` 텍스트→정식 테이블(PK token·chain·address, kind `bridged_wrapped`|`ccip_remote`). `deriveBridgedVariant` Base(OP-stack) 확장 — Superchain 토큰리스트 후보 + `l1Token()`/`remoteToken()` 온체인 검증(실패=버림). 검증: arbitrum 래핑본 3 + **base USDbC 1**(0xd9aa…, OP Standard Bridge) 적재, base 네이티브 USDC는 variant 제외. CCIP `getRemoteToken` 원격 토큰도 `ccip_remote`로 1급화(LINK 다수 원격 체인). 미매핑 체인 셀렉터는 `chain='selector:…'`로 보존(프론트 3체인 필터라 표시 무영향).
- **래핑본 레고 연결(A6)**: `token_variants`의 `bridged_wrapped`를 derivative(`role=wrapper`, protocol=bridge)로, 그 주소를 수용처 질의에 투입 → **USDC.e@arbitrum → Morpho arbitrum 마켓 `collateral_at` 연결**(브릿지 노드에서 끊기던 엣지 해소). Aave arbitrum은 USDC.e 비담보화(네이티브 이행)라 미연결 — 실데이터.
- **추정 브릿지 토글(B4)**: `/api/flow?estimated=1`로 `mint_event`(Method E 추정) 브릿지 포함(기본 제외 유지). 브릿지맵 "추정 브릿지 표시" 체크박스(기본 꺼짐), 점점선+추정 태그. API 검증: GHO estimated 0→1 시 브릿지 4→5(+mint_event 추정). **알려진 갭**: 검증 브릿지 0 + 단일체인 mint_event 토큰(DAI: 15건 전부 ethereum)은 빈 상태 가드로 토글 도달 불가 — 추정만 있는 토큰의 토글 노출은 후속.
- **가중 방향 PageRank(`lib/centrality.ts`)**: 무가중·무방향 차수 → damping 0.85·USD log1p 가중·방향 그래프 PageRank로 `connImportance` 교체(boost [1.0,1.7] 정규화, Token/파생/저차수 제외 규칙 보존). vitest 15케이스(합≈1·결정론·정규화 경계). 멘토 §6 "규모 아닌 연결성"을 전이성까지 반영.
- 문서: §2 빠른 시작 DB 접속정보를 실제(wbtc/wbtc_local_pw)로 정정.

### 2026-06-12 (밤) — 관계맵 확정: 동심원 + 직선 엣지 + 겹침 제거 (사용자 최종)

- **직선 + 교차 엣지는 최적(낭비 최소) 라우팅**: 기본은 직선. 파생↔수용처 교차 엣지(collateral_at/staked_in)는 **직선이 중앙 클러스터를 실제로 가로지를 때만**(중심↔코드 수직거리 h < Rcluster=rp·0.6) 휜다. 그것도 외곽 전체가 아니라 **클러스터 가장자리(rp·0.7)까지만** + **짧은 쪽 각이등분 방향**으로 돌아간다(제어점=2·정점−중점). → 클러스터 밖을 지나는 엣지는 직선(낭비 0), 가로지르는 것만 최소 호. (이전: 무조건 외곽 둘러서 선분 낭비 → 사용자 "최적 경로로".) 검증: USDC 교차 12개, 직선 119개, 콘솔 클린.
- **겹침 제거(deOverlapConcentric)**: 동심원/오버레이 좌표는 거의 유지하되(원래 자리 forceX/Y 앵커 0.45) **노드 크기 forceCollide 로 겹치는 것만 분리**, 토큰은 중심 고정. organic 전체 재배치(사용자가 거부)와 달리 동심원 구조 보존 + 겹침만 해소. 검증: 노드 121개 중 원 겹침 0(라벨 1쌍만 살짝), 엣지 131개 전부 직선. (share 기반 대형 프로토콜 노드가 서로 겹치던 문제 해소.)

### 2026-06-12 (밤) — 브릿지 맵 재설계: 래핑(lock&mint) 변형 포착 + 체인쌍 엣지 위 브릿지

- **진단(사용자 "확인해")**: 브릿지 알고리즘이 burn&mint(전 체인 동일 토큰, CCIP/CCTP/OFT)는 잡지만 **lock&mint(L1 잠금→L2 가 USDC.e 등 다른 토큰 민팅)는 누락**. 근본 원인 ① 스냅샷이 체인별 "정규 주소 1개"만 스캔(USDC.e 미스캔) ② 감지가 mint-권한 기반이라 L1 잠금형은 구조적으로 안 잡힘. 실DB: USDC 가 ccip_pool(burn&mint)만, l2_canonical 0건. (AUTH_MAP 의 메커니즘 분류 자체는 이미 있음.)
- **플랜1 — 래핑 변형 온체인 감지(범용)**: `deriveBridgedVariant` 신설 — Arbitrum **L1 GatewayRouter.calculateL2TokenAddress(l1Token)** 로 래핑본(USDC.e=0xff97…) 도출 → 그 주소를 readBridgeAuthority 로 스캔하면 기존 probeL2Canonical 의 `l1Address()` 가 "L1 원본=이더리움 USDC"를 확인 → l2_canonical(lock&mint) 검출. 어떤 L1 토큰이든 자동·온체인·하드코딩 0. (OP스택 Base 는 native 라 후속.)
- **플랜2 — 스냅샷 적재**: snapshot-bridge-authority 에 ① native 스캔 + ② 래핑 변형 스캔 추가. note 에 래핑본 주소+출발체인(L1) 기록. 실행: USDC arbitrum 래핑본 1건(l2_canonical) 적재 확인 → /api/flow 가 arbitrum 에 "L2 Canonical" 브릿지 노드 생성. 체인쌍은 auth_type 으로 추론(캐노니컬=eth↔L2).
- **플랜3·4 — 브릿지 맵 재설계**: 동심원(체인 링) + **직선 연결**, 브릿지 노드를 **체인쌍 엣지 위**(중점, 여러 개면 수직 오프셋)에 배치. burn&mint=같은 메커니즘이 있는 체인쌍 모두 연결, lock&mint=eth↔L2. 같은 메커니즘이 여러 쌍을 연결하면 **쌍마다 고유 합성 노드**(id 충돌 방지). 노드 라벨에 "번&민트/락&민트(래핑)" + 연결 체인쌍 표기, 래핑은 주의색. **스코프 필터: eth/base/arbitrum 만**(미구현 체인 숨김). FloatingFlowEdge·TxFlowLayer 에 `straight`(곡률0) 추가. 검증: USDC 5 브릿지(eth↔base: CCTP·CCIP / eth↔arb: CCTP·**USDC.e 캐노니컬** / base↔arb: CCTP), 노드·엣지 중복 0.
- 관계맵은 사용자 요청대로 방사형 트리 → **동심원 복귀**(radial-tree-layout 제거).

### 2026-06-12 (밤) — 관계맵 배치: 동심원 → 방사형 트리 (사용자 선택)

- **방사형 트리 채택**: 동심원은 링에 균등 배치라 "어느 마켓이 어느 프로토콜 소속인지" 안 보이고 의존선이 엉킴. 사용자에게 3안(계층형 흐름 / 방사형 트리 / 클러스터) 제시 → **방사형 트리**(토큰 중심 유지). `lib/radial-tree-layout.ts` 신설, legoTopology 최종 좌표만 재계산(노드·엣지 디자인 불변). 동심원/오버레이는 그대로 두고 post-process.
- **알고리즘**: 토큰=root, 방향 엣지로 BFS 스패닝 트리(토큰→프로토콜→마켓/파생→큐레이터) — 얕은 경로가 부모라 수용처 마켓은 "자기 프로토콜" 자식이 되고 파생→수용처는 비트리 엣지(곡선)로 남음. 깊이=반지름, 각도=트리 가지. 각 프로토콜이 부채꼴을 갖고 그 안에 자기 마켓이 모여 구조가 보임.
- **노드 크기 적응(핵심 난점)**: 프로토콜은 TVL share 로 96~264px(×연결성 boost → 큰 건 ~450px). 고정 반지름 링에 안 들어가 겹침 → **requiredAngle 를 노드 실제 크기로 bottom-up 계산**(max(자기 각폭, 자식 각폭 합)) + root 자식 합이 2π 넘으면 **radii 를 scale 업**해 재계산. 각도는 requiredAngle 비례 배분(자식이 부모 부채꼴 안에). 검증: 노드 겹침쌍 0(이전 동심원/직선 대비 가독성↑).
- 엣지는 직전의 곡선(FloatingEdge, 토큰 중심에서 바깥으로 휨) 그대로 — 방사형 트리와 잘 맞음(가지 사이 교차 의존선이 중앙 안 뚫고 돌아감).

### 2026-06-12 (밤) — 관계맵: 동심원 유지 + 엣지 곡선화(자기장 선) — organic 시도→롤백

- **organic(force-directed) 시도 후 롤백**: 동심원이 연결선을 가려 보기 어렵다는 피드백에 GraphCanvas `organic` 모드(토큰 fx/fy 고정 + 나머지 황금각 seed → 수렴 tick)를 만들었으나 **사용자가 "너무 보기 어렵다, 직전(동심원)이 낫다"** → 롤백(관계맵 `staticLayout` 복귀, organic 코드 제거). 교훈: 동심원의 정렬된 가독성이 force hairball 보다 우위 — 문제는 레이아웃이 아니라 직선 엣지였음.
- **엣지 곡선화(진짜 해결)**: FloatingEdge 가 `getStraightPath`(tiger 식 직선)라 길게 가로지르는 파생 의존선이 중앙을 직선 관통 → 보기 어려움. **2차 베지어 호**로 교체: 토큰(레이아웃 중심) 기준 먼 쪽으로 휘게(GraphCanvas 가 토큰 중심 cx,cy 를 엣지 data 로 주입; bow=min(190,len·0.18)). 짧은 방사형 엣지는 거의 직선, 긴 교차 의존선만 크게 휘어 중앙을 비켜 돌아간다. 사용자: "파생 토큰 선은 휘어도 돼, 직선이라 가로질러서 어렵다".
- **레고 엣지 id 중복 제거**: 한 파생의 두 수용처 엣지가 같은 기존 마켓 노드로 매칭되면 동일 `lego:src→target:relation` id 가 생겨 React key 충돌(엣지 누락 가능) → overlayLego 말미에 id dedup. 검증: 렌더 엣지 131개 전부 유니크(중복 0).

### 2026-06-12 (밤) — 브릿지 맵·관계맵 폴리시 6종 (사용자 피드백)

- **파생토큰 = 연결 있을 때만 표시(고아 숨김)**: LP/aToken 등 파생을 발행(프로토콜→파생)만 있고 수용처(collateral_at/staked_in)도, 연결된 다른 파생을 낳지도(issues/lp_of) 않으면 숨김. `lego-overlay` 에 connected 집합(직접 수용처 + LP→cvxLP/PT 상위 보존 fixpoint) 계산 → bySource·레벨2 배치를 connected 로 필터. USDC 검증: 파생 54개 중 **연결 12개만 표시, 고아 42개 숨김**(aEthUSDC·aBasUSDC·aArbUSDCn 영수증, ANOgp·ib3CRV·GMACTri 등 미사용 Curve LP). 사용자: "다른 풀이나 마켓 연결 있는 경우만".
- **엣지 자기장 선 라우팅**: 브릿지 맵에서 체인↔체인 현(弦)이 중앙(브릿지)을 가로지르던 걸, 레이아웃 중심에서 먼 쪽으로 휘어(bowedMidpoint — 두 수직 후보 중 중심에서 먼 쪽) 바깥 호로. FloatingFlowEdge 에 `cx,cy` 옵션 + TxFlowLayer lanePath 동기화(입자가 휜 엣지 위 유지). 흐름맵은 cx 없으면 기존 동작 불변.
- **브릿지 맵 체인 식별**: 바깥원(체인) 노드를 토큰 로고(USDC 3개 동일) → **체인 로고**(llamao chains CDN) + 노드 아래 "Ethereum · USDC · $6.9B" 라벨. FlowNodeShell `chainNode` 플래그.
- **관계맵 hover 툴팁 2개 → 1개**: 브릿지 노드가 RiskNode 자체 group-hover 툴팁 + GraphCanvas HoverTooltip 둘 다 띄우던 중복 → RiskNode 툴팁 제거, 메커니즘/한도/사고이력을 통합 HoverTooltip(NodeBody)으로 일원화. (현재 단일체인 관계맵엔 브릿지 노드 없음 — bridgeHub 전용이라 휴면이나, 재등장 대비 방어.)
- **이름·피드백**: 탭/패널 "브릿지 뷰" → "브릿지 맵". 패널에 "브릿지 N개 · 체인 M개 로드됨" 추가(로딩 확인). layout null 가드 수정(패널이 layout 미로딩 시 크래시하던 것).

### 2026-06-12 (밤) — 브릿지 뷰 신설: 탭 교체 · 관계맵 단일체인 · 실시간 브릿지 입자 (사용자 설계)

- **탭 교체 + 관계맵 단일 체인**: "실시간 상황판" → "브릿지 뷰". 관계맵은 한 체인의 머니레고만 보도록 체인 선택을 체크박스(다중) → **단일 선택**(하나씩)으로, "전체" 버튼 제거 + "단일 체인 머니레고" 라벨. bridgeHub(다중체인 매크로) 경로는 항상 단일체인이 되어 자연 비활성. (사용자: "관계맵에서는 하나의 체인에 대해서 머니레고 구조를".)
- **브릿지 뷰 레이아웃**: 가장 바깥 원 = 체인(체인별 토큰 노드, 원 크기=체인 TVL), 내부 동심원 = 브릿지(검증된 mint 권한 노드). 흐름맵 인프라 재사용(`BridgeView` = useFlowData 그래프 + FlowNodeShell·FloatingFlowEdge·TxFlowLayer) → 같은 UI 형식. 브릿지>10 이면 두 겹 동심원.
- **실시간 입자 = 정직한 데이터 재설계(핵심)**: 흐름맵 `/api/transactions` 는 토큰의 **전역 최신 1000전송**만 훑어 체인내 DeFi/지갑 전송에 묻혀 브릿지 주소 전송을 거의 못 잡음(검증: USDC 132건 중 브릿지 접촉 **0**, 민트 1건). 또 `flow-match` 는 설계상 브릿지를 카운터파티에서 제외(`token`/`bridge` skip)하고 민트/소각을 엣지에 안 태움(수신 민트로 출발 체인 증명 불가 = 출처 날조 방지). → **전용 `/api/bridge-transactions` 신설**: 브릿지 컨트랙트 주소로/에서의 전송만 Alchemy `fromAddress`/`toAddress` 필터로 직접 조회 + 브릿지는 저빈도라 **60분 윈도우**. 검증: USDC CCIP(eth) 실거래 3건(예치 2·릴리즈 1) 포착(전역피드는 0이던 것).
- **매칭 정직성**: `bridge-flow-match.buildBridgeRenderPlan` 은 tx 카운터파티 주소 = 브릿지 노드 주소일 때만 **체인↔브릿지 통로 엣지**에 입자를 태움(in=체인→브릿지 락/소각, out=브릿지→체인 릴리즈). **체인↔체인(sibling) 엣지엔 절대 안 태움** — 그건 "어느 체인에서 왔다" 출처 날조(flow-match 의 기존 honesty 노트와 일관). TxFlowLayer 에 `buildPlan` prop 주입점만 추가(흐름맵 기본 동작 불변). 번-민트 토큰(USDC=CCIP)은 풀이 USDC 를 들지 않아 입자가 희소한 게 정직한 현실 → 0건일 때 "최근 60분 브릿지 거래 없음" 명시.

### 2026-06-12 (밤) — E19/E20 브릿지 (메인앱 — 팀원 bridge-detect 모듈 미수정)

- **E19 표준 토큰 타입 판별 = 이미 배선 확인**: concentric `verifiedFor(chain)` 가 `bridge_authorities`(snapshot-bridge-authority 가 토큰 컨트랙트서 직독한 xERC20/OFT/CCIP/MINTER/Wormhole NTT/Axelar 등)로 브릿지 노드를 "추정→검증"으로 승격 + 표준 프로토콜·mint한도 표시. 멘토 §2 "표준 토큰 타입으로 먼저 필터링"이 EVM 3체인에 이미 작동(USDC 매크로뷰 검증: ✓ Chainlink 등). 팀원의 `bridge-detect/`(비-EVM 8계열) 파이썬 모듈은 **수정 안 함**(G가드).
- **E20 "락만 된" 필터 추가**: 브릿지에 잠긴/공급된 양이 총공급(eth+base+arb) 대비 **0.3% 미만이면 "비주력(소액)"** 으로 — 노드 흐리게(active:false→opacity·grayscale) + 라벨. 멘토 §2(rsETH LayerZero→CCIP 이동·Wormhole 소액 락 오탐) 해소: 자금이 사실상 없는 브릿지를 디클러터. 검증: USDC 브릿지 9개 중 7개 비주력 처리(흐림), 주력 2개만 또렷. (라벨은 "이동(미사용)"이 $14M Axelar 같은 실재 소액엔 과해 "비주력(소액)"으로 — 대형 토큰 스케일 고려.)

### 2026-06-12 (밤) — 꼬리 정리: /multi·deep flow-trace 죽은코드 제거 · F22 Abracadabra finding

- **죽은 코드 제거(A5·D16 꼬리)**: `/multi`(어디서도 링크 안 됨) + multi-token-layout, `DetailGraph`+`/api/flows`+automation `flow-trace.ts`/`flow-rpc.ts`(Dune 기반 deep flow-trace — 소비자 0), `/api/leverageloop`(lev 탭 제거로 죽음) 삭제. **흐름맵은 이미 /api/transactions(Alchemy RPC)로 작동** → D16 "흐름 RPC화" 목표는 이미 충족, Dune 잔재만 정리. flow_nodes/flow_edges 테이블은 보존(무해).
- **F22 Abracadabra finding(멘토 §8 "안 넣었으면 이유라도")**: 수용처 어댑터 추가 검토했으나 — ① 멘토도 짚은 deprecated 프로토콜 ② 공개 API 빈 응답·TheGraph hosted 폐기(깨끗한 역질의 소스 없음, 탈중앙 키 또는 DegenBox clone 이벤트 스캔 필요) ③ 우리 LP는 신규(2025~26 sUSDe/stETH 풀)라 Abracadabra 구 cauldron(yvCurve·cvxstETH, 2021~22)과 무관 ④ 구조(LP→cauldron 담보)가 이미 구현된 **LP→Convex·Euler 와 동일** → 추가해도 데모 가치 0. 일반 어댑터(Convex/Morpho/Euler)로 LP·PT 재담보는 충분히 시연됨. (하드코딩 cauldron 리스트는 일반성 원칙 위배라 배제.)

### 2026-06-12 (밤) — B8 멀티홉 재귀 · B10 자동 라벨링 · C14/C15 연결성 크기 · +큐레이터 고정

- **+큐레이터 기본 고정 + 가시성**: 토큰 페이지 기본 depth=curator. 큐레이터는 렌더되나 최외곽(반경 ~1400)이라 fitView 에서 작던 문제 → 스파이럴 컴팩트화(SPIRAL_SPAN 230→150, 단일체인 마켓 10→7) + 마켓/볼트 노드 48→54(레이아웃 예약치) → 볼트 반경 1346→1064.
- **C14/C15 연결성 중요도 크기**: 노드 크기 = 규모(TVL) 단일이 아니라 "연결성"도 반영. 들어오고 나가는 구조 엣지가 많은 허브(많은 파생/토큰이 거쳐가는 프로토콜·마켓·큐레이터)일수록 큼(connImportance, 캡 1.7x). 멘토 §6 "규모가 아니라 연결성" 구현. (거래량 복합점수는 DeFiLlama yields 에 volume 없어 연결성으로 대체 — 후속.)
- **B8 임의깊이 멀티홉 재귀**: snapshot-lego 에 레벨2 — Curve LP → Convex 풀 → **cvxLP 영수증**(Booster.poolInfo.token) 을 레벨2 파생으로 추가, 그 영수증의 수용처(Morpho/Euler)를 다시 추적(addAcceptorsFor 재사용). LP 가 Pendle 기초자산이면 LP→PT 도. 검증: stETH → Curve LP → Convex → cvxsteCRV·cvxstETH-ng-f·cvxSTETHETH_C-f. 오버레이는 레벨2를 출처그룹에서 제외(Convex 를 출처로 오해해 기존 풀 숨기는 버그 차단) + producer 바깥에 멀티패스 배치(step 6).
- **B10 자동 라벨링 파이프**: `snapshot/classify.ts` 에 kuromi 프록시(EIP-1967/비콘/1167)·기초자산 프로브(asset/UNDERLYING/stETH/eETH)·Etherscan ContractName 을 얹어 미지 컨트랙트 → "어디 프로토콜의 무슨 역할" 추정 라벨. `classify-unknowns.ts`(npm/ cron 일일)가 unknown_addresses 큐를 라벨링 → `npm run review` 사람 확인 → protocol-registry 반영. 검증: wstETH→래퍼(underlying stETH)·Morpho→core(확정)·sDAI→erc4626(underlying DAI)·EOA→미확인. selectorReadable 은 비어있지 않은 응답 요구(7702 EOA 오탐 차단).

### 2026-06-12 (밤) — 큐레이터 홉 + B12 확인 (멘토 §3·§5)

- **B12 Uniswap = 이미 작동 확인**: breadth(DeFiLlama)가 Uniswap V2/V3/V4 풀을 잡고(USDe: V3 3·V4 2·V2 1풀) 동심원에 펼쳐짐(USDE-USDC 등 6 마켓). 이전 세션 컷오프 하향으로 §5 해소됨. 레고 재구현은 열등(on-chain getPool 은 quote 추측이라 실제 풀 놓침 — DeFiLlama 가 우월) → 재구현 안 함.
- **큐레이터 한 홉 추가**: Morpho `supplyingVaults{name}` → 수용처 마켓에 펀딩 큐레이터(MetaMorpho 볼트, 연쇄청산 시 부실채권 책임자) 볼트 노드 + 마켓→볼트 엣지. 체인: 토큰 → Pendle → PT → Morpho 마켓 → **큐레이터 볼트**(sUSDe PT/PYUSD → "Sentora PYUSD" 검증). 단 PT-담보 마켓이 대부분 소액·직접펀딩이라 현재 큐레이터 희소(sUSDe 1건) — 기능은 일반적, 데이터 있는 곳마다 표시.

### 2026-06-12 (밤) — F: 수용처 어댑터 확장 — Euler v2 (멘토 §6·§8 "LP·PT 재담보 케이스")

- **Euler v2 수용처 추가**: Euler v2 = 볼트별 모델. 각 대출볼트(`eulerVault`)의 `collaterals[]` = 받아주는 담보볼트들. goldsky 서브그래프 1회 bulk(841볼트) 캐시 → "토큰 D 를 담보로 받는 마켓" 역질의(`eulerAccepting`). discover.ts + snapshot ④'. 마켓 노드(kind=market, protocol=euler_v2), 파생→마켓 collateral_at.
- **리서치 발견(멘토 "안 넣었으면 이유라도"에 대한 답)**: Euler 는 PT 를 대량 수용(841볼트 중 PT 123). **단 현재 활성 PT 는 Morpho(퍼미션리스·즉시 생성)에 몰리고 Euler(거버넌스 큐레이션)는 과거 만기를 들고 있어** sUSDe 13AUG2026 PT 같은 최신물은 Euler 교집합 0. 그래도 **전체 watchlist 에선 stcUSD 등 일부 토큰의 현재 PT 가 Euler 담보로 잡혀**(frxUSD·USDe·USDT·USDC·RLUSD 대출 6마켓) 연결이 뜸 → 일반 알고리즘이라 데이터가 맞는 토큰에서 작동.
- **오버레이 폴백(c)**: Euler 처럼 동심원에 없는 수용처는 파생 바깥으로 체인 연장(부채꼴, 겹침 방지). 중복이 아니라 새 수용처라 자연스러움. venue 로고로 식별.
- 후속 후보: Silo(서브그래프 경로 미확정)·Abracadabra(대부분 deprecated, 현재 LP 미수용)·Spark. PT 만기 불일치 때문에 현재 활성물 커버는 Morpho 가 주력.

### 2026-06-12 (밤) — B11.1 정밀화: 수용처를 "마켓"에, 캡 제거, 임의 토큰 일반화 (사용자 피드백 3건)

- **수용처 = 개별 마켓(프로토콜 X)**: PT 를 받아주는 건 Morpho **프로토콜**이 아니라 그 PT 를 담보로 받는 **개별 마켓**. `lego_nodes.kind='market'` 신설, 파생→마켓 엣지. (사용자: "pt를 받아주는 마켓과 연결, 프로토콜로 가지말고")
- **연결 우선순위(2차 피드백 — "이미 있는 마켓 노드에 연결, 새로 만들지 마")**: 오버레이 step4 가 ⓐ 기존 동심원 마켓에 토큰겹침 매칭되면 그 노드에 연결(새 노드 X) → **Curve LP 는 기존 Convex 풀 노드(`convex-finance@…:m{j}`)에 붙음** ⓑ 매칭 없으면 그 수용처 프로토콜 클러스터(wedge ring2)에 마켓 생성 + 프로토콜→마켓 구조 엣지 → **PT-담보 Morpho 마켓(PYUSD·RLUSD)은 Morpho Blue 옆에 붙고 PT 가 거기로 교차 엣지** ⓒ 프로토콜이 그래프에 없을 때만 폴백. 파생 옆에 떠다니는 브랜드 노드 0. 매칭은 viewed 심볼·일반어 제거 후 4자+ 접두 일치(crvU↔crvUSD)라 "susde"만 겹치는 오탐 차단.
- **출처당 파생 캡 제거**: 6 → 24(사실상 전부), wedge 내 줄바꿈(perRow 4·radial rows)으로 가독성. sUSDe Curve LP 7종 전부 표시.
- **임의 토큰 일반화**: 토큰별 하드코딩 0(감사 완료 — 전 소스가 주소 기반 어댑터). `snapshot:lego` 기본 커버리지 top-12 → **전체 watchlist**(`allSymbols()`), cron 도 전체. 어떤 토큰을 봐도 동일 알고리즘. (사용자: "다른 토큰을 봤을 때도 그 모든 게 잘 되어야")
- 정리: 구모델의 acceptor protocol 노드(parent_token NULL) 고아 → DB 정리. /api/lego back-fill 을 참조 노드 일반화(마켓 포함).

### 2026-06-12 (저녁) — B11 레이아웃: 파생토큰을 "출처 프로토콜에서 뻗어나오게" (사용자 설계 확정)

- **사용자 설계**: 동심원을 유지하되 파생토큰을 토큰이 아니라 **어느 프로토콜에서 나온 LP/PT 인지** 그 출처 프로토콜에 붙이고, 그게 다시 어느 풀·마켓·프로토콜로 들어가는지(의존)를 잇는다. 순서 = 토큰 → 프로토콜 → (파생 풀/마켓) → (파생토큰) → 수용처. (동심원 완전 교체 X — 중간발표 기반·멘토 "갑자기 단순해지면 안 됨" 존중.)
- **lego-overlay 재작성(프로토콜 앵커)**: ① 각 파생을 출처 프로토콜(d.protocol)의 wedge 방향·바깥 반경에 배치(LP=링2, PT/YT/receipt=링3). ② 출처 프로토콜이 파생을 발행하면 그 프로토콜의 breadth 마켓 노드(`{pid}:m*`)를 숨겨 레고 파생으로 대체(Pendle generic 풀→PT/YT/LP, Aave reserve→aToken). ③ 엣지: 출처 프로토콜→파생(issues/lp_of) → 수용처(collateral_at/staked_in). 수용처가 동심원에 이미 있으면(Morpho·Convex) **교차 의존 엣지**로 잇고, 없으면 파생 바깥에 새 프로토콜 노드.
- **검증(sUSDe)**: Pendle→PT/YT/LP, Aave→aToken, Curve Dex→LP 6종 (출처 앵커 엣지 12). PT→Morpho(담보)·Curve LP→Convex(스테이킹) 교차 의존 엣지 = §8 "Pendle→Morpho 떠야"·§6 "stETH→Curve→Convex" 둘 다 그래프에 표시. 파생 클릭 시 상세(종류·발행 프로토콜·컨트랙트·수용처). 범례에 머니레고 4종 추가.
- **임시/후속**: wedge 내 파생 ≤6 캡(가독성), 교차 엣지가 길어질 수 있음. d3 tidy-tree 급 정식 라우팅·간격 최적화는 후속. 함정: Turbopack 파일워처가 가끔 멈춰 stale 컴파일 서빙 → `.next/cache` 삭제 + dev 재시작으로 해소(편집-검증 루프 복구).

### 2026-06-12 (오후) — 머니레고 엔진 v1: 파생토큰 1급 노드 + 구조 엣지 (멘토 §6·§8·§9)

- **원칙(§9 멘토 확정)**: 직접 자금흐름 없어도 구조가 확인되면 잇는다 — `issues`(기초→PT/YT/aToken 발행) · `lp_of`(구성토큰→LP) · `collateral_at`(PT→Morpho 담보 등재) · `staked_in`(Curve LP→Convex Booster 등재). 모든 엣지에 evidence(API/온체인 메서드) 기록, 추측 금지. EOA 는 소스가 전부 컨트랙트 레지스트리/API 라 구조적으로 배제.
- **소스(전부 키리스, Dune 없음 — 2026-06-12 라이브 검증)**: Pendle `markets/active`(underlying→PT/YT/LP) · Morpho GraphQL `collateralAssetAddress_in`(담보 수용 마켓) · Curve MetaRegistry `find_pools_for_coins`+`get_lp_token` · Convex `Booster.poolLength/poolInfo` 전수(567풀, multicall) · Aave `Pool.getReserveData` word8(aToken). 검증 사례: **sUSDe→PT-sUSDE-13AUG2026→Morpho(PYUSD·RLUSD 담보)** = §8 "Pendle→Morpho 가 떠야", **stETH→steCRV→Convex pid25** = §6 stETH→Curve→Convex.
- **저장**: `lego_nodes`/`lego_edges`(017 마이그레이션) — 시계열 아닌 "현재 구조", 토큰 단위 replace(만기 PT 자연 소멸). `snapshot:lego`(cron 6시간 `--top 12`). 라벨 = 온체인 symbol() 일괄 읽기(PT-sUSDE-13AUG2026·aEthsUSDe·steCRV — 주소가 아닌 읽히는 라벨).
- **kuromi 포팅**: `src/lego/onchain.ts` = proxy.py(EIP-1967/비콘/1167) + classify 프로브(asset()/UNDERLYING_ASSET_ADDRESS()/stETH()/eETH()) TS 화 — 멀티홉 확장(D17)·미지주소 라벨링의 공용 프리미티브.
- **프론트**: NodeType `DerivativeToken`(역할 칩 PT/YT/LP/aT) + 엣지 4색/한글 범례, `/api/lego/[token]`, `lego-overlay.ts` 가 동심원 위에 오버레이(수용처 방향 58% 지점/위쪽 호, 신규 프로토콜은 링 밖 1.18R — **임시 배치, B11 나무형 레이아웃 때 정식 재설계**). "머니레고 | 파생토큰" 토글(기본 켜짐). 함정 기록: 동심원 노드 id 는 `c:{chain}:token`/`c:{chain}:protocol:*` 이고 position 은 좌상단(중심 = +diameterPx/2) — 오버레이는 반드시 이 체계로 매핑.
- 부수정리: breadth Morpho 라이브 마켓의 비대상 체인 누수(Hyperliquid 칩) 차단 — CHAINID_KEY 3체인 + null=제외.

### 2026-06-12 — 스코프 대정리: 비EVM 삭제 · 3체인 축소 · Dune 폐기 · 메인 상황판 제거 (멘토 피드백 §11·§1 + 머니레고 관계맵 개편 준비)

- **비EVM 전부 삭제**: 솔라나(kamino/drift/marginfi/solend)·수이(navi/suilend/scallop)·스타크넷(vesu) 어댑터 + `snapshot-nonevm-lending` + cron 루프, breadth/token-exposures/flow-core CHAIN_MAP·chains-ui 의 비EVM 엔트리, 비EVM transfer 어댑터 5종(lib/{solana,tron,aptos,starknet,sui}-transfers + nonevm-venues), breadth 의 비EVM supply 직독(solana/sui/tron/aptos/starknet), bridge-authority·/api/flow 의 bridge_detections 병합. 근거: 검증 불가(§11) + 3체인 완성 우선. **`automation/bridge-detect/`(파이썬 8계열 탐지기)는 팀원 활성 작업이라 보존** — 호출부(snapshot-bridge-detect)만 제거. `bridge_detections` DB 테이블·기존 데이터도 보존(재통합 대비).
- **EVM 3체인 축소**: 이더리움·베이스·아비트럼만. `EVM_CHAINS`·`CHAIN_RPC`·snapshot-chain CHAINS·extraChainLoop(14체인) 제거. 체인 재추가 지점 = config/chains.ts `EVM_CHAINS` + lib/rpc.ts + snapshot-chain CHAINS + 프론트 CHAIN_MAP 들(각 파일에 주석).
- **Dune 폐기**: 너무 느려 사용 불가 판정 → `lib/dune.ts`·`snapshot-flows`(쿼리 7688600)·`discover-curator-wallets`·`backfill-flow-usd`(Dune URL 초과 우회 패치) 삭제, cron flowsLoop 제거, DUNE_API_KEY env 제거. **RPC 대체 시드 보존**: `src/snapshot/flow-rpc.ts`(온체인 폴백)·`flow-trace.ts`(enrich 로직) + `/api/flows/[token]` 의 refresh 큐(automationDir 가드로 현재 no-op) = D-16 에서 RPC 수집기 꽂는 자리. flow_nodes/flow_edges 테이블·기존 데이터 보존.
- **메인 페이지 실시간 상황판 제거**(§1 내부 합의): 랜딩 중앙 = 시총 순위 리스트(클릭=관계맵)로 교체, 우측 알림 패널 유지. FlowMapBoard 컴포넌트는 토큰 페이지 "실시간 상황판" 탭에서 계속 사용. 고아가 된 LandingGraph/LandingTxLayer 삭제.
- **lev(레버리지 루프) 탭 제거**: LeverageLoopGraph 삭제 — 머니레고 관계맵 개편(파생토큰 1급 노드)으로 흡수 예정. **브릿지 허브 뷰는 보존** — 레이아웃 개편 때 머니레고 구조와 함께 재설계.

### 2026-06-10 (밤) — 알림 독·비-EVM 흐름맵·발견 점선 구분

- **알림 토스트 → 쌓이는 독**: 3초 토스트(이력 소실)를 벨 버튼+우측 패널로 교체(AlertToasts 동일 export). /api/alerts 5초 폴링, 심각도 필터 칩(위험/주의/정보 카운트), 미확인 배지, critical 펄스. 브라우저 검증: 80건 누적·필터 동작·plasma euler-v2/solana drift 알림 표시.
- **비-EVM 흐름맵**: flow-core CHAIN_MAP + 체인 선택지에 Solana·Sui·Tron·Aptos·Starknet 추가 — 그래프(토큰·프로토콜·마켓·브릿지노드)는 DeFiLlama 라이브로 EVM 과 동일 구성(검증: USDC 솔라나 10프로토콜·40마켓, 수이 9·31, 트론 3). **라이브 입자는 Alchemy getAssetTransfers 가 EVM 전용이라 비-EVM 미지원** — 선택 시 헤더 배지·범례로 정직 표기(`LIVE_TX_CHAINS` = transactions API ALCHEMY_NET 거울).
- **발견 점선 구분(스크린샷 피드백)**: 위험(알림) 색이 sibling/관계 점선까지 빨갛게 물들여 추적 점선과 혼동 → 위험색은 흐름 실선(holds/market/vault)에만. 추적(발견)은 퓨샤(#c026d3) 굵은 점선 + 중앙 ◆N 마커 + 방향 crawl 로 유일하게. 발견 현황: fluid↔uniswap-v3 USDC $490K ×1,123(경유 접힘) — WBTC·WETH 조합은 0건(메이저 흐름은 전부 기존 엣지 위 = 정직).

- **방향 전환(사용자 피드백)**: 상세그래프 탭의 행위자 클러스터(이름모를 주소 노드)는 "정리 안 됨" — 폐기. hello 브랜치의 `/flow` 흐름맵(자체 페이지)을 그대로 채택: d3-force 라이브 시뮬 + ReactFlow, **실시간 트랜잭션 입자 애니메이션**(5분 윈도우·1분 지연, Alchemy getAssetTransfers — 입자가 실제 엣지 기하를 hop 단위로 탐), 카운터파티는 온체인 레지스트리(Uniswap CREATE2·Curve MetaRegistry·aToken·Comet·Morpho 싱글톤·Aerodrome)로만 해석(추측·날조 없음, 미해석=패널 전용). 채택 파일: app/flow + components/flow/* + lib/flow-* + api/flow·transactions·token-universe + 홈/토큰 페이지·헤더. DetailGraph·RiskHistoryPanel·/multi·정적 reflexivity.json 삭제(hello 와 동일).
- **우리 기능 결합 ①오라클 ◉**: `/api/flow` 가 DB `edges.attrs.topMarkets[].oracle`(온체인 introspection)을 마켓 라벨 매칭으로 오라클 엣지에 부착 — ─o─ 원이 NAV/ORACLE_FREE(자기참조)면 빨강 `!`, 클릭 상세에 제공자/타입/검증(예: WBTC/USDC · EACAggregatorProxy · MARKET ✓).
- **②브릿지 = 노드**: 토큰↔토큰 브릿지 엣지를 🌉 노드로 승격(토큰A↔[브릿지]↔토큰B). bridge_authorities 검증 메커니즘(CCIP·LZ·락박스…)이 라벨, 미검증 = "브릿지 미확인" 주의색 점선. 라이브 tx 가 이 노드를 경유 → 락/민팅 경로가 눈에 보임.
- **③Dune 추적 흐름 = trace 엣지(EOA 접기)**: flow_edges(14일 집계)의 행위자를 그래프 노드로 해석(주소→토큰노드 / family·별칭→프로토콜노드: UniswapV3Pool·UniversalRouter→uniswap, 라벨→마켓·볼트) — **미지 중간주소(EOA/MEV봇/라우터)는 1-hop 재귀 접기**(같은 자산 in→out, 금액=병목 min) 후 끝점끼리만 잇고, **이미 정적으로 연결된 쌍은 제외** = "트랜잭션이 발견한 새 의존성"만 로즈 점선(┈┈→, 방향 애니메이션)으로 보강. 잡주소 노드 0. 검증: fluid-lending→uniswap-v3 USDe $490K ×5 (경유 접힘) 등장.
- **전 토큰 동일 파이프라인**: /flow 는 어떤 토큰이든 동일 과정(DeFiLlama+Morpho 라이브 그래프 → DB enrich → 추적/브릿지/오라클) — 토큰피커(전 토큰 유니버스)·`?tokens=` 딥링크·토큰페이지 "흐름맵에서 보기" 링크. flow_* 데이터는 방문 시 자동 refresh 큐(타 에이전트의 016 잡 테이블) + cron 일간 `--top 6`.

### 2026-06-10 (오후) — 체인 커버리지 검증 + 트랜잭션 플로우 그래프 (kuromi flow_trace → Dune)

- **커버리지 검증(전 DeFi TVL $71B 대비)**: 정밀그래프 69.5% + 비EVM 14.1% = **83.6%**, breadth 포함 ~89%. 미커버 11%의 대부분은 Bitcoin L1($4.1B)·Provenance($1.6B, 기관 폐쇄형) — ERC20 담보 큐레이터 워크플로 구조상 스코프 밖. 큰 공백이던 **Hyperliquid($1.4B)·Plasma($1.8B 렌딩)·Katana** 를 DeFiLlama lendBorrow 어댑터 1줄씩으로 편입(hyperlend·hypurrfi·felix / aave-v3·fluid / morpho — dry 검증 알림 7건). 결론: 충분, 신규 체인은 lendBorrow 1줄 패턴으로 즉시 추가 가능.
- **트랜잭션 플로우 그래프 — kuromi `feeder/flow_trace.py` 포팅(Dune 단일 SQL)**: kuromi 의 alchemy BFS(depth2)를 Dune 저장쿼리 **7688600**(파라미터: token_address·window_days·max_actors)으로 대체 — ① 토큰 transfer 활동량(degree) 상위 행위자 발굴(=discover_seeds) ② 행위자간 **모든 ERC20** 방향 흐름 집계(담보의 담보) + 민트/번. 실행 ~2크레딧/토큰, USDe 라이브 검증(행위자 60·엣지 1940·Uniswap V4 라우터/MEV봇/sUSDe 정확히 포착).
- **후처리 = 결정적 코드**(kuromi 원칙): `snapshot/flow-trace.ts` — 병적 자기조달 고리(LENDERS{Morpho·AaveV2/3·Spark}→주입 자산이 닫힌 고리로 복귀할 때만, 순수 스왑고리 제외) DFS·심볼 스푸핑(비ASCII 정제+메이저 사칭)·역할(공급/담보·차입/인출). 라벨링: 우리 nodes → 프로토콜 레지스트리 → EOA판별 → 온체인 symbol → Etherscan V2.
- **자동화 계약**: `npm run snapshot:flows -- <SYM>` 한 줄 = 새 토큰도 주소해석→Dune→라벨→고리→DB(flow_runs/nodes/edges, 015 마이그레이션, 토큰당 최신 런 REPLACE). cron 24h `--top 6`(~12크레딧/일). **DUNE_API_KEY 미설정 시 안내 후 종료**(현재 미설정 — 키 추가 시 라이브). 개발/테스트는 `--input <dune rows json>`(크레딧 0).
- **상세그래프 탭 전용 렌더**: `/api/flows/[token]` → DetailGraph 6번째 레이어(행위자 2행 지그재그, 종류색: 프로토콜/토큰/컨트랙트/외부지갑) — 흐름 엣지 = 점선+자산·금액·횟수 라벨, 공급/담보=청록·차입/인출=주황·민트/번=보라·**자기조달 고리=빨강 애니메이션**, 엣지/노드 클릭=우측 상세(샘플 tx·블록범위). 관계맵(동심원)은 이 데이터를 일절 소비하지 않음(요구사항).

### 2026-06-10 — 전 체인 커버리지 확장 (Alchemy 전수 활용) + 운영 사고 2건 복구

- **사고① 구버전 cron**: 6/9 08:31에 뜬 cron 프로세스가 21:06에 추가된 루프(extraChain·nonevm·reflexivity)를 모름 → polygon/bsc/gnosis/scroll/worldchain/metis 스냅샷 0회. `start.sh` 재기동으로 해결(로그도 `/dev/null`→`.run/cron.log`). 교훈: cron.ts 수정 시 반드시 재기동(자식 스크립트는 spawn이라 핫리로드되지만 루프 셋은 아님).
- **사고② 워치리스트 붕괴 + 안전가드**: 6/9 23:31 discovery 사이클에서 소스 일시 실패 → `deactivateDiscoveredExcept`가 자동발굴 전원 해제(60→10, 그래프 287→33엣지). `discover` 재실행으로 복구(61 active) + **가드 추가**: 3소스 중 하나라도 0건이면 비활성화 sync 스킵(활성화만 반영).
- **EVM 정밀 그래프 12→17체인**: `snapshot-chain.ts CHAINS`에 linea·zksync·sonic·celo·soneium 추가(pap = bgd aave-address-book 값을 Alchemy RPC `getPoolDataProvider→getAllReservesTokens`로 전수 검증: 9/8/4/6/3 reserve). cron `EXTRA_CHAINS` 9→14(체인당 ~4.7h 주기). `rpc.ts`에 unichain·worldchain 등 7체인 등록(viem 내장 체인 객체 — zksync는 multicall3 특수주소라 내장 필수) + 미등록 chainId 메인넷 폴백 시 **경고 출력**(조용한 잘못된-체인 호출 방지).
- **breadth 멀티체인 supply 22→31 EVM + 비-EVM 6**: `ALCHEMY_SLUG`에 metis·celo·sei·fraxtal·polygonzkevm·monad·rootstock·opbnb·abstract 추가(전부 실키 eth_chainId 프로브 검증). **Starknet supply 리더**(starknet_call, sn_keccak 셀렉터 라이브 검증) + Aptos를 Alchemy `/v1/view` 우선으로. TON 은 Alchemy 미지원(대시보드 전수 확인)이라 리더 미탑재 — 익스포저는 DeFiLlama 풀 매핑으로만 표시.
- **decimals 버그 수정(중요)**: EVM supply 환산이 "레퍼런스(이더리움) decimals" 가정 → opBNB/Rootstock USDT(18dec)가 $58조로 폭발. llama 메타 없으면 **온체인 `decimals()` 직독** 후 레퍼런스 폴백으로 변경.
- **Sui/Tron supply 샘플 0 수리**: ① 주소 resolve 2차 패스(underlyingTokens 1개면 exposure 표기 없어도 인정 — 비-EVM 풀 메타 부실 대응) ② 검증된 오버라이드(USDT@tron `TR7NH…` $89.3B·USDT/USDC/USDe@solana·USDC@sui — 전부 해당 체인 RPC로 totalSupply 직독 검증) ③ `snapshot-chain-supply` 토큰 선정을 알파벳순→**규모(엣지 USD 합)순**(USDT/USDC가 톱12에서 잘리던 구멍). 결과: chain_supply_samples 19→**34체인**.
- **Starknet 렌딩 = Vesu 직접 어댑터**: DeFiLlama lendBorrow에 Starknet 0건(전수 확인) → `vesu-starknet.ts`(api.vesu.xyz 공개 REST, 86 reserve·$29M, isDeprecated 풀 스킵, LTV는 페어 단위라 util-only). nonevm 러너 11어댑터: Solana 4 · Sui 3 · Starknet 1(Vesu) · Tron/Aptos/Starknet(DeFiLlama lendBorrow).
- **git 히스토리 스쿼시**: 기존 커밋 전부 정리 → 단일 기준 커밋(`main`, 941파일). `.run/` gitignore 추가, `.env` 류 미추적 확인. 리모트(GitHub)에는 옛 히스토리 잔존 — 푸시 시 force 필요. **이후 커밋은 사용자 명시 요청 시에만**(정책).
- **디텍터 체인 리스트 단일화(P10)**: `config/chains.ts EVM_CHAINS`(18체인: chainId·alchemy슬러그·publicRpc·avgBlockSec) 신설 — public-rpc(로그스캔)·bridge-authority·backing·mintburn·bridgeauth 러너·alchemy(getTokenBalances/getOutgoingTransfers)가 전부 이걸 소비. backing 7→18체인(목록 밖 체인 = watch 전체 skip 이던 정확도 구멍 해소). `evmRpcUrl()` = env > Alchemy > 공개.
- **큐레이터 확장(P11)**: Morpho vaults 3→8체인(+optimism·polygon·unichain·worldchain·**katana** — GraphQL 라이브 프로브로 fraxtal/ink/gnosis/avax 미지원 확인). Euler Goldsky 3→17 엔드포인트(실볼트: sonic·avalanche·bsc·unichain·swell·linea·plasma — 슬러그 전수 프로브, avax/polygon 404). 첫 런 198 할당(katana 20·worldchain 7). **Kamino 볼트 큐레이터는 공개 REST 부재**(kvaults/v2/vaults 404, strategies 는 LP 전략) → klend SDK 온체인 직독 필요, 백로그.
- **CCIP·CCTP 멀티체인(P12)**: CCIP selector 8→18(공식 chain-selectors 레지스트리에서 추출 — **구 gnosis 값이 틀려있었음**, 교정). CCTP USDC/TokenMessenger 6체인(eth·base·arb·op·polygon·avax — 전부 usdc.symbol()+messenger getCode 온체인 검증; unichain 은 messenger 미검증이라 제외).
- **reflexivity·지갑 멀티체인(P13)**: morpho-api·computeReflexivity 에 chainId 파라미터(Etherscan V2 는 이미 chainid 지원 확인) → 러너가 메인넷 watchlist + 비메인넷 Morpho 6체인(체인당 상위 25·≥$5M, 비용가드) 계산, loop_findings 는 체인 스코프 id(token:SYM@base). dossier 는 `LIKE $1||'@%'` 로 체인 행 포함. 지갑추적: getAllTokenBalances 체인 파라미터화 → 5체인(eth·base·arb·op·polygon) 온체인-매핑 합산.
- **비-EVM 그래프 1급 시민(P14)**: nonevm 러너가 알림과 함께 nodes/edges upsert — `token:SYM@{solana|sui|tron|aptos|starknet}` + `protocol:{slug}@{chain}`, edge_type=loan_asset, lendingRisk(가중 LTV/이용률)+topMarkets. 노드 슬러그를 DeFiLlama project 와 정렬(kamino-lend·save·navi-lending·scallop-lend — 라이브 확인) → 동심원 정밀-우선 dedup 이 breadth 점선과 중복 제거. 첫 런 165 엣지(solana 50토큰·sui 36·tron 19·starknet 12·aptos 11). topology/USDC 가 15체인 노드 반환 검증.
- **Detector B 모델 게이트(체인 확장이 드러낸 구조적 FP)**: 18체인 확장 후 USDC 8,164건·wstETH 미정합 mint 발화 — Circle 네이티브 발행(burn 없는 mint 가 정상)과 lock&mint(A 권위, 모듈 헤더의 설계 의도)는 B 의 burn&mint 가정 밖. `NATIVE_ISSUANCE_SKIP`(USDC·USDT·PYUSD·EURC·WETH·cbBTC — 체인별 독립 발행/wrap) + `BACKING_WATCHES` 토큰 자동 skip(A 핸드오프). 결과: B 는 burn&mint 메시 클래스(WBTC·ezETH·weETH·wrsETH·USR·syrupUSDC·wsrUSD·LBTC)만 — USR 40건·LBTC 6건 미정합은 정직한 검토 신호로 유지.

### 2026-06-09 — 백엔드 보완 4종 (게이트 문서화 · dead config · Detector A 활성 · reflexivity 라이브)

- **discovery 승인 게이트 = 문서를 코드에 맞춤** — MANUAL은 "active=false 제안 후 승인"이었으나 `discover.ts`는 임계(누적 95% 커버리지·최소 $1M) 통과 시 `active=true` 즉시 등록(승인 게이트 없음, 미달 시 자동 해제). 코드 유지 + §1.3·§4·§5·§14·§18 문서 정정.
- **dead config 5종 제거 + 리베이스 억제 배선** — `oracle.{stalenessBlocks,deviationByClass}` · `totalSupply.perBlockPct` · `depeg.{nearLtDistance,deviationBps}` 전수 grep 후 미사용 확인 → 제거. `rebaseSaneMax`(백테스트 전용이던 것)를 `diff.ts:checkTotalSupply` 통계 스파이크 경로에 배선(1스냅샷 |Δ|≤50% ∧ 단일-블록 이산 mint 0 → 설계 리베이스로 억제, provenance/critical 경로 무영향 → 진짜 무한민팅은 계속 잡힘). 검증: tsc 0 · 백테스트 67 GREEN.
- **Detector A 라이브 활성(P0-2 갱신)** — `BACKING_WATCHES`에 wstETH lock&mint(Lido L2 브릿지) 추가. L1 잠긴 wstETH(Σ 3 브릿지) ≥ Σ L2 공급(arb/op/base). 온체인 검증 arb 1.041·op 1.006·base 1.003 over-backed → `snapshot:backing` "balanced ✓"(건강 → 무알림이 정상). 브릿지 메시지층 침해로 L2 무담보 mint 시 critical(백테스트 Wormhole/xUSD GREEN 경로). xERC20 lockbox() 노출 토큰이 드물어 manual watch가 가장 확실.
- **kuromi reflexivity 라이브화 + Tier0 통합** — 정적 `public/fraud/reflexivity.json` 수동복사 → 라이브 파이프라인. `snapshot/reflexivity.ts`(`computeReflexivity`: Morpho 담보 마켓 오라클 introspect[introspect.ts 재사용] + 차입자 집중도/self-deal → kuromi grade) + `scripts/snapshot-reflexivity.ts` + cron 1h + `loop_findings(source=reflexivity-v1, 토큰당 1행, detail jsonb)` 적재. dossier.loops가 서빙 → 프론트 Tier0 판결 + 상세그래프가 **라이브 소비**(정적 fetch 제거). 라이브 62토큰 적재: muBOND CRITICAL(sole·$11.5M) · deUSD/USD0++/stcUSD/msY HIGH(bespoke/NAV·self-deal). deUSD worst-market 오라클(0x2D94…)이 정적 kuromi와 일치(충실 포팅). Tier0 verdict에 `reflexive` 팩터(HIGH+∧bespoke/NAV∧비-RWA → hardOracle 승격) 통합 — 정적 regex 보강. 검증: automation tsc 0 · frontend build 0 · dossier API 라이브 · UI "사기 루핑 의심(kuromi HIGH)" 판결 렌더 · 콘솔 0.
- **UI 탭 정리 + 상세그래프 강화(별건)** — 토큰 페이지 보기 탭 5→2(관계맵·상세그래프 유지, 분포/나선상세/xUSD사례 + 컴포넌트 3종 삭제). 상세그래프에 오라클 위험분류 색(oracle.ts: 하드코딩/NAV=⚠빨강, 엣지에서 경고) + reflexivity 사기판정 뱃지 통합(멘토 피드백: "자산–Morpho 엣지에서 오라클 조작 경고"). 한자 제거(高→높음·有→있음, 메모리 UI 순수한글 규칙).

### 2026-06-08 — D04b 오라클 freeze/staleness 검출기 구현 (dead config heartbeat/stalenessFactor 배선)

- **목표**: 오라클 피드가 멈추면(updatedAt 노후) 디페그가 온체인에 안 잡혀 청산 미발화 → silent bad debt(팀원 risk_rules D04b).
- **데이터 소스 발견(프로브)**: Aave `getSourceOfAsset` 어댑터는 `latestAnswer`(가격)만 노출, `latestRoundData`·`latestTimestamp` 는 revert(USDC·rsETH 확인) → timestamp 없어 staleness 불가. **정답 = Chainlink Feed Registry**(`0x47Fb…`) `latestRoundData(token, USD)` 로 정식 USD 피드 updatedAt. (WETH→ETH 키, 미등록 LST/exotic→revert→skip.)
- **구현**: `snapshot-token.ts` 가 토큰레벨 1회 FeedRegistry 읽어 `token.metadata.oracleFeed{updatedAt,answer,roundStale}` 저장 → `diff.ts:checkOracleStaleness`(토큰레벨, checkDepeg 옆) 가 answer≤0 / roundStale / age>heartbeat×stalenessFactor → `oracle_stale` critical. `heartbeatByClass`·`stalenessFactor` 이제 라이브. (per-edge Aave 시도는 dead 라 제거.)
- **calibration 정정(라이브 측정)**: USDC 평시 feed age 3.4h(실제 Chainlink stable heartbeat 24h)인데 구 config stable=1h → 1.75h 임계로 상시 오탐이었음. 실측 재보정: stable/soft/altcoin→24h, major→2h. → USDC 발화 안 함(검증), oracle_stale 0건.
- **커버리지/후속**: FeedRegistry 등록 major/stable(silent-bad-debt 핵심 시나리오). LST/exotic 미등록(교환비 오라클, freeze 의미 다름). `deviationByClass`(오라클-시장 괴리)는 두 가격 단위정규화 필요 — 미사용. 검증: tsc 0 · 백테스트 67 GREEN · USDC oracleFeed 캡처 + 오탐 0.

### 2026-06-08 — dead config 전수조사 → production diff.ts 배선 (팀원 risk_rules 이식 갭 메움)

- **발견(팀원 audit + 기계적 grep 검증)**: `alert-thresholds.ts:RECOMMENDED_THRESHOLDS` 필드 중 **17 dead + 3 backtest-only** 가 production(`diff.ts`) 미연결 — 값표는 이식됐으나 발화 코드가 안 읽음. (config 파일 제외 재귀 grep.)
- **이번 배선(11필드 → 라이브, 기존 스냅샷 데이터만, 새 데이터/스키마 불요)**:
  - `largeSingleMintBps`(10%→critical) · `minRelDelta`(flat-MAD z-폭발 가드) → `checkTotalSupply`
  - `jumpMinLevel`+`jumpActionable`(util 점프 레벨 co-gate — idle 5→20% 오탐 차단, ≥70% 안착만 + ≥12pp run) → `checkUtilizationLiquidity`
  - `whaleUnwind.absDropUsd.info`($1M dust floor — $100k 50% 인출이 critical 되던 % 우회 차단) → `checkWhaleUnwind`
  - `collateralAdoption.dustUsd`/`materialUsd`(먼지 게이트 + materiality 플래그) → `checkCollateralAdoption`
  - `newMarket.fastGrowthUsd`($5M 급유입) → `checkNewMarkets`(신규 kind `market_fast_growth`)
  - `badDebt.actionableUsd`/`highUsd`(마켓 deficit=borrow>collateral, deficit-$ 기준) → 신규 `checkBadDebt`(scan-current-risks LLTV-거리와 상보)
  - `mintBurn.matchWindowSeconds` → `snapshot-mintburn.ts` 가 env 대신 config 기본값 소비
- **audit 정정 1건**: D11 mint/burn 은 false-negative 아님 — `snapshot-mintburn.ts` cron 이 프로덕션에서 `reconcile` 발화 중(env-param). config 필드만 dead 였음 → 이제 config 소비.
- **검증**: automation tsc 0 · 백테스트 67 GREEN(회귀 0) · 라이브 `snapshot:one rsETH` EXIT 0 · DB 464마켓 deficit 파싱(현재 underwater 0=정상 과담보).
- **남은 갭**: ✅ D04b 오라클 staleness(완료 — 위 항목) · unbacked 지속성(`settlementSeconds`/`persistencePolls` — 크로스스냅샷 상태저장) · 7d slow-bleed(value-drift 2번째 윈도우) · depeg venue/`nearLtDistance` · `deviationByClass`(오라클-시장 괴리, 단위정규화) · HIGH 4단계(severity enum 스키마). `perBlockPct`·`stalenessBlocks` 의도적 제외(v1).

### 2026-06-08 — L2 래핑 변형(wrsETH) 별칭 + dust 컷오프 ↓ → rsETH Base/OP 노출

- **증상**: rsETH 페이지에 ETH/Arb 2체인만 표시. **원인 2개**: ① Base/OP 의 rsETH 는 **wrsETH(WRSETH)** 로 배포(주소 0xEDfa…/0x87eE…) → breadth 의 정확-심볼 파트 매칭("RSETH")이 "WRSETH"를 못 잡음. ② TVL(Base $137k·OP $21k)이 `CHAIN_TVL_MIN=$250k` dust 컷 아래(이게 1차 진단이었으나 ① 이 더 근본).
- **수정**(`frontend/app/api/breadth/[symbol]/route.ts`): ① `WRAP_ALIASES`(RSETH→[WRSETH]) 명시 별칭으로 symMatch 확장 — W-prefix 일괄 매칭은 stETH↔wstETH 혼동 유발이라 **금지**, 명시 맵만. ② `CHAIN_TVL_MIN` 250k→20k(OP $21k 통과, 노이즈는 MAX_CHAINS=12 로 제한). 검증: breadth 4체인(eth/arb/base/op) · 그래프 4 체인 원 + base/op 캐노니컬 락&민트 브릿지 렌더.

### 2026-06-08 — LST/LRT 오라클 = 교환비(NAV)로 표시 분류 (rsETH "시장가" 오표기 정정)

- **함정(사용자 지적)**: rsETH 등 LST/LRT 는 2차 시장가가 아니라 기초 ETH 대비 **교환비(exchange-rate/NAV)**로 가격됨(Aave CAPO 등) → 시장 디페그가 오라클에 안 잡힘. 그런데 UI 엔 "시장가"로 표기됐음.
- **근본 원인**: automation 어댑터(aave-v3-family·compound-v3·fluid·morpho-blue·aave-v2)가 자산 구분 없이 `oracle.type="MARKET"` 하드코딩. aave-v3 `provider="Chainlink composite (with CAPO)"` 도 어댑터 상수라 USDe·rsETH 동일. `EXCHANGE_RATE` 타입은 스키마에 있으나 미사용.
- **수정(표시 계층)**: `frontend/lib/oracle.ts` 신설 — `isRateBasedAsset`(classifyAsset lst 미러: rsETH/weETH/*ETH)·`oracleClassOf`(MARKET ∧ LST → "환율(LST)")·`oracleNote`(클래스별 디페그민감·한 줄 해석). dossier **오라클 분포**·**엣지 클릭 패널**·**상단 판결 바** 3곳 공유. "디페그 민감"도 클래스에서 파생(환율=아니오/교환비 추종 · 시장가=예). 검증: rsETH 3곳 모두 환율(LST) · tsc 0.
- **정공법(적용 완료)**: 어댑터 6종(aave-v3-family[=aave_v3+spark]·compound-v3·fluid·morpho-blue·aave-v2·generic-balance)이 `AdapterContext.tokenSymbol` 을 받아 collateral 의 classifyAsset='lst' 면 `EXCHANGE_RATE` 적재(`oracleTypeForCollateral` 헬퍼). snapshot-token·snapshot-chain 이 심볼 전달. **rsETH 재스냅샷 검증**: Aave/Compound/Fluid/Spark/Morpho=EXCHANGE_RATE · DEX=NONE · USD 정상($772M). 전체 `snapshot:all` 로 DB 정정. 프론트 표시 보정(MARKET∧LST→환율)은 미재스냅샷 데이터용 폴백으로 유지.

### 2026-06-08 — RWA 의도적 디스카운트 오라클 정상-라벨 (P2-8)

- **함정(전문가 §3.3, mF-ONE)**: RWA(국채/펀드형)는 NAV 1.1 인데 오라클을 일부러 0.98 로 **디스카운트 고정**(청산 방지·보수평가) — 정상 설계. 그런데 하드코딩 오라클 detector(P1-4 + Tier0 hardOracle)가 이걸 "위험 가격동결"로 오탐.
- **수정**: `classifyAsset` 에 RWA 토큰(mF-ONE/JTRSY/USDY 등) 보강 + `isIntentionalDiscountOracle(symbol, oracleType)` = (rwa ∧ NAV/ORACLE_FREE/fixed) 신설. **비-RWA 의 고정 오라클은 여전히 위험**(이게 핵심 구분).
- **배선**: `diff.ts` oracle_hardcoded_switch — RWA 의도적이면 critical→warning + "RWA NAV 보수평가일 수 있음" 메시지. 프론트 Tier0 — 페이지 토큰이 RWA 면 NAV/fixed 오라클을 `rwaDiscount`(정상)로 분기해 위험 hardOracle 에서 제외, 오라클 칩 "RWA NAV(정상)". 검증: classifyAsset(mF-ONE/OUSG/USTB/USYC)=rwa · 헬퍼 정확 · tsc 0 · 백테스트 GREEN.

### 2026-06-08 — 지갑 7일 브릿지 in-flight FP 가드 (P2-7)

- **함정(전문가 §3.2)**: 추적 지갑이 Optimistic 롤업 L2→L1 인출(7일 챌린지) 시 자금이 브릿지에 묶여 포트폴리오가 "비어 보임" → `wallet_value_drop` 오탐.
- **가드**: 급감 발화 시 급감 윈도우(3일) 아웃고잉 목적지를 주요 5체인에서 확인 → known 브릿지면 in-flight/settling 로 **info 다운그레이드**(페이지 억제, 기록 유지). 삭제/완전억제 아닌 다운그레이드라 실드레인 오억제 위험 제한.
- **known 브릿지**: ① 검증된 `bridge_authorities`(토큰별) ② canonical(OP-stack 0x42…0010/0016/0007 예약주소·ArbSys 0x…64·L1 게이트웨이 — 결정론적/문서화 안전주소만).
- **구현**: `lib/alchemy.ts:getOutgoingTransfers`(alchemy_getAssetTransfers, enhanced API·무료티어 OK, 체인 파라미터화) + `lib/wallet-bridge-guard.ts`(detectBridgeOutflow·loadVerifiedBridgeAddrs) + `snapshot-wallets.ts` 배선. ALCHEMY 키 없으면 가드 미작동(원래대로 발화). 검증: tsc 0·백테스트 GREEN·라이브 getAssetTransfers 동작·매칭/null-safe.

### 2026-06-08 — 문서 통합 (중복/stale 정리)

- **루트 .md 7→3개로 통합.** `ARCHITECTURE.md`(stale 06-05, "7개 리스크팩터"=구버전) + `BLUEPRINT.md`(MANUAL이 상위집합) → **`MANUAL.md` 단일 종합 문서**로 통합 후 삭제. `DEPLOY.md`(체인맵·Slack stale) → **`ops/OPS.md`** 에 프로세스·포트·ENV 표 병합 후 삭제. `TOKEN-ADDRESSES.md`(`dump-token-addresses.ts` 로 재생성 가능한 stale 덤프) 삭제.
- **남은 문서**: MANUAL(운영·이해·재현 종합) · DECISIONS(왜 로그) · BACKLOG(todo) · ops/OPS(운영절차) · docs/threshold-calibration(임계값 근거). 상호참조 링크 갱신(BACKLOG/MANUAL 의 BLUEPRINT 링크 제거).
- **원칙**: "어떻게 동작하나" 문서를 **하나(MANUAL)로 단일화** — 셋(ARCHITECTURE/BLUEPRINT/MANUAL) 분산은 동기화 누락(직전 ouroboros stale)을 부른다. 상태 스냅샷 문서는 최소로.

### 2026-06-08 — 동일패밀리 재담보(ouroboros) 신호 전면 제거

- **왜**: "담보·대출이 같은 계열이면 단일마켓 레버리지 루프 가능"은 **실 레버리지 미검증 추정 휴리스틱**(`isOuroborosPair`/`sameFamily` = 단순 자산패밀리 매칭). 약한 신호라 노이즈만 키움 → 전면 제외.
- **소스 2곳 무력화**: `morpho-blue.ts:isOuroborosPair`(+ 자산패밀리 Set) · `frontend breadth route:sameFamily` 제거 → `ouroborosRisk`/`ouroboros` 항상 false.
- **위험 로직 제거**: `diff.ts` new_market ouroboros 승격 + `scan-current-risks.ts` `ouroboros_market` 알림·structural-v1 loop_finding + `alert-thresholds.ts:newMarket.flagOuroboros`.
- **UI 제거**: Tier 0 판결 '재담보 루프' 팩터·Stat 칩 · 토큰 상세패널 🔁 주석 · 동심원 그래프 노드 빨강 하이라이트 · explore/SidePanel/HoverTooltip/TokenDashboard 마커 · 알림 라벨(app/page.tsx)·카테고리(AlertPanel).
- **옛 데이터 정리**: DB `alerts(kind=ouroboros_market)` 14행 + `loop_findings(kind=ouroboros)` 10행 삭제.
- **잔여(무해)**: `ouroborosRisk`/`ouroboros` 타입 필드는 인터페이스에 남되 항상 false. 검증: tsc 0(양쪽) · 백테스트 67 GREEN · UI .js 청크 0 매치.

### 2026-06-08 — 백로그 P0/P1/P2: watchlist 재조준 + 오라클 하드코딩 + 담보채택 + 가치-드리프트

- **P2-6 NAV×supply 가치-드리프트 detector** — 전문가 §3.2 핵심 자금추적 방법론(총가치=NAV×supply, 빠지면 "유출"). 데이터는 이미 있음: **`chain_supply_samples.supply_usd`**(체인별 가치 시계열, 210행). `snapshot/value-drift.ts`(순수 `computeValueDrift`: 윈도우 내 peak 대비 낙폭) + `scripts/snapshot-value-drift.ts`(러너, source=valuedrift-v1) + cron 1h + config `valueDrift`(dropPct 10/25/40% · **minAbsUsd $10M 절대게이트**(소형 노이즈 컷) · window 24h) + AlertPanel "유동성" 분류. 합성검증: $1B→$600M(40%)→critical · 노이즈±3%→null · 소형<$10M→null · 상승→null. 실데이터(잠잠) 0 오탐. (지갑묶음 연계는 P2-7 후속.)

- **루트 `.env.example` 삭제** — 옛 new-simulator(attic) 유물. "mock 모드 데모 데이터" 문구가 가짜데이터 오해 유발. mock 생성기(AaveCollector)는 전부 `attic/backend/`(죽음, :8000 down, 라이브 0 참조) 확인. 라이브 데이터는 실온체인(검증).
- **BACKLOG.md 신설 — 평가서를 실제 코드와 대조 정정**: P1-3(IRM)·P1-4(오라클)·P1-5(담보채택) detector 는 **이미 구현돼 있었음**(평가서 "추가"는 부정확). 실제 갭은 보완뿐.
- **P0-1 위험 토큰 재조준** — `scripts/seed-risk-watchlist.ts`: USD0++·crvUSD·sUSDe·USDe·ENA·mkUSD·USR·syrupUSDC·alUSD·deUSD 를 **온체인 symbol() 검증 후 pin**(manual → discovery 안 내림). 잘못된 주소 자동 탈락. 10개 스냅샷 → **35건 실제 알림 생성**(USDe critical new_market+ouroboros, sUSDe bad_debt_threshold·ouroboros, crvUSD/syrupUSDC critical collateral_adoption). 제품이 "실제 위험"을 보기 시작.
- **P0-2 정직한 발견** — 위험 토큰 9/9 **xERC20 lockbox 없음**(네이티브/CDP/burn&mint) → **Detector A 활성 안 됨**(엔진/백테스트는 검증됨). 이들은 Detector B+디페그+공급이 올바른 커버리지. Detector A 라이브엔 진짜 lock&mint(xERC20) 토큰 필요.
- **P1-4 오라클 하드코딩 전환 critical** — `diff.ts:checkOracleChange` 에 정상 라이브 피드(MARKET/EXCHANGE_RATE) → ORACLE_FREE(하드코딩) 전이 = critical(`oracle_hardcoded_switch`). 가격 동결 → 청산 미발화 → bad debt 누적(§6.7). Tier0 `crit`+`hardOracle` 팩터로 자동 연계, AlertPanel 분류.
- **P1-5 저신뢰 담보채택 critical 승격** — `checkCollateralAdoption`: minor 렌딩 프로토콜이 **long-tail(classifyAsset=altcoin) 담보** 채택 시 warning→critical(쓰레기담보 마켓 의심, UwU/MEV류 선행 시그널). 블루칩(stable/major/lst)은 warning 유지(FP 억제).
- 검증: automation/frontend tsc 0, 백테스트 67 case GREEN 유지, 위험 토큰 라이브 페이지 200(DB 직독 — 재빌드 없이 노출).

### 2026-06-08 — 운영(D): 알림 채널 + launchd + archive RPC 옵션 + 배포 문서

- **알림 채널(D#9)** — `src/lib/notify.ts` `dispatchAlert`: insertAlert 가 DB 적재 후 호출, **env 설정 채널로만** warning/critical 발송(**Discord webhook** · Telegram bot · 범용 webhook). info 는 DB만. fire-and-forget(메인 비차단). 미설정 시 no-op(기본 zero-cost). cron 기동 로그에 활성 채널 표시. (토큰/계정은 운영자가 .env 에 — 자동화가 대신 못 함.)
  - **2026-06-08 후속: Slack→Discord 전환.** 구 `slack-alert.ts`(`postSlack`, blocks 형식) → `discord-alert.ts`(`postDiscord`, embed 형식) 로 교체. notify.ts 채널도 Discord(`{content}`). `diff.ts` 가 insertAlert 직후 직접 postSlack 하던 **중복 발송 제거**(insertAlert→dispatchAlert 가 쿨다운 적용해 유일 경로). discover.ts watchlist 요약은 postDiscord 로. `SLACK_WEBHOOK_URL`→`DISCORD_WEBHOOK_URL`.
- **launchd 상시구동(D#11)** — `ops/com.exposure.frontend.plist`(무비용, 단일 링크 유지) + `ops/com.exposure.cron.plist`(OPT-IN, 무료티어 RPC 연속 소모). KeepAlive 자동 복구 + RunAtLoad. cron 은 비용 안전상 기본 OFF 유지.
- **archive RPC 옵션(D#12)** — `ARCHIVE_RPC_URL` 설정 시 `scanLogsRecent(deep=true)` 가 한 콜 fromBlock:0 full-history. 미설정이면 publicnode bounded(비용 0). `archiveClientFor`/`hasArchiveRpc` 신설, bridge-authority·mint-burn-recon 이 우선 사용.
- **배포(D#10)는 문서로** — `ops/OPS.md`: 로컬(기본)·cloudflared 터널·Vercel+Neon 경로. 계정 생성/연결문자열은 운영자 단계(자동화 불가, 프로히비티드).
- **타임라인 스크럽(D#8)은 부분** — 공급/알림 **시계열은 존재**(dossier supplyHistory 24h + alerts 타임스탬프)하나, 전체 **그래프 상태 스냅샷은 비영속**(JSON 덤프 게이트 off — 저장 절감) → 그래프-스테이트 스크럽은 영속화 추가가 선행. 정직하게 deferred.

### 2026-06-08 — 데이터 폭(C): Detector A 멀티체인 backing 백테스트 검증 + #6/#5 현황 정직화

- **Detector A(멀티체인 backing) 백테스트 구동(C#7)** — 하니스가 `evaluateBacking` 을 라벨된 무담보 사건으로 검증: backing + `remote_supply{chain:supply}` 입력 → Σremote vs backing 불변식. **Wormhole(2022, backing 21 vs Σremote 93,769 → critical) · xUSD(2025, 2.0e14 vs backing 1.7e14 → critical, persist→CRITICAL, balanced 1.68e14<1.7e14 → 침묵) 전부 PASS.** 구동채점 64→67, 여전히 recall 100%·FP 0%·GREEN. (dedup 은 DEPEG 에만 적용 — 공급/backing 은 persistence 확정 자체가 신호라 point-in-time.)
- **Detector A 러너 정확도** — autoWatches 가 하드코딩 `decimals:18` 대신 canonical 토큰에서 실제 decimals 읽기, `tolBps` 도 config(`unbacked.toleranceBps`) 기반. 엔진은 이미 멀티체인(`nodes` 의 모든 체인 ΣtotalSupply vs lockbox 잔액). ⚠️ 현재 라이브 watch 0 — 추적 토큰(GHO/USDC/LBTC/LINK)이 전부 burn&mint(CCIP/OFT, 담보 backing 없음 → Detector B 영역)이고 xERC20 lockbox 가 DB에 없어서. lock&mint 토큰이 들어오면 bridge-authority 스냅샷이 lockbox 적재 → 자동 활성.
- **#6 L2 depeg/oracle = 설계상 충족** — `checkDepeg`/oracle staleness 는 스냅샷의 오라클 가격에 작용하는 **체인 불문** detector. L2 마켓 스냅샷이 있으면 동일 코드가 거기서도 평가. 별도 "L2 전용" 코드 불필요(추가하면 중복).
- **#5 depositor+LTV = 데이터 이미 수집·노출** — dossier API 가 `vault_allocations`(큐레이터/볼트별 supply_usd) + `loop_findings`(lltv·looped_usd) 반환, 토큰 페이지가 소비. 중첩 인터랙티브 트리는 UI 폴리시(데이터 폭은 이미 확보).

### 2026-06-08 — 브릿지 토폴로지 완성(B): CCIP 원격 주소 + Detector B allowlist 동적 시드

- **CCIP 원격 토폴로지 1급화(B#2)** — `resolveCcipTopology` 신설: getSupportedChains selector 별 `getRemotePools`(멀티풀, 구버전 `getRemotePool` 폴백) + `getRemoteToken` → 원격 **풀/토큰 주소** 디코드(bytes 마지막 20B). 기존엔 체인 *목록*만. `bridge-authority.ts` 가 `ccip_remote` authority 로 적재(AuthType + 프론트 AUTH_MAP/ORDER 확장, order 12 = ccip_pool 대표성 유지). **라이브 검증: LINK@ethereum 풀 → 28 원격 체인의 실제 풀+토큰 주소 해석**(예 @base pool=0x0a99… token=0x88fb…). LZ OFT peer 원격 주소는 이미 추출 중이었음(`0x+slice(-40)`).
- **Detector B allowlist 동적 시드(B#4)** — 하드코딩 주소 추측(틀리면 실제 공격 침묵=FP보다 위험) 대신, `verifiedMintersFor(sym)` 가 **온체인 검증된 `bridge_authorities` 주소**(xERC20·MINTER_ROLE·OFT peer·CCIP 풀/원격)를 동적 allowlist 로 주입 → 검증 인프라로의 mint 는 정합 대상 제외(FP↓), 공격자 자기주소 민팅은 여전히 포착. 정적 config(GLOBAL/BY_TOKEN)는 수동 override 로 남김. DB에 GHO/USDC/LBTC/LINK ccip_pool 존재 → 실데이터 동작.
- **bridgeFlows 실주입(B#3)은 obsolete** — 체인맵 뷰 제거로 소비처 소멸(동심원·리스트만 유지). 크로스체인 flow 시각화는 현 UI 범위 밖.

### 2026-06-08 — TS 백테스트 하니스 구현(A) + detector 충실화로 36사건 GREEN

- **`scripts/backtest.ts` 신설(설계 §7.3)** — `backtest/events/` 라벨된 사건을 **production 알림 함수**(depegSeverity·reconcile·severityForValue·cooldownSecondsFor)에 결정론적 replay → precision/recall 스코어보드. `npm run backtest`. **35사건/81case 중 구동채점 64 → recall 100% · FP 0% · GREEN.** 미구동 17(oracle/util/whale/bad-debt/unbacked — 스냅샷에 입력 없음), 부분커버 4(구동 신호만 채점, 미구동은 정직하게 제외).
- **하니스가 드러낸 5개 detector 격차를 production 에서 수정**(임계값 오버핏 아니라 로직 개선):
  1. **자산클래스 세분화** — `classifyAsset` 에 `stable_soft`(GHO·mkUSD·crvUSD·USD0++ 등 설계상 할인 거래, band 5%)·`pendle_pt`(만기 전 할인, band 8%) 추가. 기존 `stable`(USDC/USDT 하드페그)은 0.5% 유지. → GHO 3.5%·PT 0.6%·mkUSD 0.8% 소프트 할인 FP 제거하면서 USDC 12%(catastrophic)·mkUSD 7% 는 정상 발화.
  2. **부호 인식 depeg** — `depegSeverity(belowPegFraction)`: 양수=peg 아래(catastrophic 가능), 음수=peg 위(수익누적/프리미엄 → **WARN 상한**, critical 안 됨). diff.ts `(1-price)` 규약 보존. → USYC(NAV 누적으로 $1.088) above-peg review-nudge.
  3. **무권한 민트 provenance 승격** — 비-home·비-authorized 수신자 단일 mint 가 supply 5%+ 면 크기 무관 critical. → PAID 정확히 10%(float 999.99bps 경계) HIGH 확보, authorized 발행은 무시(FP 0).
  4. **리베이스 억제** — `|Δsupply|≤rebaseSaneMax(50%) ∧ 이산 mint 0` = 설계 리베이스 → TOTAL_SUPPLY_SPIKE 억제. → AMPL +14.42% rebase quiet, 단 AMPL 합성 무권한 mint 는 LARGE_SINGLE_MINT 로 발화.
  5. **severity별 dedup 재생** — polls[] 멀티폴 케이스를 `cooldownBySeverity` 로 재생 후 마지막 폴 채점. → USDC SVB worsens(WARN→CRIT 재페이지) vs steady(동일 WARN 쿨다운 내 억제) 구분.

### 2026-06-08 — 백테스트 보정 임계값 이식 + 자산클래스 + 사건 라이브러리 보존

- **`risk_rules_test_agent`(QA 튜닝 에이전트) 산출물 → alert-thresholds.ts 이식 후 폴더 삭제.** 빌드타임 에이전트가 라벨된 36개 사건으로 GREEN 튜닝한 임계값을 TS config 로. 헤드라인: **depeg catastrophic 0.085**(USD0++ 실측 9.02% 보정, asserted 0.10 이 못 잡던 것). + 자산클래스(major/stable/lst/rwa/altcoin) per-class depeg/oracle band, supply elastic whitelist 11종, large-single-mint 10%→critical, 무담보 critical 100bps, per-severity 쿨다운(crit 1h/warn 12h/info 24h).
- **배선**: diff.ts depeg → `depegSeverity`(클래스 band + catastrophic) · Detector A → criticalBps 100 · insertAlert 쿨다운 → per-severity(make_interval). 검증: classifyAsset/depeg/쿨다운 SQL 라이브 OK, tsc 0.
- **사건 라이브러리(§7.3) 보존**: `automation/backtest/events/`(36개 라벨된 사건+스냅샷) — 미래 TS 백테스트 하니스용. calibration 근거는 `docs/threshold-calibration.md`.
- **`new-simulator` 재삭제**(events.db 1개, 라이브 무참조).

### 2026-06-08 — Detector B(mint/burn 정합) + getLogs publicnode 우회 + output 정리

- **Detector B(mint_burn_recon) 이식** — alarm-totalsupply 포팅. 크로스체인 mint↔burn 을 **금액+시간창(기본 30분)** 으로 매칭, 창 지나도 미정합 mint = 무담보민팅 의심(Kelp 직접 시그니처). `snapshot/mint-burn-recon.ts`(수집+순수 reconcile) + `scripts/snapshot-mintburn.ts`(러너, ledger/cursor) + migration 014 + cron 1h + 7일 보존. backing 불일치(Detector A) 동반 시 **critical 승격**. `source=mintburn-v1`. **Method E의 mint 로그 위에** 구축. (authorized-minter allowlist 는 v1 생략 — L2 비-브릿지 발행 FP 가능, 추후 보강.)
- **getLogs 는 publicnode 로(item1).** Alchemy **무료티어가 eth_getLogs 를 10블록으로 제한**(viem 버그 아님). `lib/public-rpc.ts` 공용 모듈 신설 → bridge-authority block#1(xERC20 BridgeLimitsSet)·Method E·Detector B 모두 publicnode. ⚠️ full-history 는 무료 RPC 불가(publicnode 도 ~200k/콜) → **bounded 최근 스캔**. 깊은 과거가 필요하면 paid archive RPC.
- **output 23M 정리(item3).** 스냅샷 디버그 JSON 덤프 비우고, snapshot-all 의 writeFile 을 `SNAPSHOT_JSON_DUMP=1` 일 때만(기본 off → 재증식 방지). DB가 source of truth.
- **새 알림 UI 1급화 + Detector B FP 컷.** unbacked_supply·unmatched_mint 를 AlertPanel **"민팅/공급" 카테고리 신설**로 분류 + Tier 0 verdict 에 **"무담보민팅" factor·칩** 추가(critical 이면 위험 승격). Detector B 에 authorized-수신자 allowlist(전역+토큰별, 기본 빈 config — issuer/treasury 추가 시 FP↓) + **구조적 FP 가드**(일시적 미정합은 알림 X — 2×window 지속 또는 backing 동반일 때만 발화).

### 2026-06-08 — 브릿지 mint-이벤트 발견(Method E) + 루트 정리

- **`get_token_bridge_address` 이벤트 확장(Method E, `events.py`) → automation 이식 후 폴더 삭제.** mint(Transfer from 0x0) 로그의 `tx.to` 빈도로 브릿지 발견(view-probe가 다 실패할 때 fallback) → `lib/bridge-mint-events.ts`. `readBridgeAuthority`가 bridges 0건일 때만 호출, 상위 후보를 `mint_event`(추정)로 적재. frontend `verifiedFor`는 mint_event를 "검증"에서 제외(추정이라 ✓검증 오표기 방지). 검증: weETH(eth)→EtherFi 발행자, weETH(base)→브릿지 OFT 발행자 최빈 1위로 잡힘.
- **Method E 로그 스캔은 publicnode 사용.** ⚠️ Alchemy가 viem `eth_getLogs` 를 "JSON is not a valid request object"로 거부(getBlockNumber 등은 정상) → publicnode는 정상. 같은 이유로 bridge-authority의 xERC20 `BridgeLimitsSet` getLogs(block #1)도 Alchemy에서 조용히 실패 가능(단 `probeXerc20Lockbox` eth_call 은 정상이라 lockbox/Detector A 입력은 잡힘). 추후 그 getLogs도 publicnode로 옮기면 됨.
- **루트 정리**: `get_token_bridge_address`·`new-simulator`(events.db 1개, 코드 0) **삭제**. `automation/dep-engine`(구 crawl→`.sim.json` 생성기, 라이브 TS 무참조) → **`attic/`**. `/explore` depgraph 는 `frontend/public/depgraph/*.sim.json`(정적 사본)을 읽어 **여전히 동작** — 데이터 재생성만 attic 에서 꺼내야 가능.

### 2026-06-07 — 브릿지 표준 감지 확장 + 무담보 공급 detector 이식 (외부 폴더 정리)

- **외부 `get_token_bridge_address`(Python) → automation TS 이식 후 폴더 삭제.** Method C(추가 8표준: Hyperlane·OP·Arbitrum/zkSync canonical·Axelar ITS·CCTP·Polygon PoS·Wormhole NTT·xERC20 lockbox) + Method B(CCIP `getSupportedChains` 원격 토폴로지)를 `lib/bridge-standards.ts`로. `readBridgeAuthority`가 호출, `bridge_authorities`(auth_type 자유텍스트)에 **마이그레이션 없이** 흐름. frontend AUTH_MAP/ORDER 2곳 확장. (기존 TS는 xERC20-limits/MINTER/OFT/CCIP-pool만.) Method D(catch-all)는 노이즈 위험으로 미이식. CCIP 원격 *주소*(getRemotePools)·LZ peer 주소는 이벤트 확장 시(지금은 연결 *체인 목록*까지).
- **외부 `alarm-totalsupply`(Kelp rsETH 무담보민팅 탐지) → Detector A 이식 후 폴더 삭제.** automation은 Detector C(supply-spike)만 흡수했었고, Detector A(Σremote≤backing)는 `diff.ts:344`가 "멀티체인 필요, 스코프 밖"이라 자인 → 멀티체인 도입됐으니 이식. `snapshot/supply-backing.ts`(불변식 엔진 — **무담보 방향만** 알림: 정상 브릿징은 항상 over-backed라 FP 0) + `scripts/snapshot-backing.ts`(러너). backing 자동 watch는 `bridge_authorities`의 xERC20 lockbox에서(위 브릿지 작업이 입력 제공). cron 1급 스텝(1h)으로 편입. `source=backing-v1`(알고리즘 swap 계약).
- **Detector B(mint_burn_recon)는 이벤트(Transfer 로그) 기반이라 이번엔 미이식** — 사용자 계획상 "이벤트 기반 확장"은 추후 단계에서.

### 2026-06-10 — 상황판 멀티체인 확장 (13체인, 동적 토큰 레지스트리)

- **상황판을 메인넷 전용 → 13체인으로**: ethereum + base·arbitrum·optimism·polygon·avalanche·bsc·gnosis·scroll·linea·sonic·celo·metis. 후보는 전부 `scripts/probe_flowmap_chains.mjs` 온체인 프로브(Aave getReservesList·Comet baseToken·Balancer/Fluid 코드+로그·UniV3 tick(500)==10·llama 가격 슬러그·Morpho chainId) 통과분만 등록 — zksync 는 publicnode 404 로 탈락. 레지스트리 = `lib/flowmap.ts FLOW_CHAINS`.
- **토큰 레지스트리는 체인마다 자동 유도(손 주소 0)**: Aave `getReservesList()` ∪ Comet `baseToken()` → 온체인 `symbol()/decimals()` 배치 → llama 가격(`avax`·`xdai` 슬러그 주의). 가격 미해석 토큰은 정직하게 제외, **심볼 충돌(아비트럼 USDC.e vs 네이티브 USDC — 온체인 심볼 둘 다 "USDC")은 "(2)" 접미사로 분리 추적**(드롭하면 큰 시장이 통째로 빠짐). 메인넷은 큐레이션 59종 고정 링 유지.
- **윈도우는 blockSec 실측**(latest vs latest-10000)으로 ≈6h 환산, 버킷 72개 고정 — BSC 0.45s(Maxwell 이후)·Metis 36s(비정형) 자동 적응. 이상치 게이트(systemic/whale)·레버 페어링은 체인 공통.
- **퍼블릭 RPC 실측 한계 3개를 코드에 고정**: ① publicnode getLogs **주소배열 ≤8개**(전 체인 동일 — 8개 그룹×동시3 분할), ② **블록범위 ≤10,000**(arbitrum "exceed maximum block range" 명시 에러 — 전 체인 10k 청크), ③ 호스트당 **동시 요청 4 세마포어 + 1회 재시도**(13체인 동시 수집 시 arbitrum 쓰로틀 전멸 실측). Aave/Comet getLogs 에 토픽 필터 필수(잡로그가 압도적).
- **서빙 = stale-while-revalidate**: 체인별 캐시(120s) 스냅샷 즉답 + 백그라운드 갱신, `?summary=1` 이 전 체인 systemic/whale 집계(+미수집 체인 수집 트리거, 5분 주기). 보드엔 체인 칩 — 빨간 숫자=systemic, 호박 점=whale, 펄스=수집 중. 첫 수집 무거운 체인(base UniV3 ~100s)도 사용자는 항상 즉답.
- **검증(라이브)**: 13/13 ready·getLogs 오류 0 — ethereum $1.86B/6h(systemic 1·whale 9·레버 8), base $138M(레버 cbETH↦Aave↦WETH), arbitrum $64M(7프로토콜 전부), bsc $15M….
- **알려진 공백(§18 백로그)**: BSC Venus·Avalanche Benqi(Compound V2 포크 ABI), Base Aerodrome(Solidly ABI) — 새 디코더 패밀리 필요. 비메인넷 Euler(Goldsky 체인별 서브그래프)·UniV4(전이력 스캔 무거움), zksync(publicnode 미지원 — 대체 RPC 후보 탐색).

### 2026-06-10 — hoont 실시간 상황판을 메인 화면 그래프로 (이벤트 기반)

- **메인 중앙 그래프 = hoont `a5ba4b7` 실시간 상황판(FlowMapBoard)으로 완전 교체.** hello 이중동심원(LandingGraph)은 마운트만 해제(컴포넌트 파일은 보존 — 복구 가능). 근거: 정적 구조(이중동심원)보다 "지금 어디가 평소와 다른가"(이상치 발화)가 메인 화면의 질문에 맞음 — 상세 스펙은 `docs/flow-situation-board.md`(hoont 산출물 동반 이관).
- **상황판 = 온체인 이벤트 직독, DB·키 불필요.** 렌딩 8(Aave Core/Prime/EtherFi·Spark·Morpho·Compound·Fluid·Euler) + DEX 4(Uniswap V3/V4·Curve·Balancer)를 publicnode/mevblocker `eth_getLogs`로 6h 윈도우 수집, robust z(≥3.5)∧다수주체(≥4)∧최대주체≤60% = systemic / 단일 ≥$2M = whale 게이트, 같은 tx의 담보예치+차입 = 레버 페어(원자적 사실만). 첫 수집 ~26s, 60s 모듈 캐시. 검증: 라이브에서 systemic 1건(USDC←Aave 차입 z 19.5)·레버 8쌍 발화 확인.
- **토큰 페이지 보기 3단 Seg = 관계맵 / 실시간 상황판(sym 강조) / 레버리지 루프.** hoont는 흐름맵 탭+서브탭 중첩이었으나 `/flow`(라이브 입자 흐름맵)와 이름 충돌을 피해 평탄화. 깊이·체인·상세패널 컨트롤은 관계맵 전용으로 게이팅. `/api/leverageloop`(Morpho 포지션 기반 루퍼 탐지)도 동반 이식.
- **`concentric-layout` PROTO_ALIAS 이중계상 수정 동반 적용** — DB "spark" vs Llama "sparklend"가 분포에 둘 다 ~30%로 뜨던 왜곡 병합(+역별칭 풀 조회로 마켓 링 유지).
- **chains-ui 비-EVM 5체인 중복 등록 제거** — hello 병합 잔재(React duplicate key `starknet` 콘솔 에러 400건)였음. 단일 등록 유지.
- **스킵**: hoont의 FlowBoard v1(`flowboard/`·`flow-board.ts`)은 hoont 문서 스스로 "폐기" 명시 + 참조 0건이라 미이관. `probe_protocol.py`(프로토콜 추가 하네스)는 `scripts/`로 이관.

### 2026-06-07 — 산발 코드 triage + 포지셔닝 정렬

- **라이브 제품 = `automation`(TS) + `frontend`(Next) + Postgres 한 곳.** 프론트가 자체 `/api/*`에서 `pg`로 DB 직독(정적 폴백 없음), automation cron이 같은 DB에 적재. 둘의 `DATABASE_URL`이 동일(`…@localhost:5433/wbtc_mapping`)임을 확인 → 이 경로만 keep.
- **`backend`(Python 시뮬), `modules`, `shared`, `integration` → `attic/`로 격리.** 구 "contagion simulator" 클러스터(modules→integration→`simulator_graph.json`→backend `/api/contagion*`). 프론트가 `:8000` 프록시를 제거(`next.config.ts`)해 라이브와 단절돼 있었고, 라이브 빌드가 이들을 import 0건이라 이동 안전. 설계 WON'T(W1 시뮬레이션)에 해당.
- **`.github/workflows/fly-deploy.yml` → `attic/fly-deploy.yml.disabled`.** 격리한 Python backend를 Fly.io에 배포하던 CI라 같이 비활성.
- **포지셔닝: "contagion simulator" 문구 제거 → "Exposure Intelligence".** 제품 핵심은 *시뮬이 아니라 정확한 매핑+알림*(설계 §1.4). `layout.tsx` 메타데이터·`DEPLOY.md` 재작성.
- **`snapshot_runs` 감사로그를 cron 실행마다 채움.** 테이블은 있었으나 INSERT가 없어 비어 있었음 → `recordSnapshotRun()`을 `snapshot-all`/`snapshot-chain` 끝에 배선. 나중 받을 백테스트가 cron 건강도/시점을 쓸 데이터.

### 2026-06-07 — Tier 0 판결 + at-risk 곡선 + opaque 라벨

- **Tier 0 판결 = 4신호 합성(집중 HHI · 디페그 · 재담보 루프 · 하드코딩 오라클) → 위험/주의/안전 + 한 줄 사유.** 데이터(HHI·alerts·ouroboros·oracle type)는 이미 있어 *합성·문장화*만. critical 알림 또는 (하드코딩 오라클 ∧ 디페그) 같은 복합조건이 "위험"으로 승격(설계 §7.2).
- **하드코딩/고정 오라클을 1급 리스크로.** 가격이 온체인에서 안 움직이면 디페그 시 청산이 안 걸려 bad debt가 조용히 쌓임(설계 §1.4 통찰) → 판결·at-risk의 "청산가능" 컬럼에 반영.
- **bad-debt at-risk(p) 곡선 = 정적 계산**(담보 −p% → 누적 위험$). 백테스트와 무관. 마켓이 underwater 되는 임계 drop(=1−aggLTV)을 누적합.
- **데이터 출처 3단계 = verified(실선)/estimated(점선)/opaque(점점선).** breadth(DeFiLlama)=estimated, UNKNOWN/이름없는 큐레이터·볼트=opaque(DD 불가). 정직성=차별점이라 UI에 1급으로 노출.

### (이전 결정 — ARCHITECTURE.md §6 불변식에서 이관)

- **Bipartite 불변**: 모든 엣지는 `token:* → protocol:*`. 멀티롤은 `classification.roles[]`에 중첩(페어당 1엣지).
- **즉시 모니터링(게이트 없음)**: discovery는 임계(누적 95% 커버리지·최소 $1M) 통과 토큰을 `active=true`로 바로 등록·스냅샷, 임계 미달 시 자동 해제. 수동 pin(`reason='manual'`)만 discovery가 안 내림. (구 `active=false` 승인 게이트 설계는 미사용 — 코드 기준.)
- **무료·배치 우선**: 핵심 그래프는 Alchemy Multicall3 + Morpho GraphQL(무료). 유료 holder API 미사용.
- **정밀(DB) + breadth(DeFiLlama) 2레이어**: 온체인 검증 엣지는 실선, breadth는 점선으로 신뢰도 구분.

---

## 18. 백로그 / 진행 현황

> 평가서 P0~P3 항목을 실제 코드와 대조한 정직 버전. `[GAP]`미구현 · `[PARTIAL]`일부 · `[DONE]`구현완료 · `[WONT]`의도적 비구현. (구 BACKLOG.md 통합.)

### ⚠️ 평가서 정정 (실제 코드 확인 결과)
- **P1-3 IRM 변경 detector = 이미 있음** — `diff.ts:checkIrmChange` 가 `irm_changed`(주소 swap) + `irm_base_rate_jump`(baseRate) 발화. *평가서의 "추가"는 틀림.* 갭은 target utilization/곡선 파라미터까지 확장하는 **보완**뿐.
- **P1-4 오라클 변경 detector = 이미 있음** — `diff.ts:checkOracleChange` 가 `oracle_changed`(주소) + `oracle_paused_suspect` + `oracle_depeg_flag_flip` 발화. 갭은 **OracleType 변경(MARKET→ORACLE_FREE=하드코딩) critical 승격**(필드는 이미 존재: `OracleType`).
- **P1-5 신규마켓/담보채택 = 이미 있음** — `new_market` + `collateral_adoption` alert kind 존재(라이브에 cbBTC/WBTC collateral_adoption critical 적재 확인). 갭은 "저신뢰 dApp + 의외 자산" 승격 **보완**.
- **mF-ONE/OUSG/USDat/USTB/USCC(RWA), PT-* = 이미 watchlist active.** 평가서가 안전축만 본다고 한 건 부정확 — RWA·PT 는 이미 추적 중. 빠진 건 아래 P0-1 의 *특정 위험군*.

---

### P0 — 제품이 "실제 위험"을 보게 (최대 레버리지)

#### 1. Watchlist 위험 토큰 재조준 `[DONE]` ✅ (10종 핀+스냅샷 → 35건 실알림)
현 watchlist 12개에 RWA·PT 는 있으나 평가서 지목 **특정 위험군이 빠짐**: xUSD·USDf·USR·USD0++·sUSDe·USDe·ENA·crvUSD·mkUSD·syrupUSDC·alUSD·deUSD.
→ `scripts/seed-risk-watchlist.ts`(신규): 큐레이트 주소를 **온체인 symbol() 검증 후** `pin`(active=true, reason=manual:risk). 잘못된 주소는 검증에서 자동 탈락(가짜 토큰 추적 방지).
경로: `scripts/seed-risk-watchlist.ts`, `db/upsert.ts:pinWatchlist`, watchlist(mig 003/006).

#### 2. Detector A 라이브 활성화 `[DONE-판정]` — 위험토큰 9/9 lockbox 없음(burn&mint) → 활성 안 됨, Detector B/디페그가 커버. 진짜 lock&mint 들어오면 자동활성.
P0-1 의 직접 귀결. lock&mint(xERC20 lockbox) 토큰(USD0++/crvUSD 등)이 watchlist 에 들어오면 `bridgeAuthLoop` 이 lockbox 적재 → `backingLoop` 이 자동 watch. 엔진/백테스트는 검증됨(Wormhole·xUSD GREEN). 활성 후 실데이터 FP 0% 모니터.
경로: `scripts/snapshot-bridge-authority.ts` → `scripts/snapshot-backing.ts`, `supply-backing.ts`.

### P1 — 명시 시그널 보완

#### 3. IRM target-utilization/곡선까지 `[PARTIAL]`
`checkIrmChange` 는 주소+baseRate 만. 곡선의 변곡점(target utilization) 변경도 알람으로. → `edge-schema.ts:IrmInfo` 에 `targetUtil` 추가, 스냅샷 채집(`snapshot-token.ts`), `diff.ts:checkIrmChange` 비교 + `alert-thresholds.ts:irmChange`.

#### 4. 오라클 OracleType 변경 critical `[DONE]` ✅ (oracle_hardcoded_switch: MARKET/EXCHANGE_RATE→ORACLE_FREE critical)
정상 피드(MARKET/EXCHANGE_RATE) → 하드코딩(ORACLE_FREE/고정) 전환을 critical 로. 필드(`OracleType`)는 이미 있음. → `diff.ts:checkOracleChange` 에 type 전이 규칙 + Tier 0(§6.7) 연계.

#### 5. 저신뢰 dApp + 의외 담보채택 1급 `[DONE]` ✅ (minor 렌딩 + long-tail(altcoin) 담보 → critical 승격)
`collateral_adoption` 은 있으나 "비주류 렌더가 갑자기 이상 자산 담보 채택"(Dolomite→alUSD 류) 승격이 약함. → `diff.ts` 신규 엣지 알람 + `alert-thresholds.ts:collateralAdoption.majorProtocols` 밖 + dApp 신뢰도 신호 결합.

### P2 — 자금추적 깊이 `[GAP]`

#### 6. NAV×supply 가치-드리프트 detector `[DONE]` ✅
전문가 핵심 방법론(NAV×supply=총밸류 → 급락=유출). **구현 완료**: `snapshot/value-drift.ts`(순수 computeValueDrift) + `scripts/snapshot-value-drift.ts`(`npm run snapshot:valuedrift`) + cron 1h + config `valueDrift`. 데이터=`chain_supply_samples.supply_usd`(체인 가치 시계열). 윈도우 peak 대비 25%/40% 낙폭 + $10M 절대게이트 → value_drift 알람(유동성 카테고리). 합성검증 4/4. (지갑묶음 "비었다" 연계는 P2-7 후속.)

#### 7. 지갑 이탈 7일 브릿지 in-flight FP 가드 `[DONE]` ✅
`wallet_value_drop` 발화 시 급감 윈도우(3일) 아웃고잉 목적지가 known 브릿지(canonical OP-stack·ArbSys·L1 게이트웨이 + 검증 `bridge_authorities`)면 in-flight/settling 로 **info 다운그레이드**(페이지 억제, 기록 유지). `lib/wallet-bridge-guard.ts`(detectBridgeOutflow) + alchemy `getAssetTransfers` + `scripts/snapshot-wallets.ts`. 검증: API 동작·매칭·null-safe.

#### 8. RWA 의도적 디스카운트 정상-라벨 `[DONE]` ✅
mF-ONE 류(NAV 1.1, 오라클 0.98 의도적 디스카운트=청산방지)를 위험 하드코딩에서 제외. `classifyAsset` 에 RWA(mF-ONE 등) + `isIntentionalDiscountOracle`(rwa ∧ NAV/ORACLE_FREE/fixed) 헬퍼 → `diff.ts` oracle_hardcoded_switch critical→warning 다운그레이드 + 프론트 Tier0 RWA 면 `rwaDiscount`(오라클 칩 "RWA NAV(정상)", 위험 미승격). 비-RWA 고정 오라클은 여전히 critical.

### P3 — 관측·성숙도 (후순위)
- **9. 그래프-스테이트 타임라인 스크럽 `[GAP/deferred]`** — 전체 그래프 비영속. 공급/알림 시계열은 있음. 영속화 선행(저장비용 트레이드오프). `SNAPSHOT_JSON_DUMP` 게이트.
- **10. 알람 학습 메모리 `[GAP/deferred]`** — v1 은 결정론 유지가 맞음. swap 지점 A(detector 계약)로 추후 에이전트형. `db/upsert.ts` source 계약.
- **11. 실전 채널 전환 `[DONE-code/운영]`** — Discord/Telegram 코드 완료(D#9). `.env` 토큰 입력 + cron OPT-IN 은 운영자 단계.

### 의도적 비구현 `[WONT]` (스코프 크립 방지)
- 정량적 전염 시뮬레이션 — `attic/` 격리 유지(전문가 §4 "freeze 시대엔 무의미").
- 컨트랙트 오디트 자동화 — 딜레이 커서 ROI 낮음.
- 실시간 인덱서 — 1시간 배치 스냅샷으로 충분.
- 유료 holder/archive 상시화 — 무료 RPC+Multicall3 충분, 유료는 옵션 유지.

---
**진행 현황**: ✅ 완료 — P0-1·P0-2·P1-4·P1-5·P2-6·P2-7·P2-8 (+ ouroboros 신호 제거). 2026-06-13 보완(§17): 수용처 레지스트리+Aave/볼트쉐어/Fluid 어댑터·Euler 멀티체인·token_variants(Base 래핑본·CCIP 1급화)·래핑본 레고 연결·추정 브릿지 토글·가중 PageRank. 🔜 남음 — P1-3(IRM 곡선) · 레고가 viewed 베이스 토큰도 수용처 질의에 투입(Fluid 0건 해소) · 추정만-있는 토큰 브릿지 토글 노출 · ccip_remote 셀렉터→체인명 매핑 · P3(deferred).

---
*이 설명서는 사실 기반. 코드와 어긋나면 코드가 정답이고 이 문서를 고친다. 변경 "왜"는 §17 진행 이력.*
