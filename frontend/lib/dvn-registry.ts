/**
 * LayerZero V2 / Circle CCTP 온체인 읽기용 상수 — 워크플로 리서치(2026-06-18)로 검증, 적대적 재확인 완료.
 *   EndpointV2 는 ethereum/base/arbitrum 에서 동일 주소(CREATE2). EID·configType·UlnConfig 구조 확인됨.
 *   DVN 주소→이름: LayerZero 공식 metadata API(metadata.layerzero-api.com/v1/metadata/dvns) 기준.
 */

// LayerZero V2 EndpointV2 — eth/base/arb 공통 (적대적 검증 통과)
export const LZ_ENDPOINT_V2 = "0x1a44076050125825900e736c501f859c50fe728c";

// chain → LayerZero V2 endpoint id (EID)
export const LZ_EID: Record<string, number> = { ethereum: 30101, base: 30184, arbitrum: 30110 };
export const eidFor = (chain: string): number | null => LZ_EID[chain] ?? null;

// EndpointV2.getConfig configType: 1=Executor, 2=ULN (DVN). (검증됨)
export const CONFIG_TYPE_ULN = 2;

// Circle CCTP MessageTransmitter (ethereum mainnet) — attester 셋은 체인 무관(Circle 단일)이라 eth 에서 읽는다.
export const CCTP_MESSAGE_TRANSMITTER_ETH = "0x0a992d191deec32afe36203ad87d7d289a738f81"; // V1

/** DVN 컨트랙트 주소(lowercase) → 사람이 읽는 이름. eth/base/arb 통합(동일 주소는 같은 이름). */
const DVN_NAMES: Record<string, string> = {
  // LayerZero Labs (체인별 상이)
  "0x589dedbd617e0cbcb916a9223f4d1300c294236b": "LayerZero Labs",
  "0xdb979d0a36af0525afa60fc265b1525505c55d79": "LayerZero Labs",
  "0x9e059a54699a285714207b43b055483e78faac25": "LayerZero Labs",
  "0xb1473ac9f58fb27597a21710da9d1071841e8163": "LayerZero Labs",
  "0x2f55c492897526677c5b68fb199ea31e2c126416": "LayerZero Labs",
  "0x1308151a7ebac14f435d3ad5ff95c34160d539a5": "LayerZero Labs",
  // Google Cloud (3체인 동일)
  "0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc": "Google Cloud",
  // Polyhedra zkBridge (3체인 동일)
  "0x8ddf05f9a5c488b4973897e278b58895bf87cb24": "Polyhedra zkBridge",
  // Nethermind
  "0xa59ba433ac34d2927232918ef5b2eaafcf130ba5": "Nethermind",
  "0xf4064220871e3b94ca6ab3b0cee8e29178bf47de": "Nethermind",
  "0x658947bc7956aea0067a62cf87ab02ae199ef3f3": "Nethermind",
  "0xcd37ca043f8479064e10635020c65ffc005d36f6": "Nethermind",
  "0x14e570a1684c7ca883b35e1b25d2f7cec98a16cd": "Nethermind",
  // Horizen
  "0x380275805876ff19055ea900cdb2b46a94ecf20d": "Horizen",
  "0x2f0ba3dbb93cf087e32c15aab46726fdb4fb24cf": "Horizen",
  "0xa7b5189bca84cd304d8553977c7c614329750d99": "Horizen",
  "0x3a4636e9ab975d28d3af808b4e1c9fd936374e30": "Horizen",
  "0x19670df5e16bea2ba9b9e68b48c054c5baea06b8": "Horizen",
  "0x5cff49d69d79d677dd3e5b38e048a0dcb6d86aaf": "Horizen",
  // Chainlink CCIP
  "0x771d10d0c86e26ea8d3b778ad4d31b30533b9cbf": "Chainlink CCIP",
  // Animoca-Blockdaemon
  "0x7e65bdd15c8db8995f80abf0d6593b57dc8be437": "Animoca-Blockdaemon",
  "0x864b42dddc43a610e7506c163048c087f0b406ef": "Animoca-Blockdaemon",
  "0x41ef29f974fc9f6772654f005271c64210425391": "Animoca-Blockdaemon",
  "0xf0e40968e27f63b3b0a0b3baac4a274149376591": "Animoca-Blockdaemon",
  "0xddaa92ce2d2fac3f7c5eae19136e438902ab46cc": "Animoca-Blockdaemon",
  // Switchboard
  "0x276e6b1138d2d49c0cda86658765d12ef84550c1": "Switchboard",
  "0xcced05c3667877b545285b25f19f794436a1c481": "Switchboard",
  // Axelar
  "0xce5b47fa5139fc5f3c8c5f4c278ad5f56a7b2016": "Axelar",
  "0x9d3979c7e3dd26653c52256307709c09f47741e0": "Axelar",
  // BCW Group
  "0x3a283ed6bcce8d9dfb673fbfba6e644c9d02e9ab": "BCW Group",
  "0xb3ce0a5d132cd9bf965aba435e650c55edce0062": "BCW Group",
  "0xd77a62b54ee18bcd667b6cd158d5a000182af5cf": "BCW Group",
  "0x78203678d264063815dac114ea810e9837cd80f7": "BCW Group",
  "0x05ce650134d943c5e336dc7990e84fb4e69fdf29": "BCW Group",
  // P2P
  "0x06559ee34d85a88317bf0bfe307444116c631b67": "P2P",
  "0x5b6735c66d97479ccd18294fc96b3084ecb2fa3f": "P2P",
  // Stargate (deprecated 표기)
  "0x8fafae7dd957044088b3d0f67359c327c6200d18": "Stargate",
  "0xcdf31d62140204c08853b547e64707110fbc6680": "Stargate",
  "0x5756a74e8e18d8392605ba667171962b2b2826b5": "Stargate",
};

/** DVN 주소 → 이름(알면). 모르면 짧은 주소. */
export function dvnName(addr: string): string {
  const a = addr.toLowerCase();
  return DVN_NAMES[a] ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
}
