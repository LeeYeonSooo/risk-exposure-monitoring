# 모듈 템플릿 — 새 프로토콜 분석 시작 가이드

이 폴더를 복사해서 자기 프로토콜 모듈을 만듭니다.

```bash
cp -r shared/module_template modules/{본인_프로토콜}
```

예: `cp -r shared/module_template modules/lido`

---

## 채워야 할 파일 4개

| 파일 | 무엇을 담는가 |
|---|---|
| `nodes.json` | 프로토콜의 정적 노드 정의 (Pool/Oracle/Token 등) |
| `events.json` | 감지할 이벤트 + 어느 함수로 발생 + 만드는 엣지 |
| `edges.json` | 엣지 타입 정의 (의미 + 어디서 발생) |
| `signals.json` | (선택) 검출할 Layer 2 패턴 |

각 파일 형식 검증: `shared/schemas/` 의 JSON Schema 참고.
실제 채워진 완성 예시: `modules/aave/` 참고.

---

## 작업 순서 (권장)

### 1단계 — 어휘 학습 (30분)
- `shared/vocab/node_types.md` 읽기
- `shared/vocab/edge_types.md` 읽기
- `shared/vocab/signal_types.md` 읽기 (선택)

### 2단계 — 본인 프로토콜 핵심 컨트랙트 식별
- 사용자가 호출하는 진입점 (Aave는 Pool, Sky는 Vat 등)
- 발행하는 토큰들
- 의존하는 오라클
- 관리자/거버넌스 컨트랙트

→ `nodes.json` 의 정적 노드로 등록

### 3단계 — 감지할 이벤트 목록
- 본인 프로토콜의 핵심 이벤트 (supply, borrow, liquidation 등)
- 각 이벤트가 어느 함수 호출로 발생하는지
- 각 이벤트가 만드는 엣지 (1개 또는 여러 개)

→ `events.json` 작성

### 4단계 — 엣지 타입 카탈로그
- 본인 모듈이 사용하는 엣지 타입 목록
- 각 타입의 from/to role, 필수 필드
- `shared/vocab/edge_types.md` 의 표준 어휘 준수

→ `edges.json` 작성

### 5단계 — (선택) 시그널 검출 후보
- 이 프로토콜에서 검출 가치 있는 Layer 2 패턴
- 1차 작업엔 후순위. 시간 남으면.

→ `signals.json` 작성

### 6단계 — README 추가
복사한 폴더에 `README.md` 추가 (이 템플릿 README 덮어쓰기). 다음 포함:
- 다루는 범위 (체인, 버전)
- 핵심 컨트랙트 주소표
- 다른 프로토콜과 다른 점
- 우선순위/제약

---

## 형식 검증

JSON 파일이 schema에 맞는지 확인:

```python
import json
from jsonschema import validate

with open("modules/lido/nodes.json") as f:
    nodes = json.load(f)
with open("shared/schemas/node_schema.json") as f:
    schema = json.load(f)

for node in nodes["nodes"]:
    validate(node, schema)
```

---

## 자주 하는 실수

| 실수 | 해결 |
|---|---|
| 주소를 체크섬 형식으로 작성 | 모두 소문자로 변환 |
| 자기 도메인 어휘 사용 | `shared/vocab/` 준수 |
| 시장 식별자 형식 다르게 | `{chain_id}:{address}` 사용 |
| amount를 raw integer로만 또는 decimal로만 | 둘 다 포함 |
| 위임 케이스에서 엣지 1개만 만듦 | 자금 흐름 + 권리 귀속 2개 분리 |

---

## 다 끝났다면

1. 본인 모듈 폴더(`modules/{프로토콜}/`)를 통합 담당자(현이)에게 공유
2. `integration/module_loader.py` 가 자동으로 통합
3. simulator에 반영됨
