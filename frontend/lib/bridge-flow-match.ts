/**
 * 브릿지 뷰 전용 tx → 엣지 라우터. 흐름맵의 buildRenderPlan(토큰→프로토콜→마켓→볼트, 브릿지 제외)과
 * 별개 — 여기서는 **체인↔브릿지 통로 엣지에만** 입자를 태운다.
 *
 * 정직성(MANUAL §17): 단일 체인 사실만 — tx 의 카운터파티 주소가 브릿지 노드 주소와 일치할 때만 매핑.
 *   · direction "in"  (to=브릿지) → 체인→브릿지 (락/예치/소각, USDC가 이 체인에서 브릿지로)
 *   · direction "out" (from=브릿지) → 브릿지→체인 (릴리즈, 브릿지에서 이 체인으로)
 * 체인↔체인(sibling) 엣지에는 절대 태우지 않는다 — 그건 "어느 체인에서 왔다"는 출처 날조가 된다.
 *
 * TxFlowLayer 의 buildPlan prop 으로 주입 → 흐름맵과 동일한 입자 렌더(같은 UI 형식)를 재사용.
 */

type NodeLite = { id: string; kind: string; label: string; chain: string; address?: string };
type EdgeLite = { source: string; target: string; kind: string };
type BridgeTx = {
  hash: string; token: string; chain: string; from: string; to: string;
  direction: "in" | "out"; kind?: string; counterpartyAddr?: string | null; valueUsd: number;
};

export function buildBridgeRenderPlan<N extends NodeLite, T extends BridgeTx>(
  nodes: N[], edges: EdgeLite[], txs: T[], maxHops = 260,
): { tx: T; hops: [N, N][] }[] {
  // 브릿지 주소(소문자) → 브릿지 노드
  const bridgeByAddr = new Map<string, N>();
  for (const n of nodes) if (n.kind === "bridge" && n.address) bridgeByAddr.set(n.address.toLowerCase(), n);
  // 체인 → 그 체인의 토큰 노드(가장 바깥 원)
  const tokenByChain = new Map<string, N>();
  for (const n of nodes) if (n.kind === "token") tokenByChain.set(n.chain, n);
  // 통로 엣지 존재 확인용 페어 집합
  const edgePair = new Set<string>();
  for (const e of edges) { edgePair.add(`${e.source}|${e.target}`); edgePair.add(`${e.target}|${e.source}`); }

  const plan: { tx: T; hops: [N, N][] }[] = [];
  let total = 0;
  for (const tx of txs) {
    if (total >= maxHops) break;
    const cp = (tx.counterpartyAddr ?? "").toLowerCase();
    const bridge = cp ? bridgeByAddr.get(cp) : undefined;
    const tok = tokenByChain.get(tx.chain);
    if (!bridge || !tok || bridge.id === tok.id) continue;
    if (!edgePair.has(`${tok.id}|${bridge.id}`)) continue; // 통로 엣지가 실제로 있어야 함
    // in = 체인→브릿지(유입/락/소각), out = 브릿지→체인(릴리즈)
    const hop: [N, N] = tx.direction === "in" ? [tok, bridge] : [bridge, tok];
    plan.push({ tx, hops: [hop] });
    total++;
  }
  return plan;
}
