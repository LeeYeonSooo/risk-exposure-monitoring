# 표준 노드 타입 어휘

총 31개 노드 타입. 모든 모듈은 이 어휘를 사용.

---

## 분류 1: 프로토콜 인프라

| type | 설명 | 사용 예시 |
|---|---|---|
| `market_registry` | 시장의 단일 진실 공급원 (다른 컨트랙트 주소 조회) | Aave PoolAddressesProvider |
| `protocol_pool` | 사용자가 직접 호출하는 프로토콜 진입점 | Aave Pool, Morpho Market, Sky Vat |
| `protocol_admin` | 관리자 전용 컨트롤 패널 | PoolConfigurator |
| `access_control` | 권한(role) 관리 | ACLManager |
| `treasury` | 프로토콜 수익/적립금 보관 | Aave Collector |
| `vault` | 자산 위임 관리 컨테이너 | Morpho MetaMorpho, ether.fi vault |
| `stability_module` | 스테이블 페그 안정화 모듈 | Aave GSM, Sky PSM |
| `safety_module` | 보험/슬래싱 풀 | Aave Safety Module, Umbrella |

---

## 분류 2: 오라클

| type | 설명 |
|---|---|
| `oracle` | 라우터 / 단일 진입점 (예: AaveOracle) |
| `price_feed` | 데이터 1차 소스 (예: Chainlink Aggregator) |
| `price_adapter` | 가공 레이어 (예: Aave CAPO Adapter) |
| `lido_oracle` | Lido 자체 비콘체인 오라클 |
| `beacon_chain_oracle` | 비콘체인 데이터 브리지 (검증자 잔액 등) |

---

## 분류 3: 토큰

| type | 설명 | 사용 예시 |
|---|---|---|
| `underlying_asset` | 외부 발행 자산 (Aave 외부) | USDC, WETH, DAI |
| `a_token` | Aave 예치 영수증 | aUSDC, aWETH |
| `variable_debt_token` | Aave 부채 영수증 | variableDebtUSDC |
| `lst_token` | Liquid Staking Token | stETH, wstETH, rETH, cbETH |
| `lrt_token` | Liquid Restaking Token | weETH, ezETH, rsETH |
| `pt_token` | Pendle Principal Token | PT-stETH |
| `yt_token` | Pendle Yield Token | YT-stETH |
| `sy_token` | Pendle Standardized Yield | SY-stETH |
| `stable_token` | 프로토콜 발행 스테이블 | GHO, DAI, USDS |
| `governance_token` | 거버넌스 토큰 | AAVE, LDO, MORPHO |
| `staked_governance` | 스테이킹된 거버넌스 | stkAAVE, stkABPT |
| `withdrawal_nft` | 인출 대기 영수증 | Lido unstETH |

---

## 분류 4: 사용자 / 외부

| type | 설명 |
|---|---|
| `user` | 일반 EOA (외부 소유 계정) |
| `liquidator_bot` | 알려진 청산 봇 |
| `mev_bot` | MEV 추출 봇 |
| `curator` | Vault 큐레이터 (예: MetaMorpho) |
| `operator` | 노드 오퍼레이터 (Lido CSM 등) |
| `multisig` | 거버넌스/관리 멀티시그 |
| `external_contract` | 알려지지 않은 dApp/컨트랙트 |

---

## 노드 타입 선택 가이드

### "어떤 타입으로 분류할지 헷갈릴 때"

1. **자산이면**: 발행자가 누구인지 본다
   - 일반 발행자 (Circle 등) → `underlying_asset`
   - Aave 발행 영수증 → `a_token` 또는 `variable_debt_token`
   - LST/LRT 발행자 → `lst_token` 또는 `lrt_token`
   - 프로토콜 발행 스테이블 → `stable_token`

2. **컨트랙트면**: 사용자가 직접 호출하는가
   - 예 → `protocol_pool`
   - 관리자만 → `protocol_admin`
   - 권한 관리 → `access_control`

3. **오라클이면**: 정확한 위치 본다
   - 외부 → 온체인 데이터 1차 = `price_feed`
   - 가공 레이어 = `price_adapter`
   - 라우터 = `oracle`

4. **사용자/EOA면**: 행동 패턴 본다
   - 평범 → `user`
   - 자동화 청산 → `liquidator_bot`
   - MEV 추출 → `mev_bot`

### 같은 의미인데 표준에 없는 타입을 추가하고 싶을 때

1. **먼저 기존 타입에 메타데이터로 표현 가능한지** 검토
   - 예: "이건 Aave의 특수 컨트랙트인데..." → `protocol_pool` + `metadata.subtype` 으로 충분한 경우 많음
2. 그래도 새 타입이 필요하면 **팀 채널에 제안 + PR**
3. 승인되면 `node_schema.json` 의 enum + `node_types.md` 모두 업데이트
