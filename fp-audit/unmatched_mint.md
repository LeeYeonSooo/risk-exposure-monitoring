# unmatched_mint — FP 검증 (✅ 2026-06-12)

활성 18건 → **TP 0 / FP 18 / UNCERTAIN 0**. (LBTC×5, CBBTC×4, USDC×4, WETH×3, WEETH×1, WSTETH×1)

## 두 그룹
- **라이브 재발 FP (미수정) 6건** — **WEETH 1 + LBTC 5**: lock&mint/네이티브를 burn&mint로 오분류. `mint_burn_ledger`에서 이 토큰들의 mint 금액에 **어느 체인이든 일치 burn 0건**(소스 burn이 원리적으로 없음). 존재하는 burn은 라운드 redemption(홈 상환). peg 정상(weETH $1834.9·LBTC $63,809). `mint_burn_cursor`가 06-12까지 진행 = 계속 발화 중.
- **잔재 FP (이미 수정, 알림만 미ack) 12건** — **USDC 4·WETH 3·CBBTC 4·WSTETH 1**: 이미 `NATIVE_ISSUANCE_SKIP`(USDC/WETH/CBBTC) / `BACKING_WATCHES`=A_WATCHED(WSTETH)에 포함. `mint_burn_cursor` **동결 06-10 00:36~37** = 신규 발화 멈춤. 활성 알림은 그 직전 마지막 발화의 미acknowledge 잔재.

## 근본원인
디텍터 B(`snapshot-mintburn.ts`)의 **burn&mint 단일 가정**. lock&mint(weETH OFT·wstETH Lido·LBTC CCIP)·네이티브 발행(USDC/WETH/cbBTC)은 소스 레그가 `Transfer→0x0` burn이 아니라 **lock(escrow) 또는 발행사 직접 mint**라 매칭 burn이 ledger에 **원리적으로 존재하지 않음**(전 토큰 일치 burn 0건으로 입증).

## 1순위 수정안 (미적용)
`automation/scripts/snapshot-mintburn.ts:31` `NATIVE_ISSUANCE_SKIP`에 **`WEETH`·`LBTC` 추가**(유일하게 계속 재발 중인 6건 차단).
**동반 필수**: weETH·LBTC를 `BACKING_WATCHES`(supply-backing.ts)에 lock&mint watch(OFT adapter / CCIP 풀 lock 잔액 = backing)로 채워 **Detector A 커버리지 공백 방지** — 아니면 Kelp식 무담보 mint(진짜 TP)를 놓침.
잔재 12건: 코드 무관 — `UPDATE alerts SET acknowledged=true WHERE kind='unmatched_mint' AND token IN ('USDC','WETH','CBBTC','WSTETH') AND acknowledged IS NOT TRUE;` (+ 러너가 skip/watch 토큰의 기존 unmatched_mint를 auto-resolve하는 스윕 추가 시 재발 방지).

근거: `mint_burn_ledger` 일치-burn 카운트(전 토큰 0) · `mint_burn_cursor` 동결 타임라인 · `/api/breadth` · DefiLlama peg. 코드: `snapshot-mintburn.ts:31,42,60-74` · `mint-burn-recon.ts:65,90-115` · `supply-backing.ts:135`.

## 에이전트 보강 (이 kind에서 트리거)
RECIPE GAP: 프로젝트 인프라만으로 mint 수신자(EOA/브릿지) 확인 불가(`mint_burn_ledger`에 `to` 없음). → 레시피를 (1) ledger 일치-burn율로 **모델 판별** (2) `mint_burn_cursor` 동결로 **residual vs live** 구분 (3) skip/watch 멤버십을 1차 근거로 갱신. + 루브릭에 **residual(코드 이미 수정, 미ack 잔재)** 분류 추가.
