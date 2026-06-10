# Aave V3 분석 모듈

담당자: **현이**
프로토콜: **Aave V3**
상태: ✅ Phase 1 완료, Phase 2 진행 예정

---

## 다루는 범위

| 항목 | 내용 |
|---|---|
| 버전 | Aave V3 (V2/V1은 필요 시만 참조) |
| 체인 | Ethereum mainnet (우선), L2는 후순위 |
| 시장 | Main + Lido Market + EtherFi Market |

---

## 시장 식별자

```
(chain_id, addresses_provider_address)
```

| 시장 | market_id |
|---|---|
| Main | `1:0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` |
| Lido | `1:0xcfBf336fe147D643B9Cb705648500e101504B16d` |
| EtherFi | `1:0xeBa440B438Ad808101d1c451C1C5322c90BEFCdA` |

---

## 핵심 컨트랙트

| 컨트랙트 | 역할 |
|---|---|
| Pool | 사용자 진입점 (supply/borrow/repay/liquidation/flashLoan) |
| PoolAddressesProvider | 주소 레지스트리 = 시장 식별자 |
| PoolConfigurator | 거버넌스 룰 변경 |
| AaveOracle | 가격 라우터 (CAPO 어댑터 + Chainlink) |
| ACLManager | 권한 관리 |
| Collector | Treasury (Reserve Factor + Flash Loan Premium + GHO 이자) |
| aToken들 | 예치 영수증 (자산별) |
| variableDebtToken들 | 부채 영수증 (자산별) |
| GHO + GSM | Aave 발행 스테이블 + 페그 안정화 |

---

## 산출물 (4개 JSON)

| 파일 | 개수 | 설명 |
|---|---|---|
| `nodes.json` | 16+4 노드 타입 | 정적 노드 12종 + 동적 노드 4종 |
| `events.json` | 24 이벤트 | 모든 감지 대상 이벤트 + 만드는 엣지 |
| `edges.json` | 19 엣지 타입 | 자금 흐름/위임/청산/GHO/정적 |
| `signals.json` | 22 시그널 | Layer 2 패턴 (1차 후순위) |

---

## Aave V3 특수 사항 (다른 프로토콜과 다른 점)

### 1. 멀티 시장 구조
- 같은 이더리움 체인에 3개 시장 (Main / Lido / EtherFi)
- 각 시장이 독립된 Pool, Oracle, Configurator
- 분석 모듈은 시장 단위로 분리해서 처리

### 2. eMode (Efficiency Mode)
- 같은 카테고리 자산은 LTV 93%까지 (LST 루핑의 핵심)
- 분석 모듈은 사용자별 emode_category 추적 필요

### 3. Isolation Mode
- 위험 자산은 다른 담보와 격리
- debt ceiling으로 시스템 잠재 손실 제한

### 4. CAPO (Custom Price Oracle for LST/LRT)
- 비대칭 보호: 상승 조작 차단 / 하락은 즉시 반영
- 자산 → CAPO Adapter → 하위 Chainlink 피드들의 의존성 체인

### 5. GHO (Aave 발행 스테이블)
- 일반 차입과 다름: mint, 고정 이자율, 100% Treasury 수익
- Facilitator 기반 발행 (Pool, GSM, FlashMinter, CCIP)
- 외부 디파이로 확산 → cross-protocol 의존성 핵심

### 6. user vs onBehalfOf
- supply/borrow/repay에 위임 가능
- 위임 케이스는 엣지 2개 생성 (자금 흐름 + 권리 귀속)

### 7. 두 종류 인덱스 (lazy update)
- liquidityIndex (예치), variableBorrowIndex (차입)
- 호출 시점에만 정착. balanceOf는 즉석 계산.
- aToken Transfer는 underlying 단위, BalanceTransfer는 scaled 단위

### 8. 두 종류 영수증
- aToken: transferable. 사용자 간 직접 전송 = 숨은 엣지
- variableDebtToken: non-transferable. 단, credit delegation 가능

---

## 데이터 소스 (계획)

| 데이터 | 1차 소스 | 보완 |
|---|---|---|
| 컨트랙트 주소 | `@bgd-labs/aave-address-book` | RPC |
| Supply/Borrow/Repay/Withdraw | Aave V3 Subgraph | RPC eth_getLogs |
| LiquidationCall, FlashLoan | Aave V3 Subgraph | RPC |
| aToken Transfer (사용자 간) | RPC eth_getLogs | (Subgraph 누락) |
| BorrowAllowanceDelegated | RPC | (Subgraph 누락) |
| 현재 HF | RPC (eth_call) | - |
| 자산 가격 | RPC (Oracle.getAssetPrice) | - |
| 거버넌스 액션 | Subgraph | RPC |

---

## 우선순위

### Phase 1 (✅ 완료)
- 도메인 분석 완료
- JSON 4개 정리 완료

### Phase 2 (진행 예정)
- `integration/module_loader.py` 로 simulator에 주입

### Phase 3 (진행 예정)
- Aave Subgraph 폴러 작성 (다른 사람 레퍼런스)

### Phase 4 (진행 예정)
- Aave 범위에서 토큰/주소 포커스 모드

---

## 학습 자료 (선택, docs/ 폴더)

12개 챕터의 상세 학습 노트는 별도 폴더에 보관 가능:
- 풀 구조, 이자 모델, 청산, eMode, GHO, Oracle 등

→ 통합 작업엔 직접 필요 없음. 다른 팀원이 본인 모듈 이해할 때 참고용.

---

## 참고

- Aave V3 공식 docs: https://aave.com/docs
- Aave V3 컨트랙트 소스: `../../aave-v3-origin/`
- Address Book: https://github.com/bgd-labs/aave-address-book
- Aave V3 Subgraph: https://thegraph.com/explorer (검색: "aave v3 ethereum")
