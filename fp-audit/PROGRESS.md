# FP 검증 진행 — 담당자 2, 11종 (자동 루프) — ✅ 전부 완료
> **+ Fable 교차검증 6/6 완료 (2026-06-12)** — 전부 CONFIRMED-WITH-CORRECTIONS. 판정 유지, 수정안 다수 정정. **적용 시 [CROSS-CHECK.md](CROSS-CHECK.md) 우선순위 표를 따를 것** (SUMMARY 표 일부 기각됨).

상태: ⬜ pending · 🔄 in-progress · ✅ done
검증 도구: `.claude/agents/alert-fp-verifier.md` (general-purpose가 읽고 수행)
결과: `fp-audit/<kind>.md` · 종합: `fp-audit/SUMMARY.md` · 대상: 실시간 패널의 활성 알림

| # | kind | 상태 | 활성 | TP/FP/UNC | 1순위 수정 |
|---|---|---|---|---|---|
| 1 | supply_spike | ✅ | 20 | 0/12(+8 capped)/0 | stats.ts robustZ MAD-floor |
| 2 | supply_single_mint | ✅ | 0 | 활성 없음(skip) | - |
| 3 | chain_supply_spike | ✅ | 2 | 0/2/0 | chain-supply.ts:133 minRelDelta+Σ게이트 |
| 4 | unmatched_mint | ✅ | 18 | 0/18/0 | mintburn.ts:31 WEETH·LBTC skip+backing watch |
| 5 | unbacked_supply | ✅ | 0 | 활성 없음(skip) | - |
| 6 | whale_unwind | ✅ | 0 | 활성 없음(skip) | - |
| 7 | wallet_value_drop | ✅ | 0 | 활성 없음(skip) | - |
| 8 | value_drift | ✅ | 0 | 활성 없음(skip) | - |
| 9 | curator_derisk | ✅ | 19 | 0/18/1 | curators.ts marketId 키 교체+net-outflow 게이트 |
| 10 | bad_debt_threshold | ✅ | 8 | 0/8/0 | scan-current-risks.ts:94 dropToLiquidation 게이트 |
| 11 | unverified_large_exposure | ✅ | 17 | 0/17/0 | scan-current-risks.ts:120 breadth→대시보드 |

**총계: 활성 84건 검증 → TP 0 / FP 83 / 경미TP 1.** 종합·수정 우선순위는 `fp-audit/SUMMARY.md`.

## 에이전트 보강 이력 (4건)
- **unmatched_mint** — RECIPE GAP: 수신자 확인 불가(`mint_burn_ledger`에 `to` 없음). 레시피를 ledger 일치-burn율 모델판별 + `mint_burn_cursor` residual/live + skip/watch 멤버십으로 재작성 + 루브릭 **residual FP** 추가.
- **curator_derisk** — RECIPE GAP #2: 디텍터가 라이브 Morpho fetch vs DB 비교. "라이브 Morpho 교차 + vault net-outflow + partial-read skip + marketId 충돌" 반영.
- **bad_debt_threshold** — RECIPE GAP #3: 정밀 모드 FP는 게이트 지표(`dropToUnderwater`) 오류. "`dropToLiquidation`로 판정 + NAV/EXCHANGE_RATE 시장가-drop 무의미" 추가.
- **unverified_large_exposure** — RECIPE GAP #4: 현 구현상 TP 구조적 불가. "TP 도달 불가 + confidence/상한추정 noise 차등" 반영.

## 비고
- 활성 0건 5종은 패널에 없어 skip(✅). 알림 생기면 재검증.
