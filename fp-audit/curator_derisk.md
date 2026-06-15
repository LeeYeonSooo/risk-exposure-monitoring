# curator_derisk — FP 검증 (✅ 2026-06-12)

활성 19건 → **TP 0 / FP 18 / UNCERTAIN(경미 TP) 1** (#261 weETH — 진짜 단일마켓 축소지만 ~$0.9M·$354M vault의 정상 리밸런싱·LST 담보라 저위험).

## 근본원인
**market_key 충돌**: `marketKey = collateral|loan|lltv`(`snapshot-curators.ts:84`)가 oracle/IRM만 다른 별개 Morpho 마켓(상이 `marketId`)을 한 키로 합침 → split/secondary 행($0.82M)을 본 포지션 총액($70M)과 비교 → 가짜 "99% 회수". **결정적 증거: WBTC·cbETH curr 값이 어느 DB 스냅샷에도 없음**(WBTC는 38행 줄곧 ~$70M). 보조 패턴: vault 내부 담보 로테이션(#259 cbBTC→WBTC, 자금 안 떠남), partial-snapshot read(#257 XAUt — 직전 vault $5.94M 과소 read).

라이브 재발 6(#256–260) + 잔재 12(#36–48·76–79·145–157, 같은 결함 과거 재발·현 포지션 정상).

## 1순위 수정안 (미적용)
`snapshot-curators.ts` 쿼리(:46-49)에 `market{ uniqueKey:marketId }` 받아 **`marketKey`를 Morpho `marketId`로 교체**(충돌 제거 → #256/258/260 계열 소멸). 보강: **vault net-outflow 게이트**(vault 총 supply_usd가 같이 줄 때만 발화 → #259 컷) + **partial-snapshot skip**(vault 총액 ±50% 급변 시 비교 제외 → #257 컷) + info-tier **절대액 게이트**($5M↑). 진짜 단일마켓 회수(TP) 보존.
잔재 12: 코드 무관 — **수정 → 재스캔 → `acknowledged=true` 정리** 순(키 수정 전 ack하면 다음 run 재발).

근거: `vault_allocations` 시계열 min/max + 라이브 Morpho 교차. 코드: `snapshot-curators.ts:84,120-152` · `scan-curator-derisk.ts:30-61`.

## 에이전트 보강 (이 kind에서 트리거)
RECIPE GAP #2: 디텍터(`snapshot-curators.ts:120-143`)는 **DB-vs-DB가 아니라 그 run의 라이브 Morpho fetch vs DB 직전 스냅샷**을 비교 → 알림 curr가 어느 DB 스냅샷에도 없을 수 있음. `vault_allocations`엔 `market_key`만 있고 `marketId`가 없어 DB만으로 충돌 마켓 분리 불가. → 레시피에 "**라이브 Morpho 교차 필수** + vault net-outflow + partial-read skip + marketId 충돌 판별" 반영.
