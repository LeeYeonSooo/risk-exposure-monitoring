# unverified_large_exposure — FP 검증 (✅ 2026-06-12)

활성 17건 → **TP 0 / FP 17 / UNCERTAIN 0**.

## 근본원인
`scan-current-risks.ts:120`이 DeFiLlama breadth 엣지(설계상 `meta.verifiableOnchain=false`, 일부 multi-asset 상한추정)를 **검증여부·confidence 무시하고 `amountUsd ≥ $100M` 임계만으로 info 알림 발화** → "대시보드용 미검증 집계"를 "위험 알림"으로 오승격. 17건 전부 verifiableOnchain=false(MEDIUM 11·LOW 6). multi-asset(uniswap-v4)은 풀 전액을 1토큰에 귀속해 magnitude도 과대(`breadth-defillama.ts:114-127`). info 쿨다운 24h라 **매일 재발**(잔재 아닌 라이브).

## 1순위 수정안 (미적용)
`scan-current-risks.ts:120` — breadth(`verifiableOnchain!==true`)는 알림에서 제외, **엣지/대시보드 전용 강등**. 단일 변경으로 활성 17건 + 향후 재발 전량 제거. 보수적 대안: verifiable-only + 임계 $1B + 상한추정(`dataSource.includes("상한추정")`) 제외.
부작용 0: 진짜 대형 노출은 이미 **HIGH/verifiable 엣지**(Aave/Morpho/Spark/Fluid)가 커버(USDC/USDT/WBTC/WETH 모두 precise 엣지 보유 확인). 이 kind의 TP 정의 자체가 breadth로는 도달 불가.

근거: `edges.attrs.meta`(dataSource/verifiableOnchain/confidence) 재현 + DefiLlama TVL 교차. 코드: `scan-current-risks.ts:120` · `snapshot-chain.ts:359-365` · `breadth-defillama.ts:114-127`.

## 에이전트 보강 (이 kind에서 트리거)
RECIPE GAP #4: 이 kind는 현 구현상 **구조적으로 TP 산출 불가**(breadth=verifiableOnchain false). 레시피에 "TP 도달 불가 명시 + confidence(LOW/MEDIUM)·multi-asset 상한추정으로 noise 강도 차등" 반영.
