# supply_spike — FP 검증 (✅ 2026-06-12)

**활성 20건 → 검증 12 / capped 8(동일 클래스·동일 메커니즘 → 동일 결론).**
판정: **TP 0 / FP 12 / UNCERTAIN 0** (capped 8도 FP 강추정).

## 검증 방법
`diff.ts checkTotalSupply`의 z-score 경로를 재구현해 `supply_samples`(snapshot_ts 미만 최신 50) 시계열로 z 재계산 → **12건 모두 alert detail의 z와 정확 일치**(PRIME z=22,586,586.73 등). 전후 샘플로 "지속 vs V자 노이즈" 판정. `classifyAsset`·breadth API 교차확인.

## 알림별 (요약)
전부 FP. 패턴 둘:
- **flat-MAD z 폭발**: PRIME(altcoin 정상발행 유지)·osETH(LST staking 유입)·USDY(RWA 발행)·LBTC(BTC 발행)·PYUSD(발행형 stable) — MAD≈0이라 0.5%대 정상 변동도 z가 수백~수천만.
- **직전-1샘플 V자 오염**: sUSDS·USDS — 직전 read가 단일 저점이라 "복귀"를 가짜 점프로.
- **스테일(현행 가드면 억제)**: USDe·PT-reUSD·LBTC·USDY·USDC·stcUSD — relΔ<0.5%라 현행 `minRelDelta`가 이미 차단. 구버전 발화가 DB에 잔존.

## 근본원인
1. `automation/src/lib/stats.ts:28-32` `robustZ` — **MAD 하한 없음** → flat baseline에서 z 폭발. `minRelDelta(0.5%)`가 작은 건 막지만 0.5% 살짝 넘는 정상발행은 통과.
2. `automation/src/snapshot/diff.ts:489-491` — delta를 **직전 1샘플** 기준으로 → 단일 outlier read가 d를 오염.

## 1순위 수정안 (미적용)
```js
// stats.ts robustZ: 상대 MAD floor
if (mad / (Math.abs(median(baseline)) || 1) < 1e-3) return 0; // near-flat → 통계 무의미
```
- 보조: `diff.ts:489` delta를 "직전 median" 기준으로 / 이자형 stable·LST·RWA·major를 z-only 경로 제외.
- **부작용 없음**: 진짜 무단 mint는 single-block %경로(`diff.ts:466`) + corroboration(`:514`) + (멀티체인) backing-invariant로 포착. z-only는 info WATCH 등급(페이지 X).
- 운영 조치: 활성 20건 ack(스테일 정리).

## 근거
`/tmp/recon.mjs`(z 재현, 12건 일치) · `/tmp/shape.mjs`(전후 샘플). 코드: `diff.ts:466,489-491,500-502,514` · `stats.ts:28-32` · `alert-thresholds.ts:219,220,226`. 데이터: DB `supply_samples` · `/api/breadth`.
