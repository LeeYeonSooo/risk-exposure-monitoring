# 표준 시그널 타입 어휘

Layer 2 패턴 검출 시그널. 총 22개. severity별 분류.

→ **1차 목표(엣지 매핑) 이후 단계. Phase 3 이후 도입.**

---

## Severity: Critical (4개)

### `oracle_manipulation_suspect`
- **트리거**: 한 tx 내 [flash loan + DEX 큰 스왑 + 다른 프로토콜 활용 + DEX 복구]
- **함의**: 오라클 조작 공격 시도

### `lst_depeg_risk`
- **트리거**: LST 시장가가 NAV 대비 N% 이상 하락
- **함의**: CAPO는 상승만 막아서 디페그 즉시 청산 발동

### `gho_depeg_risk`
- **트리거**: GHO 시장 가격 페그($1) 이탈
- **함의**: GHO 의존 모든 프로토콜에 영향 전파

### `asset_paused`
- **트리거**: PoolConfigurator.ReservePaused(paused=true)
- **함의**: 긴급 상황 신호

---

## Severity: High (5개)

### `bad_debt_realized`
- **트리거**: Pool.DeficitCreated 발생
- **함의**: 회수 불가능한 부채. Treasury/Umbrella/예치자가 흡수.

### `liquidation_cascade`
- **트리거**: 짧은 시간 내 같은 자산에 다발 청산
- **함의**: 시장 충격 진행 중

### `shared_oracle_risk`
- **트리거**: 여러 자산이 같은 price_feed 의존
- **함의**: 디파이 의존성 허브. 피드 하나 실패 시 광범위 영향
- **핵심 가치**: 본인 도구의 가장 강력한 발견 후보

### `gho_dependency_cluster`
- **트리거**: GHO를 직간접 보유한 모든 주소 식별
- **함의**: GHO 디페그 시 영향 받는 사용자 그래프
- **핵심 가치**: 본인 도구 최강 데모

### `credit_delegation_abuse`
- **트리거**: credit_delegation 직후 즉시 최대치 borrow + 자금 외부 유출
- **함의**: 사회공학적 사기 검출

---

## Severity: Medium (8개)

| signal_type | 트리거 |
|---|---|
| `lst_looping_pattern` | eMode + LST 담보 + ETH 차입 + 높은 레버리지 |
| `isolation_capacity_warning` | isolation 자산 debt ceiling 80%+ |
| `capo_protected_depeg_exposure` | CAPO 보호 자산 담보 사용 (정보성) |
| `asymmetric_price_exposure` | 시장가 기반 자산 디페그 노출 |
| `gho_facilitator_capacity_warning` | facilitator bucket 한도 임박 |
| `risk_parameter_tightening` | LTV/LT 하향 변경 |
| `shared_asset_risk` | 같은 자산이 여러 시장 사용 |
| `cross_market_parameter_change` | 거버넌스 여러 시장 동시 변경 |

---

## Severity: Low (5개)

| signal_type | 트리거 |
|---|---|
| `stablecoin_looping_pattern` | 스테이블 카테고리 루핑 |
| `self_liquidation` | flash loan + 본인 청산 |
| `flashloan_leverage` | flash loan으로 레버리지 조정 |
| `new_asset_listed` | 새 자산 등록 |
| `multi_market_user` | 같은 사용자가 여러 시장 노출 |

---

## 시그널 생성 원칙

1. **엣지 위에서만 가능** — 엣지가 완성된 후에 시그널 검출
2. **재현 가능해야 함** — `evidence_edges` 에 근거 엣지 ID 포함
3. **단일 시점이 아닌 누적 분석** — 트랜잭션 1개가 아니라 패턴
4. **cross-protocol 가능** — 5개 모듈 통합 후에 cross-protocol 시그널 생성

---

## 새 시그널 추가 절차

1. **검출 조건 명확히 정의** — 어떤 엣지/노드 조합이면 트리거인지
2. **severity 결정** — 사용자에게 얼마나 강하게 알려야 하는가
3. **PR로 제안** — `signal_schema.json` enum + `signal_types.md` 추가
