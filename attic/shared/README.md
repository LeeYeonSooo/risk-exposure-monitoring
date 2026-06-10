# Shared — 5명 공통 인프라

이 폴더는 **모든 팀원이 따라야 할 공통 스키마, 어휘, 템플릿**을 담습니다.
각 팀원은 이 폴더만 읽으면 자기 모듈을 어떻게 만들어야 하는지 파악 가능.

---

## 구성

```
shared/
├── README.md              ← 지금 읽고 있는 파일
├── schemas/               # JSON Schema (출력 형식 검증)
│   ├── node_schema.json
│   ├── edge_schema.json
│   └── signal_schema.json
├── vocab/                 # 표준 어휘 정의 (모든 모듈이 같은 이름 사용)
│   ├── node_types.md      # 17개 노드 타입
│   ├── edge_types.md      # 19개 엣지 타입
│   └── signal_types.md    # 22개 시그널 타입
└── module_template/       # 새 프로토콜 모듈 만들 때 복사할 빈 템플릿
    ├── README.md
    ├── nodes.json
    ├── events.json
    ├── edges.json
    └── signals.json
```

---

## 새 모듈 만드는 방법 (다른 팀원용)

### Step 1: 템플릿 복사
```bash
cp -r shared/module_template modules/{본인_프로토콜}
```
예: `cp -r shared/module_template modules/lido`

### Step 2: 어휘 학습
`shared/vocab/` 의 3개 파일을 읽어서 표준 노드/엣지/시그널 타입 파악.
**같은 의미는 반드시 같은 타입 이름 사용**.
(예: lending 프로토콜의 청산은 모두 `liquidation` edge_type)

### Step 3: 4개 JSON 채우기
복사한 폴더 안의 4개 JSON을 자기 프로토콜에 맞게 채움:

| 파일 | 무엇 |
|---|---|
| `nodes.json` | 정적 노드 정의 (Pool/Oracle/Token 등) |
| `events.json` | 감지할 이벤트 + 발생 트리거 + 만드는 엣지 |
| `edges.json` | 엣지 타입 정의 (의미 + 어디서 발생) |
| `signals.json` | (선택) 검출할 Layer 2 패턴 |

각 파일의 형식은 `shared/schemas/` 의 JSON Schema 참고.
실제 예시는 `modules/aave/` 참고 (본인이 먼저 완성한 모듈).

### Step 4: README 작성
`modules/{본인_프로토콜}/README.md` 에 프로토콜 특수 사항 정리:
- 다루는 범위 (체인, 버전)
- 핵심 컨트랙트 주소
- 다른 프로토콜과 다른 점 (예: Morpho는 시장별 격리)
- 우선순위 산출물

---

## 표준 어휘 — 왜 중요한가

5명이 각자 다른 어휘를 쓰면 통합 시 다음 문제 발생:
- 같은 청산을 누구는 `liquidation`, 누구는 `liquidate` → 통계 안 됨
- 같은 사용자 노드를 누구는 `user`, 누구는 `eoa` → 중복 노드 생성
- 같은 자산 의존성을 누구는 `oracle_dep`, 누구는 `price_dep` → 그래프 탐색 깨짐

→ **`shared/vocab/` 의 어휘를 엄격히 준수**.

표준에 없는 어휘가 꼭 필요하면 **PR로 추가 제안** + 팀 합의.

---

## 시장 식별자 표준

각 프로토콜은 시장(market) 개념이 있고, 시장 식별자는:

```
market_id = "{chain_id}:{market_address}"
```

| 프로토콜 | market_id 예시 |
|---|---|
| Aave V3 | `1:0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` (Main) |
| Morpho Blue | `1:{각 시장의 고유 ID}` |
| Lido | `1:lido-eth-staking` (논리 식별자) |
| Sky | `1:sky-mainnet` 또는 ilk 단위 |
| Pendle | `1:{각 PT/YT 시장 주소}` |

---

## 주소 표기 표준

**모든 주소는 소문자 통일** (체크섬 형식 X).

이유: 5명 모듈 통합 시 대소문자 불일치로 인한 중복 노드 방지.

```python
# 권장
address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

# 비추천
address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  # 체크섬
```

---

## amount 단위 표준

엣지의 `amount` 필드는 두 가지 형식 모두 포함:

```json
{
  "amount_raw": "100000000",   // 토큰 raw integer (wei 단위, stringified)
  "amount_decimal": 100.0      // human-readable (decimals 적용 후)
}
```

이유:
- raw: 정밀도 손실 없음 (분석용)
- decimal: 시각화/표시 편의

---

## 데이터 소스 권장

| 우선순위 | 소스 | 사용 시점 |
|---|---|---|
| 1 | **Subgraph** | 표준 이벤트 (Supply, Borrow 등) |
| 2 | **RPC** (Alchemy) | Subgraph 누락 보완 + 현재 상태 조회 |
| 3 | **Dune** | 복잡한 집계 + 케이스 스터디 |
| 4 | **Address Book** (`bgd-labs/aave-address-book` 등) | 정적 메타데이터 |

→ Subgraph 우선 합의. RPC는 보완용으로만.

---

## 통합 워크플로

본인이 자기 모듈 JSON 완성 후:

```
1. modules/{본인}/ 폴더에 JSON 4개 채워서 공유
                       ↓
2. 통합 담당자(현이)가 integration/module_loader.py 실행
                       ↓
3. 모든 모듈을 표준 어휘로 정규화 후 머지
                       ↓
4. simulator 형식으로 변환 후 new-simulator에 주입
                       ↓
5. http://localhost:3000/simulation 에서 자동으로 노출
```

→ 본인 모듈만 잘 만들면 통합은 자동.

---

## 문제 발생 시

- 어휘 충돌: `shared/vocab/` 의 어휘를 본인 도메인에 적용 못 하겠으면 → PR로 제안
- 형식 검증 실패: `shared/schemas/` 의 JSON Schema와 본인 JSON 비교
- 통합 실패: `integration/module_loader.py` 의 에러 메시지 확인
- 기타: 본인 모듈 README + 본인 정의 명확히 → 통합 담당자에게 전달

---

## 참고

- `modules/aave/` — 본인(현이)의 완성된 레퍼런스 모듈
- `integration/README.md` — 통합 동작 원리
- 프로젝트 루트 `README.md` — 전체 그림
