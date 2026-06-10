# 🖤 ultra-automated-token-accelerator-the-god-kuromi

> **ChainSpiral** 의 온체인 DeFi **토큰 의존성 그래프 엔진**.
> 토큰 하나를 던지면, 홀더를 진짜 주인이 나올 때까지 재귀적으로 **까 내려가** token ↔ protocol 그래프를 만든다.
> 악마처럼 끝까지 따라간다. 😈

---

## 한 줄

ERC20 홀더 목록 1위는 대부분 진짜 주인이 아니라 **중간 컨트랙트**(래퍼·풀·금고·내부 장부)다.
이 엔진은 "이 돈 누구 거야?"를 **은행 → 펀드 → 고객** 순서로 자동 추적해서,
*이 토큰이 어디에 잠겨 있고, 무슨 일이 터지면 어디로 번지나*를 한 장의 그래프로 보여준다.

## 핵심 설계

- **두 종류의 "까기"**
  - **(A) ERC20-unwrap** — 홀더가 그 자체로 ERC20(aToken·ERC4626·SY 등) → 그 토큰의 홀더를 다시 크롤. 제네릭.
  - **(B) singleton-ledger 어댑터** — 홀더가 내부 장부에 다수 포지션을 모아둔 프로토콜 → 프로토콜별 어댑터로 펼침.
- **발견(Dune/GraphQL) → 검증(온체인 @block)** 분리. 수치는 전부 온체인 재측정으로 확정.
- **price-free** — USD 환산 없음. 토큰 네이티브 수량 + 설정값(LLTV·LT·utilization)만.
- **추측 금지** — 모르는 컨트랙트는 거짓으로 채우지 않고 `opaque`(점선)로 둔다.
- **재현성** — 모든 값은 `(token, block)` 에서 재현. block별 캐시.

## 어댑터 (singleton-ledger)

| 어댑터 | 해석 | 엣지 포지션 |
|---|---|---|
| **Aave v3** (+Spark) | aToken 홀더 = 예치자 | 예치량 · LTV · 청산임계(LT) |
| **Morpho Blue** | 마켓별 담보 차입자 / 대출 예치자 | 담보 · 차입(loan토큰) · LLTV · utilization |
| **Compound v3** | Comet 담보 차입자 / 베이스 공급자 | 담보 · base 차입 · liq_factor |
| **EigenLayer** | Strategy staker | shares · underlying · operator |
| **Kelp** | NodeDelegator → rsETH (transformed) | 핸드오프 |
| **Maker (MCD)** | GemJoin → vat.urns CDP | 담보(ink) · 부채(art×rate) · ilk |

새 프로토콜 = **어댑터 1개 추가 + 레지스트리 등록**. 코어는 안 건드린다.

## Quickstart

```bash
# 키는 레포 밖 /Users/link/podotree/.env 에서 읽음 (ETH_RPC, DUNE_API_KEY, ETHERSCAN_API_KEY)

# 1) 단일 토큰 크롤 → 프론트 sim 갱신
python3 run.py rsETH                 # head block
python3 run.py wstETH 25235536       # 특정 block
python3 run.py --all                 # tokens.json 전체 (20+)

# 2) 백엔드 + 프론트
python3 mock_server.py               # :8000  /api/manifest, /api/graph?token=
cd frontend && npm run dev           # :3000  /overview (토큰 셀렉터 + 드래그 + 흐름 애니메이션)
```

## 구조

```
feeder/
  crawl.py             # 통일 재귀 DFS: visit_token + dispatch (종류 A/B/leaf)
  ledger_adapters.py   # 종류 B 어댑터 레지스트리 (Aave/Morpho/Compound/EigenLayer/Kelp/Maker)
  validate.py          # 불변식(bipartite/self-loop/conservation) + 트리 출력
  tokens.json          # 20+ 토큰 (온체인 symbol 검증됨)
adapters/
  crawl_to_frontend.py # crawl 트리 → react-flow sim.json (라벨·포지션·색상)
run.py                 # 원커맨드: crawl → convert → manifest
mock_server.py         # /api/manifest, /api/graph?token=
frontend/              # Next.js /overview (React Flow, depth 컬럼 레이아웃)
graphs/                # 산출물 (crawl.*.json, frontend/*.sim.json)
```

## 불변식 (validate 게이트)

- **bipartite**: 모든 엣지 token↔holder. self-loop 금지.
- **보존**: 합 = 추적 총량. transformed/nested/via 는 재카운트 X.
- **컷오프**: 컷 이하 잔여는 `coverage`로 명시 (silent 누락 금지).
- **provenance**: `verifiable_onchain` + `confidence`(HIGH=온체인 측정값만).

체인: Ethereum mainnet. 멀티체인은 v2. 😈
