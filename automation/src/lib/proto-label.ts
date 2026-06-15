/**
 * 프로토콜 노드 id → 사람이 읽는 프로토콜명. 메시지 텍스트 표기 전용.
 *   `protocol:`·`dl:` 접두와 `@chain` 접미를 제거한다.
 *
 *   protocol:morpho_blue@ethereum → morpho_blue
 *   protocol:dl:maple             → maple
 *   protocol:aave_v3              → aave_v3
 *
 * ⚠️ protocolNodeId 필드 자체는 절대 이걸로 바꾸지 말 것 — 흐름맵 칩이 `@chain` 접미에서
 *    체인을 읽는다. 오직 message 문자열을 깔끔히 만들 때만 사용.
 * 프론트 lib/alert-kinds.ts 의 prettyMessage 와 동작 일치(이미 protocol:·@chain strip) → 멱등.
 */
export function protoLabel(nodeId: string | null | undefined): string {
  return (nodeId ?? "")
    .replace(/^protocol:(dl:)?/, "")
    .replace(/@[a-z0-9-]+$/i, "");
}
