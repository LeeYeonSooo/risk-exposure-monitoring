/**
 * 온체인 주소 핀 테스트 — 주소 중앙화(2026-06) 통합이 생산 escrow/feed 주소를 손상시키지 않음을 보증.
 *
 * ① 각 상수를 **검증된 리터럴**로 고정(통합 중/후 오타 트립와이어). ② viem getAddress 라운드트립으로
 *    체크섬 유효성 확인(잘못된 체크섬·길이 오류 즉시 적발). 값은 온체인 검증(2026-06, 프로젝트 Alchemy 키).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getAddress } from "viem";

import * as A from "@/config/onchain-addresses";

// 검증된 정답(소비처에서 떼어온 원본 리터럴). 통합이 이 값을 바꾸면 실패.
const EXPECTED: Record<string, string> = {
  ETH_USD_FEED: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  BTC_USD_FEED: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
  WSTETH_MAINNET: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  WEETH_MAINNET: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
  RSETH_LRT_ORACLE: "0x349A73444b1a310BAe67ef67973022020d70020d",
  WSTETH_BASE: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
  WSTETH_ARBITRUM: "0x5979D7b546E38E414F7E9822514be443A4800529",
  LIDO_BASE_BRIDGE: "0x9de443AdC5A411E83F1878Ef24C3F52C61571e72",
  LIDO_ARBITRUM_GATEWAY: "0x0F25c1DC2a9922304f2eac71DCa9B07E310e8E5a",
};

describe("onchain-addresses 핀", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    test(`${name} = 검증된 리터럴`, () => {
      assert.equal((A as Record<string, string>)[name], expected);
    });
    test(`${name} 체크섬 유효(getAddress 라운드트립)`, () => {
      // 대소문자 무관 동일 주소 — getAddress 가 정규화하면 던지지 않음(잘못된 길이/체크섬이면 throw).
      assert.equal(getAddress((A as Record<string, string>)[name]), getAddress(expected));
    });
  }

  test("export 누락/오타 없음 — 상수 개수 일치", () => {
    const exported = Object.keys(A).filter((k) => typeof (A as Record<string, unknown>)[k] === "string");
    assert.equal(exported.length, Object.keys(EXPECTED).length);
  });
});
