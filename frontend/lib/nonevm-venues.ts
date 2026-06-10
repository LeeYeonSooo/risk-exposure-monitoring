/**
 * 비-EVM 체인의 검증된 장소(venue) 레지스트리 — 각 어댑터의 카운터파티 라벨 근거.
 * 전 항목은 해당 프로토콜의 공식 문서/공식 깃헙(또는 공식 Move Registry)에서 검증된 것이며
 * (2026-06-10, 출처는 리서치 워크플로 wq25xd61o 기록), 탐색기 라벨 단독 항목은 제외했다.
 * 예외 2건(Aries·Cellana)은 온체인 모듈 셋이 공식 오픈소스 리포와 정확히 일치함을 확인하고 포함.
 * 등재되지 않은 장소의 전송은 라벨 없이 "전송"으로 표시 — 추측 라벨 0 원칙.
 * label 은 DeFiLlama 프로토콜 슬러그와 맞춰 그래프 노드로 입자가 흐르게 한다.
 */
export interface Venue {
  address: string; // tron: T-base58 / starknet: felt hex / aptos: 모듈 계정 / sui: 패키지 ID(원본+현행 세트)
  label: string;
  kind: "swap" | "lend" | "stake";
}

export const TRON_VENUES: Venue[] = [
  { address: "TNJVzGqKBWkJxJB5XYSqGAwUTV15U24pPq", label: "sunswap", kind: "swap" }, // SunSwap V2 Router (current, deployed 2026-01-06) [official-doc]
  { address: "TXF1xDbVGdxFGbovmmmXvBGu8ZiE3Lq4mR", label: "sunswap", kind: "swap" }, // SunSwap V2 Router02 (DEPRECATED per docs; 2024-09 to ~2025-12, 4.2M tx [official-doc]
  { address: "TMmRKgwC1hx4azzkXoPzujgQThzF48Actq", label: "sunswap", kind: "swap" }, // SunSwap V2 Router (DEPRECATED interim, deployed 2025-12-28) [official-doc]
  { address: "TQAvWQpT9H916GckwWDJNhYZvQMkuRL7PN", label: "sunswap", kind: "swap" }, // SunSwap V3 Router (SwapRouter) [official-doc]
  { address: "TGnC7LMji8hBpyvZt1TTEJhVpAZ5HFyJ3r", label: "sunswap", kind: "swap" }, // SUN.io Smart Router (SmartExchangeRouter, current, deployed 2025-12-28 [official-doc]
  { address: "TJ4NNy8xZEqsowCBhLvZ45LCqPdGjkET5j", label: "sunswap", kind: "swap" }, // SUN.io Smart Router (DEPRECATED per docs; 2024-09 deployment, 1.29M tx [official-doc]
  { address: "TFVisXFaijZfeyeSjCEVkHfex7HGdTxzF9", label: "sunswap", kind: "swap" }, // SUN.io Smart Router (DEPRECATED per docs) [official-doc]
  { address: "TCFNp179Lg46D16zKoumd4Poa2WFFdtqYj", label: "sunswap", kind: "swap" }, // SUN.io Smart Router (DEPRECATED per docs) [official-doc]
  { address: "TSJEtPuqHpvSaVnSwvCsngaeBxrGUzp95Q", label: "sunswap", kind: "swap" }, // SUN.io UniversalRouter (current main swap entry, deployed 2025-12-28) [official-doc]
  { address: "TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br", label: "sunswap", kind: "swap" }, // SunSwap V4 PoolManager (singleton; custodies all v4 pool funds) [official-doc]
  { address: "TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7", label: "justlend", kind: "lend" }, // JustLend DAO Unitroller (Comptroller proxy/entrypoint - events emit he [official-doc]
  { address: "TE2RzoSV3wFK99w6J9UnnZ4vLfXYoxvRwP", label: "justlend", kind: "lend" }, // jTRX (TRX market) [official-doc]
  { address: "TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd", label: "justlend", kind: "lend" }, // jUSDT (USDT market) [official-doc]
  { address: "TNSBA6KvSvMoTqQcEgpVK7VhHT3z7wifxy", label: "justlend", kind: "lend" }, // jUSDCOLD (USDC market - LEGACY; the only USDC market, no active one ex [official-doc]
  { address: "TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf", label: "justlend", kind: "lend" }, // jUSDD (USDD market) [official-doc]
  { address: "TBEKggwqFkrc4KckQVR9BLucAmQugafEZf", label: "justlend", kind: "lend" }, // jUSD1 (USD1 market) [official-doc]
  { address: "TSXv71Fy5XdL3Rh2QfBoUu3NAaM4sMif8R", label: "justlend", kind: "lend" }, // jTUSD (TUSD market) [official-doc]
  { address: "TD5SdLw5scR6mXgyMK2xKrFJpauDjpKqrW", label: "justlend", kind: "lend" }, // jwstUSDT (wstUSDT market) [official-doc]
  { address: "TJQ9rbVe9ei3nNtyGgBL22Fuu2xYjZaLAQ", label: "justlend", kind: "lend" }, // jsTRX (sTRX market) [official-doc]
  { address: "TLeEu311Cbw63BcmMHDgDLu7fnk9fqGcqT", label: "justlend", kind: "lend" }, // jBTC (BTC market) [official-doc]
  { address: "TVyvpmaVmz25z2GaXBDDjzLZi5iR5dBzGd", label: "justlend", kind: "lend" }, // jWBTC (WBTC market) [official-doc]
  { address: "TR7BUFRQeq1w5jAZf1FKx85SHuX6PfMqsV", label: "justlend", kind: "lend" }, // jETH (ETH market) [official-doc]
  { address: "TWBxQMb6RD3qmkXUXpNwVCYbL8SHNreru6", label: "justlend", kind: "lend" }, // jETHB (ETHB market) [official-doc]
  { address: "TWQhCXaWz4eHK4Kd1ErSDHjMFPoPc9czts", label: "justlend", kind: "lend" }, // jJST (JST market) [official-doc]
  { address: "TRg6MnpsFXc82ymUPgf5qbj59ibxiEDWvv", label: "justlend", kind: "lend" }, // jWIN (WIN market) [official-doc]
  { address: "TFpPyDCKvNFgos3g3WVsAqMrdqhB81JXHE", label: "justlend", kind: "lend" }, // jNFT (NFT market) [official-doc]
  { address: "TUaUHU9Dy8x5yNi1pKnFYqHWojot61Jfto", label: "justlend", kind: "lend" }, // jBTT (BTT market) [official-doc]
  { address: "TPXDpkg9e3eZzxqxAUyke9S4z4pGJBJw9e", label: "justlend", kind: "lend" }, // jSUN (SUN market) [official-doc]
  { address: "TDA1mWPyAjTRATMGA55UTswGAHhV2itEXR", label: "justlend", kind: "lend" }, // jHTX (HTX market) [official-doc]
  { address: "TGBr8uh9jBVHJhhkwSJvQN2ZAKzVkxDmno", label: "justlend", kind: "lend" }, // jSUNOLD (LEGACY) [official-doc]
  { address: "TLHASseQymmpGQdfAyNjkMXFTJh8nzR2x2", label: "justlend", kind: "lend" }, // jBUSDOLD (LEGACY) [official-doc]
  { address: "TX7kybeP6UwTBRHLNPYmswFESHfyjm9bAS", label: "justlend", kind: "lend" }, // jUSDDOLD (LEGACY) [official-doc]
  { address: "TL5x9MtSnDy537FXKx53yAaHRRNdg9TkkA", label: "justlend", kind: "lend" }, // jUSDJ (LEGACY, closed) [official-doc]
  { address: "TUY54PVeH6WCcYCd6ZXXoBDsHytN9V5PXt", label: "justlend", kind: "lend" }, // jWBTT (LEGACY, closed) [official-doc]
  { address: "TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5", label: "justlend", kind: "lend" }, // JustLend sTRX (Staked TRX - official TRX staking venue) [official-doc]
  { address: "TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz", label: "usdd", kind: "swap" }, // USDD PSM (UsddPsm / MCD_PSM_USDT_A - the swap module users call) [official-doc]
  { address: "TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ", label: "usdd", kind: "swap" }, // USDD PSM USDT GemJoin (AuthGemJoin5 / JOIN_PSM_USDT_A - custodies USDT [official-doc]
  { address: "TXdYNjXaHn3c1whomRpzCkaFbjfCffMFGf", label: "usdd", kind: "swap" }, // USDD Smart Allocator vault SA001-A (yield allocation venue) [official-doc]
];

// 앱토스: entry_function_id_str 의 모듈 계정 주소와 비교 (선행 0 트리밍 → BigInt 정규화 필수)
export const APTOS_VENUES: Venue[] = [
  { address: "0x48271d39d0b05bd6efca2278f22277d6fcc375504f9839fd73f74ace240861af", label: "thalaswap", kind: "swap" }, // ThalaSwap v1 (weighted/stable pools + entry scripts) [github-repo]
  { address: "0x007730cd28ee1cdc9e999336cbc430f99e7c44397c0aa77516f6f23a78559bb5", label: "thalaswap", kind: "swap" }, // ThalaSwap v2 (FA-based AMM, pool + coin_wrapper) [github-repo]
  { address: "0x6a48c1554aa54128ea7acdea6d627cda9914f4a7ffd4c7aee3432b6043291938", label: "thalaswap", kind: "swap" }, // ThalaSwap CLAMM (current deployment, 2025-09-29 resource account) [github-repo]
  { address: "0x6f986d146e4a90b828d8c12c14b6f4e003fdff11a8eecceceb63744363eaac01", label: "thala-cdp", kind: "lend" }, // Thala CDP / Move Dollar (ThalaProtocol, PSM v2) [github-repo]
  { address: "0xc7efb4076dbe143cbcd98cfaaa929ecfc8f299203dfff63b95ccb6bfe19850fa", label: "pancakeswap", kind: "swap" }, // PancakeSwap Aptos (pancake::swap core + pancake::router entry, same ac [official-doc]
  { address: "0x190d44266241744264b964a37b8f09863167a12d3e70cda39376cfb4e3561e12", label: "liquidswap", kind: "swap" }, // LiquidSwap v0 (Pontem; entries via scripts/scripts_v2/router_v2 at sam [official-doc]
  { address: "0x0163df34fccbf003ce219d3f1d9e70d140b60622cb9dd47599c25fb2f797ba6e", label: "liquidswap", kind: "swap" }, // LiquidSwap v0.5 (Pontem; entries via ::scripts) [official-doc]
  { address: "0x54cb0bb2c18564b86e34539b9f89cfe1186e39d89fce54e1cd007b8e61673a85", label: "liquidswap", kind: "swap" }, // LiquidSwap v1 (Pontem concentrated liquidity / liquidity-bin; entries  [official-doc]
  { address: "0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3", label: "aries-markets", kind: "lend" }, // Aries Markets (entries via ::controller deposit/withdraw; on-chain mod [explorer-label-only]
  { address: "0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a", label: "amnis-finance", kind: "stake" }, // Amnis Finance (amAPT/stAPT; entries via ::router e.g. deposit_and_stak [official-doc]
  { address: "0xc6bc659f1649553c1a3fa05d9727433dc03843baac29473c817d06d39e7621ba", label: "echelon", kind: "lend" }, // Echelon Market main pool (entries via ::lending and ::scripts) [official-doc]
  { address: "0x4bf51972879e3b95c4781a5cdcb9e1ee24ef483e7d22f2d903626f126df62bd1", label: "cellana", kind: "swap" }, // Cellana Finance (ve(3,3) DEX; router + liquidity_pool + cellana_token  [explorer-label-only]
  { address: "0x5ae6789dd2fec1a9ec9cccfb3acaf12e93d432f0a3a42c92fe1a9d490b7bbc06", label: "merkle-trade", kind: "swap" }, // Merkle Trade (perps; entries via ::managed_trading / ::router; mainnet [github-repo]
  { address: "0x8b4a2c4bb53857c718a04c020b98f8c2e1f99a68b0f57389a8bf5434cd22e05c", label: "hyperion", kind: "swap" }, // Hyperion CLMM (pool_v3 + router_v3 at one account) [official-doc]
];

export const STARKNET_VENUES: Venue[] = [
  { address: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b", label: "ekubo", kind: "swap" }, // Ekubo: Core [official-doc]
  { address: "0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067", label: "ekubo", kind: "swap" }, // Ekubo: Positions [official-doc]
  { address: "0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e", label: "ekubo", kind: "swap" }, // Ekubo: Router v3.0.13 [official-doc]
  { address: "0x04505a9f06f2bd639b6601f37a4dc0908bb70e8e0e0c34b1220827d64f4fc066", label: "ekubo", kind: "swap" }, // Ekubo: Router v3.0.3 [official-doc]
  { address: "0x03266fe47923e1500aec0fa973df8093b5850bbce8dcd0666d3f47298b4b806e", label: "ekubo", kind: "swap" }, // Ekubo: Router v2.0.1 [official-doc]
  { address: "0x010c7eb57cbfeb18bde525912c1b6e9a7ebb4f692e0576af1ba7be8b3b9a70f6", label: "ekubo", kind: "swap" }, // Ekubo: Router v2 [official-doc]
  { address: "0x01b6f560def289b32e2a7b0920909615531a4d9d5636ca509045843559dc23d5", label: "ekubo", kind: "swap" }, // Ekubo: Router v1 (legacy) [official-doc]
  { address: "0x04c0a5193d58f74fbace4b74dcf65481e734ed1714121bdc571da345540efa05", label: "zklend", kind: "lend" }, // zkLend: Market [official-doc]
  { address: "0x073f6addc9339de9822cab4dac8c9431779c09077f02ba7bc36904ea342dd9eb", label: "nostra", kind: "lend" }, // Nostra Money Market: CDP Manager [official-doc]
  { address: "0x06bde9f5dad56196ce852c8099db62d0a2827bd389cd0d0885aa7c7dd969fd57", label: "nostra", kind: "lend" }, // Nostra Money Market: Deferred Batch Call Adapter [official-doc]
  { address: "0x01bcfcb651e98317dc042cb34d0e0226c7f83bca309b6c54d8f0df6ee4e5f721", label: "nostra", kind: "lend" }, // Nostra Money Market: Flash Loan Adapter [official-doc]
  { address: "0x049ff5b3a7d38e2b50198f408fa8281635b5bc81ee49ab87ac36c8324c214427", label: "nostra", kind: "swap" }, // Nostra Pools: Router [official-doc]
  { address: "0x041fd22b238fa21cfcf5dd45a8548974d8263b3a531a60388411c5e230f97023", label: "jediswap", kind: "swap" }, // JediSwap v1: Router [official-doc]
  { address: "0x0359550b990167afd6635fa574f3bdadd83cb51850e1d00061fe693158c23f80", label: "jediswap", kind: "swap" }, // JediSwap v2: Swap Router [official-doc]
  { address: "0x07a6f98c03379b9513ca84cca1373ff452a7462a3b61598f0af5bb27ad7f76d1", label: "10kswap", kind: "swap" }, // 10kSwap: Router [github-repo]
  { address: "0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f", label: "avnu", kind: "swap" }, // AVNU: Exchange (aggregator router) [github-repo]
  { address: "0x000d8d6dfec4d33bfb6895de9f3852143a17c6f92fd2a21da3d6924d34870160", label: "vesu", kind: "lend" }, // Vesu v1.1: Singleton (holds all v1 funds) [github-repo]
  { address: "0x451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5", label: "vesu", kind: "lend" }, // Vesu v2: Prime pool [official-doc]
  { address: "0x3976cac265a12609934089004df458ea29c776d77da423c96dc761d09d24124", label: "vesu", kind: "lend" }, // Vesu v2: Re7 USDC Core pool [official-doc]
  { address: "0x2eef0c13b10b487ea5916b54c0a7f98ec43fb3048f60fdeedaf5b08f6f88aaf", label: "vesu", kind: "lend" }, // Vesu v2: Re7 USDC Prime pool [official-doc]
  { address: "0x5c03e7e0ccfe79c634782388eb1e6ed4e8e2a013ab0fcc055140805e46261bd", label: "vesu", kind: "lend" }, // Vesu v2: Re7 USDC Frontier pool [official-doc]
  { address: "0x3a8416bf20d036df5b1cf3447630a2e1cb04685f6b0c3a70ed7fb1473548ecf", label: "vesu", kind: "lend" }, // Vesu v2: Re7 xBTC pool [official-doc]
  { address: "0x73702fce24aba36da1eac539bd4bae62d4d6a76747b7cdd3e016da754d7a135", label: "vesu", kind: "lend" }, // Vesu v2: Re7 USDC Stable Core pool [official-doc]
];

// Sui: 패키지 업그레이드마다 ID 가 바뀌고 구버전도 호출 가능 → 원본+현행 세트로 등재.
// 공개 풀노드의 MoveFunction 필터는 정렬이 보장되지 않아(리서치 실측) 커버리지가 듬성할 수 있음 — 배지 공지.
export const SUI_VENUES: Venue[] = [
  { address: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb", label: "cetus", kind: "swap" }, // Cetus CLMM (original package / type-tag ID) [github-repo]
  { address: "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3", label: "cetus", kind: "swap" }, // Cetus CLMM (current published-at, mainnet-v0.0.14, MVR @cetuspackages/ [official-doc]
  { address: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1", label: "turbos", kind: "swap" }, // Turbos Finance CLMM (original package) [official-doc]
  { address: "0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64", label: "turbos", kind: "swap" }, // Turbos Finance CLMM (current published-at; verified live 2026-06-10) [official-doc]
  { address: "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c", label: "aftermath", kind: "swap" }, // Aftermath AMM (original package) [github-repo]
  { address: "0xc4049b2d1cc0f6e017fda8260e4377cecd236bd7f56a54fee120816e72e2e0dd", label: "aftermath", kind: "swap" }, // Aftermath AMM (published-at in official repo; still receives aggregato [github-repo]
  { address: "0xf948935b111990c2b604900c9b2eeb8f24dcf9868a45d1ea1653a5f282c10e29", label: "aftermath", kind: "swap" }, // Aftermath AMM (latest version per Move Registry @aftermath-fi/amm) [official-doc]
  { address: "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66", label: "kriya", kind: "swap" }, // Kriya v2 spot AMM (original = published-at; verified live 2026-06-10) [github-repo]
  { address: "0xbd8d4489782042c6fafad4de4bc6a5e0b84a43c6c00647ffd7062d1e2bb7549e", label: "kriya", kind: "swap" }, // Kriya v3 CLMM (original package, from official kriya-v3-sdk npm by Kri [github-repo]
  { address: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267", label: "bluefin", kind: "swap" }, // Bluefin Spot CLMM (original package / type-tag ID) [github-repo]
  { address: "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c", label: "bluefin", kind: "swap" }, // Bluefin Spot CLMM (published-at; verified live 2026-06-03/06-10) [github-repo]
  { address: "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809", label: "deepbook", kind: "swap" }, // DeepBook v3 (original package, version 1) [official-doc]
  { address: "0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497", label: "deepbook", kind: "swap" }, // DeepBook v3 (DEEPBOOK_PACKAGE_ID version 6 per docs.sui.io) [official-doc]
  { address: "0x0e735f8c93a95722efd73521aca7a7652c0bb71ed1daf41b26dfd7d1ff71f748", label: "deepbook", kind: "swap" }, // DeepBook v3 (current version per Move Registry @deepbook/core; verifie [official-doc]
  { address: "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca", label: "navi-lending", kind: "lend" }, // Navi Protocol lending (original package, MVR @navi-protocol/lending) [official-doc]
  { address: "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0", label: "navi-lending", kind: "lend" }, // Navi Protocol lending (defaultProtocolPackage in official navi-sdk; no [github-repo]
  { address: "0xc37b81366a01d6c2ef686bfe48f26116cdb0443516885b5ccd03a48e5efa2339", label: "navi-lending", kind: "lend" }, // Navi Protocol lending (current version per Move Registry @navi-protoco [official-doc]
  { address: "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf", label: "suilend", kind: "lend" }, // Suilend (original PACKAGE_ID / PKG_V1, from official @suilend/sdk) [github-repo]
  { address: "0xe53906c2c058d1e369763114418f3c144d1b74960d29b2785718a782fec09b61", label: "suilend", kind: "lend" }, // Suilend (current version per Move Registry @suilend/core; verified liv [official-doc]
  { address: "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf", label: "scallop", kind: "lend" }, // Scallop core protocol (original package, from official Scallop address [official-doc]
  { address: "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805", label: "scallop", kind: "lend" }, // Scallop core protocol (current version per Move Registry lending@scall [official-doc]
  { address: "0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7", label: "springsui", kind: "stake" }, // SpringSui LST (original package PKG_V1, from official @suilend/springs [github-repo]
  { address: "0x47c4b62aed92c5ae308ecd00253b64b3568ad97e6fb11e54b3d1ac5ed7be19ab", label: "springsui", kind: "stake" }, // SpringSui LST (current version per Move Registry @suilend/springsui; v [official-doc]
  { address: "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d", label: "haedal", kind: "stake" }, // Haedal haSUI staking (original package = haSUI coin-type package; modu [official-doc]
  { address: "0x126e4cfb051cad744706df590ec399e8c02b6feae195c35b8b496280d5442a62", label: "haedal", kind: "stake" }, // Haedal haSUI staking (current version per Move Registry @haedal/hasui; [official-doc]
];
