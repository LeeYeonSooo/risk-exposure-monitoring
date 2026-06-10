# bipartite-graphhh — Token ↔ Protocol 의존성 그래프 빌더

주어진 `(token, block)` 좌표에 대해, 그 토큰이 온체인에서 **어떤 프로토콜에 얼마나 의존하는지**를
**이분그래프(token ↔ protocol)** JSON으로 산출한다. 결과는 `schema.json` 구조를 100% 따른다.

> 이 문서 + `schema.json` 만 읽으면 무엇을 만들지 충분히 알 수 있어야 한다.
> 구조의 단일 진실은 `schema.json`, 규칙의 단일 진실은 그 안의 `_policy`다.

---

## 1. 목적 (한 줄)

"이 토큰이 어디에 잠겨 있고, 무슨 일이 터지면 어디로 번지나"를 **한 장의 이분그래프**로 보여준다.

## 2. 입력 / 출력

- **입력 (사람이 주는 건 둘뿐):** `token_address`, `snapshot_block`
- **출력:** `graphs/<symbol>.<block>.graph.json`
  ```
  { "meta": {...}, "nodes": [ <schema.nodes.* 준수> ], "edges": [ <schema.edge 준수> ] }
  ```
  모든 노드/엣지는 `schema.json` 구조를 그대로 따른다.

## 3. 먼저 읽을 것

- **`schema.json`** — 노드 4종(token / lending_dapp / dex / wrapper) + 엣지 구조 + **`_policy`(규칙 10개)**.
  `_policy`가 곧 작업 지시서다. 특히:
  - `1_attribution` 토큰은 실제 있는 곳 **한 곳에서만** 카운트 (이중계산 금지)
  - `2_cutoff` ≥0.3% 공급 또는 ≥$10M 만 포함
  - `4_vaults` 볼트 처리 분기 (추적되면 leaf / 직접보유면 노드 / 변신·중첩·크로스체인)
  - `5_wrapper` 바스켓 래퍼 = `mint_backing` 엣지 + `edge.mint_backing` 블록
  - `9_cdp_is_wrapper` CDP = 다중담보 래퍼 (`issued_by` + `cdp_collateral` 2-hop)
  - `10_pass_through` 볼트 넘김은 `edge.pass_through`에 (메타, 재카운트 X)

## 4. 빌드 파이프라인 (이 순서)

1. **holders** — snapshot_block 시점 토큰 보유자 상위 목록 (Dune `erc20_*.evt_transfer` net, 또는 Alchemy). **0.3%/$10M 컷** 적용.
2. **classify(addr)** — 각 보유자 정체 분류:
   자체 `labels.json` → Etherscan `getsourcecode`/nametag → 함수셀렉터 probe(`asset()`, `MORPHO()`, `getReserveData()` 등).
   결과: `EOA | CEX | lending | dex | cdp | wrapper | vault | bridge`.
3. **resolve (= follow the token)** — 보유자별로:
   - pool / cdp / dex / wrapper / EOA / CEX → **leaf**: 여기서 카운트, 엣지 생성.
   - **vault** → 넘김 해석(`read_allocations`): **영수증 토큰 탐지**로 행선지 분류 → `edge.pass_through` 채움.
     - `resolved` → leaf 프로토콜에 카운트 (+ `top_markets.funding_vaults`에 볼트 기록)
     - `transformed` → 새 토큰 그래프로 핸드오프 (`to: token:*`), 이 그래프에선 안 셈
     - `nested` → 한 칸 더 재귀 (depth cap, visited set)
     - `crosschain` → 브릿지(토큰 메타데이터)
     - `idle | opaque` → 그 볼트에서 카운트 (볼트가 ≥0.3%면 노드)
4. **assemble** — 같은 `(token, protocol)`는 **엣지 1개**로 합치고 `classification.roles[]`로 역할 분해.
   drill-down 채움: `top_markets / top_pools / funding_vaults / pass_through`.
5. **enrich** — 엣지별 `oracle`(주소까지) · `lending_risk`/`cdp_risk` · `dex_metrics` · `meta`(provenance).
6. **validate** — §6 불변식 통과해야만 저장.

## 5. resolve의 뇌: receipt-token 탐지

볼트가 토큰을 어디로 보냈는지 모를 때 → **그 컨트랙트가 들고 있는 nonzero 토큰**을 읽어 역추적.
받은 영수증이 곧 행선지다. (`registry/receipt_tokens.json`로 매핑)
```
spWETH/aEthWETH → resolved(Spark/Aave)   |  comet share → resolved(Compound)
morpho share    → resolved(Morpho+market)|  LP token    → resolved(DEX pool)
다른 yvToken    → nested(vault)          |  다른 base token(stETH) → transformed
bridge/OFT      → crosschain             |  해독 불가    → opaque (confidence LOW)
```

## 6. 불변식 (전부 통과 필수 — 코드 테스트로 강제)

- **bipartite**: 모든 엣지는 token↔protocol. token-token / protocol-protocol 금지.
- **보존 (이중계산 0)**: `Σ(leaf + terminal amount) == 추적된 토큰 총량`.
  pass_through / nested / via / transformed-out 은 **절대 안 더한다**.
- **컷오프**: 모든 노드/엣지 ≥0.3% or ≥$10M. 버린 잔여는 "기타 N%"로 **명시**(silent 누락 금지).
- **provenance**: 모든 엣지에 `snapshot_block` + `verifiable_onchain` + `confidence`.
  `confidence: HIGH` 는 온체인 측정값에만. 오프체인/주장은 MEDIUM/LOW.

## 7. 데이터 소스 / 키 (전부 `block` 고정 → 재현)

| 용도 | 도구 |
|---|---|
| Archive RPC + **Multicall3** | Alchemy — 키: `/Users/link/podotree/.env` |
| 라벨 / 컨트랙트 검증 | Etherscan V2 (`/v2/api?chainid=1&...`) |
| 홀더 집계 | Dune (MCP) |
| Morpho 마켓·볼트 | Morpho GraphQL `https://blue-api.morpho.org/graphql` |
| Yearn 전략 | ydaemon `https://ydaemon.yearn.fi` |

체인 범위: **Ethereum mainnet (chain_id 1)** 만. 멀티체인은 v2.

## 8. Harness 구성 (추천)

핵심 원칙: **온체인 읽기·카운팅·검증은 결정적 코드(LLM 금지, 재현성). LLM/agent는 "가장자리"만.**

```
feeder/
  run.py            # 엔트리: (token, block) -> graphs/<sym>.<block>.graph.json
  pipeline.py       # §4 6단계 오케스트레이션 + validate 게이트
  sources/          # 얇은 어댑터 (교체 가능)
    rpc.py          #  Multicall3 배치 read
    dune.py  etherscan.py  morpho.py  yearn.py
  classify.py       # addr -> kind
  resolve.py        # follow-the-token 재귀 + pass_through (§5)
  validate.py       # §6 불변식 4종
  registry/
    receipt_tokens.json   # 영수증토큰 -> 프로토콜  (★ resolver의 자산)
    labels.json           # 자체 라벨 (etherscan 미스 보완)
  cache/<block>/    # block별 RPC 캐시 (재현 + 속도)
graphs/             # 산출물
schema.json  CLAUDE.md
```

추천 사항:
1. **순수코드 코어 + LLM은 가장자리만** — on-chain read/카운트/검증 = 결정적 코드.
   LLM(또는 에이전트)은 ① 라벨 모르는 주소 정체 추정 ② 새 vault 타입 어댑터 초안, **두 군데만**.
2. **어댑터 패턴** — 새 프로토콜 = 어댑터 1개 추가 + 레지스트리 등록. 코어는 안 건드림.
3. **레지스트리가 자산** — `receipt_tokens.json` + `labels.json` 한 번 구축, 계속 재사용. resolver의 뇌.
4. **block별 캐시** — 모든 RPC를 block 키로 캐시 → 같은 `(token, block)` 재실행은 즉시 + 완전 재현.
5. **검증 게이트** — `validate` 실패 시 저장 안 함. 보존법칙 깨지면 **빌드 실패**(이중계산이 절대 못 새게).
6. **결정적 + 점진 커버리지** — 모르는 vault는 `opaque, confidence:LOW`로 **통과**(에러 아님). 어댑터는 나중에 채움.
   데모 대상 토큰 경로만 깊게, 커버리지는 점진.

## 9. 작업 원칙

1. **추측 금지** — 분류 안 되면 `opaque` + `confidence: LOW`. 지어내지 마라.
2. **검증 before 주장** — 수치는 온체인 재측정(balanceOf 등)으로 확인 후 기록.
3. **스코프는 쿼리에서** — 안 쓸 필드 미리 채우지 마. (YAGNI)
4. **schema.json이 단일 진실** — 구조를 바꾸려면 `schema.json` 먼저 고치고 `_policy` 갱신. 코드가 스키마를 따른다.
5. **백테스트 재현성** — 모든 값은 `snapshot_block`에서 재현 가능해야 한다.

## 10. 안 하는 것 (스코프 밖)

- 실시간 추적·알림 (지금은 임의 block 백테스트)
- 멀티체인 동시 (지금은 mainnet 단일)
