---

# 크로스체인 공급 보존(Cross-Chain Supply-Conservation) Detector 설계서 — FINAL

> **목표**: Kelp DAO rsETH류 **무담보 OFT mint**(목적지 체인에서 소스 burn/lock 없이 mint → 실제 backing 초과)를 잡되, 단일 토큰 하드코딩이 아니라 **토큰 클래스별 config 1행 = 1토큰**으로 일반화한다.
> 기존 Detector A(escrow, `supply-backing.ts` BACKING_WATCHES)는 wstETH만 보고 escrow-less 토큰을 health gate로 자동 스킵, Detector B(mint-burn recon)는 OFT를 `NATIVE_ISSUANCE_SKIP`으로 영구 제외, d10 `supply_single_mint`(`snapshot-mintburn.ts`)는 단일 트랜잭션 ≥5% mint만 잡는 **이벤트형**이다. 이 detector는 그 사이의 **상태형(state) 보존 불변식** 구멍을 메운다.

## 리뷰 반영 요약 (먼저 — 무엇이 바뀌었나)

**BLOCKER 정정 (온체인 라이브 검증 완료, 프로젝트 Alchemy 키 사용):**

1. **rsETH/weETH는 burn-mint OFT가 아니라 lock-mint(OFT Adapter)다 — M1 폐기.** 라이브 측정(2026-06):
   - rsETH: home(eth)=549,285, base=25,611, arb=20,917 → Σ=595,813. **home(549,285) < Σ(595,813)**, 차이 −46,528 = L2합과 정확히 일치.
   - weETH: home(eth)=1,557,607, base=28,387, arb=54,150 → Σ=1,640,144. **home < Σ**, 차이 −82,537 = L2합과 일치.
   dra프트의 M1 불변식 `Σ − homeTotalSupply > 0`은 **건강한 현재 상태에서 즉시 +43,782 rsETH / +79,791 weETH의 phantom CRITICAL을 발화**(≈$153M + $271M FP). 게다가 `rsETH.endpoint()`·`getRoleMemberCount(MINTER_ROLE)`가 canonical 주소에서 **revert** → home 토큰은 plain ERC20이고 OFT Adapter는 별도 컨트랙트가 lock한다. ⇒ **rsETH/weETH/ezETH를 M2(escrow)로 재분류.** 두 명의 kelp-recall/generalization 리뷰어가 지적한 "M1 불변식이 두 의미를 동시에 요구해 닫히지 않는다"는 모순도 이로써 소멸한다(escrow는 단일 의미).

2. **Alchemy ETH-only 전제는 STALE — base/arb eth_call 정상 동작.** 라이브 검증: `base-mainnet`/`arb-mainnet` Alchemy 슬러그로 rsETH/weETH `totalSupply()` eth_call이 **403 없이 정상 반환**. 프로젝트 메모리 'alchemy-app-eth-only'는 키 업그레이드로 무효. ⇒ Σ 데이터 경로를 단순화: **config에 고정한 L2 주소를 Alchemy로 직접 read(폴백 publicnode)** — DeFiLlama 풀 발견에 의존하지 않는다. (메모리 갱신 필요 — §8.)

3. **Σ는 median이 아니라 current(live) read로 비교.** `chain_supply_samples` median은 +116,500 단일 점프를 평활화해 발화를 막는다(리뷰어 정확). `snapshot-chain-supply.ts`의 검증된 패턴(상향 급증=탐지 수행, baseline 적재만 quarantine)을 그대로 미러.

**MAJOR 정정:**

4. **기존 커버리지 재서술(d10 존재 인정).** "기존 detector 전부 blind"는 부정확. d10 `supply_single_mint`는 116,500 rsETH 단일 mint(≈+35%, ≈$390M)를 **이미 critical로 잡는다**(rsETH가 mintWatchTokens·노드에 있을 때). 이 detector의 고유 가치는 (a) **5% 미만 다건 분할 mint의 누적**, (b) mint 로그가 윈도 밖으로 사라진 뒤에도 **불변식 위반이 지속되는 한 standing alert 유지**다. corroboration은 "d10 동반 시 confidence 승격"으로 재설계.

5. **fp-filters 대소문자 버그 정정.** `coverageGapVeto`(fp-filters.ts:138)는 대문자 `"MEDIUM"/"LOW"`만 본다. 알림 detail에 **반드시 대문자** confidence를 기록(config 타입은 소문자 유지, 기록 시 `.toUpperCase()`).

6. **USD 사이징은 토큰 자체 DEX/DeFiLlama 가격 금지.** `excessTokens × rate × underlyingAssetPriceUsd`로만 계산하되 `underlyingAssetPriceUsd`(ETH/USD, USD-peg=1.0)는 홈 체인 Chainlink feed에서 read. NAV-anchored 토큰은 **% 축 단독으로 critical 도달 가능**(USD 축이 같이 통과해야 한다는 AND를 깸) → 익스플로잇 중 시장가 폭락이 critical을 warning으로 강등시키지 못하게.

7. **persistence/throttle/poll-count를 wall-clock·DB 기반으로.** cron이 매 폴 새 프로세스를 spawn → in-memory `pollCount`는 항상 0 (`0%N==0` → throttle 무력화), in-memory `breachStreak`도 리셋. ⇒ throttle는 `now − last_nav_ts > throttleSeconds`(DB), persistence는 alerts 테이블의 escalation-aware 경로(첫 폴 info→WATCH, settlementSeconds 경과 후 escalate)로 구현.

8. **`evaluated`/`asserted` 분리.** Σ-integrity로 skip된 watch의 키를 asserted에서 빼면 `resolveStaleAlerts`가 살아있는 breach를 auto-resolve(UI 깜빡임 → 재페이지). ⇒ "평가 완료-clean(evaluated)"와 "평가 불가(skipped)"를 구분, **skip된 키는 resolve 후보에서 제외**.

9. **M3(home_issued)는 ledger 재사용 불가 → Phase 1에서 제외, future work로 강등.** `reconcile()`은 매칭/stale 행을 **삭제**하므로 누적 발행량 복원 불가, USDe는 NATIVE_ISSUANCE_SKIP. M3를 쓰려면 별도 append-only 카운터(또는 `chain_supply_samples` 홈행 델타)가 선결. CCTP/네이티브-멀티민트 스테이블(USDC/PYUSD/EURC)은 **구조적으로 보존 불변식이 없음 → 영구 EXCLUDE**(정직하게 범위 밖).

**리뷰어가 틀린 부분(간단히):**
- (data-feasibility) "weETH@base/rsETH L2 주소는 검증됨 → HIGH로 승격" — 맞음, 반영. 단 주소는 wire 직전 explorer 재대조를 절차로 남긴다(OFT redeploy 리스크는 실재).
- (generalization) "M2를 새 detector가 가지면 wstETH 이중발화" — 부분만 맞음. 정답은 **소유권 명시 분리**: wstETH는 Detector A 잔류, 신규 detector는 wstETH를 **등록하지 않음**(§6). 이중발화 회피.
- 일부 리뷰는 "M1이 살릴 수 있다"고 가정했으나, 라이브 데이터상 rsETH/weETH에 M1은 **불가**. M1은 "홈 burn-through가 온체인 증명된 토큰"에만 보류(현 config엔 해당 토큰 없음 → M1 행 0개로 출발).

---

## 1. 핵심 불변식 (Conservation Invariant)

표기: `supply_c` = 체인 c의 decimals-정규화 totalSupply(고정 read 주소). `Σ = Σ_{c∈ACTIVE_CHAINS} supply_c`. `slack = anchor × tolBps/10000`. 모든 비교는 **현재(live) supply** 기준.

세 모델이 같은 엔진 `evaluateConservation()`에서 `backingModel` switch로 갈린다. **Phase 1 출발은 M2만.**

### M2 — Escrow-anchored (lock-mint / OFT-Adapter / native-L2-deposit-mint) — **Kelp 클래스, 핵심**

홈 체인 lockbox/adapter에 **잠긴 canonical 토큰 잔액**이 L2 발행의 유일 정당 backing이다. 기존 `evaluateBacking`(supply-backing.ts:99)과 **동일 불변식**:

```
escrow    = Σ_i  balanceOf(canonicalHomeToken, lockbox_i)     # 홈 OFT adapter/bridge가 잠근 양
remoteSum = Σ_{c ≠ home} supply_c                              # circulating="remotes"
unbackedExcess = remoteSum − escrow − escrow×tolBps/1e4
FIRE iff unbackedExcess > 0   (over-backed/balanced = null = 안전)
```

이것이 **Kelp 시그니처를 정확히 잡는 형태**다: 정상 브릿지는 항상 lock-먼저(over-backed), L2 무단 mint는 lock 없이 remoteSum만 키워 `remoteSum > escrow` → 발화.

> **핵심 운영 제약 — lockbox 주소는 추측 금지, 온체인 발견.** rsETH/weETH의 OFT Adapter(lockbox)는 canonical 토큰을 잠그며, 그 주소는 explorer/온체인 토폴로지로 확정해야 한다. 코드베이스에 이미 `readBridgeAuthority`(bridge-authority.ts:89)가 **oft_peer / xERC20 lockbox / MINTER_ROLE을 온체인 enumerate**한다. lockbox 후보를 이걸로 발견하고, **자가검증 게이트**(아래)가 통과할 때만 watch를 arm한다.

**자가검증(calibration) 게이트 — fail-CLOSED:** watch를 wire하기 전(그리고 매 폴 첫 평가 시) 다음 항등식을 확인한다:
```
| remoteSum − escrow | ≤ escrow × armTolBps/1e4    (armTolBps 기본 200 = 2%, 건강한 over-backed 여유 포함)
```
건강한 스냅샷에서 이 항등식이 성립하지 않으면(=lockbox 주소가 틀렸거나 모델 오분류) **watch를 arm하지 않고 info/log-only로 강등**한다. 이는 "silent semantic guess"를 fail-closed 게이트로 전환한다(generalization 리뷰어 요구). rsETH의 경우 lockbox는 오늘 ≈46,528 rsETH, weETH는 ≈82,537 weETH를 보유해야 한다(라이브 측정한 L2합).

**경제적 backstop(보조, throttle):** lockbox가 채워졌더라도 NAV가 정말 그 공급을 받치는지 확증:
```
navExcess = (Σ × rate / 1e18) − underlyingNav − underlyingNav×tolBps/1e4   # rate=underlying per token @1e18
```
`rate`/`underlyingNav`는 홈 체인 getter(검증된 selector, §5). 통과 시 escrow breach를 critical로 승격. **NAV는 권위가 아니라 backstop** — escrow가 1차 게이트.

### M2-native — Escrow + L2-native-deposit-mint 혼합 (weETH) — **NAV backstop AUTHORITATIVE**

weETH는 일부 구성에서 L2 네이티브 예치-mint 경로가 있어 **합법 L2 공급이 lockbox 잔액을 일시 초과**할 수 있다(escrow-only면 FP). 이 토큰은 `requireNavConfirm: true`로 표시하고 발화 조건을 **AND**로 강제:
```
FIRE iff (remoteSum − escrow − slack > 0)  AND  (navExcess > 0 with FRESH nav this poll)
```
NAV가 stale/미read(throttle로 이번 폴 미실행)면 supply-excess가 양수라도 **info/WATCH로 강등**(escalate 금지). 즉 throttle된 backstop이 per-poll supply 트리거를 뒤따라가며 FP 스팸을 내지 못하게 — NAV를 매폴 read하거나(가벼우면), 다음 NAV read가 확증할 때까지 hold.

### M1 — NAV/issuance-anchored (홈 burn-through가 **온체인 증명된** 순수 burn-mint OFT 전용) — **현재 행 0개**

`Σ ≤ homeTotalSupply + slack` (circulating="all"). **이 모델은 "L2 무단 mint가 홈 totalSupply를 증가시키지 않고, 정상 브릿지는 홈에서 burn한다"가 온체인으로 증명된 토큰에만** 부여한다. 부여 전 토큰별로 OFT 토폴로지를 검증해야 하며(L2 mint가 L1 totalSupply에 영향 주는가?), **검증 전엔 어떤 토큰도 M1로 출발하지 않는다.** 현재 후보 전부(rsETH/weETH/ezETH)는 검증 결과 lock-mint → M2. M1은 스키마에 보존하되 행은 비움.

### M3 — Home-issuance flow conservation — **Phase 1 제외(future work)**

`unexplainedGrowth = dΣ − homeIssuanceNet − slack`. anchor가 없어 신뢰도 최하 + **데이터 소스 부재**(reconcile ledger는 누적 발행 복원 불가, USDe는 NATIVE_ISSUANCE_SKIP). 선결 조건(append-only 발행 카운터 신설 또는 chain_supply_samples 홈행 델타 + USDE를 NATIVE_ISSUANCE_SKIP에서 제외하고 recon이 home-issuance ledger를 emit)이 충족되기 전엔 wire하지 않는다. 스키마만 보존.

**명시적 EXCLUDE(영구):** USDC/PYUSD/EURC(CCTP·네이티브 per-chain mint → 단일 발행상한 없음 → 보존 불변식 자체가 없음), cbETH(Coinbase off-chain 커스터디 — 단, **Base 공급의 크로스체인 보존은 cbETH exchangeRate getter로 NAV backstop만은 읽힘**; terminal USD backing은 off-chain이므로 supply-conservation 범위에선 info-level만), USDe-peg-backing(Ethena off-chain attestation). 이들은 `chain_supply_spike`(info) best-effort 모니터로 남긴다.

---

## 2. Config-driven watch schema

```ts
// automation/src/snapshot/supply-conservation.ts (신규 lib)
export type BackingModel = "escrow" | "nav" | "home_issued"; // Phase1=escrow only

export type IssuanceCeilingMode =
  | "escrow_lock"            // M2: Σ balanceOf(canonical, lockbox_i)
  | "home_total_supply"      // M1: homeTotalSupply (burn-through 증명 토큰 전용)
  | "deposit_pool_cumulative"// M1 변종: deposit pool 누적 발행/ NAV÷rate
  | "ledger_flow";           // M3: 시계열 (Phase1 미사용)

export interface BackingRead {
  contract: string;          // 홈 체인 컨트랙트 주소
  method:
    | "balanceOf"            // M2 escrow lockbox 잔액 (canonical 토큰 read)
    | "erc20_total_supply"   // M1 issuance ceiling
    | "uint_getter"          // rate getter: rsETHPrice()/getRate()/exchangeRate() @rateDecimals
    | "uint_getter_with_arg" // convertToAssets(1e18)
    | "total_assets"         // totalAssets()/getTotalPooledEther() → underlyingNav
    | "struct_tuple_field";  // calculateTVLs() → tuple[fieldIndex] (gas-heavy)
  selector: `0x${string}`;   // ★ fn-name이 아니라 **4-byte selector 고정**(deterministic decode)
  arg?: `0x${string}`;       // uint_getter_with_arg: ABI-encoded arg (1e18 = 0x..0de0b6b3a7640000)
  fieldIndex?: number;       // struct_tuple_field
  holder?: string;           // balanceOf: lockbox 주소
  rateDecimals?: number;     // 기본 18
  role?: "escrow" | "rate" | "underlyingNav" | "ceiling";
  throttleSeconds?: number;  // gas-heavy backstop: now−last_ts>this 일 때만 실행 (기본 0=매폴)
}

export interface SupplyLeg {
  chain: string;
  token: string;             // ★ 고정 주소 — breadth DeFiLlama 발견 미사용. Alchemy/public RPC 직접 read.
  decimals: number;          // ★ per-leg decimals (lock-side ≠ mint-side 대응; USDT0=6)
}

export interface ConservationWatch {
  symbol: string;
  backingModel: BackingModel;
  issuanceCeilingMode: IssuanceCeilingMode;
  homeChain: string;                       // 보통 ethereum (getter Alchemy-readable)
  supplyChains: SupplyLeg[];               // Σ 합산 다리(고정 주소)
  circulating: "remotes" | "all";          // remotes=lock-mint(M2) · all=burn-mint(M1)
  backingReads: BackingRead[];             // role 로 escrow/rate/underlyingNav 구분
  tolBps: number;                          // 보존 허용밴드 (기본 50)
  armTolBps: number;                       // 자가검증 게이트 (기본 200)
  requireNavConfirm: boolean;              // M2-native: NAV가 발화의 필요조건
  confidence: "HIGH" | "MEDIUM" | "LOW";   // ★ 대문자 — fp-filters coverageGapVeto 호환
  feasible: "onchain_now" | "deferred";    // ★ 즉시 구현 가능 vs PoR/API 대기
  underlyingPriceFeed?: { chain: string; aggregator: string; selector: `0x${string}` } | { const: number };
                                           // ETH/USD Chainlink 등; const=1.0 (USD-peg)
  severity?: Partial<SeverityFloor>;       // override (기본은 RECOMMENDED_THRESHOLDS.supplyConservation)
}
```

**핵심 설계 결정:** issuance 의미론이 **엔진이 아니라 config 필드**(`issuanceCeilingMode`)에 노출 → 스키마가 더 이상 "rsETH-shaped"가 아니다. severity 디폴트는 `RECOMMENDED_THRESHOLDS.supplyConservation` 한 곳, watch는 override만.

---

## 3. 구체적 config rows

> 주소/selector는 라이브 검증(2026-06, 프로젝트 Alchemy 키). confidence는 주소+getter 확실성. ⚠️ wire 직전 공식 deployment 페이지 재대조(OFT redeploy·lookalike 리스크 실재).

```ts
export const CONSERVATION_WATCHES: ConservationWatch[] = [

  // ══ M2 ESCROW — rsETH (THE Kelp case) ══════════════════════════════════════
  // home<Σ 라이브 확인(549,285 < 595,813) → lock-mint. lockbox = readBridgeAuthority 로 발견,
  // 자가검증 게이트(|remoteSum−escrow|≤2%)가 통과해야 arm. lockbox는 오늘 ≈46,528 rsETH 보유해야 함.
  {
    symbol: "rsETH", backingModel: "escrow", issuanceCeilingMode: "escrow_lock",
    homeChain: "ethereum", circulating: "remotes", requireNavConfirm: false,
    supplyChains: [
      { chain: "base",     token: "0x1Bc71130A0e39942a7658878169764Bbd8A45993", decimals: 18 }, // HIGH (live 25,611)
      { chain: "arbitrum", token: "0x4186BFC76E2E237523CBC30FD220FE055156b41F", decimals: 18 }, // HIGH (live 20,917)
    ],
    backingReads: [
      // role:escrow — canonical rsETH(0xA1290d69…).balanceOf(OFT Adapter lockbox).
      // ⚠️ holder = readBridgeAuthority('0xA1290d69…','ethereum') 로 발견된 oft adapter/xERC20 lockbox.
      //    발견 실패 또는 자가검증 미통과 시 watch 미arm(아래 §4 calibration).
      { contract: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7", method: "balanceOf",
        selector: "0x70a08231", holder: "0x<RSETH_OFT_ADAPTER@eth — discover+calibrate>", role: "escrow" },
      // role:rate — LRTOracle.rsETHPrice() @1e18 (live=1.0737)
      { contract: "0x349A73444b1a310BAe67ef67973022020d70020d", method: "uint_getter",
        selector: "0xb4b46434", role: "rate", throttleSeconds: 0 },
    ],
    tolBps: 50, armTolBps: 200, confidence: "HIGH", feasible: "onchain_now",
    underlyingPriceFeed: { chain: "ethereum", aggregator: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", selector: "0xfeaf968c" }, // Chainlink ETH/USD latestRoundData
  },

  // ══ M2-native ESCROW — weETH (NAV backstop AUTHORITATIVE) ═══════════════════
  // home<Σ 라이브 확인(1,557,607 < 1,640,144). L2 네이티브 예치-mint 가능 → requireNavConfirm.
  {
    symbol: "weETH", backingModel: "escrow", issuanceCeilingMode: "escrow_lock",
    homeChain: "ethereum", circulating: "remotes", requireNavConfirm: true,
    supplyChains: [
      { chain: "base",     token: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", decimals: 18 }, // HIGH (live 28,387)
      { chain: "arbitrum", token: "0x35751007a407ca6feffe80b3cb397736d2cf4dbe", decimals: 18 }, // HIGH (live 54,150)
    ],
    backingReads: [
      { contract: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", method: "balanceOf",
        selector: "0x70a08231", holder: "0x<WEETH_BRIDGE_ADAPTER@eth — discover+calibrate>", role: "escrow" },
      // role:rate — weETH.getRate() @1e18 (live=1.0970)
      { contract: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", method: "uint_getter",
        selector: "0x679aefce", role: "rate", throttleSeconds: 0 },
      // role:underlyingNav — eETH LiquidityPool.getTotalPooledEther() (live=1,850,989), gas-적당 → 매폴
      { contract: "0x308861A430be4cce5502d0A12724771Fc6DaF216", method: "total_assets",
        selector: "0x37cfdaca", role: "underlyingNav", throttleSeconds: 0 },
    ],
    tolBps: 50, armTolBps: 200, confidence: "HIGH", feasible: "onchain_now",
    underlyingPriceFeed: { chain: "ethereum", aggregator: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", selector: "0xfeaf968c" },
  },

  // ══ M2 ESCROW — USDT0 (decimals=6! lock-side=USDT, mint-side=USDT0) ═════════
  // 즉시 추가 가능. wire 전 USDT.balanceOf(adapter) ≈ arb USDT0 totalSupply 확인(자가검증 게이트가 강제).
  {
    symbol: "USDT0", backingModel: "escrow", issuanceCeilingMode: "escrow_lock",
    homeChain: "ethereum", circulating: "remotes", requireNavConfirm: false,
    supplyChains: [
      { chain: "arbitrum", token: "0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92", decimals: 6 }, // HIGH (base 미배포; 배포 시 leg 추가 — §8)
    ],
    backingReads: [
      // role:escrow — USDT(0xdAC1…,6dp).balanceOf(OFT Adapter). lock-side decimals=6.
      { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", method: "balanceOf",
        selector: "0x70a08231", holder: "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee", role: "escrow" }, // ⚠️ wire 전 잔액 대조
    ],
    tolBps: 50, armTolBps: 200, confidence: "MEDIUM", feasible: "onchain_now",
    underlyingPriceFeed: { const: 1.0 },
  },

  // ══ M2 ESCROW — ezETH (DEFERRED: L2 주소·calculateTVLs 튜플 미검증) ══════════
  // home-only 등록(safe no-op). L2 주소 explorer 검증 + calculateTVLs fieldIndex eth_call 디코드 후 leg 추가.
  {
    symbol: "ezETH", backingModel: "escrow", issuanceCeilingMode: "escrow_lock",
    homeChain: "ethereum", circulating: "remotes", requireNavConfirm: true,
    supplyChains: [], // L2 검증 전까지 비움 → Σ=0, no-op (divide-by-zero 가드 §4)
    backingReads: [
      { contract: "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110", method: "balanceOf",
        selector: "0x70a08231", holder: "0x<EZETH_ADAPTER — discover>", role: "escrow" },
      // backstop: RestakeManager.calculateTVLs() tuple — fieldIndex 미검증 → eth_call 디코드 확정 후만 활성
      { contract: "0x6921C63fcF9796C9733690804e116be3520ba468", method: "struct_tuple_field",
        selector: "0x<calculateTVLs — verify>", fieldIndex: -1, role: "underlyingNav", throttleSeconds: 3600 },
    ],
    tolBps: 50, armTolBps: 200, confidence: "MEDIUM", feasible: "deferred",
  },

  // ══ M2 ESCROW — rETH (Rocket Pool, LayerZero OFT to L2) — DEFERRED(L2 주소 검증) ══
  // ETH-class, Aave/Morpho 담보 footprint 큼. home-only 출발, L2 leg 검증 후 추가.
  {
    symbol: "rETH", backingModel: "escrow", issuanceCeilingMode: "escrow_lock",
    homeChain: "ethereum", circulating: "remotes", requireNavConfirm: true,
    supplyChains: [], // L2 주소 검증 후 추가(base/arb rETH OFT)
    backingReads: [
      { contract: "0xae78736Cd615f374D3085123A210448E74Fc6393", method: "balanceOf",
        selector: "0x70a08231", holder: "0x<RETH_OFT_ADAPTER — discover>", role: "escrow" },
      // role:rate — rETH.getExchangeRate() (RocketTokenRETH) @1e18
      { contract: "0xae78736Cd615f374D3085123A210448E74Fc6393", method: "uint_getter",
        selector: "0xe6aa216c", role: "rate", throttleSeconds: 0 }, // ⚠️ selector eth_call 확인
    ],
    tolBps: 50, armTolBps: 200, confidence: "MEDIUM", feasible: "deferred",
    underlyingPriceFeed: { chain: "ethereum", aggregator: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", selector: "0xfeaf968c" },
  },

  // ══ M1 NAV — sUSDe / pufETH / swETH / rswETH / osETH / ETHx ═════════════════
  // ⚠️ 전부 backingModel 미확정(burn-through vs lock-mint 미검증). issuanceCeilingMode 부여 전
  //    토큰별 OFT 토폴로지 온체인 검증 필수 → 검증 전엔 home-only 등록(supplyChains=[]) = safe no-op.
  //    검증되면 lock-mint=escrow(대부분 예상)·burn-through=M1 로 배정. selector는 검증된 것만:
  //      sUSDe.convertToAssets(1e18) = 0x07a2d13a (live=1.2349) ; sUSDe.totalAssets()=0x01e1d114
  {
    symbol: "sUSDe", backingModel: "nav", issuanceCeilingMode: "home_total_supply",
    homeChain: "ethereum", circulating: "all", requireNavConfirm: true,
    supplyChains: [], // ★ L2 OFT 주소 + 토폴로지 미검증 → 비움(no-op). 검증 후 escrow/M1 재배정.
    backingReads: [
      { contract: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", method: "erc20_total_supply",
        selector: "0x18160ddd", role: "ceiling" },
      { contract: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", method: "uint_getter_with_arg",
        selector: "0x07a2d13a", arg: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000", role: "rate", throttleSeconds: 0 },
      { contract: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", method: "total_assets",
        selector: "0x01e1d114", role: "underlyingNav", throttleSeconds: 600 },
    ],
    tolBps: 50, armTolBps: 200, confidence: "MEDIUM", feasible: "deferred",
    underlyingPriceFeed: { const: 1.0 }, // terminal USD backing off-chain — supply-conservation만 유효
  },
  // pufETH/swETH/rswETH/osETH/ETHx/ankrETH: 위 sUSDe 와 동형으로 home-only 등록(supplyChains=[]),
  //   feasible:"deferred". 토폴로지 검증 시 escrow(lockbox)면 M2, burn-through면 M1 으로 leg+holder 추가.
  //   단일체인이면 보존 체크 no-op이나, 미래 L2 OFT mint 등장 시 즉시 잡히는 안전 동작.

  // ══ cbETH — info-only(NAV backstop만 읽힘, terminal USD=off-chain) — EXCLUDE from fire ══
  //   Base 공급은 cbETH.exchangeRate()(0x... 검증 필요)로 NAV 비교 가능하나 terminal backing off-chain →
  //   supply-conservation 발화 대상 아님. chain_supply_spike(info) 만으로 모니터.
];

// 명시적 EXCLUDE(영구, 문서화 — maintainer FP 방지):
//   USDC/PYUSD/EURC (CCTP·per-chain native mint → 보존 불변식 없음),
//   USDe-peg-backing (Ethena off-chain attestation), cbETH terminal USD (Coinbase 커스터디).
//   BTC-class(WBTC/tBTC/LBTC): 컨소시엄/커스터디 mint → 온체인 lock escrow 없음 → PoR 필요 → deferred(§8).
//   ERC4626 yield wrapper(sDAI/sUSDS): convertToAssets 패턴 동일하나 단일체인 위주 → 등장 시 sUSDe 동형 추가.
```

---

## 4. 탐지 알고리즘 (pseudocode)

```
MANAGED_KINDS = ["supply_conservation"]
SCAN_SOURCE   = "supply-conservation-v1"

main():
  if !DATABASE_URL: exit
  activeKeys = loadActiveAlertKeys(MANAGED_KINDS, SCAN_SOURCE)   # upsert.ts:328
  asserted  = new Set<string>()    # 평가완료-clean OR fire — resolve 후보 판단용
  skipped   = new Set<string>()    # 평가불가(데이터 무결성) — resolve 절대 금지
  for w in CONSERVATION_WATCHES:
     if w.feasible == "deferred" AND w.supplyChains.length == 0: continue   # no-op skip(로그만)
     try processWatch(w, activeKeys, asserted, skipped)
     catch e: log(e)   # 한 watch 실패가 전체를 막지 않음
  # ★ skip된 키는 resolve 후보에서 제외 — 살아있는 breach 를 데이터 일시부재로 auto-resolve 하지 않음
  resolveStaleAlerts(MANAGED_KINDS, union(asserted, skipped), SCAN_SOURCE)  # skipped 를 asserted 처럼 보존
  closePool()

processWatch(w, activeKeys, asserted, skipped):
  homeClient = clientFor(w.homeChain)                # eth → Alchemy
  if !homeClient: skipped.add(keyOf(w)); return

  # ── 0) divide-by-zero / no-op 가드 ──
  if w.supplyChains.length == 0: return              # home-only 등록 = 안전 no-op

  # ── 1) Σ supply — 고정 주소 직접 read(live), 노이즈만 quarantine ──
  #    ★ breadth/DeFiLlama 발견 미사용. config supplyChains[].token 을 직접 read.
  Σ = 0n; breakdown = {}
  for leg in w.supplyChains:
     if !isActiveChain(leg.chain): continue          # eth/base/arb 게이트
     live = readTotalSupply(clientFor(leg.chain), leg.token)   # Alchemy(eth/base/arb 전부 OK) → 실패 시 publicClientFor 폴백
     if live == null:
        live = readTotalSupply(publicClientFor(leg.chain), leg.token)   # ★ 이중화: publicnode 명시 폴백
     if live == null:
        # ── 코드 없는 주소(0/revert)와 RPC 다운 구분 ──
        if addrHasNoCode(leg.chain, leg.token): live = 0n    # 미배포 = Σ 기여 0 (정당)
        else:
           log "[supply-cons] {sym}: {leg.chain} live+public 둘 다 실패 — Σ-integrity skip"
           # ★ fail-OPEN toward backstop: 홈 NAV backstop 이 읽히면 known leg 로 reduced-confidence 평가 시도
           if backstopReadable(w, homeClient):
              partialEval(w, Σ_known, asserted, confidence="LOW", note="remote leg missing — NAV-only")
           skipped.add(keyOf(w)); return            # 그 외엔 watch skip(0 대체 금지)
     # ── 노이즈 컷: prior 샘플 대비 >100x 만 손상으로 거부(대형 점프는 통과!) ──
     prior = lastSample(`token:${w.symbol}`, leg.chain)
     if prior && (live > prior*100n || (live>0n && prior > live*100n)):
        log "scale-glitch reject"; skipped.add(keyOf(w)); return
     Σ += normalize(live, leg.decimals)              # ★ per-leg decimals
     breakdown[leg.chain] = live
     recordSample(`token:${w.symbol}`, leg.chain, live)   # 다음 폴 prior 비교용(quarantine은 detect 후 baseline 보류 패턴 미러)

  # ── 2) anchor + calibration(backingModel 분기) ──
  switch w.backingModel:
    case "escrow":   # M2 (Phase1)
       escrow = readBacking(homeClient, escrowReads(w))   # supply-backing.ts:67, 하나라도 실패→null
       if escrow == null: log skip; skipped.add(keyOf(w)); return
       remoteSum = Σ                                      # circulating="remotes": Σ는 이미 home 제외(supplyChains에 home 없음)
       # ★ 자가검증(calibration) 게이트 — lockbox 주소·모델 정합 확인. 미통과 시 arm 안 함.
       if abs(remoteSum − escrow) > escrow×armTolBps/1e4 AND remoteSum < escrow:
          # remoteSum 이 escrow 보다 *작은데* 2% 넘게 벌어짐 = lockbox 과대(주소 오류 의심) → log-only
          log "[supply-cons] {sym}: calibration fail (remoteSum {remoteSum} ≪ escrow {escrow}) — watch not armed"
          skipped.add(keyOf(w)); return
       excessTokens = remoteSum − escrow − escrow×tolBps/1e4
       anchor = escrow

    case "nav":      # M1 (현재 행 0 — 토폴로지 검증된 토큰만)
       ceiling = readUint(homeClient, ceilingRead(w))     # erc20_total_supply
       if ceiling == null: skipped.add(keyOf(w)); return
       excessTokens = Σ − ceiling − ceiling×tolBps/1e4
       anchor = ceiling

    case "home_issued": # M3 (Phase1 미배선)
       skipped.add(keyOf(w)); return

  # ── 3) NAV backstop(throttle, wall-clock) ──
  navExcess = null; navFresh = false
  navRead = readByRole(w,"rate"); navUnderlying = readByRole(w,"underlyingNav")
  if navRead AND (now − lastNavTs(w.symbol) > navRead.throttleSeconds):
     rate = readUint(homeClient, navRead)
     if rate==null OR stale(lastNavTs, heartbeatByClass.lst×stalenessFactor):
        log "stale/null NAV"      # backstop 미확증(escalate 안 함, supply-only 판단 유지 — 단 requireNavConfirm 면 아래서 강등)
     else:
        navFresh = true; setLastNavTs(w.symbol, now)
        if navUnderlying:
           underlyingNav = readUint(homeClient, navUnderlying)
           if underlyingNav != null:
              navExcess = (Σ×rate/1e18) − underlyingNav − underlyingNav×tolBps/1e4

  # ── 4) direction gate ──
  if excessTokens <= 0n: asserted.add(keyOf(w))?   # 평가완료-clean: resolve 허용(조건 해소) → asserted 에 안 넣음
     log "balanced/over-backed ✓"; return          # ★ clean 은 asserted 미추가 → resolveStaleAlerts 가 정리

  # ── 5) M2-native: NAV가 발화의 필요조건 ──
  if w.requireNavConfirm:
     if !(navFresh AND navExcess != null AND navExcess > 0n):
        # supply-excess 양수지만 NAV 미확증 → info/WATCH 강등(escalate 금지)
        emitInfoWatch(w, excessTokens, breakdown, note="awaiting NAV confirm"); asserted.add(keyOf(w)); return

  # ── 6) % + USD 이중축 severity ──
  p_bps = Σ>0n ? (excessTokens×10000n)/Σ : 0n
  underlyingUsd = readUnderlyingPrice(w.underlyingPriceFeed)   # ETH/USD Chainlink @home OR const 1.0
  rateF = navFresh ? rate : lastKnownRate(w.symbol) ?? 1e18    # 토큰단위→underlying
  usd = navFresh|rate? toUsd(excessTokens, rateF, underlyingUsd) : null   # ★ DEX price 절대 미사용
  # dust suppress: USD 미가용이면 USD축 fail-OPEN(dust 가 잘못 억제 못하게)
  usdForDust = (usd == null) ? +Inf : usd
  if usdForDust < dustUsd AND p_bps < dustPctBps: asserted; return

  sev = "info"
  # ★ NAV-anchored: % 축 단독으로 critical 도달 가능(시장가 폭락이 강등 못하게)
  if p_bps >= warnPctBps: sev = "warning"
  if p_bps >= critPctBps: sev = "critical"
  if usd != null:
     if usd >= warnUsd AND sev=="info": sev = "warning"
     if usd >= hardCapUsd: sev = "critical"
  if navExcess != null AND navExcess > 0n AND sev=="warning": sev = "critical"   # NAV 확증 승격

  # ── 7) persistence — DB·escalation-aware (in-memory streak 금지) ──
  key = `supply_conservation|${w.symbol}|chain:multi`
  # 첫 관측: info(WATCH) 로 insert. settlementSeconds 경과+여전히 breach 면 escalate.
  # 구현: insertAlert escalation-aware dedup 활용 — 동일 key info 가 settlementSeconds 보다 오래 active 면
  #       warning/critical 재삽입이 통과(sevRank 상승). 미경과면 info 로만(transient 1폴 damping).
  priorActiveTs = activeCreatedAt(activeKeys, key)
  if sev != "info" AND (priorActiveTs == null OR (now − priorActiveTs) < settlementSeconds):
     # corroboration 동반이면 first-poll 즉시 승격 허용(아래 8)
     if !corroboratedSamePoll(w): sev = "info"

  # ── 8) corroboration — d10/spike 동반 시 승격(48h 윈도) ──
  if exists(supply_single_mint OR chain_supply_spike on implicatedChain within 48h):
     # d10 이 이미 critical 잡았으면 confidence 승격 + persistence 우회(first-poll critical 허용)
     if sev != "critical" AND p_bps >= warnPctBps: sev = "critical"
     detail.corroboratedBy = [...]

  # ── 9) assert + insert ──
  asserted.add(key)
  if activeKeys.has(key) AND sevUnchanged(key, sev): return     # escalation-aware: 동일 sev 재삽입 skip
  insertAlert({                                                  # upsert.ts:265 (FP필터·dedup·dispatch)
     severity: sev, kind: "supply_conservation", token: w.symbol, protocolNodeId: "chain:multi",
     source: SCAN_SOURCE,
     message: `Σremote ${remoteSum} > escrow ${escrow} (초과 ${excessTokens}, ${p_bps}bps${usd?` / $${usd}`:""}; 허용 ${tolBps}bps) — 크로스체인 무담보 mint 의심`,
     detail: {
        backingModel: w.backingModel, issuanceCeilingMode: w.issuanceCeilingMode,
        Σ, escrow, anchor, excessTokens, p_bps, usd, navExcess, navFresh, breakdown,
        confidence: w.confidence,           # ★ 대문자(HIGH/MEDIUM/LOW) — coverageGapVeto 호환
        verifiableOnchain: w.feasible == "onchain_now",
        corroboratedBy: detail.corroboratedBy ?? null,
     },
  })
```

**FP 가드 ↔ 기존 패턴 매핑(전수):**

| FP/FN 모드 | 가드 | 미러하는 기존 패턴 |
|---|---|---|
| L2 RPC 1다리 실패 → Σ 오판 | live→public 이중화 read, 둘 다 실패 시 watch skip(0 대체 금지) + NAV backstop fail-OPEN | snapshot-backing.ts:113-122 + breadth rpcUrlsFor 폴백(route.ts:202) |
| 미배포 주소(코드 없음) | addrHasNoCode → Σ 기여 0(정당), skip 아님 | data-feasibility 리뷰어 요구(leg-absent vs RPC-down 구분) |
| **median 평활화로 대형 점프 묵살** | **current(live) read 비교, >100x만 손상 거부** | chain-supply.ts:96-110 suspect-UP=탐지 수행·baseline만 quarantine |
| **lockbox 주소 오류/모델 오분류** | **calibration 게이트(\|remoteSum−escrow\|≤armTolBps), 미통과 시 미arm** | generalization 리뷰어 요구; readBridgeAuthority 로 발견 |
| 스테이킹 리워드/리베이스 NAV 성장 | over-backed=safe=null(direction gate) + live NAV | evaluateBacking deficit≤0→null(supply-backing.ts:106) |
| **weETH L2 네이티브 예치-mint** | **requireNavConfirm: navExcess>0 가 필요조건, NAV 미확증 시 info 강등** | fp-robustness 리뷰어 요구 |
| 디페그≠무담보 | NAV oracle rate만, **DEX/DeFiLlama price 미사용**, ETH/USD는 Chainlink | CLAUDE.md 도메인 규칙1 |
| **USD축이 % breach 강등** | **NAV-anchored는 % 축 단독 critical, USD 미가용 시 dust fail-OPEN** | kelp-recall 리뷰어 요구 |
| NAV staleness/revert | fail-CLOSED(heartbeat×1.75 초과→backstop 미확증; requireNavConfirm이면 info 강등) | oracle.heartbeatByClass.lst × stalenessFactor=1.75(thresholds:222) |
| **throttle 무력화(pollCount=0)** | **wall-clock: now−lastNavTs>throttleSeconds(DB)** | fp-robustness 리뷰어; cron 프로세스 매폴 재spawn |
| **persistence streak 미구현** | **DB escalation-aware: info→(settlementSeconds 경과)→warning/critical** | upsert.ts:290-305 dedup escalation |
| **resolve-on-skip 깜빡임** | **skipped 키를 resolve 후보에서 제외(asserted∪skipped 전달)** | fp-robustness 리뷰어 요구; resolveStaleAlerts(upsert.ts:339) |
| **confidence 대소문자 불일치** | **detail.confidence 대문자 기록** | fp-filters.ts:138 coverageGapVeto |
| **undiscovered chain(EOA mint, 풀 없음)** | **config 고정 주소 직접 read(breadth 발견 미의존)** | data-feasibility/generalization 리뷰어 요구 |
| decimals 불일치(lock≠mint) | per-leg decimals(SupplyLeg.decimals), USDT0=6 | generalization 리뷰어 요구 |
| 단일체인 home-only | supplyChains=[] → no-op, p_bps divide-by-zero 가드 | missing 항목 요구 |
| 정보과잉/마스킹 | escalation-aware dedup(새 sev>기존만 재발화) | upsert.ts:290-305 |
| **wstETH 이중발화** | **신규 detector는 wstETH 미등록(Detector A 잔류)** | §6 소유권 분리 |

---

## 5. 데이터 소스 (라이브 검증)

**Σ supply(체인별 totalSupply) — 고정 주소 직접 read:**
- ethereum/base/arbitrum 모두 **Alchemy eth_call 정상**(2026-06 라이브 검증, 403 없음). 1차 `clientFor(chain)`(Alchemy) → 실패 시 `publicClientFor(chain)`(publicnode 명시) 폴백.
- ★ `chain_supply_samples`/breadth API는 **prior-sample 비교(>100x 거부)와 cross-check용으로만** 사용. Σ 합산값은 항상 **config 고정 주소의 live read**(breadth의 DeFiLlama 풀 발견에 의존 금지 — EOA mint·풀 없는 체인도 카운트).

**Backing/NAV getter(전부 홈=ethereum → Alchemy-readable, selector 라이브 검증):**

| 토큰 | model | escrow(role:escrow) | rate(role:rate) selector | underlyingNav(role:underlyingNav) | feasible |
|---|---|---|---|---|---|
| rsETH | escrow | rsETH(0xA1290d69…).balanceOf(OFT adapter ★discover) | `rsETHPrice()` 0xb4b46434 @LRTOracle(0x349A…) =1.0737 | (backstop 선택) | onchain_now |
| weETH | escrow+navConfirm | weETH(0xCd5f…).balanceOf(bridge adapter ★discover) | `getRate()` 0x679aefce =1.0970 | `getTotalPooledEther()` 0x37cfdaca @eETH LP(0x3088…) =1,850,989 | onchain_now |
| USDT0 | escrow | USDT(0xdAC1…,6dp).balanceOf(adapter 0x6C96…) | — | — | onchain_now (⚠️ 잔액 대조) |
| ezETH | escrow+navConfirm | ezETH(0xbf54…).balanceOf(adapter ★discover) | rate provider | `calculateTVLs()` ★fieldIndex 미검증 | deferred |
| rETH | escrow+navConfirm | rETH(0xae78…).balanceOf(OFT adapter ★discover) | `getExchangeRate()` 0xe6aa216c ⚠️확인 | — | deferred |
| sUSDe | nav/escrow ★미정 | (토폴로지 검증 후) | `convertToAssets(1e18)` 0x07a2d13a =1.2349 | `totalAssets()` 0x01e1d114 | deferred |
| pufETH/swETH/rswETH/osETH/ETHx/ankrETH | ★미정 | (토폴로지 검증 후) | (검증된 것만) | — | deferred |

**USD 사이징:** `usd = excessTokens × rate × underlyingAssetPriceUsd`. `underlyingAssetPriceUsd`는 홈 체인 Chainlink ETH/USD(`0x5f4eC3Df…`, `latestRoundData()` 0xfeaf968c, answer/1e8) 또는 USD-peg const 1.0. **토큰 자체 DEX/DeFiLlama 가격 절대 미사용**(CLAUDE.md 규칙1 + 익스플로잇 중 시장가 폭락이 USD를 과소산정해 critical을 강등시키는 것 방지).

**lockbox 발견:** `readBridgeAuthority(canonicalToken, 'ethereum')`(bridge-authority.ts:89)가 `oft_peer`/xERC20 lockbox/MINTER_ROLE를 온체인 enumerate. 발견된 adapter 후보에 `balanceOf`를 걸고 **calibration 게이트**가 통과하는 것을 holder로 채택. 발견 실패 시 watch 미arm(log-only) — silent guess 금지.

---

## 6. 통합 계획

**신규 파일:**
- 라이브러리 `automation/src/snapshot/supply-conservation.ts` — 타입, `CONSERVATION_WATCHES`, 순수 함수 `evaluateConservation()`(escrow/nav/home_issued 분기, evaluateBacking 형태 미러), `readNav()`/`readUintGetter()`/`readStructField()`(★신규 — reflexivity.ts는 타입 분류만 하고 rate를 read하지 않으므로 신규 작성), `calibrateWatch()`.
- 러너 `automation/scripts/snapshot-supply-conservation.ts` — RPC 캐싱(snapshot-backing.ts:23-31 복사), main()/processWatch(), DATABASE_URL 체크·try/catch·closePool.

**신규 alert kind: `supply_conservation`**(이름 충돌 해소: METHOD blob의 `unbacked_conservation`보다 PATTERNS blob의 `supply_conservation`가 frontend/threshold 전반에 일관 → 채택).

**소유권 분리(이중발화 방지):**
- **wstETH·USDT0의 M2 권위는 명시 분리.** wstETH는 **Detector A(BACKING_WATCHES) 잔류, 신규 detector에 미등록**. USDT0는 **신규 detector가 소유**(BACKING_WATCHES에 추가하지 않음). source 문자열이 달라도(`builtin-v1` vs `supply-conservation-v1`) 같은 토큰을 양쪽이 들면 두 행이 생기므로, 토큰별 단일 소유를 규약으로 고정.

**STATE-type wiring:**
```ts
const MANAGED_KINDS = ["supply_conservation"];
const SCAN_SOURCE   = "supply-conservation-v1";
// main 시작:  const activeKeys = await loadActiveAlertKeys(MANAGED_KINDS, SCAN_SOURCE);   (upsert.ts:328)
// main 끝:    await resolveStaleAlerts(MANAGED_KINDS, new Set([...asserted, ...skipped]), SCAN_SOURCE); (upsert.ts:339)
//             ★ skipped 합집합 — 데이터 부재로 살아있는 breach 를 resolve 하지 않음
```
프론트 `STATE_KINDS`(alert-kinds.ts:138)에 `"supply_conservation"` 추가. ★ 단 현재 STATE_KINDS에 형제 `unbacked_supply`/`chain_supply_spike`가 **없다** — 이는 의도된 divergence임을 명시(supply_conservation은 조건 지속형이고 backend가 resolveStaleAlerts로 해소하므로 24h fade 제외가 맞다). 동시에 `unbacked_supply`도 조건형이므로 STATE_KINDS 편입을 후속 과제로 기록(현 PR 범위 밖).

**cron 등록**(cron.ts backingLoop 패턴, **15분 cadence** — 가벼운 read라 1h보다 촘촘하게 해 첫-폴 latency 완화):
```ts
async function supplyConservationLoop() {
  const ts = new Date().toISOString();
  console.log(`\n══════ ${ts} — supply conservation (크로스체인 무담보 mint) ══════`);
  try { await runScript("snapshot-supply-conservation.ts"); }
  catch (e) { console.error("[cron] supply-conservation failed:", (e as Error).message); }
}
setInterval(supplyConservationLoop, 15 * 60 * 1000);   // 15분 — escrow read는 가벼움. 첫-폴 latency 완화
kickAfter(13 * 60 * 1000, supplyConservationLoop);     // backing(6m)·chainsupply 뒤(prior-sample 채워진 후)
```
> cadence를 15분으로 한 근거: persistence settlementSeconds=1800(30분)이 ~2폴이 되어, 무담보 mint가 30분 지속하면 escalate(uncorroborated 경로의 latency floor를 1h→30분으로). corroborated(동반 d10/spike) 경로는 first-poll 즉시 critical.

**threshold block**(alert-thresholds.ts):
```ts
supplyConservation: {
  toleranceBps: 50, armToleranceBps: 200,
  warnPctBps: 100, critPctBps: 200,          // % 축 — NAV-anchored 단독 critical 가능
  warnUsd: 1_000_000, critUsd: 10_000_000, hardCapUsd: 50_000_000,
  dustUsd: 1_000_000, dustPctBps: 100,
  settlementSeconds: 1800, persistencePolls: 2,
  navThrottleSecondsDefault: 600,
},
```

**frontend 등록**(alert-kinds.ts):
```ts
KIND_LABEL: supply_conservation: "교차체인 공급 불일치",
CATEGORY:   supply_conservation: "minting",
STATE_KINDS: 추가 "supply_conservation",
```
★ 드리프트 방지 테스트: `supply_conservation`이 KIND_LABEL·CATEGORY·STATE_KINDS 세 맵에 모두 존재함을 assert.

**참조 패턴 파일포인터:** Σ-integrity/health gate/RPC 캐싱=snapshot-backing.ts; live-detect+baseline-quarantine=snapshot-chain-supply.ts:96-110; lockbox 발견=bridge-authority.ts:89; state auto-resolve=upsert.ts:328-349; dedup escalation=upsert.ts:290-305; coverageGapVeto=fp-filters.ts:138.

---

## 7. Kelp 백테스트 트레이스 (M2/escrow — 정정판)

**A. 무단 mint에서 발화함 (arbitrum +116,500 rsETH):**

정상 직전(라이브 측정 기반):
```
escrow   = rsETH.balanceOf(OFT_adapter@eth) ≈ 46,528   (= 오늘 L2합과 일치, calibration 통과)
base     = 25,611 ; arbitrum = 20,917 → remoteSum = 46,528
unbackedExcess = 46,528 − 46,528 − (46,528×0.005=233) = −233  ≤ 0  → null (정상)
calibration: |46,528 − 46,528| = 0 ≤ 46,528×2% ✓  → watch armed
```
침해 DVN이 arbitrum에 116,500 rsETH 무단 mint(홈 lock 증가 無 → escrow 불변):
```
escrow   = 46,528  (불변 — 무단 mint는 lock을 동반하지 않음)
arbitrum = 20,917 + 116,500 = 137,417
remoteSum = 25,611 + 137,417 = 163,028
unbackedExcess = 163,028 − 46,528 − 233 = +116,267 rsETH  > 0  → FIRE
p_bps = 116,267 / 163,028 = 7,131bps (71.3%)  ≫ critPctBps 200(2%) → % 단독 critical
rsETHPrice 1.0737, ETH≈$3,300(Chainlink) → navPriceUsd ≈ $3,543
usd = 116,267 × $3,543 ≈ $412M  ≫ hardCapUsd $50M
→ severity = critical (% 단독으로도 critical; USD 무관)
NAV backstop(보조): Σ×rate vs underlyingNav → navExcess>0 확증(rsETH는 requireNavConfirm=false라 필수 아님)
persistence: 침해 mint 영속 → settlementSeconds(1800s/15분×2폴) 후 escalate
corroboration: 같은 폴 chain_supply_spike(arbitrum rsETH +35%↑) + d10 supply_single_mint(단일 mint ≥5%) 동반
   → first-poll 즉시 critical(persistence 우회) + confidence 승격
```
**결과: `supply_conservation` / rsETH / critical, ≈$412M 무담보.** d10이 이벤트(단일 mint)를 잡고, 이 detector가 **mint 로그가 윈도 밖으로 사라진 뒤에도 standing critical을 유지**(state-level 보완). 분할(5%미만 다건) mint도 누적 remoteSum으로 동일 발화.

**B. 합법 스테이킹 리워드/리베이스에서 발화 안 함:**
```
리워드로 rsETHPrice 1.0737→1.085 상승, L2 공급은 브릿지로만 변동(lock 동반).
정상 브릿지: 사용자가 eth→arb 브릿지 = adapter lock +X, arb mint +X → escrow +X, remoteSum +X → excess 불변
unbackedExcess = (remoteSum+X) − (escrow+X) − slack < 0 → null
NAV 상승은 over-backed 방향(navExcess<0). direction gate(excess≤0→null)에서 걸림. ⇒ FP 없음.
```

**C. weETH 합법 L2 네이티브 예치-mint에서 발화 안 함(requireNavConfirm):**
```
L2 예치-mint로 remoteSum 이 escrow 를 일시 초과(supply-excess>0).
하지만 그 예치는 실제 ETH backing 동반 → navExcess ≤ 0 (Σ×getRate ≤ getTotalPooledEther).
requireNavConfirm: navExcess>0 가 필요조건 → 미충족 → info/WATCH 강등(critical 스팸 없음).
무단 mint(backing 無)면 navExcess>0 → 정상 발화. ⇒ 합법 예치 FP 제거 + 무담보 catch 유지.
```

---

## 8. 한계 & 롤아웃

**즉시(onchain_now, FP-safe):**
- **rsETH(escrow)** — THE Kelp case. lockbox만 `readBridgeAuthority`로 발견+calibration. confidence HIGH.
- **weETH(escrow+navConfirm)** — lockbox 발견 필요, NAV backstop 권위. HIGH.
- **USDT0(escrow, decimals=6)** — adapter 잔액 wire 전 대조(calibration이 강제). MEDIUM.
- (wstETH는 Detector A 잔류 — 신규 detector 미등록.)

**deferred(검증 후):**
- **ezETH** — L2 주소 explorer 검증 + `calculateTVLs()` selector·튜플 fieldIndex eth_call 디코드 확정. 현재 home-only no-op.
- **rETH** — L2 OFT 주소 검증 + `getExchangeRate()` selector 확인. home-only no-op.
- **sUSDe/pufETH/swETH/rswETH/osETH/ETHx/ankrETH** — ★토폴로지 검증 필수(lock-mint면 escrow, burn-through면 M1). 검증 전 home-only(supplyChains=[]) no-op. selector 검증된 것만 기재(sUSDe convertToAssets 0x07a2d13a 확인됨).

**API/PoR/오프체인(현재 불가, EXCLUDE 또는 deferred):**
- **CCTP/네이티브-멀티민트 스테이블(USDC·PYUSD·EURC)** — 보존 불변식 자체가 없음(체인별 네이티브 mint). **영구 EXCLUDE**, info-level chain_supply_spike만. (generalization 리뷰어가 정확히 물은 부분 — 정직하게 범위 밖.)
- **BTC-class(WBTC·tBTC·LBTC)** — 컨소시엄/커스터디 mint → 온체인 lock escrow 없음 → **PoR 필요 → deferred**(현 설계 불가).
- **USDe/sUSDe terminal USD backing, cbETH** — off-chain attestation/커스터디 → supply-conservation(체인간 공급 보존)만 유효, **terminal USD solvency는 범위 밖**. cbETH는 Base 공급을 exchangeRate로 NAV 비교는 가능하나 발화 대상 아님(info만).
- **M3(home_issued)** — reconcile ledger가 누적 발행 복원 불가 + USDE NATIVE_ISSUANCE_SKIP → **선결(append-only 발행 카운터 신설 또는 chain_supply_samples 홈행 델타) 후 future work.**

**Etherscan PRO 불필요:** 설계는 totalSupply/balanceOf/NAV getter eth_call + Chainlink read만 사용(전부 Alchemy/public RPC). lockbox 발견의 BridgeLimitsSet/Transfer 로그는 bridge-authority.ts의 publicnode bounded getLogs로 충분(깊은 과거 필요 시 ARCHIVE_RPC_URL 옵션).

**단계적 롤아웃:**
1. **Phase 1(즉시)**: rsETH·weETH·USDT0 escrow 빌드. lockbox 발견+calibration arm. **1주 shadow(info 강제)**로 FP 관찰(observe-alerts.ts → fp-audit/observe.jsonl). 15분 cron, 13분 kick.
2. **Phase 2**: shadow 통과 시 warning/critical 해제. ezETH/rETH L2 주소·selector 검증 후 leg 추가, NAV backstop(calculateTVLs throttle=3600s) 활성.
3. **Phase 3**: sUSDe 외 LST/LRT 토폴로지 검증 → escrow/M1 배정. M3 발행 카운터 선결 시 USDe corroboration 경로.

**잔여 blind spot:**
- **lockbox 주소 발견 의존**: `readBridgeAuthority`가 oft_peer는 잡지만 adapter lock 잔액 주소를 항상 단일로 주지는 않음 → calibration 게이트가 안전망(틀리면 미arm). 발견 실패 토큰은 자동 home-only no-op.
- **USDT0 base 배포**: 현재 미배포(arb-only). base 배포 시 leg 추가 누락하면 remoteSum 과소 → calibration이 잡아냄(escrow보다 remoteSum 작아짐 → not armed 또는 단순 미발화, safe 방향).
- **MEDIUM/deferred 주소**: wire 전 공식 deployment 재대조(OFT redeploy·lookalike). confidence는 detail에 대문자로 기록되어 coverageGapVeto가 자동으로 suppression 비활성(annotate-only).
- **프로젝트 메모리 'alchemy-app-eth-only' 갱신 필요**: base/arb eth_call이 라이브에서 정상 동작하므로 해당 메모리는 stale. (이 설계는 그래도 publicnode 폴백을 이중으로 둬 키가 다시 eth-only로 회귀해도 안전.)

---

**검증한 파일(절대경로):**
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/automation/src/snapshot/supply-backing.ts` (readBacking:67, readTotalSupply:87, evaluateBacking:99, BACKING_WATCHES:128 — wstETH만)
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/automation/src/config/chains.ts` (ACTIVE_CHAINS:84, isActiveChain:85, evmRpcUrl:90-98, EVM_CHAINS publicRpc:59-61)
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/automation/src/snapshot/fp-filters.ts` (coverageGapVeto:137-139 — **대문자 MEDIUM/LOW**, applyFpFilters:145, SEED_REBASE:197)
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/automation/src/lib/bridge-authority.ts` (readBridgeAuthority:89, OFT peers:136-148, xERC20 lockbox:102-120, MINTER_ROLE:122-134 — lockbox 발견 인프라)
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/automation/src/snapshot/mint-burn-recon.ts` (reconcile:94-120 — **매칭/stale 행 삭제 = 누적 복원 불가**, NATIVE_ISSUANCE_SKIP 주석:27-30, isAllowlistedRecipient:34)
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/automation/scripts/snapshot-chain-supply.ts` (recentSamples:55, **live-detect+quarantine:96-110**, robust-z:123-153)
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/automation/src/db/upsert.ts` (insertAlert:265, escalation-aware dedup:290-305, loadActiveAlertKeys:328, resolveStaleAlerts:339 — **asserted 미포함 키 auto-resolve**)
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/frontend/lib/alert-kinds.ts` (KIND_LABEL:10, CATEGORY:48, STATE_KINDS:138 — unbacked_supply 미포함)
- `/Users/songmyeonghun/Desktop/upside_academy/Chain_Spiral/risk-exposure-monitoring/frontend/app/api/breadth/[symbol]/route.ts` (tokenAddrByChain:446-455 **DeFiLlama 풀 발견**, ADDR_OVERRIDES:37, rpcUrlsFor:202 Alchemy→publicnode, callTotalSupply:208)

**온체인 라이브 검증값(2026-06, 프로젝트 Alchemy 키):**
- rsETH totalSupply: eth=549,285 / base=25,611 / arb=20,917 → Σ=595,813, **home<Σ(차 −46,528=L2합) ⇒ lock-mint(M2 확정)**
- weETH totalSupply: eth=1,557,607 / base=28,387 / arb=54,150 → Σ=1,640,144, **home<Σ(차 −82,537=L2합) ⇒ lock-mint+native(M2-navConfirm)**
- **Alchemy base/arb eth_call 정상(403 없음) ⇒ 'alchemy-app-eth-only' 메모리 stale**
- selector 검증: rsETHPrice() 0xb4b46434=1.0737 / weETH getRate() 0x679aefce=1.0970 / eETH getTotalPooledEther() 0x37cfdaca=1,850,989 / sUSDe convertToAssets(1e18) 0x07a2d13a=1.2349. `rsETH.endpoint()`·`getRoleMemberCount(MINTER_ROLE)` **revert ⇒ home 토큰은 plain ERC20, OFT Adapter는 별도 컨트랙트(lockbox)**