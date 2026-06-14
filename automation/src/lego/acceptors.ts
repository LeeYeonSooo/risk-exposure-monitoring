/**
 * 수용처(acceptor) 어댑터 레지스트리 — "이 파생토큰을 담보로 받아주는 마켓" 질의의 플러그인 지점.
 *
 * snapshot-lego 는 프로토콜을 모른 채 ACCEPTOR_ADAPTERS 만 순회한다. 새 수용처(Aave·Fluid·볼트쉐어…)는
 * 어댑터 1개를 여기 추가하면 끝 — 스냅샷 본체는 손대지 않는다.
 * 어댑터는 기존 discover.ts 의 열거 함수를 감싸기만 한다(로직 복제 금지). 노드 id 는
 * marketNodeId(protocol, marketKey) 관례를 따르고, meta/evidence 는 어댑터가 완성해 내보낸다.
 *
 * Convex(staked_in)는 여기 없음 — 수용처이면서 동시에 영수증 파생(cvxLP)을 발행해 레벨2 재귀의
 * 입력이 되므로(발견과 결합) snapshot-lego ⑤에 인라인으로 남긴다.
 */
import { aaveAccepting, eulerAccepting, fluidAccepting, morphoAccepting } from "./discover";
import { symbolsOf } from "./onchain";

/** 수용 마켓 1건 — collateral_at 엣지·legomkt 노드 생성에 필요한 전부. */
export interface AcceptingMarket {
  protocol: string;                  // 슬러그 — legomkt:{protocol}:{marketKey}@chain
  marketKey: string;                 // 관례: `${collateral}-${loanAddress}` (lowercase)
  label: string;                     // 마켓 노드 라벨 (관례: 대출자산 심볼)
  collateral: string;                // 담보 파생토큰 주소 (lowercase) — derivNodeId 매칭용
  loanSymbol: string;
  loanAddress: string;
  sizeUsd: number | null;            // collateral_at 엣지 weight (없으면 null)
  meta: Record<string, unknown>;     // 마켓 노드 meta
  evidence: Record<string, unknown>; // collateral_at 엣지 evidence
}

/** 수용처 어댑터 — accepting(chain, 담보후보 주소들) → 받아주는 마켓 목록. */
export interface AcceptorAdapter {
  id: string;
  chains: string[]; // 지원 체인 — 미지원 체인은 호출 자체를 스킵
  accepting(chain: string, collateralAddrs: string[]): Promise<AcceptingMarket[]>;
}

// ── Morpho Blue — GraphQL collateralAssetAddress_in (discover.morphoAccepting 래핑) ──
const morphoBlue: AcceptorAdapter = {
  id: "morpho_blue",
  chains: ["ethereum", "base", "arbitrum"],
  async accepting(chain, collateralAddrs) {
    return (await morphoAccepting(chain, collateralAddrs)).map((a) => ({
      protocol: "morpho_blue",
      marketKey: `${a.collateral}-${a.loanAddress}`,
      label: a.loanSymbol,
      collateral: a.collateral,
      loanSymbol: a.loanSymbol,
      loanAddress: a.loanAddress,
      sizeUsd: a.supplyUsd || null,
      meta: {
        kind: "lending", venue: "Morpho Blue", loan: a.loanSymbol, lltv: a.lltv, sizeUsd: a.supplyUsd,
        category: `Morpho 담보마켓${a.lltv != null ? ` · LLTV ${(a.lltv * 100).toFixed(0)}%` : ""}`,
        curators: a.curators.slice(0, 4),
        // 마켓 고유 식별(회장 작업2) — 담보+대출 주소쌍 = 노드 id 와 동일한 유일키.
        //   meta 최상위에 두면 프론트 lego-overlay 의 `_market: {...meta}` 스프레드로 metadata._market.{collateralAddress,loanAddress} 에 그대로 실린다.
        //   알림 조인(alert-link)이 loan|lltv 충돌 없이 이 마켓만 집게 한다(추측 없음 — Morpho GraphQL 실주소).
        collateralAddress: a.collateral, loanAddress: a.loanAddress,
      },
      evidence: { source: "morpho-graphql", loan: a.loanSymbol, lltv: a.lltv },
    }));
  },
};

// ── Euler v2 — 체인별 Goldsky 서브그래프 (discover.eulerAccepting 래핑) ──
const eulerV2: AcceptorAdapter = {
  id: "euler_v2",
  chains: ["ethereum", "base", "arbitrum"], // 체인별 euler-v2 서브그래프 (discover.EULER_SUBGRAPHS)
  async accepting(chain, collateralAddrs) {
    return (await eulerAccepting(chain, collateralAddrs)).map((a) => ({
      protocol: "euler_v2",
      marketKey: `${a.collateral}-${a.loanAddress}`,
      label: a.loanSymbol,
      collateral: a.collateral,
      loanSymbol: a.loanSymbol,
      loanAddress: a.loanAddress,
      sizeUsd: null, // 서브그래프에 마켓 규모 없음 — 지어내지 않는다
      meta: { kind: "lending", venue: "Euler", loan: a.loanSymbol, category: `Euler 담보마켓 · 대출 ${a.loanSymbol}`,
        collateralAddress: a.collateral, loanAddress: a.loanAddress }, // 마켓 고유 식별(주소쌍). Euler 는 LLTV 미수집 → lltv 없음.
      evidence: { source: "euler-subgraph", loan: a.loanSymbol },
    }));
  },
};

// ── Aave v3 — 풀형 수용처 (discover.aaveAccepting 래핑). 마켓 = 파생의 리저브 1개 ──
//   Aave 는 대출자산 구분이 없는 풀이라 marketKey = 담보주소(legomkt:aave_v3:{addr}@chain).
//   라벨은 담보 심볼 + 순수 한글. weightUsd = aToken totalSupply × 가격(adapter 산출, null 허용).
const aaveV3: AcceptorAdapter = {
  id: "aave_v3",
  chains: ["ethereum", "base", "arbitrum"],
  async accepting(chain, collateralAddrs) {
    const accepted = await aaveAccepting(chain, collateralAddrs);
    if (!accepted.length) return [];
    const syms = await symbolsOf(chain, accepted.map((a) => a.collateral)); // 라벨용 담보 심볼
    return accepted.map((a) => {
      const sym = syms.get(a.collateral) ?? null;
      const ltvPct = (a.ltvBps / 100).toFixed(0);
      return {
        protocol: "aave_v3",
        marketKey: a.collateral, // 풀형: 담보=리저브 1:1 → 대출자산 키 없음
        label: sym ? `${sym} · Aave v3 담보 리저브` : "Aave v3 담보 리저브",
        collateral: a.collateral,
        loanSymbol: sym ?? "?",  // 풀이라 특정 대출자산 없음 — 담보 심볼로 채움
        loanAddress: a.collateral,
        sizeUsd: a.sizeUsd,
        meta: {
          kind: "lending", venue: "Aave V3", aToken: a.aToken,
          ltv: a.ltvBps / 1e4, liqThreshold: a.ltBps / 1e4, sizeUsd: a.sizeUsd,
          category: `Aave v3 담보 리저브 · LTV ${ltvPct}%`,
          // 풀형: 담보=리저브 1:1 → collateral 주소가 곧 유일키(대출자산 없음). loan 키 없음.
          collateralAddress: a.collateral, collateral: sym,
        },
        evidence: { source: "onchain", method: "Pool.getReserveData", aToken: a.aToken, ltvBps: a.ltvBps, ltBps: a.ltBps },
      };
    });
  },
};

// ── Fluid (Instadapp) — vault형 수용처 (discover.fluidAccepting 래핑). 마켓 = vault 1개 ──
//   Fluid 는 담보·부채가 명확한 vault 모델 → marketKey = vault id(legomkt:fluid:{vaultId}@chain).
//   라벨은 부채 토큰 심볼(스마트부채면 "USDC/USDT" 식). sizeUsd 는 단일담보 vault 만 산출(어댑터 산출, null 허용).
const fluid: AcceptorAdapter = {
  id: "fluid",
  chains: ["ethereum", "base", "arbitrum"], // Fluid API 지원 체인 (CHAIN_IDS 와 동일)
  async accepting(chain, collateralAddrs) {
    return (await fluidAccepting(chain, collateralAddrs)).map((a) => {
      const loanLabel = a.loanSymbol1 ? `${a.loanSymbol}/${a.loanSymbol1}` : a.loanSymbol; // 스마트부채면 둘 다
      const cfPct = a.cf != null ? ` · 담보계수 ${(a.cf * 100).toFixed(0)}%` : "";
      return {
        protocol: "fluid",
        marketKey: a.vaultId, // vault형: vault id 가 곧 마켓 키
        label: `${loanLabel} · Fluid vault`,
        collateral: a.collateral,
        loanSymbol: a.loanSymbol,
        loanAddress: a.loanAddress,
        sizeUsd: a.sizeUsd,
        meta: {
          kind: "lending", venue: "Fluid", vaultId: a.vaultId, vaultAddress: a.vaultAddress,
          loan: loanLabel, smartCollateral: a.smartCollateral,
          collateralFactor: a.cf, liqThreshold: a.lt, liqPenalty: a.penalty, sizeUsd: a.sizeUsd,
          category: `Fluid 담보 vault · 대출 ${loanLabel}${cfPct}`,
          // vault형: vaultId 가 유일키. 담보·대출 주소도 실어 알림 조인 변별력 확보.
          collateralAddress: a.collateral, loanAddress: a.loanAddress,
        },
        evidence: {
          source: "fluid-api", endpoint: "api.fluid.instadapp.io/v2/{chainId}/vaults",
          vaultId: a.vaultId, vaultAddress: a.vaultAddress, loan: loanLabel,
          smartCollateral: a.smartCollateral, collateralFactor: a.cf,
        },
      };
    });
  },
};

/** 등록 순서 = 질의 순서(기존 Morpho→Euler→Aave 유지, Fluid 추가). 새 수용처는 여기에만 추가. */
export const ACCEPTOR_ADAPTERS: AcceptorAdapter[] = [morphoBlue, eulerV2, aaveV3, fluid];
