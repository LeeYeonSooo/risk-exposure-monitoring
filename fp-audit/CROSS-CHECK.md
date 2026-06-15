# Fable 교차검증 (adversarial re-verification) — ✅ 6/6 완료 (2026-06-12)

> ## ✅ 적용 완료 (2026-06-12) — 5개 파일 수정 + DB 82건 삭제
> **적용된 수정** (typecheck 클린, 비-EVM marginfi 에러는 기존·스코프 외):
> - `scan-current-risks.ts:94` bad_debt 게이트 → **dropToLiquidation ≤3%/1.5%** (검증: 활성 8→3, 남은 3건 전부 청산 1.6~2.8% 이내=진짜 임박)
> - `scan-current-risks.ts:120` unverified → **자기-엣지(pctOfSupply>0.9)·상한추정 억제 + first-seen만** (검증: 17→0)
> - `snapshot-curators.ts` marketKey → **Morpho uniqueKey(marketId)** + idle 마켓(담보"—") 제외
> - `snapshot-mintburn.ts:31` NATIVE_ISSUANCE_SKIP에 **WEETH·LBTC 추가** (+ mint-burn-recon.ts 커버리지 공백 주석)
> - `snapshot-chain-supply.ts:133` **minRelDelta(0.5%)+whitelist 게이트** 이식 (DAI-class 차단)
> - supply_spike: 코드 변경 없음(현행 가드가 이미 억제) — 스테일만 삭제
>
> **DB 삭제**: 담당자2 FP 82건 DELETE(보존: #261 weETH 경미TP, #262 siUSD watch). 담당자1 214건 미검증이라 손대지 않음.
>
> **보류(설계 필요, 미적용)**: ① curator **비례 net-outflow 게이트**(#259 내부 로테이션 — vault-총액 추적 필요) ② chain_supply **per-chain netting**(GHO 재분배 — Kelp 마스킹 위험) ③ mintburn **weETH/LBTC backing watch**(Detector A 공백 — weETH L2예치·LBTC PoR 필요). 신규 버그 8건(아래 "추가 발견")은 별도 백로그.

---


원 검증(1차 감사)의 판정·근거·수정안을 **Fable 모델 에이전트가 독립 재조회로 반박 시도**한 결과.
등급: CONFIRMED / CONFIRMED-WITH-CORRECTIONS / REFUTED.

## 결과 매트릭스

| kind | 결과 | 판정(TP/FP) 유지? | 수정안 유지? |
|---|---|---|---|
| supply_spike | **C-W-C** | ✅ 20/20 FP (z 10/10 정확 재현) | ❌ **MAD-floor는 as-written no-op** — 폐기 |
| chain_supply_spike | **C-W-C** | ✅ 2/2 FP (수치 전부 재현) | ⚠️ Σ-게이트에 사각지대 — per-chain netting으로 교체 |
| unmatched_mint | **C-W-C** | ✅ 18/18 FP (residual은 git `9d3a37d`로 입증) | ⚠️ 방향 유지, LBTC watch는 **불가능**(PoR 필요) |
| curator_derisk | **C-W-C** | ✅ FP 18 / 경미TP 1 (충돌 가설 더 강해짐) | ⚠️ marketId 키 ✅ / net-outflow 비례화 / **partial-skip 폐기** |
| bad_debt_threshold | **C-W-C** | ⚠️ FP 8 → **FP 7 + watch 유지 1**(#262 siUSD 재분류) | ⚠️ 레버1 ✅ / 레버2 스펙 결함 / 레버3 보류 |
| unverified_large_exposure | **C-W-C** | ✅ 17/17 FP | ❌ **"알림 제거" 기각** → first-seen/다이제스트로 강등 |

**헤드라인**: "활성 84건 중 명확한 TP 0" **유지** — 단 정확한 표현은 **FP 82 / 경미TP 1 / watch-유지 1(siUSD)**. 모든 헤드라인 수치(z·MAD·aggLtv·ΔΣ·일치-burn 0 등)가 독립 재산출로 정확히 재현됨.

---

## kind별 정정 상세

### 1. supply_spike — 판정 ✅ / 수정안 ❌
- **(중대) stale 범위 정정: 7건 → 20건 전건.** 1차 감사는 relΔ<0.5% 7건만 "현행 가드 억제"라 했으나, `designedRebase`(snapPct≤50% && !discreteMint, diff.ts:499-501)가 나머지도 전부 억제 → **현행 코드에서 20/20 미발화**. 행동 증거: 06-12 run에서 타 kind 14종 발화·supply_spike 0건(PRIME 조건 재현됐는데도).
- **(중대) 제안된 MAD-floor는 no-op**: `mad/(|median(baseline)|||1)`에서 flat 구간은 median(Δ)=0 → `||1`이 분모를 1로 만들어 절대 0.001토큰 floor로 변질. 실측 MAD(PRIME 0.54 ~ USDC 7.39M) **10/10 미억제**. 이미 minRelDelta가 동일 역할 — 폐기.
- **(중대) 역방향 공백 발견**: `supply_single_mint`는 역사상 **0건 발화**(1-블록 창 한계, diff.ts:57) → **0.5~50% mid-interval 이산 mint는 현재 무알림**(Kelp류 ~10% 무단 mint 타이밍과 동일). 실제 후속 과제는 z 억제가 아니라 **이 공백 메우기**(snapPct 5~50% → provenance/persistence 확인 경로 승격).
- (버그 발견) `autoMintWhitelist`의 "USDE"가 라벨 "USDe"와 **case-sensitive 불일치** → 화이트리스트 사문화(alert-thresholds.ts:219, diff.ts:462).
- (경미) delta 라인은 diff.ts:487-488(489-491 아님). 운영 조치(20건 ack)는 동의 — 근거는 "전건 구버전 잔재"로 격상.

### 2. chain_supply_spike — 판정 ✅ / 수정안 ⚠️
- 수정안 성분 귀속 오류: GHO relΔ=0.906%로 minRelDelta **통과**(Σ-게이트만 잡음), DAI는 반대(Σ 증가라 minRelDelta만 잡음).
- "Σ 전체인"은 실제 샘플된 6체인 합(GHO의 plasma ~16.9M·ink 미커버).
- **Σ-sumGrew+5% 바이패스 기각**: GHO는 facilitator 모델(Σ-보존 불변식 없음) — base 5% 미만(≈$55k) 악성 mint가 Σ-flat 시간대에 억제되는 사각지대 + 메인넷 트랜치 시간대엔 FP 억제력도 없음. → **per-chain netting**(+Δ가 동시 −Δ 레그와 상쇄될 때만 억제) + 커버리지 확대 + provenance로 교체.

### 3. unmatched_mint — 판정 ✅ / 수정안 ⚠️
- residual 12건을 **git 커밋 `9d3a37d`** (skip 리스트 06-10 07:17 UTC 추가 = 마지막 발화 이후)로 결정적 입증 — 구조적 재발 불가.
- LBTC 메커니즘 정정: lock&mint 아님 → **네이티브 컨소시엄 발행 + CCIP burn&mint**(홈 burn 43건 실존) + 미수집 체인(solana·starknet 등) 레그.
- WEETH 정정: 홈=OFT Adapter(lock)를 sharedDecimals=6 절단 시그니처로 입증. **공동 원인**: arbitrum 수집 구조적 결손(`MAX_SCAN_BLOCKS=50k`×0.26s≈런당 3.6h vs 런간격 12-49h → arb burn ~85-93% 미수집).
- 수정안 결함: (a) LBTC backing watch는 "CCIP 풀 lock 잔액" 형태 **불가능**(lockbox 없음, 백킹=오프체인 BTC 커스터디 → PoR-vs-Σsupply 필요, 불가 시 명시적 공백 문서화) (b) weETH watch는 네이티브 L2 예치 mint 경로 미반영 시 watch 자체가 false unbacked_supply 발화.
- (버그 발견) `multichainTokens()` ORDER BY 없음 + `MAX_TOKENS=8` slice → 런마다 토큰 부분집합 비결정(커버리지 룰렛). WEETH "계속 발화"는 과장(실제 1회).

### 4. curator_derisk — 판정 ✅(강화) / 수정안 ⚠️
- **충돌 가설 강화 — 누락된 핵심 메커니즘 발견**: `ON CONFLICT (snapshot_ts,vault,market_key) DO NOTHING`(snapshot-curators.ts:152)이 충돌 시 **두 번째 행을 조용히 drop** → curr가 DB에 없는 이유 + baseline 영구 고착(영원 재발화) + **DB vault 총액 자체가 오염**.
- flapping/lost-write 대안 가설 반박됨(라이브에 두 마켓 공존 = 진짜 인출이면 큰 마켓이 비었어야 함).
- 귀속 정정: #257은 partial-read가 아니라 **동일 충돌**(+ XAUt $1.3M 실제 exit는 정상 통합) / #77·78(WETH ARM)은 충돌 아닌 **실제 일시 유출 후 회복** / #155(Sentora)는 **idle-마켓 배치**(디리스킹의 반대). residual 중 3-4건 귀속이 달랐음(결론은 동일 FP).
- #259 정량 정정: vault 총액 **−21% 실제 유출 있었음**("안 떠남" 거짓) → net-outflow 게이트는 **비례형**(마켓 drop 대비 vault 순유출 ≥50%)이어야 #259를 거름.
- live/residual = 6+13(12 아님). #261 vault 규모는 $97M(이더리움 vault — $354M은 2체인 동명 vault 합산 오류).
- 수정안: marketId 키 **승인**(morpho-api.ts:115에 이미 `uniqueKey:marketId` 사용 — 실현성 입증, DB 오염도 함께 수리됨. 마이그레이션 1런 공백 주의) / **partial-snapshot skip 기각**(실존하지 않는 현상 + 진짜 뱅크런 TP를 죽임 — fetch 무결성 게이트로 대체) / **신규 레버**: idle-마켓 행(collateral null) 제외(#155류).
- (발견) 12h dedup이 충돌 FP로 **같은 토큰의 진짜 이벤트를 12h 마스킹**하는 부작용.

### 5. bad_debt_threshold — 판정 ⚠️(1건 재분류) / 수정안 ⚠️
- 산술 8/8 정확 재현(deficit −$81K~−$12.7M 전부 음수, builtin 0건 정당 — 전 마켓 최대 deficit $68).
- **(중대) "8건 전부 NAV/EXCHANGE_RATE" 거짓**: DB `oracle.type` 기준 NAV 1·EXCHANGE_RATE 1·**MARKET 6**. 설명문 기준 ~6건은 실질 교환비지만 introspect 분류기(introspect.ts:91-93)가 type을 오기록 — **레버2를 oracle.type으로 구현하면 2/8만 잡힘**(스펙 결함).
- **재분류: #262 siUSD/msUSD → FP 아닌 "watch 유지"**: 감사 자신의 re-gate(2.7%≤3%)를 통과 + "Dummy feed" 프로토콜 내부 오라클(시장 스트레스에 안 움직임 = silent slide 가능 = Kelp 교훈) + LIF 2.62%로 청산 수익성 불확실 + **대체 커버리지 없음**(`loop_findings` 0행 — reflexivity-v1 무산출). #264 sUSDe($92.3M, self-NAV)는 2순위 watch 후보.
- 레버1(dropToLiquidation 게이트) **정확히 승인**(7/8 제거, siUSD만 warning 잔존 — 올바른 잔존). 청산보너스 반박 시도 실패(전 마켓 buffer>bonus: 8.5/5.5/3.5% vs 2.62/1.68/1.06%) — 단 수익성 caveat로 feasibility 플래그 병행 권장.
- 레버3(baddebt-v1 강등) **보류**: builtin은 구조적으로 사후(deficit 적재 후 발화)이고 silent-NAV류 대체 신호가 현재 없음.

### 6. unverified_large_exposure — 판정 ✅ / 수정안 ❌(기각→재설계)
- 17/17 FP 유지, 수치는 DefiLlama 대비 ±0.5~4% 재현(가비지 아닌 실제 TVL).
- 사실 정정: **"매일 재발" 거짓** — `scan:risks`는 cron에 없음(수동 1회만, DB에 단일 배치만 존재). "magnitude 과대"는 4/17(multi-asset)만 해당. 신규 하위 원인: **발행사 자기-엣지 3건**(pctOfSupply≈100% — sUSDS→sky 등, 신호가치 0).
- **(중대) 커버리지 홀 실존 — "제거" 기각**: USDC→Maple $3.12B는 **시스템 전체에서 가장 큰 USDC 노출**(최대 verifiable인 aave_v3 $1.96B보다 큼)인데 17개 프로토콜 전부 verifiable 엣지 0행. syrupUSDC는 chain_supply_samples에 없어 value_drift도 미커버 → Maple 디폴트 시 **아무 알림도 안 뜸**. Aave@arb/base도 breadth-only(Alchemy ETH-only 여파).
- **권장 재설계**: 정적 재알림 제거 + **first-seen/임계-크로싱**(토큰×프로토콜 쌍이 처음 $100M 돌파 시 1회 or 주간 다이제스트) + 자기-엣지(pctOfSupply>0.9) 억제 + multi-asset 상한추정 보정. "verifiable-only" 대안은 신호가 필요한 프로토콜을 정확히 배제해 **strictly worse**.

---

## 교차검증이 추가 발견한 버그/공백 (원 감사에 없음)
1. `autoMintWhitelist` "USDE" 대소문자 불일치 → 화이트리스트 사문화
2. ~~`supply_single_mint` 역사상 0건 — mid-interval(0.5~50%) 이산 mint 무알림 공백(Kelp 타이밍)~~ → **✅ 닫음(2026-06-12)**: `d10` single-mint 디텍터를 `snapshot-mintburn.ts`에 포팅(`scanLargeMints`). 어느 체인이든 supply의 ≥singleTxPctBps(5%)를 비인가 주소로 단일 mint = 무단민팅 발화(critical ≥10%). burn&mint 모델 독립 → **weETH/LBTC 등 skip 토큰까지 커버**(FN #2도 동시 해결). 검증: Kelp 규모 3566bps→critical, 정상 브릿지 0bps→무발화, 현 데이터 FP 0. ⚠️ base getLogs 느림으로 스캔 느림 — production은 MINTWATCH_MAX 제한 + archive RPC 권장.
3. `vault_allocations`의 `ON CONFLICT DO NOTHING` 행-drop — DB vault 총액 오염(차트/후속 분석도 오염)
4. mintburn `multichainTokens()` 토큰 룰렛(ORDER BY 없음 + slice 8)
5. mintburn arbitrum 스캔 캡(런당 3.6h) — arb burn ~85-93% 미수집
6. `scan-current-risks.ts`가 cron 미편입(수동 1회성)
7. `loop_findings` 0행 — reflexivity-v1이 아무것도 산출 안 함(silent-NAV 감시 공백)
8. dedup 12h가 충돌 FP로 같은 토큰의 진짜 이벤트를 마스킹

## 교차검증 후 수정 우선순위 (SUMMARY 표 대체)
| 순위 | 수정 | 상태 |
|---|---|---|
| 1 | `snapshot-curators.ts` marketId 키 교체(+DB 오염 수리) + **비례형** net-outflow + idle-마켓 제외. partial-skip은 하지 말 것 | 설계 확정 |
| 2 | `scan-current-risks.ts:94` dropToLiquidation 게이트(≤3%/1.5%) + feasibility 플래그. **siUSD는 남기는 게 정답** | 설계 확정 |
| 3 | `unverified_large_exposure` → 제거 말고 **first-seen/다이제스트 재설계**(자기-엣지·상한추정 억제 포함) | 설계 변경 |
| 4 | mintburn: WEETH·LBTC skip + weETH watch(네이티브 L2 경로 반영). LBTC는 PoR 불가 시 공백 문서화. residual 12 ack | 설계 수정 |
| 5 | chain_supply_spike: minRelDelta 이식 + **per-chain netting**(Σ-게이트 아님) | 설계 교체 |
| 6 | supply_spike: 코드 변경 불요(현행 가드가 이미 전건 억제) — 20건 ack만. MAD-floor 폐기. **신규 과제: mid-interval mint 공백**(single_mint 창 확대/승격 경로) | 재정의 |
| 7 | 위 "추가 발견 버그" 1·3·4·5·6·7 별도 백로그 | 신규 |
