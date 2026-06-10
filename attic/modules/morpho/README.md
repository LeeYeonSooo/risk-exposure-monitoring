# Morpho 분석 모듈

담당자: **경환**
상태: ⏳ 작업 예정 (Week 2)

---

## 시작 방법

```bash
cp shared/module_template/*.json modules/morpho/
```

`shared/module_template/README.md` 참고해서 4개 JSON 채움.

---

## Morpho 관련 핵심 (참고용)

### 다뤄야 할 시스템
- **Morpho Blue** (현재 메인) — permissionless 시장 생성
- Morpho Optimizers (구버전, deprecated 중) — 우선순위 낮음

### 다뤄야 할 핵심
- Morpho Blue 컨트랙트
- 각 시장 = (담보 자산, 차입 자산, 오라클, LLTV) 묶음
- MetaMorpho Vaults (큐레이터 운영)

### 예상 엣지 타입
- `supply`, `withdraw`, `borrow`, `repay` (Aave와 공통)
- `liquidation`, `repay_via_liquidation`, `collateral_seized`
- `vault_allocation` — MetaMorpho → Market

### Bad Debt 처리 (Aave와 다름!)
- Aave: Treasury → Umbrella → 예치자 → Safety Module
- Morpho: **즉시 LP에게 비례 분배** (보호망 없음)
- 시그널: `bad_debt_socialized` 같은 별도 타입 검토

### 사용자 식별 (Aave와 다름!)
- Aave: 단일 사용자 노드 (cross-collateral)
- Morpho: **시장별 별개 노드** (격리 시장)
- `(user_address, market_id)` 복합 키 권장

### 데이터 소스
- Morpho Blue Subgraph (공식)
- RPC 보완 (시장 메타데이터)

### 본인(Aave 모듈)과의 의존성 접점
- 같은 사용자가 Aave + Morpho 양쪽 노출
- 같은 자산(wstETH 등)이 두 프로토콜에 담보로 들어감
- 같은 Chainlink 피드 의존 → 공통 오라클 시그널
