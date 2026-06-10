# Pendle 분석 모듈

담당자: **서진**
상태: ⏳ 작업 예정 (Week 2)

---

## 시작 방법

```bash
cp shared/module_template/*.json modules/pendle/
```

`shared/module_template/README.md` 참고해서 4개 JSON 채움.

---

## Pendle 관련 핵심 (참고용)

### 다뤄야 할 핵심
- Pendle Router (사용자 진입점)
- 각 시장 (yield-bearing asset마다 SY/PT/YT)
- AMM 풀

### 토큰 종류 (Pendle 특유)
- **SY** (Standardized Yield) — 표준화된 yield-bearing 토큰
- **PT** (Principal Token) — 만기에 원금 1:1
- **YT** (Yield Token) — 만기까지의 수익권

### 예상 엣지 타입
- `mint_wrapper` — yield-bearing asset → SY
- `split` — SY → PT + YT (Pendle 고유)
- `merge` — PT + YT → SY
- `swap` — AMM 풀에서 PT/YT 거래
- `redeem` — 만기 후 PT → underlying

### 시장 식별
- 각 PT/YT 시장이 별도 컨트랙트
- 만기 (expiry)가 시장 메타데이터 핵심

### 데이터 소스
- Pendle Subgraph (공식)
- RPC 보완

### 본인(Aave 모듈)과의 의존성 접점
- **Aave 담보 자산(wstETH 등)이 Pendle에 들어와 PT/YT로 분할**
- 또는 반대: PT/sUSDe 같은 Pendle 토큰이 Aave 담보로 등록
- GHO도 Pendle에 깔릴 수 있음
- → 자산이 wrap → 분할 → 재담보로 가는 체인 추적 가능
