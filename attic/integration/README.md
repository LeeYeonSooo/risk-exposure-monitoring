# Integration — 모듈 통합 레이어

5명의 `modules/{프로토콜}/` JSON을 읽어서:
1. 표준 어휘로 정규화
2. simulator가 이해하는 형식으로 변환
3. `new-simulator/backend/api/` 가 자동 로드하도록 출력

---

## 구성

```
integration/
├── README.md              ← 이 파일
├── module_loader.py       # 메인 통합 스크립트
├── vocab_mapper.py        # 본인 어휘 ↔ simulator 어휘 매핑
└── output/                # 변환 결과 (gitignore 대상)
    └── combined_graph.json
```

---

## 동작 흐름

```
[modules/aave/]    [modules/lido/]    [modules/sky/]
  4 JSONs           4 JSONs            4 JSONs
       │                │                  │
       └────────────────┼──────────────────┘
                        ▼
              module_loader.py
                        │
                        ├─ 1. shared/schemas/ 로 검증
                        ├─ 2. shared/vocab/ 어휘 통일
                        ├─ 3. 중복 노드 머지 (예: 같은 자산)
                        ├─ 4. simulator 형식으로 변환 (vocab_mapper.py)
                        ▼
            integration/output/combined_graph.json
                        │
                        ▼
        new-simulator/backend/api/main.py 가 로드
                        │
                        ▼
              /api/graph 응답에 반영
```

---

## 본인 어휘 vs simulator 어휘 매핑

본인 정의(31 노드 / 34 엣지)는 simulator의 단순 어휘(5 노드 / 9 엣지)보다 세분화됨.
통합 시 다음 매핑 적용:

### 노드 타입 매핑

| 본인 어휘 | simulator type | 비고 |
|---|---|---|
| `market_registry`, `protocol_pool`, `protocol_admin`, `vault`, `stability_module`, `safety_module`, `access_control` | `protocol` | category 메타데이터로 세분화 표시 |
| `a_token`, `variable_debt_token`, `underlying_asset`, `lst_token`, `lrt_token`, `pt_token`, `yt_token`, `sy_token`, `stable_token`, `governance_token`, `staked_governance`, `withdrawal_nft` | `token` | category로 LST/LRT/stable 등 구분 |
| `oracle`, `price_feed`, `price_adapter`, `lido_oracle`, `beacon_chain_oracle` | `oracle` | category로 세분화 |
| `treasury` | `protocol` | category=treasury |
| `user`, `liquidator_bot`, `mev_bot`, `curator`, `operator`, `multisig`, `external_contract` | (동적 노드, simulator 정적 그래프엔 미포함) | Layer 2 동적 그래프에서만 |

### 엣지 타입 매핑

| 본인 어휘 | simulator edge_type |
|---|---|
| `supply`, `withdraw`, `borrow`, `repay`, `atoken_transfer`, `flashloan`, `liquidation`, `repay_via_liquidation`, `collateral_seized`, `supply_on_behalf`, `debt_to`, `debt_reduced_for`, `safety_module_stake`, `safety_module_slash`, `gho_facilitator_*`, `gsm_swap`, `psm_swap`, `cdp_mint/burn`, `vault_allocation`, `treasury_accrual`, `swap` | (런타임 동적, 정적 그래프엔 안 들어감) |
| `credit_delegation`, `position_delegation`, `delegation` | `protocol` |
| `mint_wrapper`, `burn_wrapper`, `restake`, `withdraw_restake`, `withdrawal_request`, `withdrawal_claim`, `split`, `merge` | `issued_by` 또는 `restaked` (의미에 따라) |
| `price_dependency` | `oracle` |

→ **정적 토폴로지에는 "구조적 의존성"만, 자금 흐름은 Phase 3 동적 레이어에서.**

---

## 사용 방법

### 1. 통합 실행
```bash
cd integration/
python module_loader.py
```

출력: `integration/output/combined_graph.json`

### 2. simulator에 주입
`new-simulator/backend/api/main.py` 의 `/api/graph` 엔드포인트가
이 파일을 정적 그래프 옵션으로 로드 (자동, 별도 작업 X).

또는 수동:
```python
from integration.module_loader import load_combined_graph
graph = load_combined_graph()
# graph["nodes"], graph["edges"]
```

---

## 새 모듈 추가 시 워크플로

1. 다른 팀원이 `modules/{프로토콜}/` 폴더 채워서 공유
2. `python module_loader.py` 재실행
3. simulator 재시작 또는 `/api/graph/refresh` 호출
4. 자동으로 그래프에 반영됨

→ **`module_loader.py` 코드 수정 거의 없음**. 어휘 매핑은 `vocab_mapper.py` 한 곳에서만 관리.

---

## 디버깅

| 문제 | 원인 | 해결 |
|---|---|---|
| `KeyError: 'edge_type'` | JSON에 필수 필드 누락 | `shared/schemas/edge_schema.json` 으로 검증 |
| 중복 노드 | 같은 자산이 두 모듈에 있는데 주소가 다름 (대소문자 등) | 소문자 통일 |
| 모듈이 안 보임 | 폴더명/파일명 오타 | `modules/{lowercase}/{nodes,events,edges,signals}.json` 확인 |
| simulator에 반영 안 됨 | 캐시 | `/api/graph/refresh` POST 호출 |

---

## TODO (구현 예정)

- [ ] `module_loader.py` 본문 구현 (Phase 2)
- [ ] `vocab_mapper.py` 매핑 함수 구현 (Phase 2)
- [ ] `simulator` 와의 자동 연결 (Phase 2)
- [ ] 검증 + 머지 단위 테스트 (Phase 2)
