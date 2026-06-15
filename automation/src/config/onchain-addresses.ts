/**
 * 온체인 주소 단일 출처 — **여러 모듈이 공유**하는 생산 escrow/feed/canonical 주소만 모은다.
 *
 * 종전엔 같은 주소가 peg-reference·supply-conservation·supply-backing 에 각각 하드코딩돼,
 *   브릿지/피드 교체 시 한쪽만 고쳐 불일치 날 위험이 있었다(예: ETH/USD 피드가 4곳, wstETH L2 leg 이
 *   conservation·backing 양쪽에 중복). 여기 한 곳만 고치면 전부 반영된다.
 *
 * ⚠️ 단일 모듈에서만 쓰는 주소(예: RETH/CBETH NAV getter, USDT0 OFT, Optimism wstETH leg)는 의도적으로
 *   여기 넣지 않는다 — dedup 이점이 없는데 import 결합만 늘기 때문. 공유가 생기면 그때 승격한다.
 *
 * 모든 소비처가 viem `getAddress()` 로 체크섬 정규화 후 read 하므로 case 는 무관하지만, 통합 중 오타로
 *   주소가 바뀌면 잘못된 escrow 를 읽어 탐지가 조용히 깨진다 → tests/onchain-addresses.test.ts 가 각 상수를
 *   검증된 리터럴로 핀 + 체크섬 유효성 확인. 값은 온체인 검증(2026-06, 프로젝트 Alchemy 키).
 */

// ── Chainlink USD 피드(ethereum, answer 8dp) ──
export const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
export const BTC_USD_FEED = "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c";

// ── canonical(mainnet) LST 토큰 = NAV getter 컨트랙트(토큰 자체가 rate 노출) ──
export const WSTETH_MAINNET = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"; // stEthPerToken
export const WEETH_MAINNET = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";  // getRate

// ── rsETH NAV getter(LRTOracle — rsETH 토큰과 별개 컨트랙트) ──
export const RSETH_LRT_ORACLE = "0x349A73444b1a310BAe67ef67973022020d70020d"; // rsETHPrice

// ── wstETH L2 leg(Lido canonical 브릿지 발행분) ──
export const WSTETH_BASE = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
export const WSTETH_ARBITRUM = "0x5979D7b546E38E414F7E9822514be443A4800529";

// ── Lido L1 브릿지 escrow(L2 wstETH 의 backing 잠금처) ──
export const LIDO_BASE_BRIDGE = "0x9de443AdC5A411E83F1878Ef24C3F52C61571e72";
export const LIDO_ARBITRUM_GATEWAY = "0x0F25c1DC2a9922304f2eac71DCa9B07E310e8E5a";
