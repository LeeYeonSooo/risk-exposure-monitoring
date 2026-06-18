import { NextResponse } from "next/server";
import { decodeAbiParameters, type Hex } from "viem";

import {
  CCTP_MESSAGE_TRANSMITTER_ETH, CONFIG_TYPE_ULN, LZ_ENDPOINT_V2, dvnName, eidFor,
} from "@/lib/dvn-registry";
import {
  decodeAddressWord, decodeUint, ethCall, padWord, selectorOf, supportedChain, uintWord,
} from "@/lib/onchain-read";

/**
 * GET /api/bridge-dvn — 브릿지 구조특성 "라이브 온체인 실측".
 *   ?mech=oft&chain=arbitrum&oapp=0x..&remote=ethereum  → LayerZero ULN DVN 구성(X-of-Y)
 *   ?mech=cctp                                           → Circle CCTP attester 셋(m-of-n)
 * 반환 { live: {...} | null } — bridge-security.mergeLive 가 그대로 소비(meta.live).
 */
export const revalidate = 1800; // 온체인 보안 구성은 자주 안 바뀜 → 30분 캐시

const SEL_GET_SEND_LIBRARY = selectorOf("function getSendLibrary(address,uint32)");
const SEL_GET_CONFIG = selectorOf("function getConfig(address,address,uint32,uint32)");
const SEL_NUM_ATTESTERS = selectorOf("function getNumEnabledAttesters()");
const SEL_SIG_THRESHOLD = selectorOf("function signatureThreshold()");

// UlnConfig 구조 (UlnBase.sol — 필드 순서 검증됨)
const ULN_CONFIG_ABI = [{
  type: "tuple",
  components: [
    { name: "confirmations", type: "uint64" },
    { name: "requiredDVNCount", type: "uint8" },
    { name: "optionalDVNCount", type: "uint8" },
    { name: "optionalDVNThreshold", type: "uint8" },
    { name: "requiredDVNs", type: "address[]" },
    { name: "optionalDVNs", type: "address[]" },
  ],
}] as const;

async function readOft(chain: string, oapp: string, remoteEid: number) {
  // 1) 이 OApp 의 send library (EndpointV2.getSendLibrary)
  const libRes = await ethCall(chain, LZ_ENDPOINT_V2, SEL_GET_SEND_LIBRARY + padWord(oapp) + uintWord(remoteEid));
  if (!libRes) return null;
  const lib = decodeAddressWord(libRes);
  if (!lib) return null;
  // 2) ULN(DVN) config (configType 2) — bytes 반환 → UlnConfig 디코드
  const cfgRes = await ethCall(chain, LZ_ENDPOINT_V2, SEL_GET_CONFIG + padWord(oapp) + padWord(lib) + uintWord(remoteEid) + uintWord(CONFIG_TYPE_ULN));
  if (!cfgRes || cfgRes === "0x") return null;
  try {
    const [configBytes] = decodeAbiParameters([{ type: "bytes" }], cfgRes as Hex) as [Hex];
    const [uln] = decodeAbiParameters(ULN_CONFIG_ABI, configBytes) as [{
      confirmations: bigint; requiredDVNCount: number; optionalDVNCount: number; optionalDVNThreshold: number;
      requiredDVNs: readonly string[]; optionalDVNs: readonly string[];
    }];
    const names = [...uln.requiredDVNs, ...uln.optionalDVNs].map((a) => dvnName(a));
    return {
      kind: "oft",
      dvnRequired: Number(uln.requiredDVNCount),
      dvnOptional: Number(uln.optionalDVNCount),
      dvnThreshold: Number(uln.optionalDVNThreshold),
      dvnNames: names,
      confirmations: Number(uln.confirmations),
    };
  } catch { return null; }
}

async function readCctp() {
  // attester 셋은 ethereum MessageTransmitter 에서 (Circle 단일 — 체인 무관)
  const nRes = await ethCall("ethereum", CCTP_MESSAGE_TRANSMITTER_ETH, SEL_NUM_ATTESTERS);
  const tRes = await ethCall("ethereum", CCTP_MESSAGE_TRANSMITTER_ETH, SEL_SIG_THRESHOLD);
  const attesters = nRes ? decodeUint(nRes) : null;
  const attesterThreshold = tRes ? decodeUint(tRes) : null;
  if (attesters == null && attesterThreshold == null) return null;
  return { kind: "cctp", attesters, attesterThreshold };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mech = (searchParams.get("mech") ?? "").toLowerCase();
  try {
    if (mech === "cctp") {
      return NextResponse.json({ live: await readCctp() }, { status: 200 });
    }
    if (mech === "oft") {
      const chain = (searchParams.get("chain") ?? "").toLowerCase();
      const oapp = searchParams.get("oapp") ?? "";
      const remote = (searchParams.get("remote") ?? "").toLowerCase();
      const eidParam = searchParams.get("eid");
      const eid = eidFor(remote) ?? (eidParam ? Number(eidParam) : null);
      if (!supportedChain(chain) || !/^0x[0-9a-fA-F]{40}$/.test(oapp) || !eid) {
        return NextResponse.json({ live: null, error: "bad params" }, { status: 200 });
      }
      return NextResponse.json({ live: await readOft(chain, oapp, eid) }, { status: 200 });
    }
    return NextResponse.json({ live: null, error: "unknown mech" }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ live: null, error: String(e) }, { status: 200 });
  }
}
