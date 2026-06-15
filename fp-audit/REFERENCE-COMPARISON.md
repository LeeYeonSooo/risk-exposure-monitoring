# 레퍼런스(risk_rules_test_agent) vs main — 탐지 로직 비교 (2026-06-12)

`github.com/ChainSpiral/risk_rules_test_agent` 의 `monitoring/risk_rules/` 와 현재 main(`automation/`)을 비교.

## 한 줄 결론
**레퍼런스는 4단계 정밀 파이프라인(detect → decision → filter → dedup)이고, main은 stage 1(detectors)만 — 그것도 단순화해서 — 포팅하고 stage 2(decision)·3(filter)·context 시스템을 통째로 누락**했다. 우리가 하나씩 잡은 FP들은 전부 **이 누락된 filter/decision 층이 원래 걸러줬어야 할 것들**이다. = 사용자 가설 확정.

## 레퍼런스 파이프라인 (pipeline.py `run_pipeline`)
```
build_context → run_detectors → decision.process → apply_filters → dedup → emit
```
| 단계 | 레퍼런스 | main(automation) |
|---|---|---|
| **1. Detect** | d01~d13 + d_slow_bleed. asset-class **적응형 baseline**, mint_events provenance(누가/누구에게), home-mint 제외 | diff.ts + scan-current-risks.ts + snapshot-*.ts. **단순화** — 고정 임계, 1-블록 diff |
| **2. Decision** (decision.py) | **지속+증거 escalation** — unbacked_supply 는 settlement 지나 ≥N 연속폴 **persist AND ≥2 디텍터 corroborate** 일 때만 CRITICAL. 일시 in-flight/finality-skew 는 WARN 유지(페이지 X). breach 해소 시 RESOLVED 발행 | **없음** — insertAlert 즉시 발화 |
| **3. Filter** (filters/) — FP 억제 | 구조적 필터 5종 + 학습 규칙 + **coverage-gap carve-out** + 안전캡 | **없음** — `registerExceptionRule` 빈 훅. 디텍터마다 **ad-hoc 인라인 억제**만(불완전·불일치) |
| **4. Dedup/correlate** | dedup + 교차신호 상관 | 부분(insertAlert 쿨다운) |
| **Context 시스템** | labels·bridge withdrawals·timelocks·rebase rates·peg probes·baselines 를 stage 2/3 에 주입 | **없음** |

## 누락된 FILTER 층 (filters/structural.py + chain.py) ← FP 핵심
레퍼런스는 탐지 **후** 양성패턴을 인식해 억제한다(데이터 없으면 graceful no-op):
| 필터 | 무엇을 거르나 | 우리가 잡은 대응 FP |
|---|---|---|
| `labeled_transfer` | 모든 수신처가 CEX/custodian/OTC/bridge 라벨이면 = 이동이지 이탈 아님 | **whale_unwind** 거래소/브릿지 정상이동 |
| `optimistic_bridge_window` | proven optimistic-rollup 7일 인출창 = 자금 "사라진" 듯하나 정상 | **wallet_value_drop** 브릿지 in-flight (main은 이걸 ad-hoc 가드로 일부만) |
| `rebase_accrual` | 리베이스/이자 누적 밴드 내 = 실제 흐름 아님 | supply/collateral rebase FP |
| `by_design_discount` | RWA 의도적 디스카운트(LT 위) = 보호적 설계 | depeg RWA (main은 `isIntentionalDiscountOracle` 부분 포팅) |
| `timelock_announced` | 거버넌스 timelock 예고된 변경 → **annotate**(억제 아님, 만료 감시) | oracle/irm/new_market FP |
| **coverage-gap carve-out** | MEDIUM/LOW conf 또는 **non-verifiable 엣지면 억제 비활성 → ANNOTATE**("mapping gap, not benign") | **unverified_large_exposure** breadth — 레퍼런스는 noise-알림이 **아니라** "커버리지 공백"으로 surface. 우리 first-seen 재설계와 정확히 같은 의도 |
| 학습 규칙(rules.py) | 사람/에이전트 작성 억제규칙(scope·TTL·guard) | main의 빈 훅이 이걸 받으려던 자리 |

**안전캡**(레퍼런스): CRITICAL 은 **절대** 억제 안 함 · guard(near_lt/depeg_sensitive)가 freeze·near-LT 마스킹 차단 · 규칙은 만료/미해결 시 **fail CLOSED**. → "억제하되 진짜 위험은 못 죽이게" 설계. main엔 이 안전망도 없음.

## 디텍터 자체도 lossy 포팅 (detectors vs main)
- **d10 supply_delta** — 단일-tx mint 체크가 **`mint_events`(amount+to+tx) + `authorized_minters` allowlist**로 mid-interval mint 를 직접 잡음. main은 `fetchTotalSupplyAtBlock(block−1)` **1-블록 diff** → **mid-interval mint 놓침**(우리가 독립 발견한 `supply_single_mint` 0건 공백이 바로 이 포팅 손실).
- **d06 whale_unwind** — 벤치마크가 **벤치별 경험적 low-tail baseline**(적응형) + 하이브리드 게이트. main은 **고정 %/USD 임계** → 정상 변동 오탐. + 레퍼런스는 `labeled_transfer` 필터와 **짝**으로 동작(main엔 그 필터 없음).
- **d12 bad_debt** — 레퍼런스는 **host-fed `bad_debt_usd`(실현 deficit)만**. main의 `scan-current-risks.ts badDebtThreshold`의 **dropToUnderwater 추정**은 레퍼런스에 없는 **main 자체 발명** → 그게 FP 원천(우리가 dropToLiquidation 게이트로 패치한 그것). 레퍼런스 방식(실현 deficit만 = diff.ts `checkBadDebt`)이 정답.
- **d09 unbacked_supply** — 레퍼런스는 한 스냅샷은 **HIGH 상한**(페이지는 decision 층이). main은 즉시 발화(persistence 없음).
- **d_slow_bleed** — 24h/7d **다중창 누적 drain** + 적응형 baseline. main `value_drift`는 24h peak-vs-latest 단일창(단일 outlier 민감).

## FP → 누락 컴포넌트 매핑 (우리가 패치한 것 = 증상, 진짜 원인은 누락 아키텍처)
| 우리가 잡은 FP | 진짜 원인(누락된 레퍼런스 컴포넌트) |
|---|---|
| whale_unwind 정상이동 | `labeled_transfer` + `optimistic_bridge_window` 필터 |
| unverified_large_exposure | coverage-gap carve-out(annotate, not alert) |
| supply_spike/chain z-폭발 | (main 인라인 가드 불일치 — 레퍼런스는 baseline+rebase가 디텍터에 일관 적용) |
| supply_single_mint 0건(놓침) | d10의 mint_events provenance(main이 1-블록으로 격하) |
| unmatched_mint lock&mint | d11 home-mint 제외 + authorized_minters(main 부분 포팅, allowlist 빔) |
| curator_derisk | (충돌은 main 자체 버그; 리밸런싱 FP는 baseline 부재) |
| bad_debt 추정 오탐 | main 자체 발명한 추정 디텍터(레퍼런스엔 없음) |
| unbacked 일시 breach | decision 층 persistence/corroboration |

## 권장: 증상 패치 → 구조 포팅
우리가 한 per-detector 패치는 옳지만 **증상 치료**다. 근본 해결은 **filter + decision + context 층을 포팅**하는 것:
1. **즉시 가능(데이터 이미 있음)**: coverage-gap carve-out — `edge.attrs.meta.confidence/verifiableOnchain`은 main DB에 이미 존재. breadth/미검증 신호를 억제-비활성+annotate 로. (unverified 류 구조적 해결)
2. **filter 층 골격 포팅**: `apply_filters` + structural 필터 5종 + `registerExceptionRule`(이미 있는 훅)에 rules.py 매처 연결. CRITICAL-불가침·fail-closed 안전캡 포함.
3. **context 제공자 구축**(가장 큰 일): labels(CEX/브릿지 주소)·bridge withdrawal 상태·timelock·rebase rate 데이터 소스. 이게 있어야 `labeled_transfer` 등이 실제로 동작(없으면 graceful no-op).
4. **decision 층 포팅**: unbacked_supply persistence/corroboration(이미 thresholds에 settlementSeconds·persistencePolls 값은 포팅돼 있음 — 엔진만 없음).

> 핵심: main은 thresholds.py(임계값)는 잘 포팅했는데(alert-thresholds.ts), **그 임계를 둘러싼 filter/decision/context 파이프라인을 안 가져옴**. FP는 임계 문제가 아니라 **억제 파이프라인 부재** 문제였다.

---

## ✅ 포팅 적용 (2026-06-12) — filter 층

`risk_rules/filters/`(structural + chain + 안전캡)를 **`automation/src/snapshot/fp-filters.ts`** 로 TS 포팅하고 **`insertAlert`**(모든 알림의 단일 choke point)에 결선.
- 포팅 필터: `byDesignDiscount`(RWA 디스카운트, DEPEG) · `optimisticBridgeWindow`(브릿지 in-flight) · `labeledTransfer`(CEX/브릿지 라벨) · `rebaseAccrual` · **coverage-gap veto**(미검증 엣지=억제비활성·annotate). 안전캡: **CRITICAL 절대 억제 안 함** + near-LT guard + 미라벨 시 no-op.
- 시드 context: 공개 CEX/브릿지 주소 라벨 + 리베이스 토큰(stETH 등) + RWA 디스카운트 토큰. (포괄적 라벨 DB·브릿지상태 서비스는 후속 — 없으면 graceful no-op.)
- **검증(throwaway 하니스)**: 합성 10/10(FP 3건 SUPPRESSED, FN 6건 PASS, gap 1건 annotate) + 실알림 218건 전수 **PASS 218 / SUPPRESSED 0 / CRITICAL 억제 0** = FN 안전 확인. typecheck 클린.
- **정정**: coverage-gap 은 "breadth 억제기"가 아니라 **억제 veto(safety)** — 미검증 엣지의 신호는 learned-away 못 하게 막아 사람에게 도달시킴. main 의 unverified_large_exposure noise 알림은 레퍼런스엔 **디텍터 자체가 없음**(main 발명)이라 first-seen 재설계로 해결한 게 맞음.

**현재 한계(정직)**: 필터 로직·안전캡은 작동·검증됐으나, 실알림 억제 yield 는 **context 데이터에 비례** — 지금은 whale_unwind/wallet_value_drop 이 0건 + 알림 detail 에 CEX 목적지/bridge 플래그가 거의 없어 실알림 0건 억제. 진짜 효과는 **context 제공자(라벨 DB·브릿지 상태·rebase rate)** 를 채워야 나옴(= 레퍼런스가 "teammate's service fills in" 이라 한 그 부분). + **decision 층(persistence)** 은 DB 상태 필요 → 후속.
