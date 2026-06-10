# 표준 엣지 타입 어휘

총 34개 엣지 타입. 카테고리별 분류.

---

## 카테고리 1: 자금 흐름 (Direct Flow)

| edge_type | 의미 | from → to | 사용 프로토콜 |
|---|---|---|---|
| `supply` | 사용자가 풀에 자산 예치 | user → pool | Aave, Morpho, Compound |
| `withdraw` | 풀에서 자산 인출 | pool → user | Aave, Morpho, Compound |
| `borrow` | 풀에서 차입 | pool → user | Aave, Morpho |
| `repay` | 차입금 상환 | user → pool | Aave, Morpho |
| `flashloan` | 플래시론 (원자적 대여) | pool → receiver | Aave, Morpho |
| `treasury_accrual` | 프로토콜 Treasury 적립 | reserve → treasury | 모든 lending |
| `atoken_transfer` | 예치 영수증 직접 전송 (Aave 특유) | user → user | Aave |
| `swap` | DEX/AMM 스왑 | user → pool | Uniswap, Curve, Pendle AMM |

---

## 카테고리 2: 위임 / 관계 (Delegation)

| edge_type | 의미 | from → to |
|---|---|---|
| `supply_on_behalf` | 위임 예치 (A가 B를 위해) | msg.sender → onBehalfOf |
| `debt_to` | 위임 차입 (B가 받고 A가 빚) | msg.sender → onBehalfOf |
| `debt_reduced_for` | 대신 갚아주기 | repayer → user |
| `credit_delegation` | 차입 권한 위임 (사전) | delegator → delegatee |
| `position_delegation` | 포지션 관리 권한 위임 | user → manager |
| `delegation` | 일반 위임 (LST 노드 오퍼레이터 등) | delegator → delegatee |

---

## 카테고리 3: 청산 (Liquidation)

| edge_type | 의미 | from → to |
|---|---|---|
| `liquidation` | 청산 관계 (가장 강한 엣지) | liquidator → borrower |
| `repay_via_liquidation` | 청산 시 자금 흐름 | liquidator → pool |
| `collateral_seized` | 청산 시 담보 이전 | pool → liquidator |

---

## 카테고리 4: Wrapper / Staking

| edge_type | 의미 | from → to | 사용 예시 |
|---|---|---|---|
| `mint_wrapper` | 기초자산 → wrapper | underlying → wrapper | ETH → stETH, stETH → wstETH, eETH → weETH |
| `burn_wrapper` | wrapper → 기초자산 | wrapper → underlying | wstETH → stETH |
| `restake` | 재스테이킹 | user → restaking_protocol | EigenLayer |
| `withdraw_restake` | 재스테이킹 인출 | restaking_protocol → user | EigenLayer |
| `withdrawal_request` | 인출 요청 (큐 진입) | user → withdrawal_queue | Lido unstETH |
| `withdrawal_claim` | 인출 큐 처리 | withdrawal_queue → user | Lido |

---

## 카테고리 5: CDP / Stablecoin

| edge_type | 의미 | 사용 프로토콜 |
|---|---|---|
| `cdp_mint` | 담보 기반 스테이블 발행 | Sky/Maker (DAI/USDS), Aave (GHO) |
| `cdp_burn` | CDP 상환 시 소각 | 동일 |
| `gsm_swap` | Aave GHO Stability Module 스왑 | Aave |
| `psm_swap` | Sky Peg Stability Module 스왑 | Sky/Maker |
| `gho_facilitator_mint` | GHO facilitator 발행 (특수) | Aave |
| `gho_facilitator_burn` | GHO facilitator 소각 | Aave |

---

## 카테고리 6: Yield (Pendle 특유)

| edge_type | 의미 |
|---|---|
| `split` | SY → PT + YT 분리 |
| `merge` | PT + YT → SY 결합 |

---

## 카테고리 7: Vault

| edge_type | 의미 | 사용 예시 |
|---|---|---|
| `vault_allocation` | Vault → 하위 시장 자산 배분 | Morpho MetaMorpho |

---

## 카테고리 8: Safety Module (Aave 특유)

| edge_type | 의미 | from → to |
|---|---|---|
| `safety_module_stake` | Safety Module 스테이킹 | user → safety_module |
| `safety_module_slash` | bad debt 발생 시 슬래싱 | safety_module → treasury |

---

## 카테고리 9: 정적 의존성 (Static)

| edge_type | 의미 | 비고 |
|---|---|---|
| `price_dependency` | 자산이 오라클에 의존 | 이벤트 아닌 정적. 자동 발견 |

---

## 엣지 타입 선택 가이드

### "어느 카테고리에 들어가야 할까"

1. **자금이 실제로 이동했나?**
   - YES → 카테고리 1 (Direct Flow)
   - NO → 권한/관계 이전이면 카테고리 2 (Delegation)

2. **청산 사건의 일부인가?**
   - YES → 카테고리 3 (Liquidation). 한 사건이 3개 엣지 생성.

3. **토큰 wrapping/staking인가?**
   - YES → 카테고리 4

4. **스테이블 발행/소각인가?**
   - YES → 카테고리 5 (CDP). GHO와 DAI는 같은 패턴.

### user ≠ onBehalfOf 위임 케이스

한 행위가 **2개의 엣지**를 생성:
1. 자금 흐름 엣지 (`supply`, `borrow`, `repay` 등)
2. 권리 귀속 엣지 (`supply_on_behalf`, `debt_to`, `debt_reduced_for`)

이유: 그래프 탐색 시 위임 관계가 1급 시민으로 표현되어야 함.

### 청산 사건 (`Pool.LiquidationCall` 하나로 3개 엣지)

1. `liquidation` — 청산자 → 채무자 (관계, asset/amount는 null)
2. `repay_via_liquidation` — 청산자 → Pool (debtAsset, debtToCover)
3. `collateral_seized` — Pool → 청산자 (collateralAsset, liquidatedCollateralAmount)
   - `receiveAToken=true` 인 경우 `atoken_transfer` 로 대체

---

## 새 엣지 타입 제안 절차

1. **기존 타입 + metadata로 표현 가능한지** 검토
2. 그래도 새 타입 필요하면 **팀 채널 제안 + PR**
3. 승인되면 `edge_schema.json` enum + `edge_types.md` 동시 업데이트
