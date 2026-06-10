# Lido 분석 모듈

담당자: **명훈**
상태: ⏳ 작업 예정 (Week 2)

---

## 시작 방법

```bash
# 이 폴더에 shared/module_template/ 내용 복사
cp shared/module_template/*.json modules/lido/
```

그 후 `shared/module_template/README.md` 참고해서 4개 JSON 채움:
- `nodes.json` — Lido 핵심 컨트랙트/토큰
- `events.json` — 감지할 이벤트
- `edges.json` — 엣지 타입 정의
- `signals.json` — (선택) 검출 시그널

레퍼런스: `modules/aave/` 참고.

---

## Lido 관련 핵심 (참고용)

### 다뤄야 할 토큰
- **stETH** — rebasing LST (Lido 메인 출력)
- **wstETH** — non-rebasing wrapper (디파이에서 가장 많이 쓰임)
- **unstETH NFT** — 인출 큐 영수증
- **LDO** — 거버넌스 (우선순위 낮음)

### 다뤄야 할 컨트랙트
- Lido (stETH 메인 컨트랙트)
- WstETH (wrapper)
- WithdrawalQueue
- AccountingOracle (Lido 자체 오라클)
- ValidatorsExitBusOracle
- StakingRouter, NodeOperatorsRegistry, CSModule

### 예상 엣지 타입
- `mint_wrapper` — ETH → stETH
- `mint_wrapper` — stETH → wstETH (wrapping)
- `burn_wrapper` — wstETH → stETH
- `withdrawal_request` — stETH burn + unstETH NFT mint
- `withdrawal_claim` — NFT redeem + ETH 받음
- `delegation` — 노드 오퍼레이터 위임

### 데이터 소스
- Lido Subgraph (공식)
- RPC 보완

### 본인(Aave 모듈)과의 의존성 접점
- **wstETH가 Aave 담보로 가장 많이 사용** → 두 모듈 통합 시 wstETH 노드 공유
- Lido Oracle의 stEthPerToken 값은 Aave CAPO Adapter의 입력
