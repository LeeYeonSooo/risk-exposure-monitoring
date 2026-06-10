# Sky (구 MakerDAO) 분석 모듈

담당자: **연수**
상태: ⏳ 작업 예정 (Week 2)

---

## 시작 방법

```bash
cp shared/module_template/*.json modules/sky/
```

`shared/module_template/README.md` 참고해서 4개 JSON 채움.

---

## Sky/MakerDAO 관련 핵심 (참고용)

### 두 시대 공존
- **레거시 MakerDAO**: DAI/MKR/Vat/CDP (여전히 활발)
- **신규 Sky**: USDS/SKY/SSR (2024.8 리브랜딩)
- DAI ↔ USDS 1:1 전환 가능

### 다뤄야 할 핵심
- Vat (vault 엔진)
- 각 ilk (collateral type, 수십 종)
- DAI / USDS 토큰
- MKR / SKY (거버넌스)
- PSM (Peg Stability Module)
- sDAI / sUSDS (Savings)
- OSM (Oracle Security Module, 1시간 가격 지연)

### 예상 엣지 타입
- `cdp_mint` — CDP에서 DAI/USDS 발행
- `cdp_burn` — 상환 시 소각
- `psm_swap` — USDC ↔ DAI/USDS 스왑
- `mint_wrapper` — DAI → sDAI, USDS → sUSDS

### 사용자 식별
- **Vault 단위 격리** (한 사용자가 여러 Vault 가능)
- `(owner, vault_id)` 복합 키 권장

### 데이터 소스
- MakerDAO Subgraph
- Sky Subgraph (점진적 확장 중)
- Dune `maker_ethereum.*` 테이블 매우 잘 정리됨

### 본인(Aave 모듈)과의 의존성 접점
- **DAI/USDS가 Aave 담보 및 차입 자산** → 두 모듈 통합 시 가장 풍부한 의존성
- GHO와 DAI/USDS는 같은 CDP 패턴 → 공통 어휘 (`cdp_mint/burn`, `gsm_swap/psm_swap`) 사용
- 둘 다 Chainlink 의존
