# CRITERIA — Sky/Maker 의존성 매핑 자동화 기준 v1.0

> **상태**: v1.0 (13개 시나리오 학습 완료 후 다듬어 재작성).
> **목적**: 이 JSON들(events/nodes/edges/flows)을 그대로 그래프 DB·시각화 도구에 input하면 정확하게 작동해야 한다.
> **정확도·완성도·일관성이 최우선.**
> **거버넌스 영향 예측은 OUT OF SCOPE.** (사용자 결정 — 거버넌스 구조는 매핑하되 spell이 시스템 파라미터 바꿔서 발생하는 전파 영향은 매핑 외)
> **셀프 루핑·공통 admin 등 2차 패턴 검출은 1차 목표 후 단계.** (현재는 1차 목표 = 의존성 통합 그래프)

---

## 0. 큰 원칙

| 원칙 | 의미 |
|---|---|
| **명시적 의존성만** | 온체인에서 관찰 가능한 자금·권한·상태 흐름만. 추측·암묵적 관계는 표시하되 라벨 분리. |
| **시나리오 단위 검증** | 모든 노드·엣지는 최소 1개 시나리오에서 활성화 가능해야. 활성화 안 되면 제외 또는 dormant 라벨. |
| **이벤트로 검증** | 모든 dynamic 엣지는 이벤트로 추적 가능해야. 이벤트 없으면 인접 이벤트로 추론 + view 함수로 보강. |
| **deprecated 완전 제외** | Cat, Flip, 구 Flap (영국식 경매), Teleport bridges, GUSD/PAX PSM (사용 미미) 등은 노드·엣지에서 빠짐. |
| **dormant vs wind_down vs deprecated 구분** | dormant = 발동 안 됨 (구조 유지), wind_down = 사용 권장 X (마이그 진행), deprecated = 완전 사용 X (제외) |
| **최소 필요한 것만** | "있어도 그만" 컨트랙트는 메타데이터로 흡수 (예: Abacus → Clipper의 calc 메타데이터). |
| **외부 프로토콜 black box** | Aave/Morpho/Curve/Uniswap/Pendle/Lido/RocketPool/Compound 등은 1 노드 (다른 담당자 분담). Spark는 예외 (Sky의 Star, 핵심 sub-component까지) |
| **정직한 보류** | 모르는 건 명시 ("확인 필요", "verified_contract metadata"). 추측 금지. |

---

## 1. 노드 등록 기준 (7개 테스트)

다음 7개 중 하나라도 yes면 노드. 7개 다 no면 노드 아님 (메타데이터로 흡수 또는 제외).

| # | 테스트 | 예시 (yes) | 예시 (no) |
|---|---|---|---|
| **N1** | 자금/자산을 보유하는가? | Vat (내부 dai/gem), LitePSM-Pocket (USDC), AllocatorBuffer (USDS), sUSDS (USDS) | Abacus (단순 계산기) |
| **N2** | 권한·역할을 가지는가? | PauseProxy, ClipperMom, AllocatorRoles, SPBEAM | MULTICALL |
| **N3** | 부채/포지션 ledger를 가지는가? | Vat (urn별 ink/art), CDP Manager (cdp_id → urn), LockstakeEngine (owner → urns 이중매핑), D3MHub (ilks struct) | DSChief (slate ID 정도, N2로 등록) |
| **N4** | 사용자가 직접 트랜잭션 보내는 진입점인가? | Dog.bark, Clipper.take, LitePSM.sellGem, sUSDS.deposit, LockstakeEngine.lock | 사용자가 직접 안 부르는 내부 helper |
| **N5** | 시스템 외부와의 경계인가? | Spark Pool, Circle, USDS_OFT, Chainlink, Uniswap V2 pair | 순수 Sky 내부 컨트랙트 |
| **N6** | dynamic 인스턴스 패턴인가? | UrnHandler (CDP), LockstakeUrn (minimal proxy clone), spell:<addr> | 단일 인스턴스 |
| **N7** | 외부 trust 가정인가? | Circle (USDC), Lido validator set, RWA operator | 자율 컨트랙트 |

**제외 정책 (7개 다 no면)**:
- 순수 view helper → 호출자 노드의 metadata로
- 단순 utility (MULTICALL, PROXY_FACTORY 일부) → 무관 시 제외
- 완전 deprecate (Cat, Flip, 구 Flap, Teleport) → 제외

---

## 2. 엣지 등록 기준 (6개 테스트)

다음 6개 중 하나라도 yes면 엣지.

| # | 테스트 | 예시 (yes) | 예시 (no) |
|---|---|---|---|
| **E1** | 자금이 실제로 이동하는가? | User → Sky CDP 담보 입금, Vat.move dai 이체, Vow → Splitter (vat.move) | Dog가 Vat.urns 읽기 (단순 view) |
| **E2** | 부채/포지션이 생성·수정·삭제되는가? | Vat.frob, Vat.grab, stUSDS.cut (chi 감소), Allocator Vault.draw | rate가 자연 증가 (Jug.drip 호출 안 한 상태) |
| **E3** | 권한·허락이 위임되는가? | ERC-20 approve, Vat.hope, AllocatorBuffer.approve, AllocatorRoles.setUserRole, LockstakeEngine.hope | view 권한 (모두에게 공개) |
| **E4** | 외부 상태가 내부 상태에 영향 주는가? | Chainlink → Median → OSM → Spot → Vat, Uniswap reserves → FlapperUniV2.exec | Chainlink 가격이 변했지만 아직 poke 안 됨 |
| **E5** | 한 컨트랙트가 다른 컨트랙트를 trigger하는가? | Dog.bark → Clipper.kick, Splitter.kick → FlapperUniV2.exec, LockstakeClipper.take → stUSDS.cut, D3MHub.exec → Pool.deposit | bark에서 vat.urns view 호출 |
| **E6** | 시나리오 의미상 의존성이 형성되는가? | LitePSM이 USDC 가격에 implicit 의존, sUSDS와 stUSDS가 같은 SPBEAM 공유 | (보통 위 5개로 잡힘) |

**제외 정책**:
- 순수 view read (Clipper → Abacus 가격 query) → 메타데이터로
- 검증 호출만 (Dog.bark 안의 Vat.urns 읽기) → 엣지 X. 그 결과로 발생하는 vat.grab은 엣지 O

---

## 3. 이벤트 신호 출처 (6개 패턴)

모든 엣지는 신호(이벤트 또는 view)로 검증 가능해야 함. 다음 6개 패턴 중 하나로 분류.

### Type 1 — 표준 Solidity event 있음 (가장 흔함)
- **Mode**: event name 기반 필터 (topic0 = keccak256(signature))
- **예**: Dog.Bark, Clipper.Kick, LitePSM.SellGem, sUSDS.Deposit, stUSDS.Cut, LockstakeEngine.Lock, D3MHub.Wind, Splitter.Kick, FlapperUniV2.Exec, DssFlash.FlashLoan, DaiUsds.DaiToUsds, MkrSky.MkrToSky
- **JSON**: `signal.source_type = "standard_event"`, `signal.events = [{name, topic0}]`

### Type 2 — LibNote (anonymous) — Vat/Jug/Vow/Pot 등 MCD 코어
- **Mode**: function selector(bytes4) 기반 필터 (topic0 = sig 자체)
- **예**: Vat.frob (sig=0x76088703), Jug.drip (sig=0x44e2a5a8), Vat.suck/heal/grab/move/slip/file/hope, Pot.drip/join/exit
- **JSON**: `signal.source_type = "lognote"`, `signal.filter_by_sig = "0x76088703"`

### Type 3 — 혼합 (Spot, OSM, Median)
- **Mode**: 핵심 행위는 standard event, 관리 행위는 LibNote
- **예**: Spot.Poke (standard), Spot.file/rely/deny (LibNote)
- **JSON**: 두 타입 다 등록 — `events: [poke, lognote_file, ...]`

### Type 4 — 이벤트 자체 없는 의존성 (★ 가장 까다로움)
- **Mode**: 인접 이벤트로 추론 OR view 함수 read
- **예 1**: CDPManager.give (event 없음) → view `CDPManager.owns(cdp)` polling
- **예 2**: D3MOperatorPlan.setTargetAssets (event 없음) → view `Plan.targetAssets()` polling
- **예 3**: vault unsafe 상태가 됨 → Dog.Bark가 발생한 사실로 역추론 + Vat.urns view 사후 확인
- **예 4**: Vow.sin 증가 → Vat.grab의 부수효과 → LogNote(grab) 신호로 추론
- **JSON**:
  ```
  signal: {
    source_type: "view_only" | "implicit_via_adjacent_event",
    trigger_events: ["dog_bark"],
    state_check: { method: "Vat.urns(ilk, urn)", expected_diff: "ink decreased", poll_interval: "block" }
  }
  ```

### Type 5 — 외부 프로토콜 event
- **Mode**: 외부 노드의 emitted_events에 ref만, 구체 indexing은 외부 담당자
- **예**: Spark.Borrow, Uniswap.Swap, UniswapV2.Mint, Aave.Supply, Morpho.Withdraw, Chainlink.AnswerUpdated
- **JSON**: 외부 노드 metadata에 `emitted_events: [...]` 표시. cross-protocol edge가 ref.

### Type 6 — Callback / Hook 패턴 (★ flash loan, Clipper take 등)
- **Mode**: 메인 호출의 atomic 안에서 외부 컨트랙트가 콜백
- **예**: DssFlash.flashLoan → receiver.onFlashLoan, Clipper.take → receiver.clipperCall, LockstakeClipper.take → engine.onTake
- **JSON**: 
  ```
  signal: {
    source_type: "callback_hook",
    parent_event: "Take" | "FlashLoan",
    callback_target: "user_provided" | "engine",
    atomic_with: [...]
  }
  ```

---

## 4. 활성도 라벨 (5단계, 모든 노드·엣지에 부착)

```
"activity_label": "active" | "emergency" | "dormant" | "wind_down" | "deprecated"
```

| 라벨 | 의미 | 예시 | 매핑 처리 |
|---|---|---|---|
| `active` | 매일/매시간/매주 자연 발생 | Vat.frob, LitePSM.SellGem, D3M.Wind, sUSDS.Deposit, FlapperUniV2.Exec | 포함 (1차 시각화 강조) |
| `emergency` | 비상 시에만 발동, 평소 0 | ClipperMom.tripBreaker, ESM.Fire, D3MMom.disable, SplitterMom.stop, STUSDS_MOM 4 action, End.cage | 포함 (별도 색/스타일) |
| `dormant` | deploy됐지만 한 번도/거의 발동 안 됨 | End, Flop (Black Thursday 이후 X), stUSDS.Cut, Cure | 포함 (희미한 색, "trigger 시에만") |
| `wind_down` | 활성이지만 사용 권장 X, 마이그 진행 | sDAI, Pot, 구 PSM_USDC_A, LOCKSTAKE_ENGINE_OLD_V1 | 포함 (점선) |
| `deprecated` | 완전 사용 안 됨 → **제외** | Cat, Flip, 구 Flap, Teleport bridges, GUSD/PAX PSM (사실상) | 제외 |

→ `deprecated`는 노드·엣지에서 빠짐. `wind_down`은 점선/희미한 색, `dormant`는 "trigger 시에만 활성화" 마커.

---

## 5. Flow Type — 엣지에 흐르는 것의 정의

**결정**: 둘 다 — `flows.jsonc`에 타입 정의 + `edges.jsonc`에 인스턴스 ref.

### 5.1 Flow 타입 분류 (확장됨 — 13개 시나리오 통합)

| flow_type | flow_id 예시 | 설명 |
|---|---|---|
| **value_flow** | `token_transfer`, `dai_internal_move`, `collateral_lock`, `share_mint`, `share_burn`, `token_mint`, `token_burn`, `token_refund`, `effective_lockup` | 자금·토큰·share 이동 |
| **permission** | `allowance_grant`, `vat_hope`, `ward_grant`, `permission_assign`, `permission_revoke`, `permission_transfer` | 권한·허락 위임 |
| **signal** | `price_update`, `oracle_pull`, `trigger_call`, `signal_only` (Referral 등) | 신호·트리거 (state 변경 동반 안 함) |
| **state_change** | `vault_modify`, `debt_create`, `debt_reduce`, `rate_accrue`, `parameter_change`, `bad_debt_absorb`, `fee_recognize`, `fee_to_surplus` | state 직접 변경 |
| **governance** | `governance_vote`, `governance_poll`, `governance_queue`, `governance_execute`, `governance_message` (cross-chain) | 거버넌스 행위 |
| **auction** | `bid_take`, `auction_kick`, `auction_cancel` | 경매 행위 |
| **cross_chain** | `cross_chain_send`, `cross_chain_receive`, `bridge_send`, `bridge_receive` | 체인 간 이동 |
| **external_call** | `external_supply`, `external_withdraw`, `external_swap`, `external_call`, `external_borrow`, `external_dependency` | 외부 프로토콜 호출 |
| **emergency** | `halt`, `cage_pool`, `cage`, `write_off_debt`, `write_off_reverse`, `share_exchange` (End) | 비상 행위 |
| **vat_internal** | `vat_internal_neutral` (suck+heal, vat.suck(vow,vow) 등) | 시스템 중립 회계 |
| **callback** | `callback` (flash loan, take 콜백) | atomic 콜백 |
| **lockup** | `token_lock`, `stake_share`, `unstake_share` | 잠금 |
| **migration** | (deprecated → new 마이그) | LOCKSTAKE_MIGRATOR 등 |

### 5.2 flows.jsonc 스키마

```json
{
  "flow_id": "token_transfer",
  "flow_type": "value_flow",
  "label": "토큰 이체",
  "schema": {
    "asset": "node_id (Token)",
    "amount": "wad",
    "direction": "from→to"
  },
  "applicable_edges": ["e01_cdp_operation", "e02_psm_swap", ...]
}
```

### 5.3 edges.jsonc에서 참조

```json
{
  "edge_id": "e01_cdp_operation",
  "flows": [
    {"flow_id": "collateral_lock", "asset": "tok_weth", "amount": "10e18"},
    {"flow_id": "debt_create", "amount": "5000e18"},
    {"flow_id": "token_transfer", "asset": "tok_dai", "direction": "out", "amount": "5000e18"}
  ]
}
```

→ 시각화 도구에서 edge에 흐르는 자산·권한·신호를 색깔·아이콘으로 표현 가능.

---

## 6. 스키마 필수 필드 (v1.0)

### 노드 필수 필드
- `node_id` (unique)
- `node_type` (EOA, ProtocolContract, UserOwnedContract, Token, Oracle, ExternalProtocol, OffchainEntity, Bridge, RemoteChain)
- `layer` (1~10, 너의 10-layer 구조)
  - 1: Core (Vat/Jug/Vow/Pot/Dog/Spot)
  - 2: Adapters (DaiJoin/UsdsJoin/GemJoin)
  - 3: (reserved)
  - 4: Liquidation (Clipper, LockstakeClipper, Flop, Cure)
  - 5: Oracle (Chainlink, Median, OSM, AllocatorOracle, LockstakeOracle)
  - 6: Sky Modules (LitePSM, sUSDS, stUSDS, LockstakeEngine, D3MHub, AllocatorVault, Splitter, FlapperUniV2, DssFlash, DaiUsds, MkrSky, Keepers)
  - 7: Governance (Chief, Pause, PauseProxy, VoteDelegate, SPBEAM, AllocatorRoles, Polling)
  - 8: Emergency (Mom 시리즈, ESM, End)
  - 9: External tokens + OffchainEntity (Circle, RWA operators)
  - 10: External Protocols + Remote Chains
- `category` (static, dynamic)
- `cluster_id` (sky, spark, oracle, bridge, external_tokens, offchain, rwa, remote_chains, 또는 user EOA)
- `activity_label` (active/emergency/dormant/wind_down)
- `addresses` (1개 이상 컨트랙트 주소, 또는 [] for off-chain)
- `label` (human-readable)
- `metadata` (자유 필드 — 아래 §10에서 정리한 패턴 metadata 활용)
- `emitted_events` (이 노드가 emit하는 event_id 배열)
- `view_functions` (사후 state read에 사용할 함수들, optional)

### 엣지 필수 필드
- `edge_id` (unique)
- `edge_type`
- `category` (static, dynamic, hybrid)
- `activity_label`
- `scenario` (어느 시나리오에 속하는지)
- `scenario_step` (시나리오 내 순서)
- `from`, `to`, `via` (경로)
- `signal` (source_type, contracts, events, ...)
- `preconditions` (발동 조건, optional)
- `side_effects` (이벤트로 잡히지 않는 부수 state 변화)
- `atomic_with` (같은 tx의 다른 엣지들, optional)
- `cumulative_stats` (count, volume, first/last block — dynamic만)
- `flow_payload` (Q2 결정 후 — flows.jsonc ref + 인스턴스 데이터)

### 이벤트 필수 필드
- `event_id`
- `name`
- `signature`
- `anonymous` (true/false)
- `filter_mode` ("event_name" or "function_selector")
- `topic0`
- `function` (LibNote인 경우)
- `decoded_inputs` (디코딩 가이드)
- `state_changes` (이 이벤트가 일으키는 state 변화)
- `emitting_contracts` (node_id 배열)
- `description`

---

## 7. 라벨링 규칙 (일관성)

| 필드 | 형식 | 예시 |
|---|---|---|
| `node_id` | snake_case, prefix로 그룹 표시 | `vat`, `tok_dai`, `gemjoin_eth_a`, `clipper_wsteth_b`, `lockstake_engine`, `allocator_spark_a_vault`, `d3m_spark_dai_pool`, `ext_aave_v3_lido` |
| `edge_id` | `e<번호>_<설명>` 또는 `s<번호>_<설명>` (static) | `e08_liquidation_trigger`, `s01_owns_dsproxy` |
| `event_id` | `<contract>_<event>` 또는 `<contract>_lognote_<func>` | `dog_bark`, `vat_lognote_frob`, `flapper_univ2_exec` |
| `cluster_id` | 짧고 명확 | `sky`, `spark`, `aave`, `oracle`, `bridge`, `rwa`, `chain_optimism` |
| `scenario` | snake_case | `liquidation`, `cdp_operation`, `psm_swap`, `smart_burn` |

---

## 8. 시나리오 분류 (학습 완료 상태)

| 우선순위 | 시나리오 | 학습 상태 | Plan A 완료 |
|---|---|---|---|
| 1 | `liquidation` | ✅ akali 직접 + md 통합 | ✅ |
| 2 | `cdp_operation` | ✅ DSProxy + CDP Manager + UrnHandler + ProxyActions + GemJoin + DaiJoin + UsdsJoin + Vat.frob + Jug.drip + DSProxy 권한 매트릭스 | ✅ |
| 3 | `psm_swap` | ✅ DssLitePsm + Mom + LitePsmJob + 구 DssPsm | ✅ |
| 4 | `savings` | ✅ sUSDS + SPBEAM + Pot + sDAI + USDS | ✅ |
| 5 | `risk_capital` | ✅ StUsds + Mom + RateSetter (Cut 메커니즘) | ✅ |
| 6 | `lockstake` | ✅ Engine + Urn + Clipper + LSSKY + VoteDelegate (cuttee=stUSDS 발견) | ✅ |
| 7 | `d3m` | ✅ Hub + 5 Pool + 5 Plan + Mom (Spark/Morpho/Aave) | ✅ |
| 8 | `allocator` | ✅ Vault + Buffer + Roles (bit-packed) + Registry + 7 Star | ✅ |
| 9 | `smart_burn` | ✅ Splitter + FlapperUniV2 + Mom + Kicker + Flop | ✅ |
| 10 | `flash_mint` | ✅ DssFlash (EIP-3156 + VatDai) | ✅ |
| 11 | `token_conversion` | ✅ DaiUsds + MkrSky | ✅ |
| 12 | `multichain` | ✅ USDS_OFT + 5 native bridges + Starknet | ✅ |
| 13 | `governance_and_emergency` | ✅ Chief + Pause + 9 Mom + ESM + End | ✅ |

---

## 9. 변경 이력

- **v0.1**: 초기 기준 세트. 청산 study 기반.
- **v1.0 (현재)**: 13개 시나리오 학습 완료 후 다듬어 작성. ~113개 도출 사항 통합.

---

## 10. ★ 13개 시나리오에서 도출된 패턴 카탈로그

각 시나리오에서 발견한 보강 사항을 6가지 카테고리로 정리.

### 10.1 컨트랙트 패턴 metadata

| metadata field | 값 | 의미 | 출처 시나리오 |
|---|---|---|---|
| `upgradeability` | `immutable` / `uups` / `transparent` / `eip1167_minimal_proxy` | sUSDS는 immutable, USDS/stUSDS는 UUPS, LockstakeUrn은 minimal proxy | #04, #05, #06 |
| `instance_pattern` | `singleton` / `per_ilk` / `per_user` / `per_star` / `minimal_proxy_clone` | UrnHandler/LockstakeUrn은 per-user clone | #02, #06, #08 |
| `impl_node` | `<impl node_id>` | proxy의 implementation 노드 | #04, #05, #06 |
| `instance_level` | `shared` / `per_star` | Allocator의 Roles/Registry는 shared, Vault/Buffer는 per_star | #08 |
| `role_separation` | `execution` / `custody` / `permission` | AllocatorVault=execution, Buffer=custody, Roles=permission | #08 |
| `permission_model` | `wards` / `ds_auth` / `bit_packed_roles` / `dual_check` | wards (단순) vs Allocator bit-packed (정교) | #02, #06, #08 |
| `interface_only` | `true` / `false` | IAllocatorConduit, ID3MPool은 인터페이스만 | #07, #08 |
| `dual_role` | `["token", "vault"]` | sUSDS/stUSDS = ERC-20 share + ERC-4626 vault, Uniswap LP도 | #04, #05, #09 |
| `inventory_model` | `pre_mint` / `lazy_mint` / `external_pool` | LitePSM은 pre-mint, sUSDS는 USDS 그대로 보관, D3MPool은 external | #03, #04, #07 |
| `collateral_model` | `secured` / `unsecured_credit` | Allocator ilk = unsecured (오라클 항상 1.0) | #08 |
| `withdrawal_constraint` | `utilization` / `free` | stUSDS는 utilization 제약, sUSDS는 free | #05 |
| `fee_model` | `zero` / `tin_tout` / `early_exit_fee` / `bps_burn_take` | DssFlash = zero, LitePSM = tin/tout, LockStake = early_exit_fee 15%, MkrSky = bps burn+take | #03, #06, #10, #11 |
| `fee_realization` | `immediate` / `batched` | Legacy PSM = immediate (vat.move), LitePSM = batched (chug) | #03 |
| `governance_layer` | `1=sky` / `2=ilkAdmin` / `3=operator` | Allocator의 3-tier 권한 | #08 |
| `delay` | `GSM_4d` / `immediate` / `cooldown_X` | spell = GSM_4d, Mom = immediate, Splitter.hop = cooldown_1h | #09, #13 |
| `bridge_pattern` | `lz_oft` / `native_bridge` / `legacy_escrow` / `starknet` / `teleport_deprecated` | USDS_OFT vs OPTIMISM_TOKEN_BRIDGE | #12 |
| `cuttee_governance` | `filable` / `immutable` | LockstakeClipper.cuttee = filable | #05, #06 |
| `ilk_governance` | `immutable` / `filable` | stUSDS의 ilk는 immutable (clip에서) | #05 |
| `line_governance` | `self_dynamic` / `autoline` / `spell_only` | stUSDS는 self_dynamic, Allocator는 spell_only | #05, #08 |
| `direction` (token conv) | `bidirectional` / `one_way` | DaiUsds = bidir, MkrSky = one_way | #11 |
| `migration_ratio` | `"1:24000"` 등 | MKR → SKY 비율 | #11 |
| `external_depth` | `1` (Spark) / `2` (Aave/Morpho) | Sky의 직속 vs 더 멀리 | #07 |
| `trigger` | `permissionless_threshold` / `auth_only` | ESM = permissionless (50k SKY 임계) | #13 |
| `verified_contract` | `etherscan_at_block_N` | chainlog와 실제 source 불일치 가능 (MCD_FLAP 케이스) | #09 |

### 10.2 신호 추출 패턴

| 패턴 | 설명 | 출처 |
|---|---|---|
| **LibNote function-selector mode** | Vat/Jug/Vow/Pot anonymous event, topic0 = bytes4 sig | #01, #02 (전반) |
| **HALTED / MAX_UINT 마커** | type(uint256).max를 "사용 중지" 신호로. PSM의 tin/tout, Splitter의 hop. `interpretation: "halt"` metadata | #03, #09 |
| **adjacent event 추론** (Type 4) | 이벤트 없는 행위는 인접 이벤트 + view 함수로 추론 (Pot, CDPManager.give, D3MOperatorPlan.setTargetAssets) | #02, #04, #07 |
| **view function only signal** | source_type: "view_only", state_check 메타데이터 | #02, #07 |
| **caller indexed event** | UsdsJoin.Join/Exit, DaiUsds, MkrSky 모두 caller indexed → 대리 호출 추적 | #02, #11 |
| **packed storage 인식** | sUSDS의 uint192 chi + uint64 rho = 1 slot. metadata 가치 | #04, #05 |
| **callback signal merging** | flash loan/take 콜백은 main event + callback 내부 events. atomic_with로 묶음 | #01, #10 |
| **EIP-1167 initCode 인식** | minimal proxy clone 식별 → urn impl 자동 추적 | #06 |

### 10.3 시스템 회계 패턴

| 패턴 | 설명 | 출처 |
|---|---|---|
| **vat.suck의 dual effect** | vat.suck(u, v, rad)은 u.sin + v.dai 동시 증가. single edge dual_effect 또는 2 edges로 분리 | #04, #05 |
| **vat.suck + vat.heal 중립 쌍** | flash loan, D3M Fees 처리. vat_internal_neutral flow type | #07, #10 |
| **vat.suck(vow, vow) 중립** | D3M Fees의 art 동기화 단계. fee 처리용 | #07 |
| **Fees auto-recognition** | 외부 풀 이자 → D3MHub.Fees → vat.slip+frob+suck. 2-step (recognize + to_surplus) | #07 |
| **bad debt absorption** | LockstakeClipper.take(sale.lot==0, due>owe) → cuttee.cut → chi 감소. **`bad_debt_absorb` flow type 신설** | #05, #06 |
| **drip atomic 묶음** | deposit/withdraw가 내부에서 drip 자동. atomic_with 명시 | #04, #05 |
| **dynamic vat.line** | stUSDS가 자기 ilk line을 자동 조정. self_dynamic 라벨 | #05 |
| **rate=RAY 강제** | D3M, Allocator ilk는 SF=0 강제. require(rate == RAY) | #07, #08 |
| **assets > 0 dust 보호** | stUSDS는 mint/redeem에서 추가 보호 | #05 |
| **cap=0 ↔ withdraw 가능 분리** | emergency 후에도 사용자 자금 출금 보장 | #05 |

### 10.4 거버넌스/Emergency 패턴

| 패턴 | 설명 | 출처 |
|---|---|---|
| **6-layer governance + emergency** | Chief → Pause → PauseProxy → Mom → ESM → End | #13 |
| **Mom 9개 표준 패턴** | 모두 owner+authority+isAuthorized | #13 |
| **GSM 4d vs immediate** | spell = 4일 지연, Mom = 즉시 | #13 |
| **PauseProxy super-wards** | 거의 모든 컨트랙트의 ward. 단일 노드 중심성 | #13 |
| **ESM 분산 emergency** | permissionless 50k SKY 임계 | #13 |
| **stop vs cage 차이** | SplitterMom.stop = hop=MAX (복구), cage = live=0 (영구) | #09 |
| **multi-action emergency** | STUSDS_MOM 4가지 (dissBud/halt/zeroCap/zeroLine) | #05 |
| **filable cuttee** | bad debt 흡수자 변경 가능 | #05, #06 |
| **3-tier governance delegation** | User → VoteDelegate → Chief, Sky → ilkAdmin → operator (Allocator) | #06, #08 |
| **spell 인스턴스 = dynamic node** | 1회용, DSPause.Plot event로 발견 | #13 |
| **chainlog mapping ambiguity** | chainlog 표시 ≠ 실제 source (MCD_FLAP). verified_contract metadata 권장 | #09 |
| **2-tier auth** | Sky wards + Star roles (Allocator) | #08 |

### 10.5 외부 의존 패턴

| 패턴 | 설명 | 출처 |
|---|---|---|
| **external token trust hub** | USDC (Sky + Aave + Spark + Pendle 공통), Circle을 hub로 | #03 |
| **3-hop external dependency** | Star (6) → funnel (6) → external pool (10) | #08 |
| **interface-only abstraction** | IAllocatorConduit, ID3MPool, IERC4626 | #07, #08 |
| **multi-pattern bridge** | LZ OFT vs native bridge vs legacy escrow vs Starknet vs Teleport | #12 |
| **RWA conduit cluster** | 16+ RWA conduits, off-chain trust 의존 | #08 |
| **xchain oracle** | sUSDS chi를 L2에 동기화 | #04, #12 |
| **oracle dependency in DEX swap** | FlapperUniV2 = Uniswap + pip oracle 이중 의존 | #09 |
| **multi reward tokens** | LockStake farm USDS/SPK/SKY 다양. payload metadata | #06 |

### 10.6 활성도/마이그레이션 패턴

| 패턴 | 설명 | 출처 |
|---|---|---|
| **wind_down 라벨 신설** | dormant와 다름. 활성이지만 사용 권장 X | #03 (구 PSM), #04 (Pot/sDAI), #06 (OLD_V1) |
| **migration 패턴** | LOCKSTAKE_MIGRATOR (구→신), MKR→SKY converter | #06, #11 |
| **3-distributor pattern** | REWARDS_DIST_USDS_SKY/SPK + LSSKY_SKY | #09 |
| **2-stage flow** | Splitter (분리) + Flapper (실행). atomic_with | #09 |
| **effective_lockup** | SKY가 LP에 잠겨 명시적 burn은 아니지만 사실상 burn 효과 | #09 |
| **bypass channel** | Kicker (Vow 우회), 별도 임계 | #09 |
| **4-in-1 atomic** | LockstakeEngine.lock = 4 effects (담보+위임+share+farm) | #06 |
| **multi-Star comparison** | 7개 Star 유사 구조 | #08 |
| **per-ilk multiple instances** | D3MHub 1개가 5개 ilk 관리 | #07 |

---

## 11. 거버넌스 영향 예측 — OUT OF SCOPE 명시

**범위 내 (포함):**
- User → Sky 거버넌스 *참여* 행위 (lock SKY, vote, delegate, ESM.join, plot/exec) — 관찰 가능
- 거버넌스 컨트랙트 구조 (Chief, Pause, Mom, ESM, End) — 노드/엣지로 표현
- spell 발생 시 그 spell 인스턴스 dynamic node + 시스템 변경 events

**범위 외 (제외):**
- spell이 시스템 파라미터를 바꿔서 발생하는 *전파 영향* (예측 불가)
- "이 spell이 통과되면 SF가 5% 오른다 → 차주들이 갚는다 → ..." 같은 시나리오 모델링
- 거버넌스 결정의 미래 시점 예측

→ **CRITERIA: spell 자체는 dynamic node로 등록. spell이 호출하는 함수는 일반 시스템 변경 엣지로 등록. spell의 *의도* 분석은 1차 매핑 외.**

---

## 12. TBD (구현 단계에서 결정)

- LibNote topic0 hash 실제 Vat 컨트랙트에서 정확 검증 (`0x6448...f31` 추정)
- 각 핵심 함수의 bytes4 selector 정확 값 (frob, grab, fold, heal, suck, slip, flux, move, hope, file, ...) — Etherscan 또는 `cast sig`로
- atomic_with 그룹의 정확한 표준 (tx hash? sequence id?)
- Star별 활성도 확인 방법 (chainlog만으론 활성도 모름 → Etherscan tx count)
- chainlog mapping ambiguity 해결 (MCD_FLAP 같은 케이스)
- LP receiver 정확한 주소 (PauseProxy인지, burner인지)
- D3MAaveTypeBufferPlan/RateTargetPlan 등 5종 Plan 수식 (이미 1차에 인터페이스만)
- StakingRewards (Synthetix-style) 정확한 reward accrual 수식 (외부 표준)
- VestedRewardsDistribution 정확한 동작
- spell 인스턴스 발견 방법 (DSPause.Plot 이벤트 indexing)
- 거버넌스 spell 분석 자동화 가능성 (calldata 디코딩)

---

## 13. 다음 단계

1. **JSON 4종 생성** (events.jsonc, nodes.jsonc, edges.jsonc, flows.jsonc):
   - 본 CRITERIA v1.0 + 13개 시나리오 md 기반
   - 활성/비활성 명확
   - signal source_type 정확
   - 패턴 metadata 활용
2. **검증 시나리오 V1~V4** (이미 v0.1에서 정의):
   - Alice EOA 입력 → 클러스터 확인
   - Sky의 Spark 노출 추적
   - USDC 디페그 시 영향 범위
   - 공통 oracle 노출
3. **시각화 통합 테스트**
