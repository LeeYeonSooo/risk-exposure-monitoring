# 세션 인수인계 (SESSION HANDOFF)

> 다음 세션에서 이 파일을 먼저 읽으면 맥락을 이어서 작업할 수 있다.
> 목적: **토큰 주소 → 그 토큰이 실제 사용하는 브릿지 주소를, 오탐 없이(확정만) 온체인으로 탐지.**

---

## 1. 현재 완성 상태 (4계열)

| 계열 | VM | 상태 | 모듈 |
|------|-----|------|------|
| EVM | EVM | ✅ 완성 (B·C·D·E·F·G + verify) | `src/evm/` |
| Solana | SVM | ✅ 완성 (authority·holders·known_bridges) | `src/solana/` |
| Cosmos | IBC | ✅ 완성 (denom-trace) | `src/cosmos/` |
| Tron | TVM | ✅ 표준 브릿지만 확정 (EVM 로직 재사용) | `src/tron/` |
| Aptos | Move | ✅ 완성 (Wormhole wrapped/lock · LayerZero · CCTP, 실측 검증) | `src/aptos/` |
| Sui | Move | ✅ 완성 (Wormhole wrapped/lock · Sui Bridge · CCTP, 실측 검증) | `src/sui/` |
| Starknet | Cairo | ✅ 완성 (StarkGate permitted_minter 역검증, L1 원본 추출) | `src/starknet/` |
| Stellar | (계정모델) | ✅ 완성 (검증 발행자 화이트리스트 = Circle CCTP, 오탐0) | `src/stellar/` |

**핵심 원칙: "확정만 출력, 오탐 0."** 표준 브릿지(고유 함수/주소로 증명되는 것)만 출력하고,
발행사·관리자·비표준은 제외. 못 잡는 건 거짓 확정 대신 누락(정직).

---

## 2. 탐지 방법 (EVM 기준, 다른 VM은 같은 목표를 그 VM 방식으로)

- **B (ccip.py)**: CCIP `TokenAdminRegistry.getPool` → TokenPool
- **C (standards.py)**: 표준 view 함수 프로빙 — LayerZero·xERC20·Hyperlane·OP·Arbitrum/zkSync·Axelar·CCTP·Polygon·Wormhole NTT
- **D (authority.py)**: `minter()`/`MINTER_ROLE` 등 발행권한자
- **E (events.py)**: `Transfer(from=0x0)` mint 이벤트 → 발행 컨트랙트 (fallback)
- **F (holders.py)**: 대량 보유 컨트랙트(금고/풀) + verify 역검증 (fallback)
- **G (known_bridges.py)**: 알려진 브릿지 주소에 `balanceOf>0` → lock 확정 (**금액 무관**, 항상 실행)
- **verify.py**: 발행권한자/후보 주소를 브릿지 고유 함수로 **역검증** → 응답하면 확정, 아니면 발행사로 제외
  - CCIP `getSupportedChains`+`getToken` / Wormhole NTT `getMode`+`token` / Stargate `poolId`
  - LayerZero `endpoint` / Hop `l2CanonicalToken` / CCTP `localMinter`
  - Wormhole Portal `tokenImplementation`+`wormhole` (고유 조합, 오탐 방지)

Solana: `authority.py`(mintAuthority+CCTP) · `holders.py`(getTokenLargestAccounts) · `known_bridges.py`(Wormhole custody PDA 유도 = `pda.py`)
Cosmos: `ibc.py`(denom-trace → 채널=브릿지)
Tron: `rpc.py`(주소변환+TronGrid) → EVM C·D·G·verify 재사용
Aptos (Move VM, `src/aptos/`): EVM eth_call 없음 → Fullnode REST 로 Move 리소스/view 조회. 토큰 2형식 분기.
  - Coin(`<addr>::mod::Struct`): ① 발행계정의 `<WH>::state::OriginInfo` 보유 = Wormhole wrapped(원본 체인/주소 포함)
    ② `<LZ>::coin_bridge::has_coin_registered<T>()`=true = LayerZero(Aptos Bridge) ③ `coin::balance<T>(WH)>0` = Wormhole lock(금액무관)
  - FA(객체주소 `0x…`): ④ FA 가 `<Circle>::stablecoin::StablecoinState` 보유 = native USDC(CCTP) · ⑤ `primary_fungible_store::balance(WH,FA)>0` = Wormhole lock
  - 검증 주소(실측 확인): WH TB `0x5764…9d4f` · LZ `0xf22b…17fa` · Circle `0xe5c5…71be`. view/리소스 호출 자체가 자기증명이라 라벨 의존 없이 확정.
Sui (Move VM, `src/sui/`): Aptos 와 같은 Move 언어지만 런타임/RPC/저장모델 상이 → 별도 어댑터. Sui JSON-RPC 로 객체/동적필드 조회. 토큰=코인타입태그.
  - ① Wormhole: TokenRegistry(`0x3348…81a5`)의 동적필드 `<WH>::token_registry::Key<T>` → 값이 `WrappedAsset<T>`=wrapped(원본 체인/주소 포함)·`NativeAsset<T>`=네이티브 잠김(lock)
  - ② Sui Bridge: 시스템 브릿지 객체 `0x9` → inner(Versioned) → treasury `id_token_type_map` 에 등록된 코인(ETH·BTC·USDT·WLBTC, 네이티브 lock&mint)
  - ③ Circle CCTP: 검증된 native USDC 타입 `0xdba3…00e7::usdc::USDC`
  - 검증 패키지: WH `0x26ef…95e3d` · TokenRegistry `0x3348…81a5` · Sui Bridge 시스템객체 `0x9`. 레지스트리 등록 여부 = 구조적 증거라 오탐 0.
  - ⚠️ 라우터: Sui 코인타입은 Aptos 와 형식이 같아 **chain='sui' 힌트 필수**(없으면 aptos 로 분류). `common.py` SUI_NAMES 가 'sui' 힌트를 우선 처리.
Starknet (Cairo VM, `src/starknet/`): JSON-RPC. selector=keccak256(name)&(2^250-1)(실측 일치). 토큰은 브릿지를 view 로 안 줌 → **스토리지 직접 읽기**.
  - ① `starknet_getStorageAt(token, selector("permitted_minter"))` 로 민터(브릿지) 주소 ② 민터에 `get_identity()`=="STARKGATE"(0x535441524b47415445) 역검증 ③ `get_l1_token(token)` 로 원본 L1 주소.
  - 공개 RPC: lava.build · cartridge.gg(둘 다 동작, Blast 폐쇄). chain='starknet' 힌트 필수(0x+felt 라 EVM/Aptos 와 겹침).
Stellar (계정모델, `src/stellar/`): Horizon REST. classic 자산 `CODE:ISSUER` 는 **온체인 브릿지 인터페이스 없음**. home_domain 은 자기신고(가짜 USDC 수십개) → 스푸핑 가능.
  - **검증된 발행자 EXACT 화이트리스트**(`KNOWN_ISSUERS`)로만 확정 — 방법 G 방식. Circle USDC `GA5ZSEJY…`·EURC `GDHU6WRG…`(둘 다 home_domain=circle.com 실측) = CCTP.
  - 화이트리스트 외 발행자는 확정 안 함(누락>오탐). 새 브릿지(Allbridge 등)는 발행자 주소 검증 후 추가. 형식 `CODE:G…` 라 힌트 없이도 분류됨.

---

## 3. 라우터 (src/router.py + common.py)

토큰 주소 형식/체인 힌트로 계열 자동 분기:
```
0x+40hex → EVM  |  T+34자 → Tron  |  0x…::mod::Struct 또는 0x+41~64hex → Aptos  |  base58 32B → Solana  |  ibc/<hash> → Cosmos
chain 힌트 우선: 정수=EVM, 'tron', 'aptos', 'solana', 'osmosis' 등
```
※ EVM 은 정확히 40hex, Aptos FA 는 41~64hex 로 구분. 40hex 이하 Aptos FA 는 chain='aptos' 힌트 필요.

실행: `from main import main; main("토큰주소"[, chain][, rpc])`

---

## 4. 검증된 실측값 (회귀 테스트용 — 이 결과가 나와야 정상)

| 토큰 | 체인 | 기대 결과 |
|------|------|----------|
| rsETH `0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7` | 1 | CCIP TokenPool `0x55e5a21B…` |
| weETH `0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee` | 1 | Wormhole Portal(lock 0.0105) + LayerZero |
| USDe `0x4c9EDD5852cD905f086C759E8383e09bff1E68B3` | 1 | (발행사 Ethena 제외) → Wormhole Portal 등 |
| USDC(base) `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | 8453 | CCIP + CCTP |
| BONK | solana | Wormhole custody(621B) |
| USDC | solana | CCTP + Wormhole custody |
| ATOM `ibc/27394FB0…E5EB2` | osmosis | IBC Transfer channel-0 |
| USDT `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | tron | (네이티브 발행 → 브릿지 없음) |
| APT `0x1::aptos_coin::AptosCoin` | aptos | Wormhole lock (금고 잠김) |
| Wrapped SOL `0xdd89c0e6…::coin::T` | aptos | Wormhole wrapped → 원본 Solana |
| LZ USDC `0xf22bede2…::asset::USDC` | aptos | LayerZero(Aptos Bridge) + Wormhole lock |
| native USDC(FA) `0xbae20765…b46f3b` | aptos | Circle CCTP (native USDC) |
| Sui Bridge ETH `0xd0e89b2a…::eth::ETH` | sui | Sui Bridge (네이티브 lock&mint) |
| WH wUSDC `0x5d4b3025…::coin::COIN` | sui | Wormhole wrapped → 원본 Ethereum(USDC 0xa0b8…eb48) |
| native USDC `0xdba34672…::usdc::USDC` | sui | Wormhole lock + Circle CCTP |
| SUI `0x2::sui::SUI` | sui | Wormhole lock |
| Starknet USDC `0x053c9125…368a8` | starknet | StarkGate → 원본 L1 USDC `0xa0b8…eb48` |
| Starknet ETH `0x049d3657…04dc7` | starknet | StarkGate (L1=ETH 센티넬 0x455448) |
| Stellar USDC `USDC:GA5ZSEJY…KZVN` | stellar | Circle CCTP (발행자 확정) |
| Stellar 가짜 USDC(임의 발행자) | stellar | 0건 (오탐0 — 화이트리스트 외 제외) |

- Wormhole Token Bridge(Portal) Ethereum: `0x3ee18b2214aff97000d974cf647e7c347e8fa585` (주소 끝 `e7c347e8fa585` 주의 — 과거 오타 주의)
- CCTP V2 TokenMessenger(EVM 공통): `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`

---

## 5. 환경설정 (.env — git 제외됨)

```
ALCHEMY_KEY=<KEY>   # 설정 시 EVM(69체인)·Solana·Sui·Aptos·Tron 을 Alchemy 전용회선으로 (getLogs 안정화)
SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=<KEY>   # Solana 보유자/custody 분석에 필요(getTokenLargestAccounts)
```
- `src/config.py` 가 import 시 `.env` 자동 로드.
- ⚠️ 과거 세션에서 노출된 키(Alchemy `uYyxa5YX…`, Helius `33c31ffe…`)는 **폐기/재발급 후 .env 교체** 필요.
- **ALCHEMY_KEY 구현됨**(`src/alchemy.py` + 각 어댑터 resolve): 키 있으면 Alchemy 우선, 없으면 공개 RPC 자동 폴백(키 없어도 동작).
  - EVM: `chains.py` 의 `ALCHEMY_SUBDOMAINS`(chainId→서브도메인, 69체인 eth_chainId 실측 매핑). 미등록 chainId 는 공개 RPC 폴백.
  - 비EVM 드롭인 검증 완료: Solana(getHealth) · Sui(chainId) · Tron(eth_call) · Aptos(REST, 경로 `/v1` 접미).
  - 우선순위: 명시 RPC 인자 > 계열별 env(SOLANA_RPC 등) > ALCHEMY_KEY > 공개 RPC.

---

## 6. 다음 작업 (TODO, 우선순위순)

1. ~~Aptos 어댑터 (Move VM)~~ ✅ **완성** (`src/aptos/`). Wormhole wrapped/lock · LayerZero · CCTP(FA) 실측 검증.
   - 남은 보강(선택): Wormhole `native_infos` 테이블 조회로 lock 을 잔고 외 등록여부로도 교차검증 / LayerZero `remote` 연결 체인 표면화 / CCTP TokenMessenger 모듈 주소 명시
2. ~~Sui~~ ✅ **완성** (`src/sui/`). Wormhole wrapped/lock · Sui Bridge · CCTP 실측 검증. chain='sui' 힌트로 Aptos 와 구분.
   - 남은 보강(선택): Wormhole wrapped 의 native_decimals/symbol 도 표면화 / Sui Bridge 의 원격(L1) 토큰 매핑 표면화
3. ~~Starknet~~ ✅ **완성** (`src/starknet/`). StarkGate permitted_minter 역검증 + L1 원본. 실측 검증.
4. ~~Stellar~~ ✅ **완성** (`src/stellar/`). 검증 발행자 화이트리스트(Circle CCTP). 오탐0 확인(가짜 USDC 제외).
5. **NEAR** (선택) — 사용자 Alchemy 목록엔 없음. NEAR 네이티브 토큰 조회가 필요할 때. WASM VM, JSON-RPC `query`+`call_function`, Rainbow Bridge.
   - 보강(선택): Stellar Allbridge 등 추가 브릿지 발행자 검증·추가 / Starknet 비StarkGate 브릿지(있다면)
6. (선택) EVM Wormhole Portal 주소를 더 많은 체인으로 확장 (현재 7체인)
7. ~~Alchemy 키 자동 사용~~ ✅ **구현됨** (`src/alchemy.py`, EVM 70체인 + Solana·Sui·Aptos·Tron 매핑, 실측 검증)

---

## 7. 확정한 정책/한계 (재논의 불필요)

- **비표준 네이티브 브릿지**(JustCryptos·Fraxferry 등): 표준 함수·고유 이벤트 시그니처가 없어 **온체인 확정 불가** → 미지원(거짓 확정 안 함). owner() 표시는 오탐이라 안 함.
- **크로스체인 메시지 이벤트**로 확정: 표준 브릿지엔 이미 함수로 잡혀 추가이득 적고, 비표준엔 시그니처를 또 몰라 막힘 + getLogs 한계 → 채택 안 함.
- **발행사 vs 브릿지**: 발행권한자를 verify 역검증해 **브릿지만** 출력(발행사 제외).
- **Solana 대형 토큰**(USDC 등 계정 수백만): `getTokenLargestAccounts` 거부 → 발행형/custody로 대체 감지.
- **VM 단위로 어댑터**: 같은 VM(EVM)이면 어댑터 1개로 수백 체인 커버. 새 VM마다 어댑터 신규.

---

## 8. 빠른 시작 (다음 세션)
```bash
cd ~/Desktop/get_token_bridge_address
pip install -r requirements.txt
# .env 에 SOLANA_RPC 넣기 (Solana 풀/custody 쓰려면)
python main.py 0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7   # 회귀 확인용
```
