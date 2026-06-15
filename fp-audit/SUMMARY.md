# FP 검증 종합 — 담당자 2 (11종) · 2026-06-12

자동 루프로 `alert-fp-verifier` 서브에이전트가 실시간 패널의 활성 알림을 **온체인 데이터 근거로** 전수 검증한 결과.

## 한 줄 결론
**담당자 2의 활성 알림 84건 중 명확한 TP는 0건.** 83건 FP + 1건 경미TP(저위험). 즉 현재 이 사람 담당 패널은 **사실상 전부 오탐**이며, 아래 5개 파일의 게이트만 고치면 거의 전량 제거되면서 진짜 위험(TP) 손실은 0.

## 종합 통계
| kind | 활성 | TP | FP | 경미TP/UNC | 결과 |
|---|---|---|---|---|---|
| supply_spike | 20 | 0 | 12(+8 capped) | 0 | fp-audit/supply_spike.md |
| chain_supply_spike | 2 | 0 | 2 | 0 | fp-audit/chain_supply_spike.md |
| unmatched_mint | 18 | 0 | 18 | 0 | fp-audit/unmatched_mint.md |
| curator_derisk | 19 | 0 | 18 | 1 | fp-audit/curator_derisk.md |
| bad_debt_threshold | 8 | 0 | 8 | 0 | fp-audit/bad_debt_threshold.md |
| unverified_large_exposure | 17 | 0 | 17 | 0 | fp-audit/unverified_large_exposure.md |
| (skip: supply_single_mint·unbacked_supply·whale_unwind·wallet_value_drop·value_drift) | 0 | - | - | - | 활성 없음 |
| **합계** | **84** | **0** | **83** | **1** | |

## 공통 FP 근본원인 (테마)
1. **통계 z 경로의 flat-MAD 폭발** — `supply_spike`·`chain_supply_spike`. near-flat baseline에서 MAD≈0이라 정상 공급 변동도 z가 수백만~수천만. 게다가 `chain_supply_spike`는 `diff.ts`가 가진 억제 게이트(minRelDelta·whitelist·rebase)를 **이식 안 함** + Σ-전체인 공급 불변(브릿지 이동)을 미검사.
2. **모델 오분류** — `unmatched_mint`. burn&mint 단일 가정을 lock&mint(weETH·wstETH·LBTC)·네이티브(USDC/WETH/cbBTC)에 적용 → 소스 burn이 원리적으로 없어 전부 미정합 플래그(ledger 일치-burn 0건으로 입증).
3. **키 충돌** — `curator_derisk`. `market_key=collateral|loan|lltv`가 oracle/IRM만 다른 별개 Morpho 마켓을 합쳐, split 행을 총액과 비교 → 가짜 "완전 회수"(curr 값이 어느 DB 스냅샷에도 없음).
4. **잘못된 위험 지표** — `bad_debt_threshold`. *청산 거리*(`dropToLiquidation`)가 아니라 *지급불능 거리*(`dropToUnderwater`)로 게이트 → aggLtv≥0.85인 정상 고-LLTV 포지션 전부 발화. + NAV/교환비 오라클 담보에 "시장가 −X% drop" 프레이밍(도메인 위반).
5. **미검증을 알림으로 오승격** — `unverified_large_exposure`. DeFiLlama breadth(설계상 `verifiableOnchain=false`, 일부 상한추정)를 검증여부 무시하고 $100M 임계만으로 info 알림.

### 횡단 패턴 (2개 — 여러 kind에 공통)
- **잔재(residual) 알림**: 디텍터를 고친 뒤(skip 리스트 추가·커서 동결) 기존 미해결 알림을 auto-resolve하는 스윕이 없어 패널에 잔존. `unmatched_mint` 12건·`curator_derisk` 12건이 이 유형. → **수정 후 해당 토큰의 기존 알림을 자동 ack하는 스윕** 필요.
- **도메인 규칙 위반**: NAV/교환비 오라클 + redeem 큐를 가진 LST/LRT/이자형 담보에 "시장가 하락 → 청산 캐스케이드" 프레이밍을 적용(CLAUDE.md 코어 규칙 위반). `bad_debt_threshold` 외 여러 곳에 잠재.

> ⚠️ **2026-06-12 Fable 교차검증 반영**: 아래 표의 일부 수정안은 교차검증에서 **기각/수정**됨 — 적용 전 반드시 [CROSS-CHECK.md](CROSS-CHECK.md)의 "교차검증 후 수정 우선순위" 표를 따를 것. 핵심 변경: ① unverified_large_exposure "알림 제거" → **first-seen/다이제스트 재설계**(Maple $3.12B 커버리지 홀) ② supply_spike MAD-floor → **no-op이라 폐기**(현행 가드가 이미 전건 억제 — ack만) ③ chain_supply Σ-게이트 → **per-chain netting** ④ curator partial-snapshot skip **기각** ⑤ bad_debt **siUSD #262는 watch로 유지**. 판정 자체(TP 0)는 6/6 모두 CONFIRMED.

## 코드 수정 우선순위 (효과 = 제거 알림 수 × 단순성, 전부 미적용)
> **`scan-current-risks.ts` 한 파일이 25건(unverified 17 + bad_debt 8)의 소스 — 최고 레버리지.**

| 순위 | 파일·위치 | 변경 | 제거 | TP 손실 |
|---|---|---|---|---|
| 1 | `scan-current-risks.ts:120` | breadth(`verifiableOnchain!==true`)는 알림 제외→대시보드 전용 | 17 (+매일 재발) | 0 (precise 엣지가 커버) |
| 2 | `scan-current-risks.ts:94` | 게이트를 `dropToLiquidation` 기준으로 (+NAV/교환비 담보 억제) | 8 중 7~8 | 0 (builtin 실손이 커버) |
| 3 | `snapshot-curators.ts:84` | `market_key`→Morpho `marketId` + vault net-outflow 게이트 + partial-read skip | ~17 충돌 | 0 (단일마켓 회수 보존) |
| 4 | `snapshot-mintburn.ts:31` | `NATIVE_ISSUANCE_SKIP`에 WEETH·LBTC + **BACKING_WATCHES에 동반 추가** | 6 live (12 잔재는 ack) | 0 (Detector A가 커버 — backing watch 필수) |
| 5 | `stats.ts robustZ` + `chain-supply.ts:133` | robustZ에 상대 MAD-floor + chain-supply에 diff.ts 억제게이트 이식 | 20+2 | 0 (single-block·corroboration이 커버) |
| 6 | (횡단) 러너 | skip/임계 변경 토큰의 기존 활성 알림 auto-resolve 스윕 + **지금 스테일 84건 ack** | 패널 클린업 | 0 |

## 주의 (모든 수정 공통)
- 4번(unmatched_mint skip)은 **반드시 backing watch를 동반**해야 Detector A 커버리지 공백이 안 생김 — 아니면 Kelp rsETH식 무단 mint(진짜 TP)를 놓침.
- 수정 → 재스캔 → 잔재 ack 순서(키/지표 수정 전 ack하면 다음 run 재발).
- 적용은 전부 **사용자 검토 후**(에이전트는 제안만, 코드 미수정).

## 산출물
- 디텍터 정의: `.claude/agents/alert-fp-verifier.md` (검증 중 RECIPE GAP 4건 반영해 보강됨)
- kind별 상세: `fp-audit/<kind>.md` (6개)
- 진행/보강 이력: `fp-audit/PROGRESS.md`
