# get_token_bridge_address

토큰 주소를 넣으면 그 토큰이 **실제로 사용 중인 브릿지**를 자동으로 찾아준다.
**라우터가 주소 형식으로 체인 계열(EVM·Tron·Solana·Cosmos·Aptos·Sui·Starknet·Stellar)을 판별**해 알맞은 어댑터로 분기하고,
출력은 **"브릿지로 확정된 것만"** 보여준다(발행사/관리자는 제외, 오탐 0).

지원: **8개 계열** — EVM(70+체인) · Tron(TVM) · Solana(SVM) · Cosmos(IBC) · Aptos(Move) · Sui(Move) · Starknet(Cairo) · Stellar.

## 빠른 시작
```bash
pip install -r requirements.txt
cp .env.example .env        # Solana RPC(Helius 등) 키 넣으면 풀/원본까지 탐지
python main.py 0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7
```

## 사용법
```python
from main import main
main("0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7")          # EVM (기본 Ethereum)
main("0xd993935e13851dd7517af10687ec7e5022127228", 8453)    # EVM (Base)
main("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "tron")          # Tron
main("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "solana")
main("ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", "osmosis")
main("0x1::aptos_coin::AptosCoin", "aptos")                 # Aptos (Move)
main("0x2::sui::SUI", "sui")                                # Sui (Move, 'sui' 힌트 필수)
main("0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8", "starknet")  # Starknet (Cairo)
main("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")  # Stellar (CODE:ISSUER)
```
명령줄: `python main.py <토큰주소> [체인] [RPC]`

## 지원 범위 (계열 × 브릿지 유형)

| 브릿지 유형 | EVM | Solana | Cosmos | Tron | Aptos | Sui |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|
| burn & mint | ✅ | ✅ | ✅ (IBC) | ✅* | ✅ (CCTP) | ✅ (CCTP) |
| lock & mint (목적지) | ✅ | ✅ | ✅ (IBC) | ✅* | ✅ (WH wrapped) | ✅ (WH wrapped) |
| lock & mint (원본/금고) | ✅ G·F | ✅ G(custody PDA)** | ✅ IBC denom-trace | ✅* | ✅ (WH 금고, 금액무관) | ✅ (WH 레지스트리) |
| 유동성 풀 | ✅ F | ⚠️ 대량 보유시** | ➖ (IBC 수렴) | ✅* | ➖ (표준 브릿지로 수렴) | ➖ (표준 브릿지로 수렴) |

`*` Tron(TVM): EVM 확정 로직(C·D·G·verify)을 TronGrid RPC 로 재사용. **표준 브릿지(LayerZero·Wormhole·CCTP 등)만 확정.**
   Tron 네이티브 브릿지(JustCryptos 등)는 표준 인터페이스가 없어 온체인 확정 불가(미지원).
`**` Solana 는 좋은 RPC(.env Helius) 권장. lock 금고(Wormhole)는 custody PDA 직접 유도로 **금액 무관** 확정.
Aptos(Move VM): Fullnode REST 로 Move 리소스/view 조회. Wormhole(wrapped/lock)·LayerZero(Aptos Bridge)·Circle CCTP(FA) **실측 검증**. RPC 키 불필요.
Sui(Move VM): JSON-RPC 로 객체/동적필드 조회. Wormhole(TokenRegistry)·Sui Bridge(시스템 0x9)·Circle CCTP **실측 검증**. Aptos 와 코인타입 형식이 같아 **chain='sui' 힌트 필수**.
Starknet(Cairo VM): JSON-RPC. 토큰의 `permitted_minter`(스토리지)를 읽어 그 민터가 **StarkGate**(`get_identity()`=="STARKGATE")인지 역검증 → L1 원본까지. lock&mint. chain='starknet' 힌트 필수.
Stellar(계정모델): classic 자산은 온체인 브릿지 인터페이스가 없어 **검증된 발행자 화이트리스트**로만 확정(Circle CCTP USDC/EURC). home_domain 은 자기신고라 미사용(가짜 USDC 제외, 오탐 0).

**모든 출력은 "인터페이스/주소로 확정된 표준 브릿지만"** — 발행사·관리자·비표준은 제외(오탐 0, 검증 완료).

## 동작 방식

### 라우터 (`src/router.py`) — 계열 자동 판별
```
0x + 40hex            → EVM
T + 34자               → Tron
0x…::mod::Struct      → Aptos (Coin 타입태그) / Sui (chain='sui' 힌트 시)
0x + 41~64hex         → Aptos (Fungible Asset) / Starknet (chain='starknet' 힌트 시)
CODE:ISSUER(G…)       → Stellar (단일 ':' + G발행자)
base58 32B            → Solana
ibc/<hash>            → Cosmos
(+ chain 인자가 있으면 우선: 'tron'·'aptos'·'sui'·'starknet'·'stellar'·'solana'·'osmosis' 등)
```
※ Aptos·Sui·Starknet 은 주소 형식(`0x…`)이 겹쳐 **chain 힌트로 구분**한다(Sui='sui', Starknet='starknet', 없으면 Aptos).

### EVM (`src/evm/`)
- **B** Chainlink CCIP — `TokenAdminRegistry.getPool` → TokenPool + 연결 체인
- **C** 다중 표준 — LayerZero·xERC20·Hyperlane·OP·Arbitrum/zkSync·Axelar·CCTP·Polygon·Wormhole NTT
- **D** 발행권한 스캔 — `minter()`/`MINTER_ROLE` 등
- **E** 발행 이벤트 추적 — `Transfer(from=0x0)` 로그
- **F** 금고/풀 잔고 + **인터페이스 역검증** — lock 원본·유동성 풀(대량 보유)
- **G** 알려진 브릿지 주소 직접 대조 — `balanceOf(token, 알려진_Portal)>0` 이면 lock 확정.
  **금액 무관**(소량도) + 화이트리스트라 **오탐 0**. (Wormhole Portal 등)
- **발행사 vs 브릿지 구분**: D·E·F 가 찾은 주소를 `verify.py` 로 역검증해
  **브릿지 인터페이스에 응답하는 것만 확정**(발행사는 제외).

### Solana (`src/solana/`)
- `authority.py` — SPL `mintAuthority` 가 알려진 브릿지(Wormhole/CCTP/NTT)면 확정
- `holders.py` — `getTokenLargestAccounts` 로 금고/풀 발견 → 소유 프로그램이 브릿지면 확정
- `known_bridges.py` + `pda.py` — Wormhole custody PDA(민트별)를 결정적 유도 →
  잔고>0 이면 lock 확정 (**금액 무관**, EVM 방법 G 의 Solana 판)

### Cosmos (`src/cosmos/`)
- `ibc.py` — `ibc/<HASH>` 의 denom-trace → 전송 채널(브릿지) + 원본 토큰

### Aptos (`src/aptos/`) — Move VM, Fullnode REST
- `rpc.py` — Move 리소스 조회(`get_resource`) + view 함수 호출(`view`) + `coin_balance`
- `coin.py` — Coin 타입태그 파싱 / Coin·FA 메타데이터(name·symbol·decimals)
- `bridges.py` — ① 발행계정의 Wormhole `OriginInfo` = wrapped(원본 체인 포함) ② LayerZero `has_coin_registered`
  ③ Wormhole 금고 잔고 = lock(금액무관) ④ FA 가 Circle stablecoin 컨트롤러 소관 = native USDC(CCTP)
  — view/리소스 호출 자체가 자기증명이라 라벨 의존 없이 확정

### Sui (`src/sui/`) — Move VM, JSON-RPC 객체모델
- `rpc.py` — Sui JSON-RPC(`sui_getObject`·`suix_getCoinMetadata`·`suix_getDynamicFieldObject`)
- `coin.py` — 코인 타입태그 파싱 + TypeName 정규화(0x 없는 64hex) + 메타데이터
- `bridges.py` — ① Wormhole TokenRegistry 동적필드 = wrapped(원본 체인 포함)/native-lock
  ② Sui Bridge 시스템객체(0x9) treasury 등록 = ETH·BTC·USDT·WLBTC ③ 검증된 native USDC = CCTP
  — 레지스트리/시스템객체 등록 여부가 구조적 증거라 라벨 의존 없이 확정
- ⚠️ Aptos 와 코인타입 형식이 같아 `chain='sui'` 힌트 필요

### Starknet (`src/starknet/`) — Cairo VM, JSON-RPC
- `rpc.py` — `starknet_call`·`starknet_getStorageAt` + selector(=keccak256(name)&2^250-1)
- `detect.py` — 토큰의 `permitted_minter` 스토리지 → 민터가 StarkGate(`get_identity`="STARKGATE")인지 역검증 → `get_l1_token` 으로 L1 원본. 라벨 무관, 고유함수 응답으로만 확정

### Stellar (`src/stellar/`) — 계정모델, Horizon REST
- `rpc.py` — Horizon 계정/자산 조회
- `detect.py` — classic 자산 `CODE:ISSUER` 의 발행자를 **검증 화이트리스트**(`KNOWN_ISSUERS`, Circle CCTP)와 대조.
  온체인 인터페이스가 없고 home_domain 은 스푸핑 가능(가짜 USDC 다수)이라 EXACT 발행자 주소로만 확정(방법 G 방식)

### Tron (`src/tron/`) — TVM, EVM 로직 재사용
- `rpc.py` — Tron 주소(T-base58)↔EVM 0x-주소 변환 + TronGrid eth_call
- `detect.py` — EVM 방법 C·D·G·verify 를 TronGrid 로 실행 (표준 브릿지만 확정)

## "브릿지만 출력" — 발행사 제외
`minter()`/발행권한 결과는 발행사일 수도 브릿지일 수도 있다. 그 주소에 **브릿지 함수를
역호출**(`getSupportedChains`·`getMode`·`poolId`·`endpoint`·`localMinter` 등)해서,
**응답하면 브릿지 확정, 미응답이면 발행사로 보고 출력하지 않는다.** (라벨 불필요, 온체인 증명)

## 공통 결과 포맷
```python
{
  "family": "evm" | "tron" | "solana" | "cosmos" | "aptos" | "sui" | "starknet" | "stellar",
  "token": ..., "chain": ...,
  "bridges": [ { "standard", "address", "remotes":[{chain,address}], "note" } ],
  "raw": {...}
}
```

## 프로젝트 구조
```
get_token_bridge_address/
├── main.py
├── .env / .env.example / .gitignore / requirements.txt
└── src/
    ├── router.py          # 계열 판별 → 분기
    ├── common.py          # 주소 분류
    ├── config.py          # .env 로더
    ├── alchemy.py         # ALCHEMY_KEY → Alchemy URL 조립 (6계열 공용)
    ├── evm/
    │   ├── detect.py rpc.py chains.py
    │   ├── ccip.py(B) standards.py(C) authority.py(D) events.py(E)
    │   └── holders.py(F) known_bridges.py(G) verify.py(역검증)
    ├── solana/
    │   ├── detect.py rpc.py authority.py holders.py
    │   └── known_bridges.py(G) pda.py
    ├── cosmos/
    │   └── detect.py rpc.py ibc.py
    ├── tron/                         # TVM (EVM 로직 재사용)
    │   └── detect.py rpc.py
    ├── aptos/                        # Move VM (Fullnode REST)
    │   └── detect.py rpc.py coin.py bridges.py
    ├── sui/                          # Move VM (JSON-RPC 객체모델)
    │   └── detect.py rpc.py coin.py bridges.py
    ├── starknet/                     # Cairo VM (JSON-RPC, permitted_minter 역검증)
    │   └── detect.py rpc.py
    └── stellar/                      # 계정모델 (Horizon, 발행자 화이트리스트)
        └── detect.py rpc.py
```

## RPC 키 (선택) — `.env` 의 `ALCHEMY_KEY`
- 설정 시 **EVM(69체인)·Solana·Sui·Aptos·Tron** 을 Alchemy 전용 회선으로 조회 → 공개 RPC 의 `getLogs` 제한/429 를 우회해 방법 E·F 가 더 안정적.
- 미설정이어도 **공개 RPC 로 자동 폴백**(키 없이 동작). 우선순위: 명시 RPC > 계열별 env(SOLANA_RPC 등) > ALCHEMY_KEY > 공개 RPC.
- 키는 `.env` 에만 (코드/깃 금지). EVM chainId→Alchemy 서브도메인 매핑은 `src/evm/chains.py` 의 `ALCHEMY_SUBDOMAINS`(실측 검증).

## 기준 데이터 자동 로드 (로컬 DB 없음)
- EVM: CCIP 레지스트리(Chainlink GitHub) · 체인 RPC(chainid.network) · LayerZero eid(API)
- Solana: RPC = `.env` 의 `SOLANA_RPC`(Helius 등) → 없으면 공개 RPC 폴백
- Cosmos: LCD = rest.cosmos.directory 자동 폴백
- Aptos: Fullnode REST(`fullnode.mainnet.aptoslabs.com`) → 환경변수 `APTOS_REST` 로 교체 가능(키 불필요)
- Sui: JSON-RPC(`fullnode.mainnet.sui.io`) → 환경변수 `SUI_RPC` 로 교체 가능(키 불필요)

## 한계 (정직하게)
- 출력되는 건 **인터페이스로 확정된 브릿지만** → 정확도 우선.
  표준 인터페이스 없는 **완전 커스텀 브릿지**는 발행사와 구분 불가해 누락될 수 있다.
- Solana 잠김/풀형은 좋은 RPC 필요, 대형 토큰은 계정 수 제한으로 제외.
- Aptos·Sui 는 표준 브릿지(Wormhole·LayerZero·Sui Bridge·CCTP)만 확정. Sui·Starknet 은 힌트 필요(주소 형식 겹침).
- Starknet 은 StarkGate 만 확정(비StarkGate 브릿지는 미지원). Stellar 는 발행자 화이트리스트 기반이라 비검증 발행자는 누락(인터페이스 부재).
- 비지원 계열(Bitcoin·TON·NEAR 등)은 아직 미지원.
