# bad_debt_threshold — FP 검증 (✅ 2026-06-12)

활성 8건 → **TP 0 / FP 8 / UNCERTAIN 0**. (전부 `source=baddebt-v1`, **정밀(aggLTV) 모드**, 라이브 — detail이 edges와 정확 일치.)

## 근본원인
`scan-current-risks.ts:94` 게이트가 **`dropToUnderwater = 1 − aggLtv`(지급불능 거리) ≤ 0.15** (= aggLtv ≥ 0.85)로 발화 → 정상 고-LLTV 스테이블/LST 차입(aggLtv 0.85~0.92)을 모조리 "부실채권 임계"로. 실제 운영 위험 지표는 **`dropToLiquidation = 1 − aggLtv/LLTV`(청산 거리)** 인데 게이트·severity 모두 안 봄. 8건 전부 **deficit ≤ 0**(담보>부채), dropToLiquidation 2.7~7.9%(청산은 청산보너스로 회수되어 실손 안 감). 추가로 8건 전부 **NAV/EXCHANGE_RATE 오라클 담보**(sUSDe self-NAV·weETH/wstETH 교환비·LBTC RedStone·reUSD 환율)에 "담보 시장가 −X% drop" 프레이밍 적용 = 도메인 규칙 위반(이 오라클은 시장가 아닌 NAV/교환비를 봄).
`diff.ts checkBadDebt`(builtin 실손 borrow>collateral)는 **0건** 발화(실제 underwater 마켓 없음 — dust는 actionableUsd $1M 미달).

## 1순위 수정안 (미적용)
- **레버1(1순위)**: `scan-current-risks.ts:94-95` 게이트·severity를 `dropToLiquidation` 기준으로(예 ≤0.03 warn / ≤0.015 crit) → 8건 중 **7건 즉시 소거**(siUSD 2.7%만 남음), 청산 임박이라는 진짜 신호만.
- **레버2(병행 권장)**: NAV/EXCHANGE_RATE 오라클 담보는 "시장가-drop 추정" 알림 억제 → sUSDe·weETH·wstETH·reUSD 4건 추가로 도메인-정당 제외.
- **레버3(보강)**: builtin `checkBadDebt`(실손)를 알림 소스로 승격, aggLTV 추정(`baddebt-v1`)은 패널 메타로 강등.
- 부작용 없음: 진짜 underwater는 builtin이, 청산 임박은 레버1이 더 정확히. Kelp식 bad debt는 `direct_bad_debt_usd` 실손 경로.

근거: `edges.attrs.topMarkets` collat/borrow 재조회(detail 일치: syrupUSDC borrow $67.39M/collat $78.84M/aggLtv 0.8548 등) + 오라클 type + DefiLlama peg. 코드: `scan-current-risks.ts:94,156-157` · `diff.ts:213`.

## 에이전트 보강 (이 kind에서 트리거)
RECIPE GAP #3: 레시피가 `worst-case(LLTV)` 모드만 FP 후보로 봤으나, 8건 전부 **정밀 모드 + deficit≤0**인데 FP — 게이트 지표(`dropToUnderwater`) 자체가 틀려서. 레시피에 "정밀 모드라도 `dropToLiquidation`(청산 거리)로 판정, `dropToUnderwater`만 작은 건 정상" + "NAV/EXCHANGE_RATE 담보엔 시장가-drop 프레이밍 무의미" 추가.
