/**
 * 머니레고 구조 그래프 모델 (멘토 피드백 §6·§9).
 *
 * 원칙: 직접 자금흐름이 없어도 "구조"가 확인되면 잇는다 —
 *   issues        : 기초자산 → 파생토큰 (sUSDe → PT-sUSDe, stETH 예치 → aToken)
 *   lp_of         : 구성토큰 → LP 토큰 (stETH → steCRV, PT → Pendle LP)
 *   collateral_at : 파생토큰 → 프로토콜 (PT 가 Morpho 마켓 담보로 등재됨)
 *   staked_in     : LP 토큰 → 프로토콜 (Curve LP 가 Convex Booster 에 등재됨)
 * 모든 엣지는 evidence(API/온체인 메서드)를 기록 — 추측으로 잇지 않는다.
 */

export type DerivRole = "pt" | "yt" | "lp" | "receipt" | "wrapper";
export type LegoRelation = "issues" | "lp_of" | "collateral_at" | "staked_in" | "backed_by";

/**
 * 종착(terminal) 분류 — 새 relation/kind 를 만들지 않고 노드 meta 에만 얹는다(원칙: "현재 노드 종류 위에서 매핑").
 * 목적: 다음 홉이 없는 노드가 "설계상 진짜 끝"인지 "아직 못 찾은 단절"인지 트리에서 구분되게.
 * 데이터로 확정되는 것만 종착으로 표기하고, 그 외 out엣지 없는 노드는 종착 표기를 하지 않는다(= 미완/숨김 후보).
 *   collateral_sink : 담보가 여기서 잠기고 청산됨(렌딩 마켓). 다음 토큰 홉 없음 — 회수는 역방향 상환.
 *   staking_sink    : LP 가 여기 스테이킹되고 영수증(cvxLP) 발행. 영수증 자체가 또 종착이면 reward 종착.
 *   reward_sink     : 예치 영수증(cvxLP·aToken). 다음은 보상(CRV/CVX·이자) 발생 = 가치 발행이라 예치엣지로 안 이어짐.
 *   yield_sink      : YT — 만기까지 이자 수취. 이자 재원 = 기초토큰의 네이티브 수익(token→issues→YT 로 이미 표현).
 *   lp_held_sink    : LP 토큰을 그냥 보유(스테이킹 안 함). 풀 자체가 최종 유동성 포지션 — 다음 예치 홉 없음.
 *                     스테이킹 LP(staked_in out엣지 있음)는 여기 아님(그건 다음 홉으로 이어지거나 staking_sink).
 *   vault_share_sink: 큐레이터 ERC-4626 볼트 쉐어(MetaMorpho steakUSDC·gtUSDC 등)를 그냥 보유.
 *                     토큰을 볼트에 예치해 받은 쉐어 = 최종 보유 포지션. 다음 예치 홉 없음(쉐어가 다시 담보로 돌면
 *                     collateral_at out엣지가 생겨 여기 안 걸리고 다음 홉으로 이어짐 → 그땐 종착 아님).
 *                     lp_held_sink 와 동형(同型): LP 보유=풀 포지션, 볼트쉐어 보유=큐레이터 볼트 포지션.
 */
export type TerminalKind = "collateral_sink" | "staking_sink" | "reward_sink" | "yield_sink" | "lp_held_sink" | "vault_share_sink";

/** 노드 meta 에 얹는 종착 표식 (snapshot-lego 가 산출, 프론트가 라벨·hover 로 렌더). */
export interface TerminalMark {
  terminal: true;
  terminalKind: TerminalKind;
  terminalReason: string;       // 사용자 노출용 순수 한글 한 줄 — 왜 여기가 끝인지
  rewardSource?: string;        // reward/yield 종착의 재원 출처 한 줄 (큐레이터 보상 재원 질문 대응)
}

export interface LegoNode {
  id: string;                 // deriv:0xaddr@chain | protocol:slug[@chain] | legomkt:proto:key@chain
  chain: string;              // ethereum | base | arbitrum
  address: string | null;
  kind: "derivative" | "protocol" | "market";  // market = 파생을 받아주는 개별 마켓(담보/스테이킹)
  role: DerivRole | null;
  label: string;
  symbol: string | null;
  protocol: string | null;    // 발행/호스팅 프로토콜 슬러그
  parentToken: string | null; // token:sUSDe / token:sUSDe@base (derivative·market 모두 viewed token)
  meta: Record<string, unknown>;
}

export interface LegoEdge {
  src: string;
  dst: string;
  relation: LegoRelation;
  chain: string;
  weightUsd: number | null;
  evidence: Record<string, unknown>;
}

/** 기존 그래프 노드 id 관례를 따른다: 이더리움은 @ 없음, 그 외는 @chain. */
export const tokenNodeId = (sym: string, chain: string) =>
  chain === "ethereum" ? `token:${sym}` : `token:${sym}@${chain}`;
export const protocolNodeId = (slug: string, chain: string) =>
  chain === "ethereum" ? `protocol:${slug}` : `protocol:${slug}@${chain}`;
export const derivNodeId = (addr: string, chain: string) => `deriv:${addr.toLowerCase()}@${chain}`;
// 수용처 마켓 노드 — 파생을 받아주는 개별 마켓(Morpho 담보마켓·Convex 풀). 프로토콜 노드가 아님.
export const marketNodeId = (proto: string, key: string, chain: string) =>
  `legomkt:${proto}:${key.toLowerCase()}@${chain}`;

export const CHAIN_IDS: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161 };

/** 프로토콜 슬러그 → 사용자 노출용 이름(순수 한글/브랜드). 종착 이유 문구에 씀. */
const PRETTY_VENUE: Record<string, string> = {
  convex: "Convex", aave_v3: "Aave v3", aave_v2: "Aave v2", curve: "Curve",
  pendle: "Pendle", morpho_blue: "Morpho Blue", balancer: "Balancer", uniswap: "Uniswap",
};

/**
 * 종착 판정 — 단일 진실 소스. snapshot-lego ⑦(신규 스냅샷) 와 backfill-terminal(전역 재계산) 가 공유한다.
 * 추측 금지: 노드의 role·kind·meta.kind + "예치방향 out엣지 유무" + "확정된 staked_in 들어오는 엣지 유무"만으로 판정.
 *
 *   · YT                         → yield_sink   (만기까지 이자 수취; 재원 = 기초토큰 네이티브 수익)
 *   · role=lp, out엣지 없음        → lp_held_sink (LP 를 그냥 보유 = 풀이 최종 유동성 포지션; 스테이킹 안 됨)
 *   · role=wrapper protocol=metamorpho, out엣지 없음 → vault_share_sink (큐레이터 볼트 쉐어 보유 = 최종 포지션; lp_held_sink 동형)
 *   · receipt, out엣지 없음        → reward_sink  (다음은 보상 발생이라 예치엣지로 안 감)
 *   · market kind=lending, out엣지 없음 → collateral_sink (담보가 여기 잠기고 청산; 회수는 역방향 상환)
 *   · market kind=pool, out엣지 없음:
 *       - 들어오는 staked_in 엣지 있음(=스테이킹은 온체인으로 확정됨, cvxLP 영수증만 미해소) → staking_sink
 *       - 그것도 없음(스테이킹 자체 미확인)                                              → 종착 단정 금지(미완/숨김)
 *   · 그 외(out엣지 있는 풀·LP·PT·wrapper, out엣지 없는 bridge wrapper 등) → 종착 아님.
 *       (bridge wrapper 는 lock&mint 이름변경일 뿐 수용처 못 찾으면 종착 단정 금지 = 미완/숨김. metamorpho 볼트쉐어와 구분.)
 *
 * @param hasOutEdge       이 노드를 src 로 하는 예치방향 엣지(issues/lp_of/collateral_at/staked_in)가 1개+ 있나
 * @param hasInStakedIn    이 노드를 dst 로 하는 staked_in 엣지가 있나(풀이 "스테이킹 수용처"로 확정됐나)
 * @param viewedSymbol     종착 이유 문구에 넣을 기초자산 이름(예: "sUSDe"). YT 재원 설명용.
 */
export function computeTerminalMark(
  node: Pick<LegoNode, "kind" | "role" | "protocol" | "meta">,
  hasOutEdge: boolean,
  hasInStakedIn: boolean,
  viewedSymbol: string,
): TerminalMark | null {
  if (node.role === "yt") {
    const ul = viewedSymbol || "기초자산";
    return {
      terminal: true, terminalKind: "yield_sink",
      terminalReason: "만기까지 이자를 수취하는 종착 — 다음 예치 홉 없음.",
      rewardSource: `${ul} 의 네이티브 수익(이자)이 재원 — 같은 발행에서 나온 PT 가 원금, YT 가 그 수익권.`,
    };
  }
  if (node.kind === "derivative" && node.role === "lp" && !hasOutEdge) {
    // 보유 LP — staked_in/collateral_at out엣지가 하나도 없음 = 사용자가 LP 를 그냥 들고 있음.
    //   풀 자체가 최종 유동성 포지션이라 다음 예치 홉이 없다(스테이킹·담보로 더 안 들어감).
    //   스테이킹된 LP 는 staked_in out엣지가 있어 hasOutEdge=true → 여기 안 걸리고 다음 홉으로 이어짐.
    //   (이 표식이 없으면 lego-overlay connected 필터에 전량 숨겨져 LP 최종출구가 트리에서 사라졌다 — 감사관 [고정1].)
    const venue = node.protocol ? (PRETTY_VENUE[node.protocol] ?? node.protocol) : "DEX";
    return {
      terminal: true, terminalKind: "lp_held_sink",
      terminalReason: `${venue} 풀 LP 보유 종착 — 스테이킹 안 한 LP 라 풀 자체가 최종 유동성 포지션. 다음 예치 홉 없음.`,
      rewardSource: `${venue} 풀의 거래 수수료가 LP 가치로 누적되는 재원 — 회수는 LP 소각으로 풀에서 페어 토큰 인출(역방향).`,
    };
  }
  if (node.kind === "derivative" && node.role === "wrapper" && node.protocol === "metamorpho" && !hasOutEdge) {
    // 큐레이터 ERC-4626 볼트 쉐어를 그냥 보유 — collateral_at out엣지가 하나도 없음 = 쉐어가 더 담보로 안 돎.
    //   토큰을 MetaMorpho 볼트에 예치해 받은 쉐어 자체가 최종 보유 포지션이라 다음 예치 홉이 없다.
    //   (lp_held_sink 와 동형: LP 보유=풀 포지션, 볼트쉐어 보유=큐레이터 볼트 포지션. 이 표식이 없으면
    //    lego-overlay connected 필터에 전량 숨겨져 "USDC→MetaMorpho 볼트 예치"라는 정당한 최종 포지션이
    //    트리에서 통째로 사라졌다 — 감사관 [추궁] 비대칭. 쉐어가 다시 담보로 돌면 out엣지가 생겨 여기 안 걸림.)
    const vname = (node.meta?.name as string | undefined) ?? "MetaMorpho 볼트";
    return {
      terminal: true, terminalKind: "vault_share_sink",
      terminalReason: `${vname} 볼트 쉐어 보유 종착 — 토큰을 이 큐레이터 볼트에 예치해 받은 쉐어가 최종 포지션. 다음 예치 홉 없음.`,
      rewardSource: `${vname} 큐레이터가 예치금을 배분한 Morpho 대출 마켓들의 대출 이자가 쉐어 가치로 누적되는 재원 — 회수는 쉐어 소각으로 볼트에서 원금 인출(역방향).`,
    };
  }
  if (node.kind === "derivative" && node.role === "receipt" && !hasOutEdge) {
    const venue = node.protocol ? (PRETTY_VENUE[node.protocol] ?? node.protocol) : "프로토콜";
    return {
      terminal: true, terminalKind: "reward_sink",
      terminalReason: `${venue} 예치 영수증 — 다음은 보상(이자·CRV/CVX) 발생이라 예치 경로의 끝.`,
      rewardSource: `${venue} 풀/마켓의 운용 수익(스왑 수수료·대출 이자)에서 보상이 누적 — 회수는 영수증 소각(역방향).`,
    };
  }
  if (node.kind === "market" && !hasOutEdge) {
    const kind = (node.meta?.kind as string | undefined) ?? "";
    if (kind === "lending") {
      const venue = (node.meta?.venue as string | undefined) ?? "렌딩 마켓";
      const curators = ((node.meta?.curators as string[] | undefined) ?? []).filter(Boolean);
      return {
        terminal: true, terminalKind: "collateral_sink",
        terminalReason: `${venue} 담보 종착 — 담보가 여기 잠기고 청산됨. 원금 회수는 여기서 역방향 상환.`,
        rewardSource: curators.length
          ? `이 마켓의 대출 이자가 큐레이터(${curators.slice(0, 2).join("·")}) 볼트 보상의 재원.`
          : "이 마켓의 대출 이자가 공급자·큐레이터 보상의 재원.",
      };
    }
    // 풀형(pool): 들어오는 staked_in 이 있으면 "스테이킹은 확정"(Booster.poolInfo) — 영수증(cvxLP)만 미해소 →
    //   staking_sink 로 표기해 "LP 가 여기서 스테이킹되는 종착"이라 읽히게(상위 LP 가 숨김/모호로 사라지지 않게).
    //   들어오는 staked_in 조차 없으면 스테이킹 자체가 미확인 → 종착 단정 금지(미완으로 남김).
    if (kind === "pool" && hasInStakedIn) {
      const venue = (node.meta?.venue as string | undefined) ?? "스테이킹 풀";
      return {
        terminal: true, terminalKind: "staking_sink",
        terminalReason: `${venue} 스테이킹 종착 — LP 가 여기 스테이킹됨(온체인 확정). 영수증 토큰은 미해소라 더 이상 추적 안 됨.`,
        rewardSource: `${venue} 가 받는 거래 수수료·보상(CRV/CVX 등)이 재원 — 회수는 스테이킹 해제(역방향).`,
      };
    }
  }
  return null;
}
